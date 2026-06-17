use crate::{
    config_file, provider, storage, tools,
    types::{AgentMode, ContextSummaryRecord, ModelTurn, SessionEventsResponse, SubmitPromptInput},
    util,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::AppHandle;

const MAX_STEPS: usize = 25;
const RECENT_EVENT_LIMIT: usize = 36;
const AUTO_COMPACT_EVENT_THRESHOLD: usize = 80;

pub async fn submit_prompt(
    app: &AppHandle,
    conn: &Connection,
    input: SubmitPromptInput,
) -> Result<SessionEventsResponse, String> {
    let session = storage::get_session(conn, &input.session_id)?;

    storage::append_event(
        conn,
        &session.id,
        "prompt.submitted",
        json!({
            "prompt": input.prompt
        }),
    )?;
    maybe_auto_compact(conn, &session.id)?;

    run_session_steps(app, conn, &session, &input.prompt).await
}

pub async fn continue_session(
    app: &AppHandle,
    conn: &Connection,
    session_id: String,
) -> Result<SessionEventsResponse, String> {
    let session = storage::get_session(conn, &session_id)?;
    run_session_steps(
        app,
        conn,
        &session,
        "Continue from the latest tool result. Inspect recent tool success/failure output, then either call the next needed tool or provide the final user-facing answer.",
    )
    .await
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

        let system_prompt = build_system_prompt(session.mode.as_str());
        let user_prompt = build_user_prompt(conn, &session.id, current_prompt)?;
        let request_config = match config_file::load_provider_request_config(
            app,
            &session.project_root,
            &session.provider_id,
        ) {
            Ok(value) => value,
            Err(error) => {
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
        let raw_response =
            match provider::complete(&request_config, &system_prompt, &user_prompt).await {
                Ok(value) => value,
                Err(error) => {
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

        let turn = match parse_model_turn(&raw_response) {
            Ok(value) => value,
            Err(error) => {
                storage::append_event(
                    conn,
                    &session.id,
                    "step.failed",
                    json!({
                        "step": step_index,
                        "error": error,
                        "rawResponse": raw_response
                    }),
                )?;
                return Err(error);
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
                for call in &turn.tool_calls {
                    let outcome = tools::execute_tool_with_mode(
                        conn,
                        &session,
                        &session.shell_mode,
                        call,
                        tools::ToolExecutionMode::Plan,
                    )?;
                    has_pending |= outcome.pending;
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
                for call in &turn.tool_calls {
                    let outcome = tools::execute_tool(conn, &session, &session.shell_mode, call)?;
                    has_pending |= outcome.pending;
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

fn build_system_prompt(mode: &str) -> String {
    let shell_environment = shell_environment_prompt();
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
      "name": "read|search|edit|write|delete|shell",
      "input": {{}}
    }}
  ],
  "done": false
}}

Tool inputs:
- read: {{"path":"relative/path"}}
- search: {{"query":"text"}}
- edit: {{"path":"relative/path","oldString":"exact text","newString":"replacement text"}}
- write: {{"path":"relative/path","content":"complete file content","expectedHash":"optional sha256"}}
- delete: {{"path":"relative/path"}}
- shell: {{"command":"test/lint/build command"}}

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

    let event_lines = events
        .iter()
        .map(|event| {
            format!(
                "#{} {} {}",
                event.seq,
                event.event_type,
                compact_json(&event.data)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    Ok(format!(
        "Current user prompt:\n{current_prompt}\n\nCompressed context:\n{summary}\n\nRecent event timeline:\n{event_lines}"
    ))
}

fn parse_model_turn(raw_response: &str) -> Result<ModelTurn, String> {
    let json_text = util::extract_json_object(raw_response)?;
    serde_json::from_str(&json_text)
        .map_err(|error| format!("模型响应不符合工具调用 JSON 协议: {error}"))
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
