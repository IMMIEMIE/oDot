use crate::{
    config_file, provider, storage, tools,
    types::{
        AgentMode, ContextSummaryRecord, ModelTurn, PromptSessionInput, SessionEventsResponse,
        SessionInputDelivery, SubmitPromptInput,
    },
    util,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use tauri::AppHandle;

const MAX_STEPS: usize = 25;
const RECENT_EVENT_LIMIT: usize = 80;
const RECENT_EVENT_CHAR_BUDGET: usize = 48_000;
const RECENT_EVENT_MIN_KEEP: usize = 12;
const AUTO_COMPACT_EVENT_THRESHOLD: usize = 80;

pub async fn submit_prompt(
    app: &AppHandle,
    conn: &Connection,
    input: SubmitPromptInput,
) -> Result<SessionEventsResponse, String> {
    prompt_session(
        app,
        conn,
        PromptSessionInput {
            id: None,
            session_id: input.session_id,
            prompt: input.prompt,
            delivery: Some(SessionInputDelivery::Queue),
            resume: true,
        },
    )
    .await
}

pub async fn prompt_session(
    app: &AppHandle,
    conn: &Connection,
    input: PromptSessionInput,
) -> Result<SessionEventsResponse, String> {
    let admitted = storage::admit_session_input(
        conn,
        input.id,
        &input.session_id,
        &input.prompt,
        input.delivery.unwrap_or(SessionInputDelivery::Queue),
        input.resume,
    )?;
    storage::append_event(
        conn,
        &admitted.session_id,
        "session.input.admitted",
        json!({
            "inputId": admitted.id,
            "delivery": admitted.delivery,
            "resume": admitted.resume
        }),
    )?;

    if admitted.resume {
        resume_session(app, conn, admitted.session_id).await
    } else {
        storage::session_events_response(conn, &admitted.session_id)
    }
}

pub async fn continue_session(
    app: &AppHandle,
    conn: &Connection,
    session_id: String,
) -> Result<SessionEventsResponse, String> {
    let session = storage::get_session(conn, &session_id)?;
    storage::set_session_status(conn, &session.id, "active")?;
    run_session_steps(
        app,
        conn,
        &session,
        "Continue from the latest tool result. Inspect recent tool success/failure output, then either call the next needed tool or provide the final user-facing answer.",
    )
    .await
}

pub async fn resume_session(
    app: &AppHandle,
    conn: &Connection,
    session_id: String,
) -> Result<SessionEventsResponse, String> {
    let run = storage::begin_session_run(conn, &session_id)?;
    let result = resume_session_inner(app, conn, &session_id).await;
    let status = if result.is_ok() {
        "completed"
    } else {
        "failed"
    };
    let _ = storage::end_session_run(conn, &run.id, status);
    result
}

async fn resume_session_inner(
    app: &AppHandle,
    conn: &Connection,
    session_id: &str,
) -> Result<SessionEventsResponse, String> {
    let session = storage::get_session(conn, session_id)?;
    storage::set_session_status(conn, &session.id, "active")?;
    let prompt = if let Some(input) = storage::next_pending_session_input(conn, &session.id)? {
        let event = storage::append_event(
            conn,
            &session.id,
            "prompt.submitted",
            json!({
                "inputId": input.id,
                "prompt": input.prompt,
                "delivery": input.delivery
            }),
        )?;
        storage::mark_session_input_promoted(conn, &input.id, &event.id)?;
        input.prompt
    } else {
        "Continue from the latest tool result. Inspect recent tool success/failure output, then either call the next needed tool or provide the final user-facing answer.".to_string()
    };
    maybe_auto_compact(conn, &session.id)?;
    run_session_steps(app, conn, &session, &prompt).await
}

async fn run_session_steps(
    app: &AppHandle,
    conn: &Connection,
    session: &crate::types::SessionRecord,
    current_prompt: &str,
) -> Result<SessionEventsResponse, String> {
    for step_index in 1..=MAX_STEPS {
        storage::append_event(
            conn,
            &session.id,
            "step.started",
            json!({
                "step": step_index
            }),
        )?;
        if stop_if_cancelled(conn, &session.id, step_index)? {
            break;
        }

        let request_config = match config_file::load_provider_request_config(
            app,
            &session.project_root,
            &session.provider_id,
        ) {
            Ok(value) => value,
            Err(error) => {
                if stop_if_cancelled(conn, &session.id, step_index)? {
                    break;
                }
                storage::append_event(
                    conn,
                    &session.id,
                    "step.failed",
                    json!({
                        "step": step_index,
                        "error": error
                    }),
                )?;
                return Err(error);
            }
        };
        let system_prompt = build_system_prompt(
            session.mode.as_str(),
            provider::supports_native_tools(&request_config),
        );
        let user_prompt = build_user_prompt(conn, &session.id, current_prompt)?;
        let completion =
            match provider::complete(&request_config, &system_prompt, &user_prompt).await {
                Ok(value) => value,
                Err(error) => {
                    if stop_if_cancelled(conn, &session.id, step_index)? {
                        break;
                    }
                    storage::append_event(
                        conn,
                        &session.id,
                        "step.failed",
                        json!({
                            "step": step_index,
                            "error": error
                        }),
                    )?;
                    return Err(error);
                }
            };

        if stop_if_cancelled(conn, &session.id, step_index)? {
            break;
        }

        let turn = if let Some(turn) = completion.turn {
            turn
        } else {
            match parse_model_turn(&completion.raw_response) {
                Ok(value) => value,
                Err(error) => {
                    storage::append_event(
                        conn,
                        &session.id,
                        "step.failed",
                        json!({
                            "step": step_index,
                            "error": error,
                            "rawResponse": completion.raw_response
                        }),
                    )?;
                    return Err(error);
                }
            }
        };

        if let Some(summary) = turn
            .summary
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            storage::append_event(
                conn,
                &session.id,
                "reasoning.summary",
                json!({
                    "text": summary
                }),
            )?;
        }

        if let Some(message) = turn
            .message
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            storage::append_event(
                conn,
                &session.id,
                "assistant.message",
                json!({
                    "text": message
                }),
            )?;
        }

        match session.mode {
            AgentMode::Ask => {
                if !turn.tool_calls.is_empty() {
                    storage::append_event(
                        conn,
                        &session.id,
                        "policy.blocked",
                        json!({
                            "reason": "问答模式是只读模式，不会执行工具",
                            "toolCalls": turn.tool_calls
                        }),
                    )?;
                }
                storage::append_event(
                    conn,
                    &session.id,
                    "step.ended",
                    json!({
                        "step": step_index,
                        "done": turn.done
                    }),
                )?;
                break;
            }
            AgentMode::Plan => {
                if turn.tool_calls.is_empty() {
                    storage::append_event(
                        conn,
                        &session.id,
                        "step.ended",
                        json!({
                            "step": step_index,
                            "done": true
                        }),
                    )?;
                    break;
                }

                let mut has_pending = false;
                let mut stopped = false;
                for call in &turn.tool_calls {
                    if stop_if_cancelled(conn, &session.id, step_index)? {
                        stopped = true;
                        break;
                    }
                    let outcome = tools::execute_tool_with_mode(
                        conn,
                        &session,
                        &session.shell_mode,
                        call,
                        tools::ToolExecutionMode::Plan,
                    )?;
                    has_pending |= outcome.pending;
                }
                if stopped {
                    break;
                }

                storage::append_event(
                    conn,
                    &session.id,
                    "step.ended",
                    json!({
                        "step": step_index,
                        "done": has_pending,
                        "pending": has_pending
                    }),
                )?;

                if has_pending {
                    break;
                }
            }
            AgentMode::Agent => {
                if turn.tool_calls.is_empty() {
                    storage::append_event(
                        conn,
                        &session.id,
                        "step.ended",
                        json!({
                            "step": step_index,
                            "done": true
                        }),
                    )?;
                    break;
                }

                let mut has_pending = false;
                let mut stopped = false;
                for call in &turn.tool_calls {
                    if stop_if_cancelled(conn, &session.id, step_index)? {
                        stopped = true;
                        break;
                    }
                    let outcome = tools::execute_tool(conn, &session, &session.shell_mode, call)?;
                    has_pending |= outcome.pending;
                }
                if stopped {
                    break;
                }

                storage::append_event(
                    conn,
                    &session.id,
                    "step.ended",
                    json!({
                        "step": step_index,
                        "done": has_pending,
                        "pending": has_pending
                    }),
                )?;

                if has_pending {
                    break;
                }
            }
        }
    }

    Ok(storage::session_events_response(conn, &session.id)?)
}

fn stop_if_cancelled(
    conn: &Connection,
    session_id: &str,
    step_index: usize,
) -> Result<bool, String> {
    if !storage::is_session_cancel_requested(conn, session_id)? {
        return Ok(false);
    }

    storage::append_event(
        conn,
        session_id,
        "agent.stopped",
        json!({
            "step": step_index,
            "reason": "用户停止了 Agent"
        }),
    )?;
    storage::append_event(
        conn,
        session_id,
        "step.ended",
        json!({
            "step": step_index,
            "done": true,
            "stopped": true
        }),
    )?;
    storage::set_session_status(conn, session_id, "active")?;
    Ok(true)
}

pub fn compact_session(
    conn: &Connection,
    session_id: &str,
) -> Result<ContextSummaryRecord, String> {
    let events = storage::list_events(conn, session_id)?;
    if events.is_empty() {
        return storage::insert_context_summary(
            conn,
            session_id,
            "当前会话还没有事件。".to_string(),
            0,
        );
    }

    let recent_event_seq = events.last().map(|event| event.seq).unwrap_or(0);
    let text = summarize_events(&events);
    let summary = storage::insert_context_summary(conn, session_id, text, recent_event_seq)?;
    storage::append_event(
        conn,
        session_id,
        "context.compacted",
        json!({
            "summaryId": summary.id,
            "recentEventSeq": summary.recent_event_seq
        }),
    )?;
    Ok(summary)
}

fn maybe_auto_compact(conn: &Connection, session_id: &str) -> Result<(), String> {
    let events = storage::list_events(conn, session_id)?;
    if events.len() < AUTO_COMPACT_EVENT_THRESHOLD {
        return Ok(());
    }

    let summaries = storage::list_context_summaries(conn, session_id)?;
    let latest_seq = events.last().map(|event| event.seq).unwrap_or(0);
    let latest_summary_seq = summaries
        .first()
        .map(|summary| summary.recent_event_seq)
        .unwrap_or(0);

    if latest_seq.saturating_sub(latest_summary_seq) > AUTO_COMPACT_EVENT_THRESHOLD as i64 {
        let _ = compact_session(conn, session_id)?;
    }

    Ok(())
}

fn build_system_prompt(mode: &str, native_tools: bool) -> String {
    let shell_environment = shell_environment_prompt();
    if native_tools {
        format!(
            r#"You are oDot, a local coding agent.
Use the provided tools for project inspection and code changes. Do not write tool calls as JSON text in your message.
Do not reveal hidden chain-of-thought. If useful, include only a short public progress note.

Tool guidance:
- read: read a relative project file.
- search: search project files.
- edit: replace exact text in an existing file. Prefer edit for code changes.
- write: create a new file or intentionally replace a whole small file. Avoid full-file rewrites for existing large files unless necessary.
- delete: delete a file.
- shell: run verification commands. Foreground commands time out by default; use background=true for long-running dev servers such as npm run dev.
- question: ask the user when blocked on an important choice.
- todo_write: publish a short task checklist.
Use read for file contents and search for project text. Do not read project files with shell commands such as Get-Content, more, cat, grep, or sed when read/search can do it.

Shell environment:
{shell_environment}

Current mode: {mode}.
ask mode: answer using current context; do not request tools.
plan mode: use read/search tools and approved shell commands to inspect the task, but do not edit, write, or delete files. When you have enough information, provide a concrete implementation plan as the final answer.
agent mode: use tools to read, search, edit, write, delete, and run safe verification commands.
If a tool fails or a shell command returns a non-zero exitCode, inspect stdout/stderr/error and try a corrected tool call. Do not stop after the first failed tool unless the failure is genuinely unrecoverable.
Use relative paths only and keep changes scoped to the user's request."#
        )
    } else {
        format!(
            r#"You are oDot, a local coding agent.
Return strict JSON only. Do not wrap the JSON in Markdown.
Do not reveal hidden chain-of-thought. Use "summary" for a short public reasoning summary.

JSON schema:
{{
  "summary": "short public reasoning summary",
  "message": "user-facing response or progress note",
  "toolCalls": [
    {{
      "name": "read|search|grep|edit|write|delete|shell|question|todo_write",
      "input": {{}}
    }}
  ],
  "done": false
}}

Tool inputs:
- read: {{"path":"relative/path"}}
- search: {{"query":"text"}}
- edit: {{"path":"relative/path","oldString":"exact text","newString":"replacement text"}}
- write: {{"path":"relative/path","content":"complete file content","expectedHash":"optional sha256"}}. Prefer edit for existing large files; use write for new files or intentional full replacement.
- delete: {{"path":"relative/path"}}
- shell: {{"command":"test/lint/build command","workdir":"optional/path","timeoutSeconds":60,"background":false,"description":"short purpose"}}. Use background=true for long-running dev servers such as npm run dev.
- question: {{"question":"short question"}}
- todo_write: {{"todos":[{{"text":"task","status":"pending|in_progress|done"}}]}}
Use read for file contents and search for project text. Do not read project files with shell commands such as Get-Content, more, cat, grep, or sed when read/search can do it.

Shell environment:
{shell_environment}

Current mode: {mode}.
ask mode: answer using current context; do not request tools.
plan mode: use read/search tools and approved shell commands to inspect the task, but do not edit, write, or delete files. When you have enough information, provide a concrete implementation plan as the final answer.
agent mode: use tools to read, search, edit, write, delete, and run safe verification commands.
If you call any tool, leave "done" false. Wait for the next turn to inspect tool results before giving the final answer.
If a tool fails or a shell command returns a non-zero exitCode, inspect stdout/stderr/error and try a corrected tool call. Do not stop after the first failed tool unless the failure is genuinely unrecoverable.
Use relative paths only and keep changes scoped to the user's request."#
        )
    }
}

fn shell_environment_prompt() -> &'static str {
    if cfg!(target_os = "windows") {
        "Host OS is Windows. Shell commands run in Windows PowerShell via powershell -NoProfile -ExecutionPolicy Bypass -Command. Prefer PowerShell commands and Windows-compatible syntax. Avoid bash-only commands such as grep, sed, rm, chmod, sudo, or here-docs unless you first verify they are available."
    } else {
        "Host OS is Unix-like. Shell commands run through sh -lc. Use POSIX-compatible commands unless the project clearly provides another shell."
    }
}

fn build_user_prompt(
    conn: &Connection,
    session_id: &str,
    current_prompt: &str,
) -> Result<String, String> {
    let events = storage::list_recent_events(conn, session_id, RECENT_EVENT_LIMIT)?;
    let summaries = storage::list_context_summaries(conn, session_id)?;
    let summary = summaries
        .first()
        .map(|summary| summary.text.as_str())
        .unwrap_or("当前还没有压缩上下文。");
    let session = storage::get_session(conn, session_id)?;
    let project_context = project_context_text(&session.project_root);

    let event_lines = recent_event_timeline(&events);

    Ok(format!(
        "Current user prompt:\n{current_prompt}\n\nProject context:\n{project_context}\n\nCompressed context:\n{summary}\n\nRecent event timeline:\n{event_lines}"
    ))
}

fn recent_event_timeline(events: &[crate::types::EventRecord]) -> String {
    let mut selected = Vec::new();
    let mut used = 0usize;
    for (index, event) in events.iter().enumerate().rev() {
        let line = format!(
            "#{} {} {}",
            event.seq,
            event.event_type,
            compact_json(&event.data)
        );
        let line_len = line.chars().count() + 1;
        let kept_from_tail = events.len().saturating_sub(index);
        if used + line_len > RECENT_EVENT_CHAR_BUDGET && kept_from_tail > RECENT_EVENT_MIN_KEEP {
            break;
        }
        used += line_len;
        selected.push(line);
    }
    selected.reverse();
    selected.join("\n")
}

fn project_context_text(project_root: &str) -> String {
    let mut lines = vec![
        format!("Host OS: {}", std::env::consts::OS),
        format!("Host arch: {}", std::env::consts::ARCH),
        format!("Project root: {project_root}"),
        format!("Local date: {}", util::now_string()),
    ];
    let root = PathBuf::from(project_root);
    for name in ["AGENTS.md", "CONTEXT.md"] {
        let path = root.join(name);
        if let Ok(content) = fs::read_to_string(&path) {
            lines.push(format!("{name}:\n{}", truncate(&content, 8_000)));
        }
    }
    truncate(&lines.join("\n\n"), 12_000)
}

fn parse_model_turn(raw_response: &str) -> Result<ModelTurn, String> {
    let json_text = util::extract_json_object(raw_response)?;
    let mut candidates = vec![json_text.clone()];
    if let Some(repaired) = repair_tool_call_done_fields(&json_text) {
        candidates.push(repaired.clone());
        if let Some(repaired_again) = repair_extra_object_before_done(&repaired) {
            candidates.push(repaired_again);
        }
    }
    if let Some(repaired) = repair_extra_object_before_done(&json_text) {
        candidates.push(repaired);
    }
    for repaired in repair_extra_object_before_tool_array_end(&json_text) {
        candidates.push(repaired);
    }

    let mut first_error = None;
    for candidate in candidates {
        match serde_json::from_str(&candidate) {
            Ok(turn) => return Ok(turn),
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error.to_string());
                }
            }
        }
    }

    Err(format!(
        "模型响应不符合工具调用 JSON 协议: {}",
        first_error.unwrap_or_else(|| "未知解析错误".to_string())
    ))
}

fn repair_extra_object_before_tool_array_end(json_text: &str) -> Vec<String> {
    let bytes = json_text.as_bytes();
    let mut repairs = Vec::new();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] != b'}' {
            index += 1;
            continue;
        }
        let close_array = skip_ascii_ws(bytes, index + 1);
        if !matches!(bytes.get(close_array), Some(b']')) {
            index += 1;
            continue;
        }
        let mut cursor = skip_ascii_ws(bytes, close_array + 1);
        if !matches!(bytes.get(cursor), Some(b',')) {
            index += 1;
            continue;
        }
        cursor += 1;
        cursor = skip_ascii_ws(bytes, cursor);
        if !bytes
            .get(cursor..)
            .map(|rest| rest.starts_with(br#""done""#))
            .unwrap_or(false)
        {
            index += 1;
            continue;
        }

        let mut repaired = String::with_capacity(json_text.len() - 1);
        repaired.push_str(&json_text[..index]);
        repaired.push_str(&json_text[index + 1..]);
        repairs.push(repaired);
        index += 1;
    }

    repairs
}

fn repair_tool_call_done_fields(json_text: &str) -> Option<String> {
    let bytes = json_text.as_bytes();
    let mut output = String::with_capacity(json_text.len());
    let mut changed = false;
    let mut last = 0;
    let mut index = 0;

    while index + 2 < bytes.len() {
        if bytes[index] == b'}' && bytes[index + 1] == b'}' {
            if let Some(done_end) = match_extra_done_field(bytes, index) {
                output.push_str(&json_text[last..index + 2]);
                last = done_end + 1;
                index = last;
                changed = true;
                continue;
            }
        }
        index += 1;
    }

    if changed {
        output.push_str(&json_text[last..]);
        Some(output)
    } else {
        None
    }
}

fn match_extra_done_field(bytes: &[u8], start: usize) -> Option<usize> {
    let mut index = start + 2;
    index = skip_ascii_ws(bytes, index);
    if *bytes.get(index)? != b',' {
        return None;
    }
    index += 1;
    index = skip_ascii_ws(bytes, index);
    if !bytes.get(index..)?.starts_with(br#""done""#) {
        return None;
    }
    index += br#""done""#.len();
    index = skip_ascii_ws(bytes, index);
    if *bytes.get(index)? != b':' {
        return None;
    }
    index += 1;
    index = skip_ascii_ws(bytes, index);
    if bytes.get(index..)?.starts_with(b"false") {
        index += b"false".len();
    } else if bytes.get(index..)?.starts_with(b"true") {
        index += b"true".len();
    } else {
        return None;
    }
    index = skip_ascii_ws(bytes, index);
    if *bytes.get(index)? == b'}' {
        Some(index)
    } else {
        None
    }
}

fn repair_extra_object_before_done(json_text: &str) -> Option<String> {
    let bytes = json_text.as_bytes();
    let mut index = bytes.len();

    while index > 0 {
        index -= 1;
        if bytes[index] != b'}' {
            continue;
        }
        if previous_non_ws(bytes, index)? != b']' {
            continue;
        }
        let mut cursor = index + 1;
        cursor = skip_ascii_ws(bytes, cursor);
        if *bytes.get(cursor)? != b',' {
            continue;
        }
        cursor += 1;
        cursor = skip_ascii_ws(bytes, cursor);
        if !bytes.get(cursor..)?.starts_with(br#""done""#) {
            continue;
        }
        cursor += br#""done""#.len();
        cursor = skip_ascii_ws(bytes, cursor);
        if *bytes.get(cursor)? != b':' {
            continue;
        }
        cursor += 1;
        cursor = skip_ascii_ws(bytes, cursor);
        if bytes.get(cursor..)?.starts_with(b"false") {
            cursor += b"false".len();
        } else if bytes.get(cursor..)?.starts_with(b"true") {
            cursor += b"true".len();
        } else {
            continue;
        }
        cursor = skip_ascii_ws(bytes, cursor);
        if *bytes.get(cursor)? != b'}' {
            continue;
        }
        cursor += 1;
        cursor = skip_ascii_ws(bytes, cursor);
        if cursor != bytes.len() {
            continue;
        }

        let mut repaired = String::with_capacity(json_text.len() - 1);
        repaired.push_str(&json_text[..index]);
        repaired.push_str(&json_text[index + 1..]);
        return Some(repaired);
    }

    None
}

fn previous_non_ws(bytes: &[u8], mut index: usize) -> Option<u8> {
    while index > 0 {
        index -= 1;
        if !matches!(bytes[index], b' ' | b'\n' | b'\r' | b'\t') {
            return Some(bytes[index]);
        }
    }
    None
}

fn skip_ascii_ws(bytes: &[u8], mut index: usize) -> usize {
    while matches!(bytes.get(index), Some(b' ' | b'\n' | b'\r' | b'\t')) {
        index += 1;
    }
    index
}

fn summarize_events(events: &[crate::types::EventRecord]) -> String {
    let mut lines = vec!["本地上下文摘要:".to_string()];
    for event in events.iter().rev().take(60).rev() {
        let detail = match event.event_type.as_str() {
            "prompt.submitted" => event
                .data
                .get("prompt")
                .and_then(Value::as_str)
                .unwrap_or(""),
            "assistant.message" | "reasoning.summary" => {
                event.data.get("text").and_then(Value::as_str).unwrap_or("")
            }
            "tool.success" | "tool.failed" | "tool.pending" => {
                event.data.get("name").and_then(Value::as_str).unwrap_or("")
            }
            _ => "",
        };
        lines.push(format!(
            "#{} {} {}",
            event.seq,
            event.event_type,
            truncate(detail, 500)
        ));
    }
    truncate(&lines.join("\n"), 24_000)
}

fn compact_json(value: &Value) -> String {
    let text = serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
    truncate(&text, 2_000)
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    let mut truncated = value.chars().take(max_chars).collect::<String>();
    truncated.push_str("...[已截断]");
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompts_prefer_shell_and_read_search() {
        let native = build_system_prompt("agent", true);
        let json = build_system_prompt("agent", false);

        assert!(native.contains("- shell: run verification commands."));
        assert!(!native.contains("bash/shell"));
        assert!(native.contains("Use read for file contents and search for project text."));
        assert!(json.contains(
            "\"name\": \"read|search|grep|edit|write|delete|shell|question|todo_write\""
        ));
        assert!(!json.contains("shell|bash"));
        assert!(json.contains("Do not read project files with shell commands"));
    }

    #[test]
    fn recent_event_timeline_respects_budget_and_keeps_recent_tail() {
        let events = (1..=80)
            .map(|seq| crate::types::EventRecord {
                id: format!("e{seq}"),
                session_id: "s1".to_string(),
                seq,
                event_type: "tool.success".to_string(),
                data: json!({ "payload": "x".repeat(4_000) }),
                created_at: "now".to_string(),
            })
            .collect::<Vec<_>>();

        let timeline = recent_event_timeline(&events);

        assert!(timeline.lines().any(|line| line.starts_with("#80 ")));
        assert!(timeline.lines().any(|line| line.starts_with("#69 ")));
        assert!(!timeline.lines().any(|line| line.starts_with("#1 ")));
        assert!(timeline.chars().count() <= RECENT_EVENT_CHAR_BUDGET);
    }

    #[test]
    fn repairs_done_field_inserted_after_tool_call() {
        let raw = r#"{
          "summary": "start",
          "message": "progress",
          "toolCalls": [
            {"name": "write", "input": {"path": "a.js", "content": "export {};\n"}},"done": false},
            {"name": "shell", "input": {"command": "npm run typecheck"}},"done": false}
          ],
          "done": false
        }"#;

        let turn = parse_model_turn(raw).expect("repaired model turn");

        assert_eq!(turn.tool_calls.len(), 2);
        assert_eq!(turn.tool_calls[0].name, "write");
        assert_eq!(turn.tool_calls[1].name, "shell");
    }

    #[test]
    fn repairs_extra_object_close_before_top_level_done() {
        let raw = r#"{
          "summary": "start",
          "message": "progress",
          "toolCalls": [
            {"name": "write", "input": {"path": "App.vue", "content": "<style>.x { color: red; }</style>"}}
          ]},"done": false}"#;

        let turn = parse_model_turn(raw).expect("repaired model turn");

        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "write");
        assert!(!turn.done);
    }

    #[test]
    fn repairs_extra_object_close_before_tool_array_end() {
        let raw = r#"{
          "summary": "start",
          "message": "progress",
          "toolCalls": [
            {"name": "write", "input": {"path": "App.vue", "content": "<template>\n  <canvas></canvas>\n</template>\n<style>\n* {\n  margin: 0;\n}\n</style>"}}
          ],
          "done": false
        }"#;
        let broken = raw.replace("}}\n          ]", "}}}\n          ]");

        let turn = parse_model_turn(&broken).expect("repaired model turn");

        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "write");
        assert_eq!(turn.tool_calls[0].input["path"], "App.vue");
        assert!(!turn.done);
    }
}
