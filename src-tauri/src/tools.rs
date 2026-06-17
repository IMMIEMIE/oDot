use crate::{
    mutation, storage,
    types::{EventRecord, SessionRecord, ShellMode, ShellPolicy, ToolCallRequest},
    util::{ignored_directories, is_likely_text_file, normalize_project_path, MAX_FILE_SIZE_BYTES},
};
use encoding_rs::GBK;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{fs, path::PathBuf, process::Command};

#[derive(Debug)]
pub struct ToolOutcome {
    pub pending: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolExecutionMode {
    Agent,
    Plan,
}

pub fn execute_tool(
    conn: &Connection,
    session: &SessionRecord,
    shell_mode: &ShellMode,
    call: &ToolCallRequest,
) -> Result<ToolOutcome, String> {
    execute_tool_with_mode(conn, session, shell_mode, call, ToolExecutionMode::Agent)
}

pub fn execute_tool_with_mode(
    conn: &Connection,
    session: &SessionRecord,
    shell_mode: &ShellMode,
    call: &ToolCallRequest,
    execution_mode: ToolExecutionMode,
) -> Result<ToolOutcome, String> {
    let shell_policy = storage::load_shell_policy(conn)?;
    let called = storage::append_event(
        conn,
        &session.id,
        "tool.called",
        json!({
            "name": call.name,
            "input": call.input
        }),
    )?;

    match execute_tool_inner(
        conn,
        session,
        shell_mode,
        &shell_policy,
        call,
        &called,
        execution_mode,
    ) {
        Ok(ToolRun::Success(data)) => {
            storage::append_event(
                conn,
                &session.id,
                "tool.success",
                json!({
                    "toolCallEventId": called.id,
                    "name": call.name,
                    "result": data
                }),
            )?;
            Ok(ToolOutcome { pending: false })
        }
        Ok(ToolRun::Pending(data)) => {
            storage::append_event(
                conn,
                &session.id,
                "tool.pending",
                json!({
                    "toolCallEventId": called.id,
                    "name": call.name,
                    "input": call.input,
                    "pending": data
                }),
            )?;
            Ok(ToolOutcome { pending: true })
        }
        Ok(ToolRun::Failure(data)) => {
            storage::append_event(
                conn,
                &session.id,
                "tool.failed",
                json!({
                    "toolCallEventId": called.id,
                    "name": call.name,
                    "result": data
                }),
            )?;
            Ok(ToolOutcome { pending: false })
        }
        Err(error) => {
            storage::append_event(
                conn,
                &session.id,
                "tool.failed",
                json!({
                    "toolCallEventId": called.id,
                    "name": call.name,
                    "error": error
                }),
            )?;
            Ok(ToolOutcome { pending: false })
        }
    }
}

pub fn approve_tool_call(conn: &Connection, event_id: &str) -> Result<EventRecord, String> {
    let event = storage::get_event(conn, event_id)?;
    if event.event_type != "tool.pending" {
        return Err("只能批准等待确认的工具事件。".to_string());
    }

    let session = storage::get_session(conn, &event.session_id)?;
    let name = event
        .data
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if name != "shell" {
        return Err("当前版本只支持确认等待中的 shell 命令。".to_string());
    }

    let command = event
        .data
        .pointer("/pending/command")
        .and_then(Value::as_str)
        .ok_or_else(|| "等待确认的 shell 事件中没有命令内容。".to_string())?;
    storage::append_event(
        conn,
        &session.id,
        "tool.approved",
        json!({
            "pendingEventId": event.id,
            "command": command
        }),
    )?;

    let result = run_shell_command(&session.project_root, command)?;
    let event_type = if result.get("exitCode").and_then(Value::as_i64).unwrap_or(1) == 0 {
        "tool.success"
    } else {
        "tool.failed"
    };

    storage::append_event(
        conn,
        &session.id,
        event_type,
        json!({
            "pendingEventId": event.id,
            "name": "shell",
            "result": result
        }),
    )
}

pub fn reject_tool_call(conn: &Connection, event_id: &str) -> Result<EventRecord, String> {
    let event = storage::get_event(conn, event_id)?;
    if event.event_type != "tool.pending" {
        return Err("只能拒绝等待确认的工具事件。".to_string());
    }

    storage::append_event(
        conn,
        &event.session_id,
        "tool.rejected",
        json!({
            "pendingEventId": event.id,
            "name": event.data.get("name").cloned().unwrap_or(Value::Null)
        }),
    )
}

enum ToolRun {
    Success(Value),
    Pending(Value),
    Failure(Value),
}

fn execute_tool_inner(
    conn: &Connection,
    session: &SessionRecord,
    shell_mode: &ShellMode,
    shell_policy: &ShellPolicy,
    call: &ToolCallRequest,
    called_event: &EventRecord,
    execution_mode: ToolExecutionMode,
) -> Result<ToolRun, String> {
    match call.name.as_str() {
        "read" => {
            let path = required_string(&call.input, "path")?;
            let root = PathBuf::from(&session.project_root);
            let content = mutation::read_file_text(&root, &path)?;
            Ok(ToolRun::Success(json!({
                "path": normalize_project_path(&path),
                "content": truncate(&content, 40_000)
            })))
        }
        "search" => {
            let query = required_string(&call.input, "query")?;
            let matches = search_project(&session.project_root, &query)?;
            Ok(ToolRun::Success(json!({
                "query": query,
                "matches": matches
            })))
        }
        "edit" => {
            if execution_mode == ToolExecutionMode::Plan {
                return Ok(plan_mode_mutation_blocked("edit"));
            }
            let path = required_string(&call.input, "path")?;
            let old_string = required_string_any(&call.input, &["oldString", "old_string"])?;
            let new_string = required_string_any(&call.input, &["newString", "new_string"])?;
            let snapshot = mutation::edit_file(
                conn,
                session,
                &called_event.id,
                &path,
                &old_string,
                &new_string,
            )?;
            Ok(ToolRun::Success(json!({
                "path": snapshot.path,
                "snapshotId": snapshot.id,
                "patch": snapshot.patch
            })))
        }
        "write" => {
            if execution_mode == ToolExecutionMode::Plan {
                return Ok(plan_mode_mutation_blocked("write"));
            }
            let path = required_string(&call.input, "path")?;
            let content = required_string(&call.input, "content")?;
            let expected_hash =
                optional_string_any(&call.input, &["expectedHash", "expected_hash"]);
            let snapshot = mutation::write_file(
                conn,
                session,
                &called_event.id,
                &path,
                &content,
                expected_hash.as_deref(),
            )?;
            Ok(ToolRun::Success(json!({
                "path": snapshot.path,
                "snapshotId": snapshot.id,
                "patch": snapshot.patch
            })))
        }
        "delete" => {
            if execution_mode == ToolExecutionMode::Plan {
                return Ok(plan_mode_mutation_blocked("delete"));
            }
            let path = required_string(&call.input, "path")?;
            let snapshot = mutation::delete_file(conn, session, &called_event.id, &path)?;
            Ok(ToolRun::Success(json!({
                "path": snapshot.path,
                "snapshotId": snapshot.id,
                "patch": snapshot.patch
            })))
        }
        "shell" => {
            let command = required_string(&call.input, "command")?;
            if execution_mode == ToolExecutionMode::Plan {
                return Ok(ToolRun::Pending(json!({
                    "command": command,
                    "reason": "计划模式下 shell 命令必须由用户确认。"
                })));
            }
            if shell_needs_approval(&command, shell_mode, shell_policy) {
                return Ok(ToolRun::Pending(json!({
                    "command": command,
                    "reason": shell_approval_reason(&command, shell_mode, shell_policy)
                })));
            }
            let result = run_shell_command(&session.project_root, &command)?;
            if shell_exit_code(&result) == 0 {
                Ok(ToolRun::Success(result))
            } else {
                Ok(ToolRun::Failure(result))
            }
        }
        other => Err(format!("未知工具: {other}")),
    }
}

fn plan_mode_mutation_blocked(tool_name: &str) -> ToolRun {
    ToolRun::Failure(json!({
        "blocked": true,
        "reason": format!("计划模式禁止执行 {tool_name}，请只读取、搜索或输出计划。")
    }))
}

fn shell_exit_code(result: &Value) -> i64 {
    result.get("exitCode").and_then(Value::as_i64).unwrap_or(1)
}

fn search_project(root: &str, query: &str) -> Result<Vec<Value>, String> {
    if query.trim().is_empty() {
        return Err("搜索关键词不能为空。".to_string());
    }

    let root = PathBuf::from(root);
    let ignored = ignored_directories();
    let mut stack = vec![root.clone()];
    let mut matches = Vec::new();

    while let Some(current) = stack.pop() {
        if matches.len() >= 100 {
            break;
        }

        for entry in fs::read_dir(&current).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = entry.metadata().map_err(|error| error.to_string())?;

            if metadata.is_dir() {
                if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                    if !ignored.contains(name) {
                        stack.push(path);
                    }
                }
                continue;
            }

            if !metadata.is_file()
                || metadata.len() > MAX_FILE_SIZE_BYTES
                || !is_likely_text_file(&path)?
            {
                continue;
            }

            let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            let relative = path
                .strip_prefix(&root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if relative.contains(query) {
                matches.push(json!({
                    "path": relative,
                    "lineNumber": 0,
                    "line": "<path match>"
                }));
            }
            for (index, line) in content.lines().enumerate() {
                if matches.len() >= 100 {
                    break;
                }
                if line.contains(query) {
                    matches.push(json!({
                        "path": relative,
                        "lineNumber": index + 1,
                        "line": truncate(line, 600)
                    }));
                }
            }
        }
    }

    Ok(matches)
}

fn run_shell_command(root: &str, command: &str) -> Result<Value, String> {
    let root = PathBuf::from(root);
    let output = if cfg!(target_os = "windows") {
        let command = format!(
            "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding; {command}"
        );
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &command,
            ])
            .current_dir(root)
            .output()
    } else {
        Command::new("sh")
            .args(["-lc", command])
            .current_dir(root)
            .output()
    }
    .map_err(|error| format!("运行 shell 命令失败: {error}"))?;

    Ok(json!({
        "command": command,
        "exitCode": output.status.code().unwrap_or(-1),
        "stdout": truncate(&decode_process_output(&output.stdout), 30_000),
        "stderr": truncate(&decode_process_output(&output.stderr), 30_000)
    }))
}

fn decode_process_output(bytes: &[u8]) -> String {
    match String::from_utf8(bytes.to_vec()) {
        Ok(value) => value,
        Err(_) => {
            let (decoded, _, _) = GBK.decode(bytes);
            decoded.into_owned()
        }
    }
}

fn shell_needs_approval(command: &str, mode: &ShellMode, policy: &ShellPolicy) -> bool {
    match mode {
        ShellMode::Manual => true,
        ShellMode::Auto => !is_low_risk_command(command, policy),
    }
}

fn shell_approval_reason(command: &str, mode: &ShellMode, policy: &ShellPolicy) -> &'static str {
    match mode {
        ShellMode::Manual => "当前为手动命令模式，需要用户确认。",
        ShellMode::Auto if !is_low_risk_command(command, policy) => {
            "该命令不在低风险自动执行白名单内。"
        }
        ShellMode::Auto => "需要用户确认。",
    }
}

fn is_low_risk_command(command: &str, policy: &ShellPolicy) -> bool {
    let normalized = command.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }

    let dangerous = [
        "rm ",
        "del ",
        "erase ",
        "rmdir",
        "remove-item",
        "git reset",
        "git checkout",
        "git clean",
        "npm install",
        "pnpm install",
        "yarn add",
        "cargo install",
        "pip install",
        "curl ",
        "wget ",
        "ssh ",
        "scp ",
        "chmod ",
        "chown ",
        "sudo ",
        "publish",
        "deploy",
    ];
    if dangerous.iter().any(|needle| normalized.contains(needle)) {
        return false;
    }

    policy
        .auto_allowlist
        .iter()
        .any(|prefix| normalized == *prefix || normalized.starts_with(&format!("{prefix} ")))
}

fn required_string(input: &Value, key: &str) -> Result<String, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .ok_or_else(|| format!("工具输入缺少字符串字段: {key}"))
}

fn required_string_any(input: &Value, keys: &[&str]) -> Result<String, String> {
    for key in keys {
        if let Some(value) = input.get(*key).and_then(Value::as_str) {
            return Ok(value.to_string());
        }
    }
    Err(format!("工具输入缺少字符串字段: {}", keys.join(" 或 ")))
}

fn optional_string_any(input: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .map(|value| value.to_string())
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    let mut truncated = value.chars().take(max_chars).collect::<String>();
    truncated.push_str("\n...[已截断]");
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(items: &[&str]) -> ShellPolicy {
        ShellPolicy {
            auto_allowlist: items.iter().map(|item| item.to_string()).collect(),
        }
    }

    #[test]
    fn auto_shell_allows_allowlisted_prefixes() {
        let policy = policy(&["npm run typecheck", "cargo test"]);

        assert!(!shell_needs_approval(
            "npm run typecheck -- --pretty false",
            &ShellMode::Auto,
            &policy
        ));
        assert!(!shell_needs_approval(
            "cargo test",
            &ShellMode::Auto,
            &policy
        ));
    }

    #[test]
    fn auto_shell_still_blocks_dangerous_commands() {
        let policy = policy(&["git", "npm"]);

        assert!(shell_needs_approval(
            "git reset --hard",
            &ShellMode::Auto,
            &policy
        ));
        assert!(shell_needs_approval(
            "npm install left-pad",
            &ShellMode::Auto,
            &policy
        ));
    }
}
