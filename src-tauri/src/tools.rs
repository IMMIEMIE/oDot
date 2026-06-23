use crate::{
    mutation, storage,
    types::{EventRecord, SessionRecord, ShellMode, ShellPolicy, ToolCallRequest},
    util::{ignored_directories, is_likely_text_file, normalize_project_path, MAX_FILE_SIZE_BYTES},
};
use encoding_rs::GBK;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Read,
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const DEFAULT_SHELL_TIMEOUT_SECONDS: u64 = 60;
const MAX_SHELL_TIMEOUT_SECONDS: u64 = 600;

#[derive(Debug)]
pub struct ToolOutcome {
    pub pending: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolExecutionMode {
    Agent,
    Ask,
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
            "toolCallId": call.tool_call_id,
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
    if name != "shell" && name != "bash" {
        return Err("当前版本只支持确认等待中的 shell/bash 命令。".to_string());
    }

    let command = event
        .data
        .pointer("/pending/command")
        .and_then(Value::as_str)
        .ok_or_else(|| "等待确认的 shell 事件中没有命令内容。".to_string())?;
    let options = shell_run_options(event.data.pointer("/pending").unwrap_or(&Value::Null));
    let cwd = shell_workdir(&session, &options)?;
    storage::append_event(
        conn,
        &session.id,
        "tool.approved",
        json!({
            "pendingEventId": event.id,
            "command": command
        }),
    )?;

    let result = if options.background {
        run_shell_command_background(conn, &session, &cwd, command)?
    } else {
        run_shell_command(&cwd, command, options.timeout_seconds)?
    };
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
            "name": name,
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

#[derive(Debug)]
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
    let tool_name = normalize_tool_name(&call.name);
    match tool_name.as_str() {
        "invalid" => Ok(ToolRun::Failure(invalid_tool_result(&call.input))),
        "read" => {
            let path = required_string(&call.input, "path")?;
            let root = PathBuf::from(&session.project_root);
            let content = mutation::read_file_text(&root, &path)?;
            Ok(ToolRun::Success(json!({
                "path": normalize_project_path(&path),
                "content": truncate(&content, 40_000)
            })))
        }
        "search" | "grep" => {
            let query = required_string(&call.input, "query")?;
            let matches = search_project(&session.project_root, &query)?;
            Ok(ToolRun::Success(json!({
                "query": query,
                "matches": matches
            })))
        }
        "edit" => {
            if execution_mode != ToolExecutionMode::Agent {
                return Ok(read_only_mode_mutation_blocked(execution_mode, "edit"));
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
            if execution_mode != ToolExecutionMode::Agent {
                return Ok(read_only_mode_mutation_blocked(execution_mode, "write"));
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
            if execution_mode != ToolExecutionMode::Agent {
                return Ok(read_only_mode_mutation_blocked(execution_mode, "delete"));
            }
            let path = required_string(&call.input, "path")?;
            let snapshot = mutation::delete_file(conn, session, &called_event.id, &path)?;
            Ok(ToolRun::Success(json!({
                "path": snapshot.path,
                "snapshotId": snapshot.id,
                "patch": snapshot.patch
            })))
        }
        "question" => {
            let question = required_string_any(&call.input, &["question", "text"])?;
            Ok(ToolRun::Pending(json!({
                "kind": "question",
                "question": question,
                "reason": "Agent 请求用户回答。"
            })))
        }
        "todo_write" => {
            let todos = call
                .input
                .get("todos")
                .cloned()
                .unwrap_or(Value::Array(Vec::new()));
            Ok(ToolRun::Success(json!({
                "todos": todos
            })))
        }
        "shell" | "bash" => {
            let command = required_string(&call.input, "command")?;
            let options = shell_run_options(&call.input);
            let cwd = shell_workdir(session, &options)?;
            if shell_needs_approval(&command, shell_mode, shell_policy)
                && !storage::permission_is_saved(conn, &session.project_root, "bash", &command)?
            {
                let permission = storage::create_permission_request(
                    conn,
                    &session.id,
                    "bash",
                    vec![command.clone()],
                    vec![command.clone()],
                    json!({ "type": "tool", "eventId": called_event.id }),
                )?;
                return Ok(ToolRun::Pending(json!({
                    "command": command,
                    "background": options.background,
                    "timeoutSeconds": options.timeout_seconds,
                    "permissionRequestId": permission.id,
                    "reason": shell_approval_reason(&command, shell_mode, shell_policy)
                })));
            }
            let result = if options.background {
                run_shell_command_background(conn, session, &cwd, &command)?
            } else {
                run_shell_command(&cwd, &command, options.timeout_seconds)?
            };
            if shell_exit_code(&result) == 0 {
                Ok(ToolRun::Success(result))
            } else {
                Ok(ToolRun::Failure(result))
            }
        }
        other => Err(format!("未知工具: {other}")),
    }
}

fn normalize_tool_name(name: &str) -> String {
    match name.trim().to_ascii_lowercase().as_str() {
        "bash" => "shell".to_string(),
        "grep" => "search".to_string(),
        "todowrite" => "todo_write".to_string(),
        other => other.to_string(),
    }
}

fn invalid_tool_result(input: &Value) -> Value {
    let tool = input.get("tool").cloned().unwrap_or(Value::Null);
    let error = input
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("unknown tool argument error");
    let arguments = input.get("arguments").cloned().unwrap_or(Value::Null);
    json!({
        "invalid": true,
        "tool": tool,
        "error": error,
        "arguments": arguments,
        "message": format!("The arguments provided to the tool are invalid: {error}")
    })
}

fn read_only_mode_mutation_blocked(execution_mode: ToolExecutionMode, tool_name: &str) -> ToolRun {
    let mode_label = match execution_mode {
        ToolExecutionMode::Ask => "问答模式",
        ToolExecutionMode::Plan => "计划模式",
        ToolExecutionMode::Agent => "Agent 模式",
    };
    ToolRun::Failure(json!({
        "blocked": true,
        "reason": format!("{mode_label}禁止执行 {tool_name}，请只读取、搜索或运行不会修改代码的检查命令。")
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

            let content = decode_text_file(&path)?;
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

#[derive(Debug, Clone)]
struct ShellRunOptions {
    background: bool,
    timeout_seconds: u64,
    workdir: Option<String>,
}

fn shell_run_options(input: &Value) -> ShellRunOptions {
    let timeout_seconds = optional_u64_any(input, &["timeoutSeconds", "timeout_seconds"])
        .unwrap_or(DEFAULT_SHELL_TIMEOUT_SECONDS)
        .clamp(1, MAX_SHELL_TIMEOUT_SECONDS);
    ShellRunOptions {
        background: optional_bool(input, "background").unwrap_or(false),
        timeout_seconds,
        workdir: optional_string_any(input, &["workdir", "cwd"]),
    }
}

fn shell_workdir(session: &SessionRecord, options: &ShellRunOptions) -> Result<String, String> {
    let root = PathBuf::from(&session.project_root);
    let dir = match options
        .workdir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                root.join(path)
            }
        }
        None => root,
    };
    if !dir.is_dir() {
        return Err(format!("Shell 工作目录不存在或不是目录: {}", dir.display()));
    }
    Ok(dir.to_string_lossy().to_string())
}

fn run_shell_command(root: &str, command: &str, timeout_seconds: u64) -> Result<Value, String> {
    let root = PathBuf::from(root);
    let mut child = shell_command(&root, command)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("运行 shell 命令失败: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .map(read_pipe)
        .ok_or_else(|| "无法读取 shell 标准输出。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .map(read_pipe)
        .ok_or_else(|| "无法读取 shell 标准错误。".to_string())?;
    let started_at = Instant::now();
    let timeout = Duration::from_secs(timeout_seconds);
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if started_at.elapsed() >= timeout {
            timed_out = true;
            terminate_process_tree(&mut child);
            break child.wait().map_err(|error| error.to_string())?;
        }
        thread::sleep(Duration::from_millis(50));
    };
    let stdout = stdout
        .join()
        .map_err(|_| "读取 shell 标准输出失败。".to_string())?;
    let stderr = stderr
        .join()
        .map_err(|_| "读取 shell 标准错误失败。".to_string())?;

    Ok(json!({
        "command": command,
        "exitCode": status.code().unwrap_or(-1),
        "timedOut": timed_out,
        "timeoutSeconds": timeout_seconds,
        "stdout": truncate(&decode_process_output(&stdout), 30_000),
        "stderr": truncate(&decode_process_output(&stderr), 30_000)
    }))
}

fn run_shell_command_background(
    conn: &Connection,
    session: &SessionRecord,
    cwd: &str,
    command: &str,
) -> Result<Value, String> {
    let cwd_path = PathBuf::from(cwd);
    let job_dir = PathBuf::from(&session.project_root)
        .join(".odot")
        .join("jobs");
    fs::create_dir_all(&job_dir).map_err(|error| error.to_string())?;
    let log_path = job_dir.join(format!("{}.log", uuid::Uuid::new_v4()));
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| error.to_string())?;
    let stderr = stdout.try_clone().map_err(|error| error.to_string())?;
    let child = shell_command(&cwd_path, command)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| format!("启动后台 shell 命令失败: {error}"))?;
    let pid = child.id();
    let job = storage::insert_background_job(
        conn,
        &session.id,
        command,
        cwd,
        pid,
        Some(log_path.to_string_lossy().to_string()),
    )?;
    Ok(json!({
        "command": command,
        "exitCode": 0,
        "background": true,
        "pid": pid,
        "jobId": job.id,
        "cwd": cwd,
        "logPath": job.log_path,
        "stdout": "",
        "stderr": ""
    }))
}

fn shell_command(root: &PathBuf, command: &str) -> Command {
    if cfg!(target_os = "windows") {
        let command = format!(
            "$OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding; {command}"
        );
        let mut process = Command::new("powershell");
        process
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &command,
            ])
            .current_dir(root);
        process
    } else {
        let mut process = Command::new("sh");
        process.args(["-lc", command]).current_dir(root);
        process
    }
}

fn read_pipe<T>(mut pipe: T) -> thread::JoinHandle<Vec<u8>>
where
    T: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        bytes
    })
}

fn terminate_process_tree(child: &mut Child) {
    let pid = child.id().to_string();
    if cfg!(target_os = "windows") {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

pub fn wait_job(conn: &Connection, job_id: &str) -> Result<Value, String> {
    let job = storage::get_background_job(conn, job_id)?;
    if job.status != "running" {
        return Ok(json!({ "job": job, "running": false }));
    }
    let running = pid_is_running(job.pid);
    let job = if running {
        job
    } else {
        storage::update_background_job_status(conn, job_id, "completed")?
    };
    Ok(json!({ "job": job, "running": running }))
}

pub fn cancel_job(conn: &Connection, job_id: &str) -> Result<Value, String> {
    let job = storage::get_background_job(conn, job_id)?;
    terminate_pid_tree(job.pid);
    let job = storage::update_background_job_status(conn, job_id, "cancelled")?;
    Ok(json!({ "job": job }))
}

pub fn read_job_logs(conn: &Connection, job_id: &str) -> Result<Value, String> {
    let job = storage::get_background_job(conn, job_id)?;
    let logs = job
        .log_path
        .as_ref()
        .and_then(|path| fs::read(path).ok())
        .map(|bytes| truncate(&decode_process_output(&bytes), 30_000))
        .unwrap_or_default();
    Ok(json!({ "job": job, "logs": logs }))
}

fn pid_is_running(pid: u32) -> bool {
    if cfg!(target_os = "windows") {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .to_ascii_lowercase()
                    .contains(&pid.to_string())
            })
            .unwrap_or(false)
    } else {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

fn terminate_pid_tree(pid: u32) {
    if cfg!(target_os = "windows") {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    } else {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn decode_process_output(bytes: &[u8]) -> String {
    decode_bytes(bytes)
}

fn decode_text_file(path: &std::path::Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    Ok(decode_bytes(&bytes))
}

fn decode_bytes(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
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
    let normalized = normalize_shell_policy_item(command);
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
        .map(|prefix| normalize_shell_policy_item(prefix))
        .any(|prefix| normalized == prefix || normalized.starts_with(&format!("{prefix} ")))
}

pub(crate) fn normalize_shell_policy_item(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
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

fn optional_bool(input: &Value, key: &str) -> Option<bool> {
    input.get(key).and_then(Value::as_bool)
}

fn optional_u64_any(input: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| input.get(*key).and_then(Value::as_u64))
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
    use crate::types::AgentMode;

    fn policy(items: &[&str]) -> ShellPolicy {
        ShellPolicy {
            auto_allowlist: items.iter().map(|item| item.to_string()).collect(),
        }
    }

    fn slow_command() -> &'static str {
        if cfg!(target_os = "windows") {
            "Start-Sleep -Seconds 5"
        } else {
            "sleep 5"
        }
    }

    fn echo_command() -> &'static str {
        if cfg!(target_os = "windows") {
            "Write-Output odot-plan-auto"
        } else {
            "printf odot-plan-auto"
        }
    }

    fn test_session(project_root: String, shell_mode: ShellMode) -> SessionRecord {
        SessionRecord {
            id: "s1".to_string(),
            parent_session_id: None,
            project_root,
            mode: AgentMode::Plan,
            provider_id: "p1".to_string(),
            title: "test".to_string(),
            status: "active".to_string(),
            shell_mode,
            total_cost: 0.0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        }
    }

    fn test_event() -> EventRecord {
        EventRecord {
            id: "e1".to_string(),
            session_id: "s1".to_string(),
            seq: 1,
            event_type: "tool.called".to_string(),
            data: json!({}),
            created_at: "now".to_string(),
        }
    }

    fn temp_project() -> PathBuf {
        let root = std::env::temp_dir().join(format!("odot-tools-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn shell_options_read_timeout_and_background() {
        let options = shell_run_options(&json!({
            "command": "npm run dev",
            "timeoutSeconds": 900,
            "background": true
        }));

        assert!(options.background);
        assert_eq!(options.timeout_seconds, MAX_SHELL_TIMEOUT_SECONDS);
    }

    #[test]
    fn shell_command_times_out() {
        let result = run_shell_command(".", slow_command(), 1).unwrap();

        assert_eq!(result["timedOut"], true);
        assert_ne!(shell_exit_code(&result), 0);
    }

    #[test]
    fn auto_shell_allows_allowlisted_prefixes() {
        let policy = policy(&["npm run typecheck", "cargo test", "cd"]);

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
        assert!(!shell_needs_approval(
            "cd System",
            &ShellMode::Auto,
            &policy
        ));
    }

    #[test]
    fn auto_shell_normalizes_allowlisted_prefixes() {
        let policy = policy(&["npm   run   typecheck"]);

        assert!(!shell_needs_approval(
            "NPM RUN TYPECHECK -- --pretty false",
            &ShellMode::Auto,
            &policy
        ));
    }

    #[test]
    fn plan_shell_auto_runs_allowlisted_command() {
        let conn = Connection::open_in_memory().unwrap();
        let session = test_session(".".to_string(), ShellMode::Auto);
        let call = ToolCallRequest {
            tool_call_id: None,
            name: "shell".to_string(),
            input: json!({
                "command": echo_command(),
                "timeoutSeconds": 3
            }),
        };
        let policy = policy(&[echo_command()]);
        let event = test_event();

        let result = execute_tool_inner(
            &conn,
            &session,
            &ShellMode::Auto,
            &policy,
            &call,
            &event,
            ToolExecutionMode::Plan,
        )
        .unwrap();

        match result {
            ToolRun::Success(data) => {
                assert_eq!(data["exitCode"], 0);
                assert!(data["stdout"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("odot-plan-auto"));
            }
            ToolRun::Pending(_) => {
                panic!("allowlisted auto shell command should not require approval")
            }
            ToolRun::Failure(data) => panic!("allowlisted auto shell command failed: {data:?}"),
        }
    }

    #[test]
    fn ask_mode_can_run_read_tool() {
        let root = temp_project();
        fs::write(root.join("note.txt"), "ask can inspect").unwrap();
        let root = fs::canonicalize(root).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        let session = test_session(root.to_string_lossy().to_string(), ShellMode::Manual);
        let call = ToolCallRequest {
            tool_call_id: None,
            name: "read".to_string(),
            input: json!({ "path": "note.txt" }),
        };
        let event = test_event();

        let result = execute_tool_inner(
            &conn,
            &session,
            &ShellMode::Manual,
            &policy(&[]),
            &call,
            &event,
            ToolExecutionMode::Ask,
        )
        .unwrap();

        match result {
            ToolRun::Success(data) => {
                assert_eq!(data["path"], "note.txt");
                assert!(data["content"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("ask can inspect"));
            }
            other => panic!("ask mode read should succeed, got {other:?}"),
        }
    }

    #[test]
    fn ask_mode_blocks_code_mutation_tools() {
        let conn = Connection::open_in_memory().unwrap();
        let session = test_session(".".to_string(), ShellMode::Manual);
        let call = ToolCallRequest {
            tool_call_id: None,
            name: "write".to_string(),
            input: json!({ "path": "note.txt", "content": "mutate" }),
        };
        let event = test_event();

        let result = execute_tool_inner(
            &conn,
            &session,
            &ShellMode::Manual,
            &policy(&[]),
            &call,
            &event,
            ToolExecutionMode::Ask,
        )
        .unwrap();

        match result {
            ToolRun::Failure(data) => {
                assert_eq!(data["blocked"], true);
                assert!(data["reason"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("问答模式禁止执行 write"));
            }
            other => panic!("ask mode write should be blocked, got {other:?}"),
        }
    }

    #[test]
    fn invalid_tool_returns_failure_without_pending_permission() {
        let conn = Connection::open_in_memory().unwrap();
        let session = test_session(".".to_string(), ShellMode::Auto);
        let call = ToolCallRequest {
            tool_call_id: None,
            name: "invalid".to_string(),
            input: json!({
                "tool": "shell",
                "error": "expected `,` or `}`",
                "arguments": "{\"command\":\"npm test\"<parameter>"
            }),
        };
        let policy = policy(&[]);
        let event = test_event();

        let result = execute_tool_inner(
            &conn,
            &session,
            &ShellMode::Auto,
            &policy,
            &call,
            &event,
            ToolExecutionMode::Agent,
        )
        .unwrap();

        match result {
            ToolRun::Failure(data) => {
                assert_eq!(data["invalid"], true);
                assert_eq!(data["tool"], "shell");
                assert!(data["message"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("The arguments provided to the tool are invalid"));
            }
            other => panic!("invalid tool should return failure, got {other:?}"),
        }
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
