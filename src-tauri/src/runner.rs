use crate::{
    config_file,
    error_model::{AppErrorInfo, ErrorKind},
    llm_runtime::{sanitize_assistant_content, LlmStreamEvent},
    mcp, provider, session_coordinator, skills, storage, task_registry, tools,
    types::{
        AgentMode, ContextSummaryRecord, EventRecord, McpToolDefinition, ModelTurn,
        PromptAttachment, PromptAttachmentKind, PromptSessionInput, ProviderPricing,
        ProviderRequestConfig, RecoverBackgroundTaskAction, RecoverBackgroundTaskInput,
        SessionEventsResponse, SessionInputDelivery, SubmitPromptInput, ToolCallRequest, ToolMode,
    },
    util,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tokio::time::sleep;

mod background_task;
mod compaction;
mod input_queue;
mod run_loop;

use background_task::{
    execute_agent_turn_tools, execute_turn_tool, render_background_task_prompt,
    BackgroundTaskStatus,
};
use compaction::maybe_auto_compact;
pub use compaction::{compact_session, compact_session_with_provider};
use run_loop::run_session_steps;

const STEP_CHECKPOINT_INTERVAL: usize = 25;
const MAX_ACTIVITY_STEPS: usize = 25;
const MAX_TOTAL_STEPS: usize = 250;
const MAX_CONTEXT_EVENT_LIMIT: usize = 2_000;
const RECENT_EVENT_CHAR_BUDGET: usize = 48_000;
const RECENT_EVENT_MIN_KEEP: usize = 12;
const AUTO_COMPACT_EVENT_THRESHOLD: usize = 80;
const DEFAULT_CONTEXT_TOKEN_LIMIT: u64 = 128_000;
const DEFAULT_OUTPUT_TOKEN_LIMIT: u64 = 4_096;
const TOOL_RESULT_REPLAY_CHAR_LIMIT: usize = 40_000;
const STREAM_DELTA_FLUSH_CHARS: usize = 96;
const STREAM_DELTA_FLUSH_MS: u64 = 120;
const LLM_RETRY_ATTEMPTS: usize = 3;
const LLM_RETRY_BASE_DELAY_MS: u64 = 350;
const AUTO_SESSION_TITLE: &str = "New session";
const TITLE_SYSTEM_PROMPT: &str = r#"You are a title generator. Output ONLY a thread title.

Rules:
- Use the same language as the user message.
- One line only.
- 50 characters or fewer.
- No quotes, Markdown, explanations, or punctuation-only filler.
- Focus on the user's main task or topic.
- Never mention that you are generating a title."#;
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
            loaded_skills: input.loaded_skills,
            delivery: Some(SessionInputDelivery::Queue),
            resume: true,
        },
    )
    .await
}

pub async fn prompt_session(
    app: &AppHandle,
    conn: &Connection,
    mut input: PromptSessionInput,
) -> Result<SessionEventsResponse, String> {
    merge_configured_loaded_skills(app, conn, &mut input)?;
    let admitted = input_queue::admit(conn, input)?;

    if admitted.input.resume {
        wake_session(
            app,
            conn,
            admitted.input.session_id,
            Some(admitted.event.seq),
        )
        .await
    } else {
        storage::session_events_response(conn, &admitted.input.session_id)
    }
}

async fn wake_session(
    app: &AppHandle,
    conn: &Connection,
    session_id: String,
    seq: Option<i64>,
) -> Result<SessionEventsResponse, String> {
    let lock_session_id = session_id.clone();
    session_coordinator::with_session_demand(
        &lock_session_id,
        session_coordinator::RunDemand::Wake { seq },
        wake_session_unlocked(app, conn, session_id),
    )
    .await
    .unwrap_or_else(|| storage::session_events_response(conn, &lock_session_id))
}

pub async fn continue_session(
    app: &AppHandle,
    conn: &Connection,
    session_id: String,
) -> Result<SessionEventsResponse, String> {
    let lock_session_id = session_id.clone();
    session_coordinator::with_session_demand(
        &lock_session_id,
        session_coordinator::RunDemand::Run,
        continue_session_unlocked(app, conn, session_id),
    )
    .await
    .unwrap_or_else(|| storage::session_events_response(conn, &lock_session_id))
}

async fn continue_session_unlocked(
    app: &AppHandle,
    conn: &Connection,
    session_id: String,
) -> Result<SessionEventsResponse, String> {
    let session = storage::get_session(conn, &session_id)?;
    let run = storage::begin_session_run(conn, &session.id)?;
    storage::save_session_checkpoint(
        conn,
        &session.id,
        Some(&run.id),
        "run.continued",
        None,
        "running",
        json!({
            "reason": "continue_session"
        }),
    )?;
    storage::set_session_status(conn, &session.id, "active")?;
    let result = run_session_steps(
        app,
        conn,
        &session,
        "Continue from the latest tool result. Inspect recent tool success/failure output, then either call the next needed tool or provide the final user-facing answer.",
        Some(&run.id),
    )
    .await;
    let status = if result.is_ok() {
        "completed"
    } else {
        "failed"
    };
    let _ = storage::end_session_run(conn, &run.id, status);
    if let Err(error) = &result {
        let _ = record_agent_failure(conn, &session.id, Some(&run.id), error);
    }
    result
}

pub async fn resume_session(
    app: &AppHandle,
    conn: &Connection,
    session_id: String,
) -> Result<SessionEventsResponse, String> {
    let lock_session_id = session_id.clone();
    session_coordinator::with_session_demand(
        &lock_session_id,
        session_coordinator::RunDemand::Run,
        resume_session_unlocked(app, conn, session_id),
    )
    .await
    .unwrap_or_else(|| storage::session_events_response(conn, &lock_session_id))
}

pub async fn wake_pending_session(
    app: &AppHandle,
    conn: &Connection,
    session_id: String,
) -> Result<SessionEventsResponse, String> {
    wake_session(app, conn, session_id, None).await
}

pub async fn await_session_idle(
    conn: &Connection,
    session_id: String,
) -> Result<SessionEventsResponse, String> {
    let _ = session_coordinator::await_idle(&session_id).await;
    storage::session_events_response(conn, &session_id)
}

pub fn promote_task(
    conn: &Connection,
    parent_session_id: &str,
    child_session_id: &str,
) -> Result<SessionEventsResponse, String> {
    let child = storage::get_session(conn, child_session_id)?;
    if child.parent_session_id.as_deref() != Some(parent_session_id) {
        return Err("任务不属于当前父会话。".to_string());
    }

    let already_background = storage::list_background_jobs(conn, parent_session_id)?
        .iter()
        .any(|job| {
            job.command == task_registry::task_command(child_session_id)
                && BackgroundTaskStatus::is_active(&job.status)
        });
    if already_background {
        return storage::session_events_response(conn, parent_session_id);
    }

    storage::append_event(
        conn,
        parent_session_id,
        "task.promote.requested",
        json!({
            "sessionId": child_session_id
        }),
    )?;
    if !task_registry::promote(child_session_id) {
        return Err("任务当前不可切到后台，可能已经完成或不在前台等待。".to_string());
    }

    storage::session_events_response(conn, parent_session_id)
}

pub fn cancel_session(conn: &Connection, session_id: &str) -> Result<EventRecord, String> {
    let event = storage::cancel_session(conn, session_id)?;
    session_coordinator::record_interrupt(session_id, Some(event.seq));
    Ok(event)
}

pub fn delete_queued_input(
    conn: &Connection,
    input_id: &str,
) -> Result<SessionEventsResponse, String> {
    let input = input_queue::delete_pending(conn, input_id)?;
    storage::session_events_response(conn, &input.session_id)
}

pub async fn recover_background_task(
    app: &AppHandle,
    conn: &Connection,
    input: RecoverBackgroundTaskInput,
) -> Result<SessionEventsResponse, String> {
    let job = storage::get_background_job(conn, &input.job_id)?;
    let child_session_id = task_registry::task_session_id(&job.command)
        .ok_or_else(|| "后台任务不是子任务会话。".to_string())?
        .to_string();
    match input.action {
        RecoverBackgroundTaskAction::ResumeChild => {
            storage::update_background_job_status(
                conn,
                &job.id,
                BackgroundTaskStatus::Recoverable.as_str(),
            )?;
            storage::append_event(
                conn,
                &job.session_id,
                "task.recoverable",
                json!({
                    "jobId": job.id,
                    "sessionId": child_session_id,
                    "action": "resumeChild"
                }),
            )?;
            let _ = recover_session_from_checkpoint(app, conn, child_session_id, None).await?;
            storage::session_events_response(conn, &job.session_id)
        }
        RecoverBackgroundTaskAction::Abandon => {
            storage::update_background_job_status(
                conn,
                &job.id,
                BackgroundTaskStatus::Cancelled.as_str(),
            )?;
            storage::append_event(
                conn,
                &job.session_id,
                "task.recoverable",
                json!({
                    "jobId": job.id,
                    "sessionId": child_session_id,
                    "action": "abandon"
                }),
            )?;
            storage::append_event(
                conn,
                &job.session_id,
                "task.failed",
                json!({
                    "jobId": job.id,
                    "sessionId": child_session_id,
                    "background": true,
                    "status": "abandoned",
                    "error": "Background task was abandoned during recovery."
                }),
            )?;
            storage::session_events_response(conn, &job.session_id)
        }
    }
}

async fn wake_session_unlocked(
    app: &AppHandle,
    conn: &Connection,
    session_id: String,
) -> Result<SessionEventsResponse, String> {
    let mut last_response = None;
    loop {
        if storage::next_pending_session_input(conn, &session_id)?.is_none() {
            return match last_response {
                Some(response) => Ok(response),
                None => storage::session_events_response(conn, &session_id),
            };
        }

        let response =
            run_session_from_pending_input(app, conn, &session_id, "wake_session").await?;
        last_response = Some(response);
    }
}

async fn resume_session_unlocked(
    app: &AppHandle,
    conn: &Connection,
    session_id: String,
) -> Result<SessionEventsResponse, String> {
    run_session_from_pending_input(app, conn, &session_id, "resume_session").await
}

async fn run_session_from_pending_input(
    app: &AppHandle,
    conn: &Connection,
    session_id: &str,
    reason: &str,
) -> Result<SessionEventsResponse, String> {
    let run = storage::begin_session_run(conn, session_id)?;
    storage::save_session_checkpoint(
        conn,
        session_id,
        Some(&run.id),
        "run.started",
        None,
        "running",
        json!({
            "reason": reason
        }),
    )?;
    let result = resume_session_inner(app, conn, session_id, Some(&run.id)).await;
    let status = if result.is_ok() {
        "completed"
    } else {
        "failed"
    };
    let _ = storage::end_session_run(conn, &run.id, status);
    if let Err(error) = &result {
        let _ = record_agent_failure(conn, session_id, Some(&run.id), error);
    }
    result
}

pub fn prepare_durable_recovery(conn: &Connection) -> Result<Vec<String>, String> {
    for run in storage::list_running_session_runs(conn)? {
        storage::append_event(
            conn,
            &run.session_id,
            "run.orphaned",
            json!({
                "runId": run.id,
                "startedAt": run.started_at
            }),
        )?;
    }
    storage::orphan_running_session_runs(conn)?;

    for job in storage::list_running_background_jobs(conn)? {
        if !task_registry::is_task_command(&job.command) {
            continue;
        }
        storage::update_background_job_status(
            conn,
            &job.id,
            BackgroundTaskStatus::Recoverable.as_str(),
        )?;
        let child_session_id = task_registry::task_session_id(&job.command).unwrap_or("");
        storage::append_event(
            conn,
            &job.session_id,
            "task.orphaned",
            json!({
                "jobId": job.id,
                "command": job.command,
                "sessionId": child_session_id,
                "startedAt": job.started_at
            }),
        )?;
        storage::append_event(
            conn,
            &job.session_id,
            "task.recoverable",
            json!({
                "jobId": job.id,
                "command": job.command,
                "sessionId": child_session_id,
                "startedAt": job.started_at,
                "actions": ["resumeChild", "abandon"]
            }),
        )?;
        let prompt = render_background_task_prompt(
            child_session_id,
            "Recovered background task",
            "error",
            "The app restarted while this background task was running. Its in-memory worker was lost, so the task has been marked orphaned. Inspect the child session if you need to recover its last durable state, then continue with the safest next step.",
        );
        storage::admit_session_input(
            conn,
            None,
            &job.session_id,
            &prompt,
            &[],
            &[],
            SessionInputDelivery::Queue,
            true,
        )?;
    }

    storage::list_session_ids_with_pending_input(conn)
}

pub async fn recover_session_from_checkpoint(
    app: &AppHandle,
    conn: &Connection,
    session_id: String,
    checkpoint_id: Option<String>,
) -> Result<SessionEventsResponse, String> {
    let lock_session_id = session_id.clone();
    session_coordinator::with_session_demand(
        &lock_session_id,
        session_coordinator::RunDemand::Run,
        recover_session_from_checkpoint_unlocked(app, conn, session_id, checkpoint_id),
    )
    .await
    .unwrap_or_else(|| storage::session_events_response(conn, &lock_session_id))
}

async fn recover_session_from_checkpoint_unlocked(
    app: &AppHandle,
    conn: &Connection,
    session_id: String,
    checkpoint_id: Option<String>,
) -> Result<SessionEventsResponse, String> {
    let checkpoint = if let Some(id) = checkpoint_id {
        storage::get_session_checkpoint(conn, &id)?
    } else {
        storage::latest_recoverable_checkpoint(conn, &session_id)?
            .ok_or_else(|| crate::i18n::no_recoverable_checkpoint())?
    };
    if checkpoint.session_id != session_id {
        return Err(crate::i18n::checkpoint_wrong_session());
    }

    let run = storage::begin_session_run(conn, &session_id)?;
    storage::append_event(
        conn,
        &session_id,
        "session.checkpoint.restored",
        json!({
            "checkpointId": checkpoint.id,
            "sourceRunId": checkpoint.run_id,
            "runId": run.id,
            "label": checkpoint.label,
            "step": checkpoint.step_index,
            "status": checkpoint.status
        }),
    )?;
    storage::save_session_checkpoint(
        conn,
        &session_id,
        Some(&run.id),
        "checkpoint.restored",
        checkpoint.step_index,
        "running",
        json!({
            "checkpointId": checkpoint.id,
            "label": checkpoint.label,
            "step": checkpoint.step_index
        }),
    )?;

    let session = storage::get_session(conn, &session_id)?;
    storage::set_session_status(conn, &session.id, "active")?;
    let prompt = recovery_prompt(&checkpoint);
    let result = run_session_steps(app, conn, &session, &prompt, Some(&run.id)).await;
    let status = if result.is_ok() {
        "completed"
    } else {
        "failed"
    };
    let _ = storage::end_session_run(conn, &run.id, status);
    if let Err(error) = &result {
        let _ = record_agent_failure(conn, &session_id, Some(&run.id), error);
    }
    result
}

async fn resume_session_inner(
    app: &AppHandle,
    conn: &Connection,
    session_id: &str,
    run_id: Option<&str>,
) -> Result<SessionEventsResponse, String> {
    let mut session = storage::get_session(conn, session_id)?;
    storage::set_session_status(conn, &session.id, "active")?;
    let prompt = if let Some(input) =
        input_queue::promote_next(conn, &session.id, attachment_summaries)?
    {
        input.input.prompt
    } else {
        "Continue from the latest tool result. Inspect recent tool success/failure output, then either call the next needed tool or provide the final user-facing answer.".to_string()
    };

    // Load provider config for token-based overflow detection.
    let request_config = config_file::load_provider_request_config_for_session(
        app,
        &session.project_root,
        &session.provider_id,
        session.config_path.as_deref(),
    )
    .ok();
    if let Err(error) =
        maybe_generate_session_title(conn, &session, &prompt, request_config.as_ref()).await
    {
        let _ = storage::append_event(
            conn,
            &session.id,
            "session.title.generation_failed",
            json!({ "error": error }),
        );
    }
    session = storage::get_session(conn, &session.id)?;
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
    run_session_steps(app, conn, &session, &prompt, run_id).await
}

async fn maybe_generate_session_title(
    conn: &Connection,
    session: &crate::types::SessionRecord,
    prompt: &str,
    request_config: Option<&ProviderRequestConfig>,
) -> Result<(), String> {
    let prompt_count = storage::list_events(conn, &session.id)?
        .iter()
        .filter(|event| event.event_type == "prompt.submitted")
        .count();
    if prompt_count != 1 || !is_auto_session_title(session) || prompt.trim().is_empty() {
        return Ok(());
    }
    let Some(request_config) = request_config else {
        return Ok(());
    };
    let mut title_config = request_config.clone();
    title_config.tool_mode = ToolMode::Json;
    title_config.output_token_limit = Some(title_config.output_token_limit.unwrap_or(80).min(80));
    let user_prompt = format!(
        "Generate a title for this user message:\n\n<user_message>\n{}\n</user_message>",
        truncate(prompt, 2_000)
    );
    let completion = provider::complete(&title_config, TITLE_SYSTEM_PROMPT, &user_prompt).await?;
    let title = clean_generated_title(&completion.raw_response);
    if title.is_empty() || title == session.title {
        return Ok(());
    }
    storage::update_session_title(conn, &session.id, &title)?;
    storage::append_event(
        conn,
        &session.id,
        "session.title.generated",
        json!({ "title": title }),
    )?;
    Ok(())
}

fn is_auto_session_title(session: &crate::types::SessionRecord) -> bool {
    let title = session.title.trim();
    if title == AUTO_SESSION_TITLE || title.starts_with("New session - ") {
        return true;
    }
    PathBuf::from(&session.project_root)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| title == name)
        .unwrap_or(false)
}

fn clean_generated_title(raw: &str) -> String {
    let mut title = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '`' | '#' | '*' | ' '))
        .trim()
        .to_string();
    if let Some((_, value)) = title.split_once(':') {
        if title.to_ascii_lowercase().starts_with("title:") {
            title = value.trim().to_string();
        }
    }
    let mut output = String::new();
    for ch in title.chars() {
        if output.chars().count() >= 50 {
            break;
        }
        if matches!(ch, '\r' | '\n' | '\t') {
            output.push(' ');
        } else {
            output.push(ch);
        }
    }
    output.trim().to_string()
}

async fn complete_with_retry(
    conn: &Connection,
    session_id: &str,
    step_index: usize,
    request_config: &ProviderRequestConfig,
    system_prompt: &str,
    current_prompt: &str,
    initial_user_prompt: &str,
    skill_sources: &[String],
) -> Result<provider::ProviderCompletion, String> {
    let mut last_error = None;
    let mut compacted_after_context_overflow = false;
    let mut user_prompt = initial_user_prompt.to_string();
    for attempt in 1..=LLM_RETRY_ATTEMPTS {
        match provider::complete(request_config, system_prompt, &user_prompt).await {
            Ok(value) => return Ok(value),
            Err(error) => {
                let info = AppErrorInfo::from_message(&error);
                let can_compact_retry = should_compact_retry_after_context_error(
                    &info,
                    compacted_after_context_overflow,
                    attempt,
                    false,
                );
                let can_retry =
                    (info.retryable && attempt < LLM_RETRY_ATTEMPTS) || can_compact_retry;
                storage::append_event(
                    conn,
                    session_id,
                    "llm.retry",
                    json!({
                        "step": step_index,
                        "attempt": attempt,
                        "maxAttempts": LLM_RETRY_ATTEMPTS,
                        "retrying": can_retry,
                        "compacting": can_compact_retry,
                        "error": info.to_value()
                    }),
                )?;
                if !can_retry {
                    return Err(error);
                }
                last_error = Some(error);
                if can_compact_retry {
                    let _ = compact_session_with_provider(conn, session_id, request_config).await?;
                    user_prompt = build_user_prompt(
                        conn,
                        session_id,
                        current_prompt,
                        request_config,
                        skill_sources,
                    )?;
                    compacted_after_context_overflow = true;
                    continue;
                }
                let delay_ms = LLM_RETRY_BASE_DELAY_MS * 2_u64.pow((attempt - 1) as u32);
                sleep(Duration::from_millis(delay_ms)).await;
            }
        }
    }
    Err(last_error.unwrap_or_else(crate::i18n::ai_request_failed))
}

async fn stream_openai_compatible_with_retry(
    conn: &Connection,
    session_id: &str,
    step_index: usize,
    provider_record_id: &str,
    request_config: &ProviderRequestConfig,
    mcp_tools: &[McpToolDefinition],
    stream_system_prompt: &str,
    current_prompt: &str,
    initial_messages: &[Value],
    skill_sources: &[String],
) -> Result<ModelTurn, String> {
    let mut last_error = None;
    let mut compacted_after_context_overflow = false;
    let mut messages = initial_messages.to_vec();
    for attempt in 1..=LLM_RETRY_ATTEMPTS {
        let mut sink = StreamEventSink::new(
            conn,
            session_id,
            step_index,
            provider_record_id,
            request_config,
        );
        let mut emitted_stream_event = false;
        let result =
            provider::stream_openai_compatible(request_config, &messages, mcp_tools, |event| {
                emitted_stream_event = true;
                sink.handle(event)
            })
            .await;

        match result {
            Ok(turn) => {
                sink.flush_all()?;
                return Ok(turn);
            }
            Err(error) => {
                let info = AppErrorInfo::from_message(&error);
                let can_compact_retry = should_compact_retry_after_context_error(
                    &info,
                    compacted_after_context_overflow,
                    attempt,
                    emitted_stream_event,
                );
                let can_retry = ((info.retryable && !emitted_stream_event) || can_compact_retry)
                    && attempt < LLM_RETRY_ATTEMPTS;
                storage::append_event(
                    conn,
                    session_id,
                    "llm.retry",
                    json!({
                        "step": step_index,
                        "attempt": attempt,
                        "maxAttempts": LLM_RETRY_ATTEMPTS,
                        "retrying": can_retry,
                        "compacting": can_compact_retry,
                        "error": info.to_value()
                    }),
                )?;
                if !can_retry {
                    return Err(error);
                }
                last_error = Some(error);
                if can_compact_retry {
                    let _ = compact_session_with_provider(conn, session_id, request_config).await?;
                    messages = build_stream_messages(
                        conn,
                        session_id,
                        stream_system_prompt,
                        current_prompt,
                        request_config,
                        skill_sources,
                    )?;
                    compacted_after_context_overflow = true;
                    continue;
                }
                let delay_ms = LLM_RETRY_BASE_DELAY_MS * 2_u64.pow((attempt - 1) as u32);
                sleep(Duration::from_millis(delay_ms)).await;
            }
        }
    }
    Err(last_error.unwrap_or_else(crate::i18n::ai_request_failed))
}

fn should_compact_retry_after_context_error(
    info: &AppErrorInfo,
    already_compacted: bool,
    attempt: usize,
    emitted_stream_event: bool,
) -> bool {
    info.kind == ErrorKind::ContextLimit
        && !already_compacted
        && !emitted_stream_event
        && attempt < LLM_RETRY_ATTEMPTS
}

fn record_agent_failure(
    conn: &Connection,
    session_id: &str,
    run_id: Option<&str>,
    error: &str,
) -> Result<EventRecord, String> {
    let info = AppErrorInfo::from_message(error);
    let checkpoint = storage::save_session_checkpoint(
        conn,
        session_id,
        run_id,
        "agent.failed",
        None,
        "failed",
        json!({
            "message": info.message,
            "error": info.to_value()
        }),
    )?;
    storage::set_session_status(conn, session_id, "failed")?;
    storage::append_event(
        conn,
        session_id,
        "agent.failed",
        json!({
            "runId": run_id,
            "checkpointId": checkpoint.id,
            "message": info.message,
            "error": info.to_value(),
            "recovery": {
                "canRetry": info.retryable,
                "canContinue": info.recoverable,
                "actions": info.suggested_actions
            }
        }),
    )
}

fn recovery_prompt(checkpoint: &crate::types::SessionCheckpointRecord) -> String {
    let step_text = checkpoint
        .step_index
        .map(|step| format!("step {step}"))
        .unwrap_or_else(|| crate::i18n::recent_safe_boundary().to_string());
    crate::i18n::recovery_prompt(
        &checkpoint.id,
        &checkpoint.label,
        &checkpoint.status,
        &step_text,
        &compact_json(&checkpoint.data),
    )
}

fn normalize_tool_name(name: &str) -> String {
    match name.trim().to_ascii_lowercase().as_str() {
        "todowrite" => "todo_write".to_string(),
        other => other.to_string(),
    }
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
            "reason": crate::i18n::agent_stopped_by_user()
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

fn build_system_prompt(
    mode: &str,
    native_tools: bool,
    model: &str,
    provider_id: &str,
    mcp_tools: &[McpToolDefinition],
    plan_path: Option<&str>,
) -> String {
    let shell_environment = shell_environment_prompt();
    let model_identity = format!(
        "You are oDot, a local coding agent. You are currently running on the '{}' model (provider: '{}'). When asked about your model or which AI you are, truthfully state that you are running on this specific model.",
        model, provider_id
    );
    let mode_guidance = build_mode_guidance(mode, plan_path);
    let mcp_guidance = mcp_tool_catalog_prompt(mcp_tools);
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
- todo_write: create and maintain a structured task list for visible progress. Use content, status (pending|in_progress|completed|cancelled), and priority (high|medium|low).
- task: launch an isolated subagent session for focused work. Use multiple task calls in one turn for independent parallel subtasks. Use task_id to continue an existing subagent. Use background=true only for independent long-running work; the result will be injected when ready.
- skill_list / skill_read: list and read project skills from .odot/skills.
- mcp__server__tool: call a project-configured MCP tool when available.
- plan_exit: in plan mode, request user approval to switch from planning to execution after the plan file is complete.
Use read for file contents and search for project text. Do not read project files with shell commands such as Get-Content, more, cat, grep, or sed when read/search can do it.

{mcp_guidance}

Shell environment:
{shell_environment}

Current mode: {mode}.
{mode_guidance}
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
      "name": "read|search|grep|edit|write|delete|shell|question|todo_write|task|skill_list|skill_read|mcp__server__tool|plan_exit",
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
- todo_write: {{"todos":[{{"content":"task","status":"pending|in_progress|completed|cancelled","priority":"high|medium|low"}}]}}
- task: {{"description":"short label","prompt":"detailed subtask","subagent_type":"general","task_id":"optional existing task session id","background":false}}
- skill_list: {{}}
- skill_read: {{"name":"skill name or .odot/skills/.../SKILL.md path"}}
- mcp__server__tool: use the exposed MCP tool name exactly and pass the tool's JSON arguments as input.
- plan_exit: {{}}
Use read for file contents and search for project text. Do not read project files with shell commands such as Get-Content, more, cat, grep, or sed when read/search can do it.

{mcp_guidance}

Shell environment:
{shell_environment}

Current mode: {mode}.
{mode_guidance}
If you call any tool, leave "done" false. Wait for the next turn to inspect tool results before giving the final answer.
If a tool fails or a shell command returns a non-zero exitCode, inspect stdout/stderr/error and try a corrected tool call. Do not stop after the first failed tool unless the failure is genuinely unrecoverable.
Use relative paths only and keep changes scoped to the user's request."#
        )
    }
}

fn build_mode_guidance(mode: &str, plan_path: Option<&str>) -> String {
    match mode {
        "plan" => {
            let plan_path = plan_path.unwrap_or(".odot/plans/plan.md");
            format!(
                r#"Plan mode is active. The user wants a researched implementation plan before code changes.
You MUST NOT edit, write, delete, or otherwise modify project files except for this plan file:
- {plan_path}
This plan file is the only writable file in plan mode. Build it incrementally with write/edit as you learn.

Plan workflow:
1. Initial understanding: read/search the relevant code and, when useful, launch up to 3 task subagents in parallel with focused exploration prompts. Ask a question only when a real requirement is ambiguous.
2. Design: synthesize the findings into a concrete implementation approach. Use one design-focused task subagent for non-trivial work when it would improve the plan.
3. Review: reread the critical files and check that the approach matches the user's request, constraints, and existing patterns.
4. Final plan file: write the recommended plan to {plan_path}. Include phases, files to modify, TodoWrite execution steps, risk notes, and end-to-end verification.
5. Exit planning: after the plan file is complete, call plan_exit. Do not ask "is this plan okay" with question; plan_exit requests approval.

Final user-facing response in plan mode should be brief because the authoritative plan lives in {plan_path}."#
            )
        }
        "ask" => "ask mode: use read/search and non-mutating inspection tools when needed, but do not edit, write, or delete files. Answer the user after inspecting enough context.".to_string(),
        _ => "agent mode: use tools to read, search, edit, write, delete, and run safe verification commands. For multi-step implementation, call todo_write before changing files and keep statuses current as work progresses.".to_string(),
    }
}

fn mcp_tool_catalog_prompt(mcp_tools: &[McpToolDefinition]) -> String {
    if mcp_tools.is_empty() {
        return "MCP tools: none currently available.".to_string();
    }
    let tools = mcp_tools
        .iter()
        .map(|tool| {
            format!(
                "- {}: {} inputSchema={}",
                tool.display_name,
                if tool.description.trim().is_empty() {
                    "(no description)"
                } else {
                    tool.description.trim()
                },
                truncate(&json_text(&tool.input_schema), 1_500)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "MCP tools available this turn. Call them by exact name in toolCalls/native tools:\n{tools}"
    )
}

fn shell_environment_prompt() -> &'static str {
    if cfg!(target_os = "windows") {
        "Host OS is Windows. Shell commands run in Windows PowerShell via powershell -NoProfile -ExecutionPolicy Bypass -Command. Prefer PowerShell commands and Windows-compatible syntax. Avoid bash-only commands such as grep, sed, rm, chmod, sudo, or here-docs unless you first verify they are available."
    } else {
        "Host OS is Unix-like. Shell commands run through sh -lc. Use POSIX-compatible commands unless the project clearly provides another shell."
    }
}

fn merge_configured_loaded_skills(
    app: &AppHandle,
    conn: &Connection,
    input: &mut PromptSessionInput,
) -> Result<(), String> {
    let session = storage::get_session(conn, &input.session_id)?;
    let skill_config =
        config_file::load_skill_config(app, &session.project_root, session.config_path.as_deref())?;
    if skill_config.loaded.is_empty() {
        return Ok(());
    }
    let configured = skills::resolve_loaded_skills(
        &session.project_root,
        &skill_config.loaded,
        &skill_config.sources,
    )?;
    let mut seen = input
        .loaded_skills
        .iter()
        .map(|skill| skill.path.clone())
        .collect::<HashSet<_>>();
    for skill in configured {
        if seen.insert(skill.path.clone()) {
            input.loaded_skills.push(skill);
        }
    }
    Ok(())
}

async fn runtime_mcp_tools(
    app: &AppHandle,
    project_root: &str,
    config_path: Option<&str>,
) -> (Vec<McpToolDefinition>, Vec<String>) {
    let servers = match config_file::load_mcp_server_configs(app, project_root, config_path) {
        Ok(value) => value,
        Err(error) => return (Vec::new(), vec![error]),
    };
    let mut tools = Vec::new();
    let mut errors = Vec::new();
    for server in servers.iter().filter(|server| server.enabled) {
        match mcp::list_server_tools(project_root, server).await {
            Ok(mut value) => tools.append(&mut value),
            Err(error) => errors.push(format!("{}: {error}", server.id)),
        }
    }
    (tools, errors)
}

fn build_stream_system_prompt(
    conn: &Connection,
    session: &crate::types::SessionRecord,
    mode: &str,
    native_tools: bool,
    model: &str,
    provider_id: &str,
    mcp_tools: &[McpToolDefinition],
    skill_sources: &[String],
) -> Result<String, String> {
    let summaries = storage::list_context_summaries(conn, &session.id)?;
    let summary = summaries
        .first()
        .map(|summary| summary.text.as_str())
        .unwrap_or(crate::i18n::no_compressed_context_yet());
    Ok(format!(
        "{}\n\nProject context:\n{}\n\n{}\n\nCompressed context:\n{}",
        build_system_prompt(
            mode,
            native_tools,
            model,
            provider_id,
            mcp_tools,
            if matches!(session.mode, AgentMode::Plan) {
                Some(util::plan_file_path(&session.created_at, &session.title))
            } else {
                None
            }
            .as_deref()
        ),
        project_context_text(&session.project_root),
        skills::skill_catalog_prompt_with_sources(&session.project_root, skill_sources),
        summary
    ))
}

fn load_context_events(
    conn: &Connection,
    session_id: &str,
    provider: &ProviderRequestConfig,
) -> Result<Vec<EventRecord>, String> {
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
            storage::list_recent_events(conn, session_id, MAX_CONTEXT_EVENT_LIMIT)?
        } else {
            events
        }
    } else {
        storage::list_events(conn, session_id)?
    };
    Ok(select_events_for_context(
        &events,
        provider_context_input_budget(provider),
    ))
}

fn provider_context_input_budget(provider: &ProviderRequestConfig) -> usize {
    let context_limit = provider
        .input_token_limit
        .or(provider.context_token_limit)
        .unwrap_or(DEFAULT_CONTEXT_TOKEN_LIMIT);
    let reserved_output = provider
        .output_token_limit
        .unwrap_or(DEFAULT_OUTPUT_TOKEN_LIMIT);
    let available = context_limit.saturating_sub(reserved_output);
    let budget = if available > 0 {
        available
    } else {
        context_limit.saturating_mul(3) / 4
    };
    budget.saturating_mul(9).saturating_div(10) as usize
}

fn select_events_for_context(events: &[EventRecord], token_budget: usize) -> Vec<EventRecord> {
    if events.len() <= RECENT_EVENT_MIN_KEEP {
        return events.to_vec();
    }

    let mut selected = Vec::new();
    let mut used = 0usize;
    for (index, event) in events.iter().enumerate().rev() {
        let estimated = estimate_context_tokens(&event_context_text(event));
        let kept_from_tail = events.len().saturating_sub(index);
        if selected.len() >= MAX_CONTEXT_EVENT_LIMIT {
            break;
        }
        if used + estimated > token_budget && kept_from_tail > RECENT_EVENT_MIN_KEEP {
            break;
        }
        used += estimated;
        selected.push(event.clone());
    }
    selected.reverse();
    selected
}

fn event_context_text(event: &EventRecord) -> String {
    match event.event_type.as_str() {
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
        "tool.called" => json_text(event.data.get("input").unwrap_or(&Value::Null)),
        "tool.success" | "tool.failed" | "tool.rejected" => tool_result_content(event),
        _ => compact_json(&event.data),
    }
}

fn estimate_context_tokens(text: &str) -> usize {
    let mut tokens: f64 = 0.0;
    for ch in text.chars() {
        tokens += if ch.is_ascii() { 0.25 } else { 1.0 };
    }
    tokens.ceil().max(1.0) as usize
}

fn build_stream_messages(
    conn: &Connection,
    session_id: &str,
    system_prompt: &str,
    current_prompt: &str,
    provider: &ProviderRequestConfig,
    skill_sources: &[String],
) -> Result<Vec<Value>, String> {
    let events = load_context_events(conn, session_id, provider)?;
    let tool_call_ids = provider_tool_call_ids(&events);
    let mut messages = vec![json!({
        "role": "system",
        "content": system_prompt
    })];
    let mut included_current_prompt = false;
    let mut emitted_tool_call_ids = Vec::new();

    for event in &events {
        match event.event_type.as_str() {
            "prompt.submitted" => {
                let prompt = event
                    .data
                    .get("prompt")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let attachments = prompt_event_attachments(conn, event)?;
                let loaded_skills = prompt_event_loaded_skills(conn, event)?;
                let loaded_skill_context = skills::loaded_skills_context_with_sources(
                    &storage::get_session(conn, session_id)?.project_root,
                    &loaded_skills,
                    skill_sources,
                );
                if prompt.trim().is_empty() && attachments.is_empty() && loaded_skills.is_empty() {
                    continue;
                }
                included_current_prompt |= prompt == current_prompt;
                messages.push(json!({
                    "role": "user",
                    "content": user_message_content(prompt, &attachments, &loaded_skill_context)
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
                if let Some((tool_call_id, message)) =
                    assistant_tool_call_message(event, &tool_call_ids)
                {
                    emitted_tool_call_ids.push(tool_call_id);
                    messages.push(message);
                }
            }
            "tool.pending" => {
                if let Some((tool_call_id, message)) =
                    assistant_tool_call_message(event, &tool_call_ids)
                {
                    if !emitted_tool_call_ids.iter().any(|id| id == &tool_call_id) {
                        emitted_tool_call_ids.push(tool_call_id);
                        messages.push(message);
                    }
                }
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

fn prompt_event_loaded_skills(
    conn: &Connection,
    event: &EventRecord,
) -> Result<Vec<crate::types::LoadedSkill>, String> {
    let Some(input_id) = event.data.get("inputId").and_then(Value::as_str) else {
        return Ok(Vec::new());
    };
    match storage::get_session_input(conn, input_id) {
        Ok(input) => Ok(input.loaded_skills),
        Err(_) => Ok(Vec::new()),
    }
}

fn user_message_content(
    prompt: &str,
    attachments: &[PromptAttachment],
    loaded_skill_context: &str,
) -> Value {
    if attachments.is_empty() && loaded_skill_context.trim().is_empty() {
        return json!(prompt);
    }

    let mut parts = Vec::new();
    let base_prompt = if prompt.trim().is_empty() {
        crate::i18n::continue_from_attachment_prompt()
    } else {
        prompt
    };
    parts.push(json!({
        "type": "text",
        "text": base_prompt
    }));
    if !loaded_skill_context.trim().is_empty() {
        parts.push(json!({
            "type": "text",
            "text": loaded_skill_context
        }));
    }

    for attachment in attachments {
        match &attachment.kind {
            PromptAttachmentKind::Text => {
                parts.push(json!({
                    "type": "text",
                    "text": crate::i18n::attachment_file_template(
                        &attachment.name,
                        &attachment.mime,
                        attachment.size,
                        &attachment.content,
                    )
                }));
            }
            PromptAttachmentKind::Image => {
                parts.push(json!({
                    "type": "text",
                    "text": crate::i18n::attachment_image_text(
                        &attachment.name,
                        &attachment.mime,
                        attachment.size,
                    )
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
        match event.event_type.as_str() {
            "tool.called" => {
                let tool_call_id = event
                    .data
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(event.id.as_str());
                result.insert(event.id.clone(), tool_call_id.to_string());
            }
            "tool.pending" => {
                let Some(local_call_id) = event.data.get("toolCallEventId").and_then(Value::as_str)
                else {
                    continue;
                };
                let tool_call_id = result
                    .get(local_call_id)
                    .cloned()
                    .unwrap_or_else(|| local_call_id.to_string());
                result.insert(event.id.clone(), tool_call_id);
            }
            _ => {}
        }
    }
    result
}

fn assistant_tool_call_message(
    event: &EventRecord,
    tool_call_ids: &HashMap<String, String>,
) -> Option<(String, Value)> {
    let name = event.data.get("name").and_then(Value::as_str).unwrap_or("");
    if name.trim().is_empty() {
        return None;
    }
    let input = event.data.get("input").cloned().unwrap_or(Value::Null);
    let tool_call_id = tool_call_ids
        .get(&event.id)
        .cloned()
        .unwrap_or_else(|| event.id.clone());
    Some((
        tool_call_id.clone(),
        json!({
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
        }),
    ))
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
                .unwrap_or_else(|| json_text(event.data.get("result").unwrap_or(&Value::Null)));
            truncate(
                &format!("Tool failed: {error}"),
                TOOL_RESULT_REPLAY_CHAR_LIMIT,
            )
        }
        _ => truncate(
            &json_text(event.data.get("result").unwrap_or(&Value::Null)),
            TOOL_RESULT_REPLAY_CHAR_LIMIT,
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
    provider: &ProviderRequestConfig,
    skill_sources: &[String],
) -> Result<String, String> {
    let events = load_context_events(conn, session_id, provider)?;
    let summaries = storage::list_context_summaries(conn, session_id)?;
    let summary = summaries
        .first()
        .map(|summary| summary.text.as_str())
        .unwrap_or(crate::i18n::no_compressed_context_yet());
    let session = storage::get_session(conn, session_id)?;
    let project_context = project_context_text(&session.project_root);

    let event_lines = recent_event_timeline(&events);
    let current_prompt = text_runtime_prompt_with_attachments(
        conn,
        &events,
        current_prompt,
        &session.project_root,
        skill_sources,
    )?;

    Ok(format!(
        "Current user prompt:\n{current_prompt}\n\nProject context:\n{project_context}\n\nCompressed context:\n{summary}\n\nRecent event timeline:\n{event_lines}"
    ))
}

fn text_runtime_prompt_with_attachments(
    conn: &Connection,
    events: &[EventRecord],
    current_prompt: &str,
    project_root: &str,
    skill_sources: &[String],
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
    let loaded_skills = prompt_event_loaded_skills(conn, event)?;
    let loaded_skill_context =
        skills::loaded_skills_context_with_sources(project_root, &loaded_skills, skill_sources);
    if attachments.is_empty() && loaded_skills.is_empty() {
        return Ok(current_prompt.to_string());
    }
    let mut lines = vec![if current_prompt.trim().is_empty() {
        crate::i18n::continue_from_attachment_prompt().to_string()
    } else {
        current_prompt.to_string()
    }];
    lines.push(crate::i18n::user_uploaded_attachments_header().to_string());
    for attachment in attachments {
        match &attachment.kind {
            PromptAttachmentKind::Text => lines.push(format!(
                "{} ({}, {} bytes):\n{}",
                attachment.name, attachment.mime, attachment.size, attachment.content
            )),
            PromptAttachmentKind::Image => lines.push(crate::i18n::attachment_image_replay_note(
                &attachment.name,
                &attachment.mime,
                attachment.size,
            )),
        }
    }
    if !loaded_skill_context.trim().is_empty() {
        lines.push(loaded_skill_context);
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

    Err(crate::i18n::tool_call_json_protocol_error(
        &first_error.unwrap_or_else(|| crate::i18n::unknown_parse_error().to_string()),
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

fn compact_json(value: &Value) -> String {
    let text = json_text(value);
    truncate(&text, 2_000)
}

fn json_text(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    let mut truncated = value.chars().take(max_chars).collect::<String>();
    truncated.push_str(crate::i18n::truncated_suffix());
    truncated
}

#[cfg(test)]
mod tests {
    use super::run_loop::{
        should_continue_after_step_checkpoint, step_checkpoint_continuation_prompt,
    };
    use super::*;
    use crate::runner::background_task::{
        running_background_task_job, task_background, task_optional_string,
    };
    use crate::runner::compaction::{is_overflow, split_events_for_compaction};

    #[test]
    fn system_prompts_prefer_shell_and_read_search() {
        let native = build_system_prompt("agent", true, "test-model", "test-provider", &[], None);
        let json = build_system_prompt("agent", false, "test-model", "test-provider", &[], None);

        assert!(native.contains("- shell: run verification commands."));
        assert!(native.contains("- task: launch an isolated subagent session"));
        assert!(native.contains("background=true only for independent long-running work"));
        assert!(native.contains("- plan_exit: in plan mode"));
        assert!(!native.contains("bash/shell"));
        assert!(native.contains("Use read for file contents and search for project text."));
        assert!(json.contains(
            "\"name\": \"read|search|grep|edit|write|delete|shell|question|todo_write|task|skill_list|skill_read|mcp__server__tool|plan_exit\""
        ));
        assert!(json.contains("\"background\":false"));
        assert!(json.contains("\"task_id\":\"optional existing task session id\""));
        assert!(!json.contains("shell|bash"));
        assert!(json.contains("Do not read project files with shell commands"));
    }

    #[test]
    fn task_background_accepts_background_flag() {
        assert!(task_background(&json!({ "background": true })));
        assert!(task_background(&json!({ "runInBackground": true })));
        assert!(!task_background(&json!({ "background": false })));
        assert!(!task_background(&json!({})));
    }

    #[test]
    fn task_optional_string_accepts_task_id_aliases() {
        assert_eq!(
            task_optional_string(&json!({ "task_id": " child-1 " }), &["task_id", "taskId"]),
            Some("child-1".to_string())
        );
        assert_eq!(
            task_optional_string(&json!({ "taskId": "child-2" }), &["task_id", "taskId"]),
            Some("child-2".to_string())
        );
        assert_eq!(
            task_optional_string(&json!({}), &["task_id", "taskId"]),
            None
        );
    }

    #[test]
    fn running_background_task_job_reuses_only_active_task_job() {
        let conn = Connection::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        conn.execute(
            "INSERT INTO session (id, project_root, mode, provider_id, title, status, shell_mode, created_at, updated_at)
             VALUES ('parent-1', 'E:/oDot', 'agent', 'p1', 'Parent', 'active', 'auto', '1', '1')",
            [],
        )
        .unwrap();
        let command = task_registry::task_command("child-1");
        let completed =
            storage::insert_background_job(&conn, "parent-1", &command, "E:/oDot", 0, None)
                .unwrap();
        storage::update_background_job_status(
            &conn,
            &completed.id,
            BackgroundTaskStatus::Completed.as_str(),
        )
        .unwrap();
        let recoverable =
            storage::insert_background_job(&conn, "parent-1", &command, "E:/oDot", 0, None)
                .unwrap();
        storage::update_background_job_status(
            &conn,
            &recoverable.id,
            BackgroundTaskStatus::Recoverable.as_str(),
        )
        .unwrap();
        let running =
            storage::insert_background_job(&conn, "parent-1", &command, "E:/oDot", 0, None)
                .unwrap();

        let found = running_background_task_job(&conn, "parent-1", "child-1")
            .unwrap()
            .unwrap();

        assert_eq!(found.id, running.id);
    }

    #[test]
    fn durable_recovery_marks_running_task_job_recoverable_and_notifies_parent() {
        let conn = Connection::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        conn.execute(
            "INSERT INTO session (id, project_root, mode, provider_id, title, status, shell_mode, created_at, updated_at)
             VALUES ('parent-1', 'E:/oDot', 'agent', 'p1', 'Parent', 'active', 'auto', '1', '1'),
                    ('child-1', 'E:/oDot', 'agent', 'p1', 'Child', 'active', 'auto', '1', '1')",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE session SET parent_session_id = 'parent-1' WHERE id = 'child-1'",
            [],
        )
        .unwrap();
        let job = storage::insert_background_job(
            &conn,
            "parent-1",
            &task_registry::task_command("child-1"),
            "E:/oDot",
            0,
            None,
        )
        .unwrap();

        let sessions = prepare_durable_recovery(&conn).unwrap();
        let recovered_job = storage::get_background_job(&conn, &job.id).unwrap();
        let events = storage::list_events(&conn, "parent-1").unwrap();
        let inputs = storage::list_session_inputs(&conn, "parent-1").unwrap();

        assert_eq!(sessions, vec!["parent-1".to_string()]);
        assert_eq!(recovered_job.status, "recoverable");
        assert!(events
            .iter()
            .any(|event| event.event_type == "task.recoverable"));
        assert!(inputs.iter().any(|input| input.status == "pending"));
    }

    #[test]
    fn context_limit_errors_trigger_one_compaction_retry_before_stream_output() {
        let info = AppErrorInfo::from_message("context_length_exceeded: too many tokens");

        assert!(should_compact_retry_after_context_error(
            &info, false, 1, false
        ));
        assert!(!should_compact_retry_after_context_error(
            &info, true, 1, false
        ));
        assert!(!should_compact_retry_after_context_error(
            &info, false, 1, true
        ));
        assert!(!should_compact_retry_after_context_error(
            &info,
            false,
            LLM_RETRY_ATTEMPTS,
            false
        ));
    }

    #[test]
    fn step_checkpoint_can_continue_long_running_work() {
        assert!(should_continue_after_step_checkpoint(
            STEP_CHECKPOINT_INTERVAL,
            false
        ));
        assert!(should_continue_after_step_checkpoint(
            STEP_CHECKPOINT_INTERVAL * 2,
            false
        ));
        assert!(!should_continue_after_step_checkpoint(
            STEP_CHECKPOINT_INTERVAL - 1,
            false
        ));
        assert!(!should_continue_after_step_checkpoint(
            STEP_CHECKPOINT_INTERVAL,
            true
        ));
        assert!(!should_continue_after_step_checkpoint(
            MAX_TOTAL_STEPS,
            false
        ));
        assert!(
            step_checkpoint_continuation_prompt(STEP_CHECKPOINT_INTERVAL)
                .contains("continue working with the next needed tool call")
        );
    }

    #[test]
    fn plan_prompt_mentions_plan_file_and_exit_tool() {
        let prompt = build_system_prompt(
            "plan",
            true,
            "test-model",
            "test-provider",
            &[],
            Some(".odot/plans/123-plan.md"),
        );

        assert!(prompt.contains(".odot/plans/123-plan.md"));
        assert!(prompt.contains("Plan workflow:"));
        assert!(prompt.contains("call plan_exit"));
        assert!(prompt.contains("only writable file"));
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
    fn context_selection_uses_token_budget_not_fixed_event_count() {
        let events = (1..=120)
            .map(|seq| EventRecord {
                id: format!("e{seq}"),
                session_id: "s1".to_string(),
                seq,
                event_type: "prompt.submitted".to_string(),
                data: json!({ "prompt": format!("remember item {seq}") }),
                created_at: "now".to_string(),
            })
            .collect::<Vec<_>>();

        let selected = select_events_for_context(&events, 10_000);

        assert_eq!(selected.len(), 120);
        assert_eq!(selected.first().map(|event| event.seq), Some(1));
        assert_eq!(selected.last().map(|event| event.seq), Some(120));
    }

    #[test]
    fn tool_result_content_replays_more_than_compact_json_preview() {
        let content = "a".repeat(6_000);
        let event = EventRecord {
            id: "result".to_string(),
            session_id: "s1".to_string(),
            seq: 1,
            event_type: "tool.success".to_string(),
            data: json!({
                "name": "read",
                "result": {
                    "path": "src/main.rs",
                    "content": content
                }
            }),
            created_at: "now".to_string(),
        };

        let replay = tool_result_content(&event);

        assert!(replay.contains(&"a".repeat(5_000)));
        assert!(!replay.contains("已截断"));
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
                id: "pending-call".to_string(),
                session_id: "s1".to_string(),
                seq: 2,
                event_type: "tool.pending".to_string(),
                data: json!({
                    "toolCallEventId": "local-call",
                    "name": "shell",
                    "input": { "command": "npm run build" },
                    "pending": { "command": "npm run build" }
                }),
                created_at: "now".to_string(),
            },
            crate::types::EventRecord {
                id: "result".to_string(),
                session_id: "s1".to_string(),
                seq: 3,
                event_type: "tool.success".to_string(),
                data: json!({
                    "pendingEventId": "pending-call",
                    "name": "shell",
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
        assert_eq!(
            ids.get("pending-call").map(String::as_str),
            Some("provider-call")
        );
        assert!(tool_result_content(&events[2]).contains("ok"));
    }

    #[test]
    fn pending_tool_can_replay_assistant_call_when_original_call_was_pruned() {
        let event = EventRecord {
            id: "pending-call".to_string(),
            session_id: "s1".to_string(),
            seq: 1,
            event_type: "tool.pending".to_string(),
            data: json!({
                "toolCallEventId": "local-call",
                "name": "shell",
                "input": { "command": "npm run build" },
                "pending": { "command": "npm run build" }
            }),
            created_at: "now".to_string(),
        };
        let events = vec![event.clone()];
        let ids = provider_tool_call_ids(&events);
        let (tool_call_id, message) =
            assistant_tool_call_message(&event, &ids).expect("assistant tool call");

        assert_eq!(tool_call_id, "local-call");
        assert_eq!(message["tool_calls"][0]["id"], json!("local-call"));
        assert_eq!(message["tool_calls"][0]["function"]["name"], json!("shell"));
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
            "",
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
