use crate::{
    config_file,
    llm_runtime::{sanitize_assistant_content, LlmStreamEvent},
    provider, storage, tools,
    types::{
        AgentMode, ContextSummaryRecord, EventRecord, ModelTurn, PromptAttachment,
        PromptAttachmentKind, PromptSessionInput, ProviderPricing, ProviderRequestConfig,
        SessionEventsResponse, SessionInputDelivery, SubmitPromptInput, ToolMode,
    },
    util,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::AppHandle;

const MAX_STEPS: usize = 25;
const RECENT_EVENT_LIMIT: usize = 80;
const RECENT_EVENT_CHAR_BUDGET: usize = 48_000;
const RECENT_EVENT_MIN_KEEP: usize = 12;
const AUTO_COMPACT_EVENT_THRESHOLD: usize = 80;
const STREAM_DELTA_FLUSH_CHARS: usize = 96;
const STREAM_DELTA_FLUSH_MS: u64 = 120;
const COMPACTION_PROMPT: &str = r#"请对以下对话历史生成结构化摘要，包含以下部分：
- Goal: 用户的核心目标
- Constraints: 已确认的约束和限制
- Progress: 已完成的工作
- Decisions: 做出的关键决策及理由
- Next Steps: 待完成的下一步

要求：
- 只保留后续继续任务必需的信息。
- 保留文件路径、命令、错误、决策和未完成事项。
- 不要编造未在历史中出现的事实。

对话历史：
{messages}"#;

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
            attachments: input.attachments,
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
        &input.attachments,
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
                "attachments": attachment_summaries(&input.attachments),
                "delivery": input.delivery
            }),
        )?;
        storage::mark_session_input_promoted(conn, &input.id, &event.id)?;
        input.prompt
    } else {
        "Continue from the latest tool result. Inspect recent tool success/failure output, then either call the next needed tool or provide the final user-facing answer.".to_string()
    };

    // Load provider config for token-based overflow detection.
    let request_config =
        config_file::load_provider_request_config(app, &session.project_root, &session.provider_id)
            .ok();
    let context_limit = request_config
        .as_ref()
        .and_then(|rc| rc.context_token_limit);
    let output_limit = request_config.as_ref().and_then(|rc| rc.output_token_limit);
    maybe_auto_compact(
        conn,
        &session.id,
        request_config.as_ref(),
        context_limit,
        output_limit,
    )
    .await?;
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
        let native_runtime = provider::supports_native_tools(&request_config);
        let provider_id_str = provider_id_from_record(&session.provider_id);
        let system_prompt = build_system_prompt(
            session.mode.as_str(),
            native_runtime,
            &request_config.model,
            provider_id_str,
        );
        let turn = if native_runtime {
            storage::append_event(
                conn,
                &session.id,
                "llm.stream.started",
                json!({
                    "step": step_index,
                    "runtime": "rust-openai-chat",
                    "providerId": provider_id_str,
                    "model": &request_config.model
                }),
            )?;
            let stream_system_prompt = build_stream_system_prompt(
                conn,
                session,
                session.mode.as_str(),
                native_runtime,
                &request_config.model,
                provider_id_str,
            )?;
            let messages =
                build_stream_messages(conn, &session.id, &stream_system_prompt, current_prompt)?;
            let mut sink = StreamEventSink::new(
                conn,
                &session.id,
                step_index,
                &session.provider_id,
                &request_config,
            );
            let turn =
                match provider::stream_openai_compatible(&request_config, &messages, |event| {
                    sink.handle(event)
                })
                .await
                {
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
            sink.flush_all()?;
            turn
        } else {
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
            if let Some(turn) = completion.turn {
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
            }
        };

        if stop_if_cancelled(conn, &session.id, step_index)? {
            break;
        }

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
                    "step": step_index,
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
                    "step": step_index,
                    "text": message
                }),
            )?;
        }

        match session.mode {
            AgentMode::Ask => {
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
                        tools::ToolExecutionMode::Ask,
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
                        "done": turn.done
                    }),
                )?;

                if has_pending {
                    break;
                }
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

pub async fn compact_session_with_provider(
    conn: &Connection,
    session_id: &str,
    provider: &ProviderRequestConfig,
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

    let context_limit = provider.context_token_limit.unwrap_or(0);
    let max_output_tokens = provider.output_token_limit.unwrap_or(4096);
    let (head_events, tail_events) =
        split_events_for_compaction(&events, context_limit, max_output_tokens);
    let text = if head_events.is_empty() {
        "较早上下文为空；最近对话已保留原文。".to_string()
    } else {
        match compact_with_llm(&head_events, provider).await {
            Ok(summary) if !summary.trim().is_empty() => summary,
            _ => summarize_events(&head_events),
        }
    };
    let latest_seq = events.last().map(|event| event.seq).unwrap_or(0);
    let recent_event_seq = tail_events
        .first()
        .map(|event| event.seq)
        .unwrap_or(latest_seq);
    let prune_before_seq = tail_events
        .first()
        .map(|event| event.seq)
        .unwrap_or_else(|| latest_seq.saturating_add(1));
    prune_tool_outputs(conn, session_id, prune_before_seq)?;
    let summary = storage::insert_context_summary(conn, session_id, text, recent_event_seq)?;
    storage::append_event(
        conn,
        session_id,
        "context.compacted",
        json!({
            "summaryId": summary.id,
            "recentEventSeq": summary.recent_event_seq,
            "prunedBeforeEventSeq": prune_before_seq
        }),
    )?;
    Ok(summary)
}

fn is_overflow(usage: &Value, context_limit: u64, max_output_tokens: u64) -> bool {
    if context_limit == 0 {
        return false;
    }
    let reserved = if max_output_tokens > 0 {
        max_output_tokens.min(20_000)
    } else {
        4096
    };
    let usable = context_limit.saturating_sub(reserved);
    if usable == 0 {
        return false;
    }
    let total = usage_token_sum(usage);
    total >= usable
}

fn usage_token_sum(usage: &Value) -> u64 {
    if let Some(tokens) = usage.get("tokens") {
        let input = tokens.get("input").and_then(value_as_u64).unwrap_or(0);
        let output = tokens.get("output").and_then(value_as_u64).unwrap_or(0);
        let reasoning = tokens.get("reasoning").and_then(value_as_u64).unwrap_or(0);
        let cache = tokens.get("cache").unwrap_or(&Value::Null);
        let cache_read = cache.get("read").and_then(value_as_u64).unwrap_or(0);
        let cache_write = cache.get("write").and_then(value_as_u64).unwrap_or(0);
        return input + output + reasoning + cache_read + cache_write;
    }

    let input_tokens = usage_number(
        usage,
        &["inputTokens", "prompt_tokens", "input_tokens"],
        &[],
    );
    let output_tokens = usage_number(
        usage,
        &["outputTokens", "completion_tokens", "output_tokens"],
        &[],
    );
    let cache_read_tokens = usage_number(
        usage,
        &[
            "cacheReadInputTokens",
            "cachedInputTokens",
            "cache_read_input_tokens",
        ],
        &[
            &["inputTokenDetails", "cacheReadTokens"],
            &["prompt_tokens_details", "cached_tokens"],
            &["promptTokensDetails", "cachedTokens"],
        ],
    );
    let cache_write_tokens = usage_number(
        usage,
        &["cacheWriteInputTokens", "cache_write_input_tokens"],
        &[
            &["inputTokenDetails", "cacheWriteTokens"],
            &["prompt_tokens_details", "cache_write_tokens"],
            &["promptTokensDetails", "cacheWriteTokens"],
        ],
    );
    let reasoning_tokens = usage_number(
        usage,
        &["reasoningTokens", "reasoning_tokens"],
        &[
            &["outputTokenDetails", "reasoningTokens"],
            &["completion_tokens_details", "reasoning_tokens"],
            &["completionTokensDetails", "reasoningTokens"],
        ],
    );
    let input = input_tokens
        .saturating_sub(cache_read_tokens)
        .saturating_sub(cache_write_tokens);
    let output = output_tokens.saturating_sub(reasoning_tokens);
    input + output + reasoning_tokens + cache_read_tokens + cache_write_tokens
}

async fn maybe_auto_compact(
    conn: &Connection,
    session_id: &str,
    provider: Option<&ProviderRequestConfig>,
    context_token_limit: Option<u64>,
    output_token_limit: Option<u64>,
) -> Result<(), String> {
    let events = storage::list_events(conn, session_id)?;
    let summaries = storage::list_context_summaries(conn, session_id)?;
    let latest_seq = events.last().map(|event| event.seq).unwrap_or(0);
    let latest_summary_seq = summaries
        .first()
        .map(|summary| summary.recent_event_seq)
        .unwrap_or(0);

    if latest_seq.saturating_sub(latest_summary_seq) <= AUTO_COMPACT_EVENT_THRESHOLD as i64 {
        return Ok(());
    }

    if let Some(context_limit) = context_token_limit.filter(|limit| *limit > 0) {
        let latest_usage = events
            .iter()
            .rev()
            .find(|event| event.event_type == "llm.stream.finished")
            .and_then(|event| event.data.get("usage"));

        if let Some(usage) = latest_usage {
            let max_output = output_token_limit.unwrap_or(0);
            if is_overflow(usage, context_limit, max_output) {
                if let Some(provider) = provider {
                    let _ = compact_session_with_provider(conn, session_id, provider).await?;
                } else {
                    let _ = compact_session(conn, session_id)?;
                }
                return Ok(());
            }
        }
    }

    Ok(())
}

fn build_system_prompt(mode: &str, native_tools: bool, model: &str, provider_id: &str) -> String {
    let shell_environment = shell_environment_prompt();
    let model_identity = format!(
        "You are oDot, a local coding agent. You are currently running on the '{}' model (provider: '{}'). When asked about your model or which AI you are, truthfully state that you are running on this specific model.",
        model, provider_id
    );
    if native_tools {
        format!(
            r#"{model_identity}
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
ask mode: use read/search and non-mutating inspection tools when needed, but do not edit, write, or delete files. Answer the user after inspecting enough context.
plan mode: use read/search tools and approved shell commands to inspect the task, but do not edit, write, or delete files. When you have enough information, provide a concrete implementation plan as the final answer.
agent mode: use tools to read, search, edit, write, delete, and run safe verification commands.
If a tool fails or a shell command returns a non-zero exitCode, inspect stdout/stderr/error and try a corrected tool call. Do not stop after the first failed tool unless the failure is genuinely unrecoverable.
Use relative paths only and keep changes scoped to the user's request."#
        )
    } else {
        format!(
            r#"{model_identity}
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
ask mode: use read/search and non-mutating inspection tools when needed, but do not edit, write, or delete files. Answer the user after inspecting enough context.
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

fn build_stream_system_prompt(
    conn: &Connection,
    session: &crate::types::SessionRecord,
    mode: &str,
    native_tools: bool,
    model: &str,
    provider_id: &str,
) -> Result<String, String> {
    let summaries = storage::list_context_summaries(conn, &session.id)?;
    let summary = summaries
        .first()
        .map(|summary| summary.text.as_str())
        .unwrap_or("当前还没有压缩上下文。");
    Ok(format!(
        "{}\n\nProject context:\n{}\n\nCompressed context:\n{}",
        build_system_prompt(mode, native_tools, model, provider_id),
        project_context_text(&session.project_root),
        summary
    ))
}

fn build_stream_messages(
    conn: &Connection,
    session_id: &str,
    system_prompt: &str,
    current_prompt: &str,
) -> Result<Vec<Value>, String> {
    let summaries = storage::list_context_summaries(conn, session_id)?;
    let events = if let Some(summary) = summaries
        .first()
        .filter(|summary| summary.recent_event_seq > 0)
    {
        let events = storage::list_events_after(
            conn,
            session_id,
            summary.recent_event_seq.saturating_sub(1),
        )?;
        if events.is_empty() {
            storage::list_recent_events(conn, session_id, RECENT_EVENT_LIMIT)?
        } else {
            events
        }
    } else {
        storage::list_recent_events(conn, session_id, RECENT_EVENT_LIMIT)?
    };
    let tool_call_ids = provider_tool_call_ids(&events);
    let mut messages = vec![json!({
        "role": "system",
        "content": system_prompt
    })];
    let mut included_current_prompt = false;

    for event in &events {
        match event.event_type.as_str() {
            "prompt.submitted" => {
                let prompt = event
                    .data
                    .get("prompt")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let attachments = prompt_event_attachments(conn, event)?;
                if prompt.trim().is_empty() && attachments.is_empty() {
                    continue;
                }
                included_current_prompt |= prompt == current_prompt;
                messages.push(json!({
                    "role": "user",
                    "content": user_message_content(prompt, &attachments)
                }));
            }
            "assistant.message" => {
                let text = event.data.get("text").and_then(Value::as_str).unwrap_or("");
                let sanitized = sanitize_assistant_content(text);
                let text = sanitized.text.as_str();
                if text.trim().is_empty() {
                    continue;
                }
                messages.push(json!({
                    "role": "assistant",
                    "content": text
                }));
            }
            "tool.called" => {
                let name = event.data.get("name").and_then(Value::as_str).unwrap_or("");
                if name.trim().is_empty() {
                    continue;
                }
                let input = event.data.get("input").cloned().unwrap_or(Value::Null);
                let tool_call_id = tool_call_ids
                    .get(&event.id)
                    .cloned()
                    .unwrap_or_else(|| event.id.clone());
                messages.push(json!({
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": tool_call_id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string())
                        }
                    }]
                }));
            }
            "tool.success" | "tool.failed" | "tool.rejected" => {
                let local_call_id = event
                    .data
                    .get("toolCallEventId")
                    .or_else(|| event.data.get("pendingEventId"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if local_call_id.is_empty() {
                    continue;
                }
                let tool_call_id = tool_call_ids
                    .get(local_call_id)
                    .cloned()
                    .unwrap_or_else(|| local_call_id.to_string());
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": tool_result_content(event)
                }));
            }
            _ => {}
        }
    }

    if !included_current_prompt && !current_prompt.trim().is_empty() {
        messages.push(json!({
            "role": "user",
            "content": current_prompt
        }));
    }

    Ok(messages)
}

fn prompt_event_attachments(
    conn: &Connection,
    event: &EventRecord,
) -> Result<Vec<PromptAttachment>, String> {
    let Some(input_id) = event.data.get("inputId").and_then(Value::as_str) else {
        return Ok(Vec::new());
    };
    match storage::get_session_input(conn, input_id) {
        Ok(input) => Ok(input.attachments),
        Err(_) => Ok(Vec::new()),
    }
}

fn user_message_content(prompt: &str, attachments: &[PromptAttachment]) -> Value {
    if attachments.is_empty() {
        return json!(prompt);
    }

    let mut parts = Vec::new();
    let base_prompt = if prompt.trim().is_empty() {
        "请根据附件内容继续。"
    } else {
        prompt
    };
    parts.push(json!({
        "type": "text",
        "text": base_prompt
    }));

    for attachment in attachments {
        match &attachment.kind {
            PromptAttachmentKind::Text => {
                parts.push(json!({
                    "type": "text",
                    "text": format!(
                        "附件文件: {}\nMIME: {}\n大小: {} bytes\n\n{}",
                        attachment.name, attachment.mime, attachment.size, attachment.content
                    )
                }));
            }
            PromptAttachmentKind::Image => {
                parts.push(json!({
                    "type": "text",
                    "text": format!("附件图片: {} ({}, {} bytes)", attachment.name, attachment.mime, attachment.size)
                }));
                parts.push(json!({
                    "type": "image_url",
                    "image_url": {
                        "url": attachment.content
                    }
                }));
            }
        }
    }

    Value::Array(parts)
}

fn attachment_summaries(attachments: &[PromptAttachment]) -> Vec<Value> {
    attachments
        .iter()
        .map(|attachment| {
            json!({
                "name": attachment.name,
                "mime": attachment.mime,
                "size": attachment.size,
                "kind": &attachment.kind
            })
        })
        .collect()
}

fn provider_tool_call_ids(events: &[EventRecord]) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for event in events {
        if event.event_type != "tool.called" {
            continue;
        }
        let tool_call_id = event
            .data
            .get("toolCallId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(event.id.as_str());
        result.insert(event.id.clone(), tool_call_id.to_string());
    }
    result
}

fn tool_result_content(event: &EventRecord) -> String {
    match event.event_type.as_str() {
        "tool.rejected" => "Tool call rejected by user.".to_string(),
        "tool.failed" => {
            let error = event
                .data
                .get("error")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| compact_json(event.data.get("result").unwrap_or(&Value::Null)));
            truncate(&format!("Tool failed: {error}"), 12_000)
        }
        _ => truncate(
            &compact_json(event.data.get("result").unwrap_or(&Value::Null)),
            12_000,
        ),
    }
}

fn provider_id_from_record(record_id: &str) -> &str {
    record_id.split('/').next().unwrap_or(record_id)
}

fn context_usage_event_data(
    step: usize,
    provider_id: &str,
    model: &str,
    context_limit: Option<u64>,
    input_limit: Option<u64>,
    output_limit: Option<u64>,
    pricing: Option<&ProviderPricing>,
    raw_usage: Option<&Value>,
) -> Option<Value> {
    let usage = raw_usage?;
    let input_tokens = usage_number(
        usage,
        &["inputTokens", "prompt_tokens", "input_tokens"],
        &[],
    );
    let output_tokens = usage_number(
        usage,
        &["outputTokens", "completion_tokens", "output_tokens"],
        &[],
    );
    let total_tokens = usage_number(usage, &["totalTokens", "total_tokens"], &[]);
    let cache_read_tokens = usage_number(
        usage,
        &[
            "cacheReadInputTokens",
            "cachedInputTokens",
            "cache_read_input_tokens",
        ],
        &[
            &["inputTokenDetails", "cacheReadTokens"],
            &["prompt_tokens_details", "cached_tokens"],
            &["promptTokensDetails", "cachedTokens"],
        ],
    );
    let cache_write_tokens = usage_number(
        usage,
        &["cacheWriteInputTokens", "cache_write_input_tokens"],
        &[
            &["inputTokenDetails", "cacheWriteTokens"],
            &["prompt_tokens_details", "cache_write_tokens"],
            &["promptTokensDetails", "cacheWriteTokens"],
        ],
    );
    let reasoning_tokens = usage_number(
        usage,
        &["reasoningTokens", "reasoning_tokens"],
        &[
            &["outputTokenDetails", "reasoningTokens"],
            &["completion_tokens_details", "reasoning_tokens"],
            &["completionTokensDetails", "reasoningTokens"],
        ],
    );

    let input = input_tokens
        .saturating_sub(cache_read_tokens)
        .saturating_sub(cache_write_tokens);
    let output = output_tokens.saturating_sub(reasoning_tokens);
    let summed = input + output + reasoning_tokens + cache_read_tokens + cache_write_tokens;
    if total_tokens == 0 && summed == 0 {
        return None;
    }
    let total = if total_tokens > 0 {
        total_tokens
    } else {
        summed
    };
    let used_for_context = if total_tokens > 0 {
        total_tokens
    } else {
        summed
    };
    let percent = context_limit
        .filter(|limit| *limit > 0)
        .map(|limit| ((used_for_context as f64 / limit as f64) * 100.0).ceil() as u64);
    let cost = pricing
        .map(|pricing| {
            usage_cost(
                pricing,
                input,
                output,
                cache_read_tokens,
                cache_write_tokens,
            )
        })
        .unwrap_or(0.0);

    Some(json!({
        "step": step,
        "providerId": provider_id,
        "model": model,
        "source": "provider",
        "tokens": {
            "input": input,
            "output": output,
            "reasoning": reasoning_tokens,
            "cache": {
                "read": cache_read_tokens,
                "write": cache_write_tokens
            },
            "total": total,
            "source": "provider"
        },
        "contextLimit": context_limit,
        "inputLimit": input_limit,
        "outputLimit": output_limit,
        "usedForContext": used_for_context,
        "percent": percent,
        "cost": cost,
        "rawUsage": usage
    }))
}

fn usage_cost(
    pricing: &ProviderPricing,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
) -> f64 {
    ((input as f64 * pricing.input_per_million)
        + (output as f64 * pricing.output_per_million)
        + (cache_read as f64 * pricing.cache_read_per_million)
        + (cache_write as f64 * pricing.cache_write_per_million))
        / 1_000_000.0
}

fn usage_number(usage: &Value, keys: &[&str], paths: &[&[&str]]) -> u64 {
    keys.iter()
        .filter_map(|key| usage.get(*key).and_then(value_as_u64))
        .chain(paths.iter().filter_map(|path| value_at_path(usage, path)))
        .next()
        .unwrap_or(0)
}

fn value_at_path(value: &Value, path: &[&str]) -> Option<u64> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    value_as_u64(current)
}

fn value_as_u64(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|item| item.is_finite() && *item >= 0.0)
            .map(|item| item as u64)
    })
}

struct StreamEventSink<'a> {
    conn: &'a Connection,
    session_id: &'a str,
    step: usize,
    provider_id: String,
    model: String,
    context_token_limit: Option<u64>,
    input_token_limit: Option<u64>,
    output_token_limit: Option<u64>,
    pricing: ProviderPricing,
    text: HashMap<String, DeltaBuffer>,
    reasoning: HashMap<String, DeltaBuffer>,
    tools: HashMap<String, ToolDeltaBuffer>,
}

struct DeltaBuffer {
    text: String,
    last_flush: Instant,
}

struct ToolDeltaBuffer {
    text: String,
    name: Option<String>,
    last_flush: Instant,
}

impl<'a> StreamEventSink<'a> {
    fn new(
        conn: &'a Connection,
        session_id: &'a str,
        step: usize,
        provider_record_id: &str,
        provider: &ProviderRequestConfig,
    ) -> Self {
        Self {
            conn,
            session_id,
            step,
            provider_id: provider_id_from_record(provider_record_id).to_string(),
            model: provider.model.clone(),
            context_token_limit: provider.context_token_limit,
            input_token_limit: provider.input_token_limit,
            output_token_limit: provider.output_token_limit,
            pricing: provider.pricing.clone(),
            text: HashMap::new(),
            reasoning: HashMap::new(),
            tools: HashMap::new(),
        }
    }

    fn handle(&mut self, event: LlmStreamEvent) -> Result<(), String> {
        match event {
            LlmStreamEvent::TextDelta { part_id, text } => {
                Self::push_delta(&mut self.text, part_id, text);
                self.flush_ready_text()
            }
            LlmStreamEvent::ReasoningDelta { part_id, text } => {
                Self::push_delta(&mut self.reasoning, part_id, text);
                self.flush_ready_reasoning()
            }
            LlmStreamEvent::ToolInputDelta {
                tool_call_id,
                name,
                text,
            } => {
                let item = self
                    .tools
                    .entry(tool_call_id)
                    .or_insert_with(|| ToolDeltaBuffer {
                        text: String::new(),
                        name: None,
                        last_flush: Instant::now(),
                    });
                if name.is_some() {
                    item.name = name;
                }
                item.text.push_str(&text);
                self.flush_ready_tools()
            }
            LlmStreamEvent::Finish {
                finish_reason,
                usage,
            } => {
                self.flush_all()?;
                storage::append_event(
                    self.conn,
                    self.session_id,
                    "llm.stream.finished",
                    json!({
                        "step": self.step,
                        "finishReason": finish_reason,
                        "usage": usage.clone()
                    }),
                )?;
                if let Some(data) = context_usage_event_data(
                    self.step,
                    &self.provider_id,
                    &self.model,
                    self.context_token_limit,
                    self.input_token_limit,
                    self.output_token_limit,
                    Some(&self.pricing),
                    usage.as_ref(),
                ) {
                    let input = data["tokens"]["input"].as_u64().unwrap_or(0)
                        + data["tokens"]["cache"]["read"].as_u64().unwrap_or(0)
                        + data["tokens"]["cache"]["write"].as_u64().unwrap_or(0);
                    let output = data["tokens"]["output"].as_u64().unwrap_or(0)
                        + data["tokens"]["reasoning"].as_u64().unwrap_or(0);
                    let cost = data.get("cost").and_then(Value::as_f64).unwrap_or(0.0);
                    storage::add_session_usage(self.conn, self.session_id, input, output, cost)?;
                    storage::append_event(self.conn, self.session_id, "context.usage", data)?;
                }
                Ok(())
            }
            LlmStreamEvent::ToolCall(_) => Ok(()),
        }
    }

    fn push_delta(buffers: &mut HashMap<String, DeltaBuffer>, part_id: String, text: String) {
        let item = buffers.entry(part_id).or_insert_with(|| DeltaBuffer {
            text: String::new(),
            last_flush: Instant::now(),
        });
        item.text.push_str(&text);
    }

    fn flush_ready_text(&mut self) -> Result<(), String> {
        let ready = ready_delta_keys(&self.text);
        for key in ready {
            self.flush_text(&key)?;
        }
        Ok(())
    }

    fn flush_ready_reasoning(&mut self) -> Result<(), String> {
        let ready = ready_delta_keys(&self.reasoning);
        for key in ready {
            self.flush_reasoning(&key)?;
        }
        Ok(())
    }

    fn flush_ready_tools(&mut self) -> Result<(), String> {
        let ready = self
            .tools
            .iter()
            .filter_map(|(key, item)| {
                should_flush(&item.text, item.last_flush).then(|| key.clone())
            })
            .collect::<Vec<_>>();
        for key in ready {
            self.flush_tool(&key)?;
        }
        Ok(())
    }

    fn flush_all(&mut self) -> Result<(), String> {
        let text = self.text.keys().cloned().collect::<Vec<_>>();
        for key in text {
            self.flush_text(&key)?;
        }
        let reasoning = self.reasoning.keys().cloned().collect::<Vec<_>>();
        for key in reasoning {
            self.flush_reasoning(&key)?;
        }
        let tools = self.tools.keys().cloned().collect::<Vec<_>>();
        for key in tools {
            self.flush_tool(&key)?;
        }
        Ok(())
    }

    fn flush_text(&mut self, part_id: &str) -> Result<(), String> {
        let Some(item) = self.text.get_mut(part_id) else {
            return Ok(());
        };
        if item.text.is_empty() {
            return Ok(());
        }
        let text = std::mem::take(&mut item.text);
        item.last_flush = Instant::now();
        storage::append_event(
            self.conn,
            self.session_id,
            "assistant.message.delta",
            json!({
                "step": self.step,
                "partId": part_id,
                "text": text
            }),
        )?;
        Ok(())
    }

    fn flush_reasoning(&mut self, part_id: &str) -> Result<(), String> {
        let Some(item) = self.reasoning.get_mut(part_id) else {
            return Ok(());
        };
        if item.text.is_empty() {
            return Ok(());
        }
        let text = std::mem::take(&mut item.text);
        item.last_flush = Instant::now();
        storage::append_event(
            self.conn,
            self.session_id,
            "reasoning.summary.delta",
            json!({
                "step": self.step,
                "partId": part_id,
                "text": text
            }),
        )?;
        Ok(())
    }

    fn flush_tool(&mut self, tool_call_id: &str) -> Result<(), String> {
        let Some(item) = self.tools.get_mut(tool_call_id) else {
            return Ok(());
        };
        if item.text.is_empty() {
            return Ok(());
        }
        let text = std::mem::take(&mut item.text);
        item.last_flush = Instant::now();
        storage::append_event(
            self.conn,
            self.session_id,
            "tool.input.delta",
            json!({
                "step": self.step,
                "toolCallId": tool_call_id,
                "name": &item.name,
                "text": text
            }),
        )?;
        Ok(())
    }
}

fn ready_delta_keys(buffers: &HashMap<String, DeltaBuffer>) -> Vec<String> {
    buffers
        .iter()
        .filter_map(|(key, item)| should_flush(&item.text, item.last_flush).then(|| key.clone()))
        .collect()
}

fn should_flush(text: &str, last_flush: Instant) -> bool {
    !text.is_empty()
        && (text.chars().count() >= STREAM_DELTA_FLUSH_CHARS
            || last_flush.elapsed() >= Duration::from_millis(STREAM_DELTA_FLUSH_MS))
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
    let current_prompt = text_runtime_prompt_with_attachments(conn, &events, current_prompt)?;

    Ok(format!(
        "Current user prompt:\n{current_prompt}\n\nProject context:\n{project_context}\n\nCompressed context:\n{summary}\n\nRecent event timeline:\n{event_lines}"
    ))
}

fn text_runtime_prompt_with_attachments(
    conn: &Connection,
    events: &[EventRecord],
    current_prompt: &str,
) -> Result<String, String> {
    let Some(event) = events.iter().rev().find(|event| {
        event.event_type == "prompt.submitted"
            && event
                .data
                .get("prompt")
                .and_then(Value::as_str)
                .map(|prompt| prompt == current_prompt)
                .unwrap_or(false)
    }) else {
        return Ok(current_prompt.to_string());
    };
    let attachments = prompt_event_attachments(conn, event)?;
    if attachments.is_empty() {
        return Ok(current_prompt.to_string());
    }
    let mut lines = vec![if current_prompt.trim().is_empty() {
        "请根据附件内容继续。".to_string()
    } else {
        current_prompt.to_string()
    }];
    lines.push("用户上传附件:".to_string());
    for attachment in attachments {
        match &attachment.kind {
            PromptAttachmentKind::Text => lines.push(format!(
                "{} ({}, {} bytes):\n{}",
                attachment.name, attachment.mime, attachment.size, attachment.content
            )),
            PromptAttachmentKind::Image => lines.push(format!(
                "{} ({}, {} bytes): [图片附件已上传，当前文本协议不内联 base64]",
                attachment.name, attachment.mime, attachment.size
            )),
        }
    }
    Ok(lines.join("\n\n"))
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
            Ok(turn) => return Ok(sanitize_model_turn(turn)),
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

fn sanitize_model_turn(mut turn: ModelTurn) -> ModelTurn {
    let Some(message) = turn.message.take() else {
        return turn;
    };
    let sanitized = sanitize_assistant_content(&message);
    turn.message = (!sanitized.text.trim().is_empty()).then_some(sanitized.text);
    if !sanitized.reasoning.trim().is_empty() {
        turn.summary = match turn.summary.take() {
            Some(summary) if !summary.trim().is_empty() => {
                Some(format!("{summary}\n\n{}", sanitized.reasoning))
            }
            _ => Some(sanitized.reasoning),
        };
    }
    turn
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

fn split_events_for_compaction(
    events: &[EventRecord],
    context_limit: u64,
    max_output_tokens: u64,
) -> (Vec<EventRecord>, Vec<EventRecord>) {
    if events.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let output_budget = if max_output_tokens > 0 {
        max_output_tokens
    } else {
        4096
    };
    let context_budget = if context_limit > 0 {
        context_limit.saturating_mul(15) / 100
    } else {
        output_budget
    };
    let preserve_budget = output_budget.min(context_budget).max(1);
    let mut used = 0_u64;
    let mut split_index = events.len();

    for (index, event) in events.iter().enumerate().rev() {
        let tokens = estimate_event_tokens(event).max(1);
        if used > 0 && used.saturating_add(tokens) > preserve_budget {
            break;
        }
        used = used.saturating_add(tokens);
        split_index = index;
    }

    (
        events[..split_index].to_vec(),
        events[split_index..].to_vec(),
    )
}

fn estimate_event_tokens(event: &EventRecord) -> u64 {
    let text = serde_json::to_string(&event.data).unwrap_or_default();
    (text.chars().count() as u64 / 4).max(1)
}

async fn compact_with_llm(
    events: &[EventRecord],
    provider: &ProviderRequestConfig,
) -> Result<String, String> {
    let messages = events
        .iter()
        .filter_map(compaction_event_line)
        .collect::<Vec<_>>()
        .join("\n");
    if messages.trim().is_empty() {
        return Ok("较早上下文没有可摘要内容。".to_string());
    }
    let user_prompt = COMPACTION_PROMPT.replace("{messages}", &truncate(&messages, 64_000));
    let mut compaction_provider = provider.clone();
    compaction_provider.tool_mode = ToolMode::Json;
    let completion = provider::complete(
        &compaction_provider,
        "你是上下文压缩器。只输出结构化摘要，不调用工具。",
        &user_prompt,
    )
    .await?;
    Ok(truncate(completion.raw_response.trim(), 24_000))
}

fn compaction_event_line(event: &EventRecord) -> Option<String> {
    let detail = match event.event_type.as_str() {
        "prompt.submitted" => event
            .data
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "assistant.message" | "assistant.message.delta" => event
            .data
            .get("text")
            .and_then(Value::as_str)
            .map(|text| sanitize_assistant_content(text).text)
            .unwrap_or_default(),
        "reasoning.summary" | "reasoning.summary.delta" => event
            .data
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "tool.called" => {
            let name = event.data.get("name").and_then(Value::as_str).unwrap_or("");
            let input = compact_json(event.data.get("input").unwrap_or(&Value::Null));
            format!("{name} input={input}")
        }
        "tool.success" | "tool.failed" | "tool.pending" | "tool.rejected" => {
            let name = event.data.get("name").and_then(Value::as_str).unwrap_or("");
            let result = tool_result_content(event);
            format!("{name} result={result}")
        }
        _ => return None,
    };
    let detail = detail.trim();
    if detail.is_empty() {
        None
    } else {
        Some(format!(
            "#{} {} {}",
            event.seq,
            event.event_type,
            truncate(detail, 2_000)
        ))
    }
}

fn prune_tool_outputs(
    conn: &Connection,
    session_id: &str,
    before_event_seq: i64,
) -> Result<(), String> {
    for event in storage::list_events(conn, session_id)? {
        if event.seq >= before_event_seq || event.event_type != "tool.success" {
            continue;
        }
        let mut data = event.data.clone();
        if let Some(object) = data.as_object_mut() {
            if object.get("result") == Some(&json!("<erased>")) {
                continue;
            }
            object.insert("result".to_string(), json!("<erased>"));
            storage::update_event_data(conn, &event.id, &data)?;
        }
    }
    Ok(())
}

fn summarize_events(events: &[crate::types::EventRecord]) -> String {
    let mut lines = vec!["本地上下文摘要:".to_string()];
    for event in events.iter().rev().take(60).rev() {
        let detail = match event.event_type.as_str() {
            "prompt.submitted" => event
                .data
                .get("prompt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            "assistant.message" => event
                .data
                .get("text")
                .and_then(Value::as_str)
                .map(|text| sanitize_assistant_content(text).text)
                .unwrap_or_default(),
            "reasoning.summary" => event
                .data
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            "tool.success" | "tool.failed" | "tool.pending" => event
                .data
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            _ => String::new(),
        };
        lines.push(format!(
            "#{} {} {}",
            event.seq,
            event.event_type,
            truncate(&detail, 500)
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
        let native = build_system_prompt("agent", true, "test-model", "test-provider");
        let json = build_system_prompt("agent", false, "test-model", "test-provider");

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
    fn provider_tool_call_ids_replay_from_tool_called_events() {
        let events = vec![
            crate::types::EventRecord {
                id: "local-call".to_string(),
                session_id: "s1".to_string(),
                seq: 1,
                event_type: "tool.called".to_string(),
                data: json!({
                    "toolCallId": "provider-call",
                    "name": "read",
                    "input": { "path": "src/main.rs" }
                }),
                created_at: "now".to_string(),
            },
            crate::types::EventRecord {
                id: "result".to_string(),
                session_id: "s1".to_string(),
                seq: 2,
                event_type: "tool.success".to_string(),
                data: json!({
                    "toolCallEventId": "local-call",
                    "name": "read",
                    "result": { "content": "ok" }
                }),
                created_at: "now".to_string(),
            },
        ];

        let ids = provider_tool_call_ids(&events);

        assert_eq!(
            ids.get("local-call").map(String::as_str),
            Some("provider-call")
        );
        assert!(tool_result_content(&events[1]).contains("ok"));
    }

    #[test]
    fn context_usage_normalizes_openai_snake_case_tokens() {
        let data = context_usage_event_data(
            3,
            "openai",
            "gpt-4.1",
            Some(128_000),
            Some(120_000),
            Some(4096),
            None,
            Some(&json!({
                "prompt_tokens": 1000,
                "completion_tokens": 250,
                "total_tokens": 1250,
                "prompt_tokens_details": { "cached_tokens": 300 },
                "completion_tokens_details": { "reasoning_tokens": 50 }
            })),
        )
        .expect("usage event");

        assert_eq!(data["tokens"]["input"], json!(700));
        assert_eq!(data["tokens"]["output"], json!(200));
        assert_eq!(data["tokens"]["reasoning"], json!(50));
        assert_eq!(data["tokens"]["cache"]["read"], json!(300));
        assert_eq!(data["tokens"]["total"], json!(1250));
        assert_eq!(data["usedForContext"], json!(1250));
        assert_eq!(data["inputLimit"], json!(120_000));
        assert_eq!(data["percent"], json!(1));
    }

    #[test]
    fn context_usage_normalizes_camel_case_tokens_without_double_counting() {
        let data = context_usage_event_data(
            1,
            "openai-compatible",
            "model",
            Some(1000),
            None,
            None,
            None,
            Some(&json!({
                "inputTokens": 600,
                "outputTokens": 300,
                "inputTokenDetails": {
                    "cacheReadTokens": 100,
                    "cacheWriteTokens": 50
                },
                "outputTokenDetails": { "reasoningTokens": 80 }
            })),
        )
        .expect("usage event");

        assert_eq!(data["tokens"]["input"], json!(450));
        assert_eq!(data["tokens"]["output"], json!(220));
        assert_eq!(data["tokens"]["reasoning"], json!(80));
        assert_eq!(data["tokens"]["cache"]["read"], json!(100));
        assert_eq!(data["tokens"]["cache"]["write"], json!(50));
        assert_eq!(data["tokens"]["total"], json!(900));
        assert_eq!(data["percent"], json!(90));
    }

    #[test]
    fn context_usage_ignores_missing_usage() {
        assert!(
            context_usage_event_data(1, "openai", "model", Some(1000), None, None, None, None)
                .is_none()
        );
        assert!(context_usage_event_data(
            1,
            "openai",
            "model",
            Some(1000),
            None,
            None,
            None,
            Some(&json!({}))
        )
        .is_none());
    }

    #[test]
    fn context_usage_calculates_pricing_cost() {
        let pricing = ProviderPricing {
            input_per_million: 2.0,
            output_per_million: 10.0,
            cache_read_per_million: 0.5,
            cache_write_per_million: 3.0,
        };
        let data = context_usage_event_data(
            1,
            "openai",
            "model",
            Some(10_000),
            None,
            None,
            Some(&pricing),
            Some(&json!({
                "inputTokens": 1000,
                "outputTokens": 200,
                "inputTokenDetails": {
                    "cacheReadTokens": 100,
                    "cacheWriteTokens": 50
                }
            })),
        )
        .expect("usage event");

        let cost = data["cost"].as_f64().unwrap();
        assert!((cost - 0.0039).abs() < f64::EPSILON);
    }

    #[test]
    fn overflow_uses_raw_provider_usage() {
        let usage = json!({
            "inputTokens": 7600,
            "outputTokens": 500,
            "inputTokenDetails": {
                "cacheReadTokens": 100,
                "cacheWriteTokens": 100
            }
        });

        assert!(is_overflow(&usage, 10_000, 2_000));
        assert!(!is_overflow(&usage, 20_000, 2_000));
    }

    #[test]
    fn split_events_for_compaction_preserves_tail_budget() {
        let events = (1..=6)
            .map(|seq| EventRecord {
                id: format!("e{seq}"),
                session_id: "s1".to_string(),
                seq,
                event_type: "assistant.message".to_string(),
                data: json!({ "text": "x".repeat(400) }),
                created_at: "now".to_string(),
            })
            .collect::<Vec<_>>();

        let (head, tail) = split_events_for_compaction(&events, 10_000, 250);

        assert!(!head.is_empty());
        assert!(!tail.is_empty());
        assert_eq!(tail.last().map(|event| event.seq), Some(6));
        assert!(head.last().unwrap().seq < tail.first().unwrap().seq);
    }

    #[test]
    fn user_message_content_keeps_image_as_image_url_part() {
        let content = user_message_content(
            "描述这张图",
            &[PromptAttachment {
                name: "screen.png".to_string(),
                mime: "image/png".to_string(),
                size: 42,
                kind: PromptAttachmentKind::Image,
                content: "data:image/png;base64,abc".to_string(),
            }],
        );

        let parts = content.as_array().expect("parts");
        assert_eq!(parts[0]["type"], json!("text"));
        assert_eq!(
            parts[1]["text"],
            json!("附件图片: screen.png (image/png, 42 bytes)")
        );
        assert_eq!(parts[2]["type"], json!("image_url"));
        assert_eq!(
            parts[2]["image_url"]["url"],
            json!("data:image/png;base64,abc")
        );
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
