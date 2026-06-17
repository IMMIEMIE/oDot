use crate::{
    provider,
    types::{
        AgentMode, BackgroundJobRecord, ContextSummaryRecord, CreateSessionInput, EventRecord,
        PermissionReply, PermissionRequestRecord, ProviderInput, ProviderKind, ProviderRecord,
        SessionEventsResponse, SessionInputDelivery, SessionInputRecord, SessionRecord,
        SessionRunRecord, ShellMode, ShellPolicy, SnapshotRecord,
    },
    util,
};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let db_path = db_path(app)?;
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    init_db(&conn)?;
    Ok(conn)
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(app_dir.join("odot.db"))
}

fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS provider (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          base_url TEXT,
          model TEXT NOT NULL,
          credential_ref TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS session (
          id TEXT PRIMARY KEY,
          project_root TEXT NOT NULL,
          mode TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          shell_mode TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS event (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          data_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(session_id, seq)
        );

        CREATE TABLE IF NOT EXISTS snapshot (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          event_id TEXT,
          path TEXT NOT NULL,
          before_hash TEXT NOT NULL,
          after_hash TEXT NOT NULL,
          before_content TEXT,
          after_content TEXT,
          patch TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS context_summary (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          text TEXT NOT NULL,
          recent_event_seq INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS setting (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS session_input (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          prompt TEXT NOT NULL,
          delivery TEXT NOT NULL,
          resume INTEGER NOT NULL,
          status TEXT NOT NULL,
          promoted_event_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS session_run (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT
        );

        CREATE TABLE IF NOT EXISTS permission_request (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          action TEXT NOT NULL,
          resources_json TEXT NOT NULL,
          save_json TEXT NOT NULL,
          source_json TEXT NOT NULL,
          status TEXT NOT NULL,
          reply TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS permission_saved (
          id TEXT PRIMARY KEY,
          project_root TEXT NOT NULL,
          action TEXT NOT NULL,
          resource TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(project_root, action, resource)
        );

        CREATE TABLE IF NOT EXISTS background_job (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          command TEXT NOT NULL,
          cwd TEXT NOT NULL,
          pid INTEGER NOT NULL,
          status TEXT NOT NULL,
          log_path TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT
        );
        "#,
    )
    .map_err(|error| error.to_string())
}

pub fn save_provider(conn: &Connection, input: ProviderInput) -> Result<ProviderRecord, String> {
    let now = util::now_string();
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let existing = get_provider(conn, &id).ok();
    let created_at = existing
        .as_ref()
        .map(|provider| provider.created_at.clone())
        .unwrap_or_else(|| now.clone());
    let credential_ref = existing
        .as_ref()
        .map(|provider| provider.credential_ref.clone())
        .unwrap_or_else(|| format!("provider:{id}"));

    if let Some(api_key) = input
        .api_key
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        provider::save_api_key(&credential_ref, api_key)?;
    }

    conn.execute(
        r#"
        INSERT INTO provider (id, kind, name, base_url, model, credential_ref, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          name = excluded.name,
          base_url = excluded.base_url,
          model = excluded.model,
          credential_ref = excluded.credential_ref,
          updated_at = excluded.updated_at
        "#,
        params![
            &id,
            input.kind.as_str(),
            &input.name,
            &input.base_url,
            &input.model,
            &credential_ref,
            &created_at,
            &now
        ],
    )
    .map_err(|error| error.to_string())?;

    get_provider(conn, &id)
}

pub fn list_providers(conn: &Connection) -> Result<Vec<ProviderRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, name, base_url, model, credential_ref, created_at, updated_at
             FROM provider ORDER BY updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], provider_from_row)
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

pub fn get_provider(conn: &Connection, id: &str) -> Result<ProviderRecord, String> {
    conn.query_row(
        "SELECT id, kind, name, base_url, model, credential_ref, created_at, updated_at
         FROM provider WHERE id = ?1",
        params![id],
        provider_from_row,
    )
    .map_err(|error| not_found_error(error, "provider", id))
}

pub fn delete_provider(conn: &Connection, id: &str) -> Result<(), String> {
    if let Ok(record) = get_provider(conn, id) {
        let _ = provider::delete_api_key(&record.credential_ref);
    }

    conn.execute("DELETE FROM provider WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn create_session(
    conn: &Connection,
    input: CreateSessionInput,
) -> Result<SessionRecord, String> {
    get_provider(conn, &input.provider_id)
        .map_err(|_| "当前选择的 AI 服务配置不存在，请先保存或重新选择服务。".to_string())?;

    let now = util::now_string();
    let id = Uuid::new_v4().to_string();
    let root = util::ensure_directory(&input.project_root)?;
    let title = input.title.unwrap_or_else(|| {
        root.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Untitled session")
            .to_string()
    });

    conn.execute(
        r#"
        INSERT INTO session
          (id, project_root, mode, provider_id, title, status, shell_mode, created_at, updated_at)
        VALUES
          (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8)
        "#,
        params![
            &id,
            root.to_string_lossy().to_string(),
            input.mode.as_str(),
            &input.provider_id,
            &title,
            input.shell_mode.as_str(),
            &now,
            &now
        ],
    )
    .map_err(|error| error.to_string())?;

    get_session(conn, &id)
}

pub fn list_sessions(conn: &Connection) -> Result<Vec<SessionRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_root, mode, provider_id, title, status, shell_mode, created_at, updated_at
             FROM session ORDER BY updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], session_from_row)
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

pub fn get_session(conn: &Connection, id: &str) -> Result<SessionRecord, String> {
    conn.query_row(
        "SELECT id, project_root, mode, provider_id, title, status, shell_mode, created_at, updated_at
         FROM session WHERE id = ?1",
        params![id],
        session_from_row,
    )
    .map_err(|error| not_found_error(error, "session", id))
}

pub fn set_session_status(conn: &Connection, session_id: &str, status: &str) -> Result<(), String> {
    let updated_at = util::now_string();
    conn.execute(
        "UPDATE session SET status = ?1, updated_at = ?2 WHERE id = ?3",
        params![status, &updated_at, session_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn cancel_session(conn: &Connection, session_id: &str) -> Result<EventRecord, String> {
    set_session_status(conn, session_id, "cancel_requested")?;
    append_event(
        conn,
        session_id,
        "agent.cancelRequested",
        serde_json::json!({
            "reason": "用户停止了 Agent"
        }),
    )
}

pub fn is_session_cancel_requested(conn: &Connection, session_id: &str) -> Result<bool, String> {
    let status: String = conn
        .query_row(
            "SELECT status FROM session WHERE id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .map_err(|error| not_found_error(error, "session", session_id))?;
    Ok(status == "cancel_requested")
}

pub fn update_session_title(
    conn: &Connection,
    session_id: &str,
    title: &str,
) -> Result<SessionRecord, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("会话标题不能为空。".to_string());
    }

    let updated_at = util::now_string();
    let changed = conn
        .execute(
            "UPDATE session SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, &updated_at, session_id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err(format!("未找到会话: {session_id}"));
    }

    get_session(conn, session_id)
}

pub fn update_session_mode(
    conn: &Connection,
    session_id: &str,
    mode: AgentMode,
) -> Result<SessionRecord, String> {
    let updated_at = util::now_string();
    let changed = conn
        .execute(
            "UPDATE session SET mode = ?1, updated_at = ?2 WHERE id = ?3",
            params![mode.as_str(), &updated_at, session_id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err(format!("未找到会话: {session_id}"));
    }

    get_session(conn, session_id)
}

pub fn delete_session(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM context_summary WHERE session_id = ?1",
        params![id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM session_input WHERE session_id = ?1",
        params![id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM session_run WHERE session_id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM permission_request WHERE session_id = ?1",
        params![id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM background_job WHERE session_id = ?1",
        params![id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM snapshot WHERE session_id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM event WHERE session_id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM session WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}

pub fn append_event(
    conn: &Connection,
    session_id: &str,
    event_type: &str,
    data: Value,
) -> Result<EventRecord, String> {
    let seq: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM event WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let id = Uuid::new_v4().to_string();
    let created_at = util::now_string();
    let data_json = serde_json::to_string(&data).map_err(|error| error.to_string())?;

    conn.execute(
        "INSERT INTO event (id, session_id, seq, type, data_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![&id, session_id, seq, event_type, &data_json, &created_at],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE session SET updated_at = ?1 WHERE id = ?2",
        params![created_at, session_id],
    )
    .map_err(|error| error.to_string())?;

    get_event(conn, &id)
}

pub fn get_event(conn: &Connection, id: &str) -> Result<EventRecord, String> {
    conn.query_row(
        "SELECT id, session_id, seq, type, data_json, created_at FROM event WHERE id = ?1",
        params![id],
        event_from_row,
    )
    .map_err(|error| not_found_error(error, "event", id))
}

pub fn list_events(conn: &Connection, session_id: &str) -> Result<Vec<EventRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, seq, type, data_json, created_at
             FROM event WHERE session_id = ?1 ORDER BY seq ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![session_id], event_from_row)
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

pub fn list_recent_events(
    conn: &Connection,
    session_id: &str,
    limit: usize,
) -> Result<Vec<EventRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, seq, type, data_json, created_at
             FROM event WHERE session_id = ?1 ORDER BY seq DESC LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![session_id, limit as i64], event_from_row)
        .map_err(|error| error.to_string())?;
    let mut events = collect_rows(rows)?;
    events.sort_by_key(|event| event.seq);
    Ok(events)
}

pub fn insert_snapshot(
    conn: &Connection,
    mut snapshot: SnapshotRecord,
) -> Result<SnapshotRecord, String> {
    if snapshot.id.is_empty() {
        snapshot.id = Uuid::new_v4().to_string();
    }
    if snapshot.created_at.is_empty() {
        snapshot.created_at = util::now_string();
    }

    conn.execute(
        r#"
        INSERT INTO snapshot
          (id, session_id, event_id, path, before_hash, after_hash, before_content, after_content, patch, created_at)
        VALUES
          (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        "#,
        params![
            &snapshot.id,
            &snapshot.session_id,
            &snapshot.event_id,
            &snapshot.path,
            &snapshot.before_hash,
            &snapshot.after_hash,
            &snapshot.before_content,
            &snapshot.after_content,
            &snapshot.patch,
            &snapshot.created_at
        ],
    )
    .map_err(|error| error.to_string())?;

    get_snapshot(conn, &snapshot.id)
}

pub fn get_snapshot(conn: &Connection, id: &str) -> Result<SnapshotRecord, String> {
    conn.query_row(
        "SELECT id, session_id, event_id, path, before_hash, after_hash, before_content, after_content, patch, created_at
         FROM snapshot WHERE id = ?1",
        params![id],
        snapshot_from_row,
    )
    .map_err(|error| not_found_error(error, "snapshot", id))
}

pub fn list_snapshots(conn: &Connection, session_id: &str) -> Result<Vec<SnapshotRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, event_id, path, before_hash, after_hash, before_content, after_content, patch, created_at
             FROM snapshot WHERE session_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![session_id], snapshot_from_row)
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

pub fn insert_context_summary(
    conn: &Connection,
    session_id: &str,
    text: String,
    recent_event_seq: i64,
) -> Result<ContextSummaryRecord, String> {
    let id = Uuid::new_v4().to_string();
    let created_at = util::now_string();
    conn.execute(
        "INSERT INTO context_summary (id, session_id, text, recent_event_seq, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![&id, session_id, &text, recent_event_seq, &created_at],
    )
    .map_err(|error| error.to_string())?;

    Ok(ContextSummaryRecord {
        id,
        session_id: session_id.to_string(),
        text,
        recent_event_seq,
        created_at,
    })
}

pub fn list_context_summaries(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ContextSummaryRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, text, recent_event_seq, created_at
             FROM context_summary WHERE session_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![session_id], context_summary_from_row)
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

pub fn list_events_after(
    conn: &Connection,
    session_id: &str,
    after_seq: i64,
) -> Result<Vec<EventRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, seq, type, data_json, created_at
             FROM event WHERE session_id = ?1 AND seq > ?2 ORDER BY seq ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![session_id, after_seq], event_from_row)
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

pub fn admit_session_input(
    conn: &Connection,
    id: Option<String>,
    session_id: &str,
    prompt: &str,
    delivery: SessionInputDelivery,
    resume: bool,
) -> Result<SessionInputRecord, String> {
    let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
    if let Ok(existing) = get_session_input(conn, &id) {
        if existing.session_id == session_id
            && existing.prompt == prompt
            && existing.delivery.as_str() == delivery.as_str()
            && existing.resume == resume
        {
            return Ok(existing);
        }
        return Err(format!("输入 ID 已被不同内容占用: {id}"));
    }

    get_session(conn, session_id)?;
    let now = util::now_string();
    conn.execute(
        r#"
        INSERT INTO session_input
          (id, session_id, prompt, delivery, resume, status, promoted_event_id, created_at, updated_at)
        VALUES
          (?1, ?2, ?3, ?4, ?5, 'pending', NULL, ?6, ?7)
        "#,
        params![&id, session_id, prompt, delivery.as_str(), resume as i64, &now, &now],
    )
    .map_err(|error| error.to_string())?;
    get_session_input(conn, &id)
}

pub fn get_session_input(conn: &Connection, id: &str) -> Result<SessionInputRecord, String> {
    conn.query_row(
        "SELECT id, session_id, prompt, delivery, resume, status, promoted_event_id, created_at, updated_at
         FROM session_input WHERE id = ?1",
        params![id],
        session_input_from_row,
    )
    .map_err(|error| not_found_error(error, "session_input", id))
}

pub fn next_pending_session_input(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<SessionInputRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, prompt, delivery, resume, status, promoted_event_id, created_at, updated_at
             FROM session_input WHERE session_id = ?1 AND status = 'pending'
             ORDER BY CASE delivery WHEN 'steer' THEN 0 ELSE 1 END, created_at ASC LIMIT 1",
        )
        .map_err(|error| error.to_string())?;
    let mut rows = stmt
        .query_map(params![session_id], session_input_from_row)
        .map_err(|error| error.to_string())?;
    rows.next().transpose().map_err(|error| error.to_string())
}

pub fn mark_session_input_promoted(
    conn: &Connection,
    input_id: &str,
    event_id: &str,
) -> Result<(), String> {
    let now = util::now_string();
    conn.execute(
        "UPDATE session_input SET status = 'promoted', promoted_event_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![event_id, &now, input_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn list_session_inputs(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionInputRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, prompt, delivery, resume, status, promoted_event_id, created_at, updated_at
             FROM session_input WHERE session_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![session_id], session_input_from_row)
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

pub fn begin_session_run(conn: &Connection, session_id: &str) -> Result<SessionRunRecord, String> {
    if let Some(active) = active_session_run(conn, session_id)? {
        return Ok(active);
    }
    let id = Uuid::new_v4().to_string();
    let now = util::now_string();
    conn.execute(
        "INSERT INTO session_run (id, session_id, status, started_at, ended_at)
         VALUES (?1, ?2, 'running', ?3, NULL)",
        params![&id, session_id, &now],
    )
    .map_err(|error| error.to_string())?;
    get_session_run(conn, &id)
}

pub fn active_session_run(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<SessionRunRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, status, started_at, ended_at
             FROM session_run WHERE session_id = ?1 AND status = 'running'
             ORDER BY started_at DESC LIMIT 1",
        )
        .map_err(|error| error.to_string())?;
    let mut rows = stmt
        .query_map(params![session_id], session_run_from_row)
        .map_err(|error| error.to_string())?;
    rows.next().transpose().map_err(|error| error.to_string())
}

pub fn get_session_run(conn: &Connection, id: &str) -> Result<SessionRunRecord, String> {
    conn.query_row(
        "SELECT id, session_id, status, started_at, ended_at FROM session_run WHERE id = ?1",
        params![id],
        session_run_from_row,
    )
    .map_err(|error| not_found_error(error, "session_run", id))
}

pub fn end_session_run(conn: &Connection, run_id: &str, status: &str) -> Result<(), String> {
    let now = util::now_string();
    conn.execute(
        "UPDATE session_run SET status = ?1, ended_at = ?2 WHERE id = ?3",
        params![status, &now, run_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn list_session_runs(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionRunRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, status, started_at, ended_at
             FROM session_run WHERE session_id = ?1 ORDER BY started_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![session_id], session_run_from_row)
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

pub fn create_permission_request(
    conn: &Connection,
    session_id: &str,
    action: &str,
    resources: Vec<String>,
    save: Vec<String>,
    source_json: Value,
) -> Result<PermissionRequestRecord, String> {
    let id = Uuid::new_v4().to_string();
    let now = util::now_string();
    let resources_json = serde_json::to_string(&resources).map_err(|error| error.to_string())?;
    let save_json = serde_json::to_string(&save).map_err(|error| error.to_string())?;
    let source_json_text =
        serde_json::to_string(&source_json).map_err(|error| error.to_string())?;
    conn.execute(
        r#"
        INSERT INTO permission_request
          (id, session_id, action, resources_json, save_json, source_json, status, reply, created_at, updated_at)
        VALUES
          (?1, ?2, ?3, ?4, ?5, ?6, 'pending', NULL, ?7, ?8)
        "#,
        params![&id, session_id, action, &resources_json, &save_json, &source_json_text, &now, &now],
    )
    .map_err(|error| error.to_string())?;
    get_permission_request(conn, &id)
}

pub fn get_permission_request(
    conn: &Connection,
    id: &str,
) -> Result<PermissionRequestRecord, String> {
    conn.query_row(
        "SELECT id, session_id, action, resources_json, save_json, source_json, status, reply, created_at, updated_at
         FROM permission_request WHERE id = ?1",
        params![id],
        permission_request_from_row,
    )
    .map_err(|error| not_found_error(error, "permission_request", id))
}

pub fn reply_permission_request(
    conn: &Connection,
    request_id: &str,
    reply: PermissionReply,
    project_root: &str,
) -> Result<PermissionRequestRecord, String> {
    let request = get_permission_request(conn, request_id)?;
    let now = util::now_string();
    conn.execute(
        "UPDATE permission_request SET status = 'answered', reply = ?1, updated_at = ?2 WHERE id = ?3",
        params![reply.as_str(), &now, request_id],
    )
    .map_err(|error| error.to_string())?;
    if matches!(reply, PermissionReply::Always) {
        for resource in &request.save {
            save_permission(conn, project_root, &request.action, resource)?;
        }
    }
    get_permission_request(conn, request_id)
}

pub fn list_permission_requests(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<PermissionRequestRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, action, resources_json, save_json, source_json, status, reply, created_at, updated_at
             FROM permission_request WHERE session_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![session_id], permission_request_from_row)
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

pub fn save_permission(
    conn: &Connection,
    project_root: &str,
    action: &str,
    resource: &str,
) -> Result<(), String> {
    let now = util::now_string();
    conn.execute(
        "INSERT OR IGNORE INTO permission_saved (id, project_root, action, resource, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            Uuid::new_v4().to_string(),
            project_root,
            action,
            resource,
            &now
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn permission_is_saved(
    conn: &Connection,
    project_root: &str,
    action: &str,
    resource: &str,
) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM permission_saved WHERE project_root = ?1 AND action = ?2 AND resource = ?3",
            params![project_root, action, resource],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(count > 0)
}

pub fn insert_background_job(
    conn: &Connection,
    session_id: &str,
    command: &str,
    cwd: &str,
    pid: u32,
    log_path: Option<String>,
) -> Result<BackgroundJobRecord, String> {
    let id = Uuid::new_v4().to_string();
    let now = util::now_string();
    conn.execute(
        "INSERT INTO background_job (id, session_id, command, cwd, pid, status, log_path, started_at, ended_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6, ?7, NULL)",
        params![&id, session_id, command, cwd, pid as i64, &log_path, &now],
    )
    .map_err(|error| error.to_string())?;
    get_background_job(conn, &id)
}

pub fn get_background_job(conn: &Connection, id: &str) -> Result<BackgroundJobRecord, String> {
    conn.query_row(
        "SELECT id, session_id, command, cwd, pid, status, log_path, started_at, ended_at
         FROM background_job WHERE id = ?1",
        params![id],
        background_job_from_row,
    )
    .map_err(|error| not_found_error(error, "background_job", id))
}

pub fn list_background_jobs(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<BackgroundJobRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, command, cwd, pid, status, log_path, started_at, ended_at
             FROM background_job WHERE session_id = ?1 ORDER BY started_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![session_id], background_job_from_row)
        .map_err(|error| error.to_string())?;
    collect_rows(rows)
}

pub fn update_background_job_status(
    conn: &Connection,
    id: &str,
    status: &str,
) -> Result<BackgroundJobRecord, String> {
    let now = util::now_string();
    conn.execute(
        "UPDATE background_job SET status = ?1, ended_at = ?2 WHERE id = ?3",
        params![status, &now, id],
    )
    .map_err(|error| error.to_string())?;
    get_background_job(conn, id)
}

pub fn session_events_response(
    conn: &Connection,
    session_id: &str,
) -> Result<SessionEventsResponse, String> {
    Ok(SessionEventsResponse {
        events: list_events(conn, session_id)?,
        snapshots: list_snapshots(conn, session_id)?,
        summaries: list_context_summaries(conn, session_id)?,
        inputs: list_session_inputs(conn, session_id)?,
        runs: list_session_runs(conn, session_id)?,
        permissions: list_permission_requests(conn, session_id)?,
        jobs: list_background_jobs(conn, session_id)?,
    })
}

pub fn load_shell_policy(conn: &Connection) -> Result<ShellPolicy, String> {
    let value_json: Result<String, rusqlite::Error> = conn.query_row(
        "SELECT value_json FROM setting WHERE key = 'shellPolicy'",
        [],
        |row| row.get(0),
    );

    match value_json {
        Ok(value) => serde_json::from_str(&value).map_err(|error| error.to_string()),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(default_shell_policy()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn save_shell_policy(conn: &Connection, policy: ShellPolicy) -> Result<ShellPolicy, String> {
    let normalized = ShellPolicy {
        auto_allowlist: normalize_allowlist(policy.auto_allowlist),
    };
    let now = util::now_string();
    let value_json = serde_json::to_string(&normalized).map_err(|error| error.to_string())?;
    conn.execute(
        r#"
        INSERT INTO setting (key, value_json, updated_at)
        VALUES ('shellPolicy', ?1, ?2)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
        "#,
        params![value_json, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(normalized)
}

pub fn default_shell_policy() -> ShellPolicy {
    ShellPolicy {
        auto_allowlist: normalize_allowlist(vec![
            "git status".to_string(),
            "git diff".to_string(),
            "git log".to_string(),
            "npm test".to_string(),
            "npm run test".to_string(),
            "npm run lint".to_string(),
            "npm run build".to_string(),
            "npm run typecheck".to_string(),
            "cargo check".to_string(),
            "cargo test".to_string(),
            "cargo clippy".to_string(),
            "node --version".to_string(),
            "npm --version".to_string(),
            "dir".to_string(),
            "ls".to_string(),
            "pwd".to_string(),
        ]),
    }
}

fn normalize_allowlist(items: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for item in items {
        let normalized = item.trim().to_ascii_lowercase();
        if !normalized.is_empty() && !result.contains(&normalized) {
            result.push(normalized);
        }
    }
    result
}

fn provider_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProviderRecord> {
    let kind: String = row.get(1)?;
    Ok(ProviderRecord {
        id: row.get(0)?,
        kind: ProviderKind::from_str(&kind).unwrap_or(ProviderKind::OpenAiCompatible),
        name: row.get(2)?,
        base_url: row.get(3)?,
        model: row.get(4)?,
        credential_ref: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRecord> {
    let mode: String = row.get(2)?;
    let shell_mode: String = row.get(6)?;
    Ok(SessionRecord {
        id: row.get(0)?,
        project_root: row.get(1)?,
        mode: AgentMode::from_str(&mode).unwrap_or(AgentMode::Ask),
        provider_id: row.get(3)?,
        title: row.get(4)?,
        status: row.get(5)?,
        shell_mode: ShellMode::from_str(&shell_mode).unwrap_or(ShellMode::Manual),
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EventRecord> {
    let data_json: String = row.get(4)?;
    Ok(EventRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        seq: row.get(2)?,
        event_type: row.get(3)?,
        data: serde_json::from_str(&data_json).unwrap_or(Value::Null),
        created_at: row.get(5)?,
    })
}

fn snapshot_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SnapshotRecord> {
    Ok(SnapshotRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        event_id: row.get(2)?,
        path: row.get(3)?,
        before_hash: row.get(4)?,
        after_hash: row.get(5)?,
        before_content: row.get(6)?,
        after_content: row.get(7)?,
        patch: row.get(8)?,
        created_at: row.get(9)?,
    })
}

fn context_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ContextSummaryRecord> {
    Ok(ContextSummaryRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        text: row.get(2)?,
        recent_event_seq: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn session_input_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionInputRecord> {
    let delivery: String = row.get(3)?;
    let resume: i64 = row.get(4)?;
    Ok(SessionInputRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        prompt: row.get(2)?,
        delivery: SessionInputDelivery::from_str(&delivery).unwrap_or(SessionInputDelivery::Queue),
        resume: resume != 0,
        status: row.get(5)?,
        promoted_event_id: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn session_run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRunRecord> {
    Ok(SessionRunRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        status: row.get(2)?,
        started_at: row.get(3)?,
        ended_at: row.get(4)?,
    })
}

fn permission_request_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<PermissionRequestRecord> {
    let resources_json: String = row.get(3)?;
    let save_json: String = row.get(4)?;
    let source_json: String = row.get(5)?;
    let reply: Option<String> = row.get(7)?;
    Ok(PermissionRequestRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        action: row.get(2)?,
        resources: serde_json::from_str(&resources_json).unwrap_or_default(),
        save: serde_json::from_str(&save_json).unwrap_or_default(),
        source_json: serde_json::from_str(&source_json).unwrap_or(Value::Null),
        status: row.get(6)?,
        reply: reply
            .as_deref()
            .and_then(|value| PermissionReply::from_str(value).ok()),
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn background_job_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BackgroundJobRecord> {
    let pid: i64 = row.get(4)?;
    Ok(BackgroundJobRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        command: row.get(2)?,
        cwd: row.get(3)?,
        pid: pid.max(0) as u32,
        status: row.get(5)?,
        log_path: row.get(6)?,
        started_at: row.get(7)?,
        ended_at: row.get(8)?,
    })
}

fn collect_rows<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>,
) -> Result<Vec<T>, String> {
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

fn not_found_error(error: rusqlite::Error, record_type: &str, id: &str) -> String {
    if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
        let label = match record_type {
            "provider" => "AI 服务配置",
            "session" => "会话",
            "event" => "事件",
            "snapshot" => "快照",
            _ => record_type,
        };
        format!("找不到{label}记录: {id}")
    } else {
        error.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn
    }

    #[test]
    fn delete_session_cleans_related_records() {
        let conn = memory_db();
        let session = SessionRecord {
            id: "session-1".to_string(),
            project_root: "E:/oDot".to_string(),
            mode: AgentMode::Agent,
            provider_id: "provider/model".to_string(),
            title: "Test".to_string(),
            status: "active".to_string(),
            shell_mode: ShellMode::Auto,
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
        };

        conn.execute(
            "INSERT INTO session (id, project_root, mode, provider_id, title, status, shell_mode, created_at, updated_at)
             VALUES (?1, ?2, 'agent', ?3, ?4, 'active', 'auto', '1', '1')",
            params![&session.id, &session.project_root, &session.provider_id, &session.title],
        )
        .unwrap();
        append_event(
            &conn,
            &session.id,
            "prompt.submitted",
            json!({ "prompt": "hi" }),
        )
        .unwrap();
        insert_context_summary(&conn, &session.id, "summary".to_string(), 1).unwrap();
        insert_snapshot(
            &conn,
            SnapshotRecord {
                id: "snapshot-1".to_string(),
                session_id: session.id.clone(),
                event_id: None,
                path: "a.txt".to_string(),
                before_hash: "before".to_string(),
                after_hash: "after".to_string(),
                before_content: Some("before".to_string()),
                after_content: Some("after".to_string()),
                patch: "patch".to_string(),
                created_at: "1".to_string(),
            },
        )
        .unwrap();

        delete_session(&conn, &session.id).unwrap();

        assert!(get_session(&conn, &session.id).is_err());
        assert!(list_events(&conn, &session.id).unwrap().is_empty());
        assert!(list_snapshots(&conn, &session.id).unwrap().is_empty());
        assert!(list_context_summaries(&conn, &session.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn shell_policy_has_default_and_can_be_saved() {
        let conn = memory_db();
        let default_policy = load_shell_policy(&conn).unwrap();
        assert!(default_policy
            .auto_allowlist
            .contains(&"cargo test".to_string()));

        let saved = save_shell_policy(
            &conn,
            ShellPolicy {
                auto_allowlist: vec![
                    " git status ".to_string(),
                    "git status".to_string(),
                    "npm run test".to_string(),
                ],
            },
        )
        .unwrap();

        assert_eq!(saved.auto_allowlist, vec!["git status", "npm run test"]);
        assert_eq!(
            load_shell_policy(&conn).unwrap().auto_allowlist,
            saved.auto_allowlist
        );
    }

    #[test]
    fn session_input_admission_is_idempotent() {
        let conn = memory_db();
        conn.execute(
            "INSERT INTO session (id, project_root, mode, provider_id, title, status, shell_mode, created_at, updated_at)
             VALUES ('s1', 'E:/oDot', 'agent', 'p1', 'Test', 'active', 'auto', '1', '1')",
            [],
        )
        .unwrap();

        let first = admit_session_input(
            &conn,
            Some("input-1".to_string()),
            "s1",
            "hi",
            SessionInputDelivery::Queue,
            true,
        )
        .unwrap();
        let second = admit_session_input(
            &conn,
            Some("input-1".to_string()),
            "s1",
            "hi",
            SessionInputDelivery::Queue,
            true,
        )
        .unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(list_session_inputs(&conn, "s1").unwrap().len(), 1);
    }

    #[test]
    fn permission_reply_always_saves_rule() {
        let conn = memory_db();
        let request = create_permission_request(
            &conn,
            "s1",
            "bash",
            vec!["npm run build".to_string()],
            vec!["npm run build".to_string()],
            json!({ "type": "tool" }),
        )
        .unwrap();

        let replied =
            reply_permission_request(&conn, &request.id, PermissionReply::Always, "E:/oDot")
                .unwrap();

        assert_eq!(replied.status, "answered");
        assert!(permission_is_saved(&conn, "E:/oDot", "bash", "npm run build").unwrap());
    }

    #[test]
    fn background_job_can_be_recorded() {
        let conn = memory_db();
        let job = insert_background_job(
            &conn,
            "s1",
            "npm run dev",
            "E:/oDot",
            123,
            Some("E:/oDot/.odot/jobs/test.log".to_string()),
        )
        .unwrap();

        assert_eq!(job.status, "running");
        assert_eq!(list_background_jobs(&conn, "s1").unwrap().len(), 1);
    }
}
