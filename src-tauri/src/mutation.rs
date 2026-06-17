use crate::{
    storage,
    types::{SessionRecord, SnapshotRecord},
    util::{create_unified_diff_preview, normalize_project_path, resolve_writable_inside},
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

static PATH_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

#[derive(Debug)]
struct TextFile {
    text: String,
    bytes: Vec<u8>,
    has_bom: bool,
    newline: &'static str,
}

pub fn read_file_text(root: &Path, relative_path: &str) -> Result<String, String> {
    let target = resolve_writable_inside(root, relative_path)?;
    let text_file = read_text_file(&target)?;
    Ok(text_file.text)
}

pub fn edit_file(
    conn: &Connection,
    session: &SessionRecord,
    event_id: &str,
    relative_path: &str,
    old_string: &str,
    new_string: &str,
) -> Result<SnapshotRecord, String> {
    if old_string.is_empty() {
        return Err("edit.oldString 不能为空。".to_string());
    }

    let root = PathBuf::from(&session.project_root);
    let target = resolve_writable_inside(&root, relative_path)?;
    let lock = lock_for_path(&target)?;
    let _guard = lock.lock().map_err(|error| error.to_string())?;
    let before = read_text_file(&target)?;

    if !before.text.contains(old_string) {
        return Err(format!(
            "在文件中找不到精确匹配的 edit.oldString: {}",
            normalize_project_path(relative_path)
        ));
    }

    let after_text = before.text.replacen(old_string, new_string, 1);
    write_text_file(&target, &after_text, before.has_bom, before.newline)?;
    let after_bytes = encode_text(&after_text, before.has_bom, before.newline);

    insert_snapshot(
        conn,
        session,
        Some(event_id.to_string()),
        relative_path,
        Some(before.text),
        Some(after_text),
        hash_bytes(&before.bytes),
        hash_bytes(&after_bytes),
    )
}

pub fn write_file(
    conn: &Connection,
    session: &SessionRecord,
    event_id: &str,
    relative_path: &str,
    content: &str,
    expected_hash: Option<&str>,
) -> Result<SnapshotRecord, String> {
    let root = PathBuf::from(&session.project_root);
    let target = resolve_writable_inside(&root, relative_path)?;
    let lock = lock_for_path(&target)?;
    let _guard = lock.lock().map_err(|error| error.to_string())?;

    let before = if target.exists() {
        Some(read_text_file(&target)?)
    } else {
        None
    };

    if let (Some(expected), Some(before_file)) = (expected_hash, before.as_ref()) {
        let actual = hash_bytes(&before_file.bytes);
        if expected != actual {
            return Err(format!(
                "工具读取后文件已被外部修改，请重新读取后再写入: {}",
                normalize_project_path(relative_path)
            ));
        }
    }

    let (has_bom, newline) = before
        .as_ref()
        .map(|file| (file.has_bom, file.newline))
        .unwrap_or((false, "\n"));
    write_text_file(&target, content, has_bom, newline)?;
    let after_bytes = encode_text(content, has_bom, newline);

    insert_snapshot(
        conn,
        session,
        Some(event_id.to_string()),
        relative_path,
        before.as_ref().map(|file| file.text.clone()),
        Some(content.to_string()),
        before
            .as_ref()
            .map(|file| hash_bytes(&file.bytes))
            .unwrap_or_default(),
        hash_bytes(&after_bytes),
    )
}

pub fn delete_file(
    conn: &Connection,
    session: &SessionRecord,
    event_id: &str,
    relative_path: &str,
) -> Result<SnapshotRecord, String> {
    let root = PathBuf::from(&session.project_root);
    let target = resolve_writable_inside(&root, relative_path)?;
    let lock = lock_for_path(&target)?;
    let _guard = lock.lock().map_err(|error| error.to_string())?;
    let before = read_text_file(&target)?;
    fs::remove_file(&target).map_err(|error| error.to_string())?;

    insert_snapshot(
        conn,
        session,
        Some(event_id.to_string()),
        relative_path,
        Some(before.text),
        None,
        hash_bytes(&before.bytes),
        String::new(),
    )
}

pub fn rollback_snapshot(conn: &Connection, snapshot_id: &str) -> Result<SnapshotRecord, String> {
    let snapshot = storage::get_snapshot(conn, snapshot_id)?;
    let session = storage::get_session(conn, &snapshot.session_id)?;
    let root = PathBuf::from(&session.project_root);
    let target = resolve_writable_inside(&root, &snapshot.path)?;
    let lock = lock_for_path(&target)?;
    let _guard = lock.lock().map_err(|error| error.to_string())?;

    if let Some(before_content) = snapshot.before_content.as_ref() {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&target, before_content).map_err(|error| error.to_string())?;
    } else if target.exists() {
        fs::remove_file(&target).map_err(|error| error.to_string())?;
    }

    storage::append_event(
        conn,
        &snapshot.session_id,
        "rollback.applied",
        serde_json::json!({
            "snapshotId": snapshot.id,
            "path": snapshot.path
        }),
    )?;
    Ok(snapshot)
}

fn insert_snapshot(
    conn: &Connection,
    session: &SessionRecord,
    event_id: Option<String>,
    relative_path: &str,
    before_content: Option<String>,
    after_content: Option<String>,
    before_hash: String,
    after_hash: String,
) -> Result<SnapshotRecord, String> {
    let path = normalize_project_path(relative_path);
    let patch = create_unified_diff_preview(
        &path,
        before_content.as_deref().unwrap_or(""),
        after_content.as_deref().unwrap_or(""),
    );
    storage::insert_snapshot(
        conn,
        SnapshotRecord {
            id: String::new(),
            session_id: session.id.clone(),
            event_id,
            path,
            before_hash,
            after_hash,
            before_content,
            after_content,
            patch,
            created_at: String::new(),
        },
    )
}

fn read_text_file(path: &Path) -> Result<TextFile, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let has_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let text_bytes = if has_bom { &bytes[3..] } else { &bytes };
    let text = String::from_utf8(text_bytes.to_vec())
        .map_err(|_| format!("文件不是有效的 UTF-8 文本: {}", path.display()))?;
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };

    Ok(TextFile {
        text,
        bytes,
        has_bom,
        newline,
    })
}

fn write_text_file(
    path: &Path,
    content: &str,
    has_bom: bool,
    newline: &'static str,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, encode_text(content, has_bom, newline)).map_err(|error| error.to_string())
}

fn encode_text(content: &str, has_bom: bool, newline: &'static str) -> Vec<u8> {
    let normalized_lf = content.replace("\r\n", "\n");
    let final_text = if newline == "\r\n" {
        normalized_lf.replace('\n', "\r\n")
    } else {
        normalized_lf
    };
    let mut bytes = Vec::new();
    if has_bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(final_text.as_bytes());
    bytes
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn lock_for_path(path: &Path) -> Result<Arc<Mutex<()>>, String> {
    let key = path.to_string_lossy().to_string();
    let locks = PATH_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = locks.lock().map_err(|error| error.to_string())?;
    Ok(guard
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}
