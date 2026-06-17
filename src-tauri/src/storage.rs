use crate::{
    provider,
    types::{
        AgentMode, ContextSummaryRecord, CreateSessionInput, EventRecord, ProviderInput,
        ProviderKind, ProviderRecord, SessionEventsResponse, SessionRecord, ShellMode, ShellPolicy,
        SnapshotRecord,
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

pub fn delete_session(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM context_summary WHERE session_id = ?1",
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

pub fn session_events_response(
    conn: &Connection,
    session_id: &str,
) -> Result<SessionEventsResponse, String> {
    Ok(SessionEventsResponse {
        events: list_events(conn, session_id)?,
        snapshots: list_snapshots(conn, session_id)?,
        summaries: list_context_summaries(conn, session_id)?,
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
}
