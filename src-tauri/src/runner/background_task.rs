use super::*;
use futures_util::future::{select, Either};

const BACKGROUND_TASK_STARTED: &str = "The task is running in the background. You will be notified automatically when it finishes. Continue only with work that does not duplicate that task.";
const BACKGROUND_TASK_UPDATED: &str = "Additional context was sent to the running background task. You will be notified automatically when it finishes. Continue only with work that does not duplicate that task.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackgroundTaskStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    Orphaned,
    Recoverable,
}

impl BackgroundTaskStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Orphaned => "orphaned",
            Self::Recoverable => "recoverable",
        }
    }

    pub(crate) fn from_str(value: &str) -> Option<Self> {
        match value {
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            "orphaned" => Some(Self::Orphaned),
            "recoverable" => Some(Self::Recoverable),
            _ => None,
        }
    }

    pub(crate) fn is_active(value: &str) -> bool {
        Self::from_str(value) == Some(Self::Running)
    }

    pub(crate) fn is_cancelled(value: &str) -> bool {
        Self::from_str(value) == Some(Self::Cancelled)
    }

    pub(crate) fn is_terminal(value: &str) -> bool {
        matches!(
            Self::from_str(value),
            Some(Self::Completed | Self::Failed | Self::Cancelled)
        )
    }
}

pub(super) async fn execute_turn_tool(
    app: &AppHandle,
    conn: &Connection,
    session: &crate::types::SessionRecord,
    call: &ToolCallRequest,
    mode: tools::ToolExecutionMode,
) -> Result<tools::ToolOutcome, String> {
    if normalize_tool_name(&call.name) == "task" {
        if mode == tools::ToolExecutionMode::Ask {
            return execute_task_blocked(conn, session, call);
        }
        execute_task_tool(app, conn, session, call).await
    } else {
        tools::execute_tool_with_mode(app, conn, session, &session.shell_mode, call, mode).await
    }
}

fn execute_task_blocked(
    conn: &Connection,
    session: &crate::types::SessionRecord,
    call: &ToolCallRequest,
) -> Result<tools::ToolOutcome, String> {
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
    storage::append_event(
        conn,
        &session.id,
        "tool.failed",
        json!({
            "toolCallEventId": called.id,
            "name": call.name,
            "result": {
                "blocked": true,
                "reason": crate::i18n::task_blocked_in_current_mode()
            }
        }),
    )?;
    Ok(tools::ToolOutcome { pending: false })
}

struct TaskRun {
    called_event_id: String,
    call_name: String,
    child_id: String,
    description: String,
    subagent_type: String,
    handle: tauri::async_runtime::JoinHandle<Result<SessionEventsResponse, String>>,
}

pub(super) async fn execute_agent_turn_tools(
    app: &AppHandle,
    conn: &Connection,
    session: &crate::types::SessionRecord,
    calls: &[ToolCallRequest],
) -> Result<bool, String> {
    let mut has_pending = false;
    let mut task_runs = Vec::new();
    for call in calls {
        if normalize_tool_name(&call.name) == "task" {
            let task = start_task_tool(app, conn, session, call)?;
            if task_background(&call.input) {
                if let Some(job) = running_background_task_job(conn, &session.id, &task.child_id)? {
                    mark_task_tool_background_updated(conn, &session.id, &task, &job.id)?;
                    detach_task_extension(task);
                } else {
                    let job_id = mark_task_tool_background_started(conn, &session.id, &task)?;
                    detach_task_tool(app.clone(), session.id.clone(), task, job_id);
                }
            } else {
                task_runs.push(task);
            }
        } else {
            let outcome = tools::execute_tool(app, conn, session, &session.shell_mode, call).await?;
            has_pending |= outcome.pending;
        }
    }
    for task in task_runs {
        let outcome = finish_task_tool(app, conn, &session.id, task).await?;
        has_pending |= outcome.pending;
    }
    Ok(has_pending)
}

async fn execute_task_tool(
    app: &AppHandle,
    conn: &Connection,
    session: &crate::types::SessionRecord,
    call: &ToolCallRequest,
) -> Result<tools::ToolOutcome, String> {
    let task = start_task_tool(app, conn, session, call)?;
    if task_background(&call.input) {
        if let Some(job) = running_background_task_job(conn, &session.id, &task.child_id)? {
            mark_task_tool_background_updated(conn, &session.id, &task, &job.id)?;
            detach_task_extension(task);
        } else {
            let job_id = mark_task_tool_background_started(conn, &session.id, &task)?;
            detach_task_tool(app.clone(), session.id.clone(), task, job_id);
        }
        return Ok(tools::ToolOutcome { pending: false });
    }
    finish_task_tool(app, conn, &session.id, task).await
}

fn start_task_tool(
    app: &AppHandle,
    conn: &Connection,
    session: &crate::types::SessionRecord,
    call: &ToolCallRequest,
) -> Result<TaskRun, String> {
    let description =
        task_string(&call.input, &["description"]).unwrap_or_else(|_| "Subagent task".to_string());
    let prompt = task_string(&call.input, &["prompt", "task"])?;
    let subagent_type = task_string(&call.input, &["subagent_type", "subagentType"])
        .unwrap_or_else(|_| "general".to_string());
    let requested_child_id = task_optional_string(&call.input, &["task_id", "taskId"]);
    let child = if let Some(child_id) = requested_child_id {
        let child = storage::get_session(conn, &child_id)?;
        if child.parent_session_id.as_deref() != Some(session.id.as_str()) {
            return Err("task_id 不属于当前父会话。".to_string());
        }
        child
    } else {
        let child_title = format!("{description} (@{subagent_type} subagent)");
        storage::create_child_session(conn, session, &child_title)?
    };
    let called = storage::append_event(
        conn,
        &session.id,
        "tool.called",
        json!({
            "toolCallId": call.tool_call_id,
            "name": call.name,
            "input": call.input,
            "metadata": {
                "parentSessionId": session.id,
                "sessionId": child.id,
                "subagentType": subagent_type
            }
        }),
    )?;
    storage::append_event(
        conn,
        &session.id,
        if child.parent_session_id.as_deref() == Some(session.id.as_str())
            && task_optional_string(&call.input, &["task_id", "taskId"]).is_some()
        {
            "task.resumed"
        } else {
            "task.created"
        },
        json!({
            "toolCallEventId": called.id,
            "sessionId": child.id,
            "description": description,
            "subagentType": subagent_type
        }),
    )?;

    let app_handle = app.clone();
    let child_id = child.id.clone();
    let child_id_for_task = child_id.clone();
    let prompt_for_task = prompt.clone();
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let child_conn = storage::open_db(&app_handle)?;
        tauri::async_runtime::block_on(prompt_session(
            &app_handle,
            &child_conn,
            PromptSessionInput {
                id: None,
                session_id: child_id_for_task,
                prompt: prompt_for_task,
                attachments: Vec::new(),
                loaded_skills: Vec::new(),
                delivery: Some(SessionInputDelivery::Queue),
                resume: true,
            },
        ))
    });

    Ok(TaskRun {
        called_event_id: called.id,
        call_name: call.name.clone(),
        child_id,
        description,
        subagent_type,
        handle,
    })
}

async fn finish_task_tool(
    app: &AppHandle,
    conn: &Connection,
    parent_session_id: &str,
    mut task: TaskRun,
) -> Result<tools::ToolOutcome, String> {
    let child_id = task.child_id.clone();
    let (promote_sender, promote_receiver) = tokio::sync::oneshot::channel();
    task_registry::register_promotable(&child_id, promote_sender);

    let result = match select(&mut task.handle, promote_receiver).await {
        Either::Left((result, _)) => {
            task_registry::unregister_promotable(&child_id);
            result.map_err(|error| error.to_string())?
        }
        Either::Right((_promoted, _)) => {
            let job_id = mark_task_tool_background_started(conn, parent_session_id, &task)?;
            detach_task_tool(app.clone(), parent_session_id.to_string(), task, job_id);
            return Ok(tools::ToolOutcome { pending: false });
        }
    };

    match result {
        Ok(response) => {
            let output = task_output_text(&response);
            storage::set_session_status(conn, &task.child_id, "completed")?;
            storage::append_event(
                conn,
                parent_session_id,
                "tool.success",
                json!({
                    "toolCallEventId": task.called_event_id,
                    "name": task.call_name,
                    "result": {
                        "taskId": task.child_id,
                        "sessionId": task.child_id,
                        "description": task.description,
                        "subagentType": task.subagent_type,
                        "status": "completed",
                        "output": output
                    }
                }),
            )?;
            storage::append_event(
                conn,
                parent_session_id,
                "task.completed",
                json!({
                    "toolCallEventId": task.called_event_id,
                    "sessionId": task.child_id,
                    "description": task.description
                }),
            )?;
        }
        Err(error) => {
            storage::set_session_status(conn, &task.child_id, "failed")?;
            storage::append_event(
                conn,
                parent_session_id,
                "tool.failed",
                json!({
                    "toolCallEventId": task.called_event_id,
                    "name": task.call_name,
                    "result": {
                        "taskId": task.child_id,
                        "sessionId": task.child_id,
                        "description": task.description,
                        "subagentType": task.subagent_type,
                        "status": "failed",
                        "error": error
                    }
                }),
            )?;
            storage::append_event(
                conn,
                parent_session_id,
                "task.failed",
                json!({
                    "toolCallEventId": task.called_event_id,
                    "sessionId": task.child_id,
                    "description": task.description,
                    "error": error
                }),
            )?;
        }
    }

    Ok(tools::ToolOutcome { pending: false })
}

fn mark_task_tool_background_started(
    conn: &Connection,
    parent_session_id: &str,
    task: &TaskRun,
) -> Result<String, String> {
    let parent = storage::get_session(conn, parent_session_id)?;
    let job = storage::insert_background_job(
        conn,
        parent_session_id,
        &task_registry::task_command(&task.child_id),
        &parent.project_root,
        0,
        None,
    )?;
    storage::append_event(
        conn,
        parent_session_id,
        "tool.success",
        json!({
            "toolCallEventId": task.called_event_id,
            "name": task.call_name,
            "result": {
                "taskId": task.child_id,
                "sessionId": task.child_id,
                "jobId": job.id,
                "description": task.description,
                "subagentType": task.subagent_type,
                "status": BackgroundTaskStatus::Running.as_str(),
                "background": true,
                "output": BACKGROUND_TASK_STARTED
            }
        }),
    )?;
    storage::append_event(
        conn,
        parent_session_id,
        "task.background.started",
        json!({
            "toolCallEventId": task.called_event_id,
            "sessionId": task.child_id,
            "jobId": job.id,
            "description": task.description,
            "subagentType": task.subagent_type
        }),
    )?;
    task_registry::register(&job.id);
    Ok(job.id)
}

fn mark_task_tool_background_updated(
    conn: &Connection,
    parent_session_id: &str,
    task: &TaskRun,
    job_id: &str,
) -> Result<(), String> {
    storage::append_event(
        conn,
        parent_session_id,
        "tool.success",
        json!({
            "toolCallEventId": task.called_event_id,
            "name": task.call_name,
            "result": {
                "taskId": task.child_id,
                "sessionId": task.child_id,
                "jobId": job_id,
                "description": task.description,
                "subagentType": task.subagent_type,
                "status": BackgroundTaskStatus::Running.as_str(),
                "background": true,
                "updated": true,
                "output": BACKGROUND_TASK_UPDATED
            }
        }),
    )?;
    storage::append_event(
        conn,
        parent_session_id,
        "task.background.updated",
        json!({
            "toolCallEventId": task.called_event_id,
            "sessionId": task.child_id,
            "jobId": job_id,
            "description": task.description,
            "subagentType": task.subagent_type
        }),
    )?;
    Ok(())
}

pub(super) fn running_background_task_job(
    conn: &Connection,
    parent_session_id: &str,
    child_session_id: &str,
) -> Result<Option<crate::types::BackgroundJobRecord>, String> {
    let command = task_registry::task_command(child_session_id);
    Ok(storage::list_background_jobs(conn, parent_session_id)?
        .into_iter()
        .find(|job| job.command == command && BackgroundTaskStatus::is_active(&job.status)))
}

fn detach_task_extension(task: TaskRun) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = task
            .handle
            .await
            .map_err(|error| error.to_string())
            .and_then(|inner| inner.map(|_| ()))
        {
            log::error!("background task extension failed: {error}");
        }
    });
}

fn detach_task_tool(app: AppHandle, parent_session_id: String, task: TaskRun, job_id: String) {
    tauri::async_runtime::spawn(async move {
        let called_event_id = task.called_event_id.clone();
        let call_name = task.call_name.clone();
        let child_id = task.child_id.clone();
        let description = task.description.clone();
        let subagent_type = task.subagent_type.clone();
        let result = task.handle.await.map_err(|error| error.to_string());
        task_registry::unregister(&job_id);
        let app_for_finish = app.clone();
        let finish = tauri::async_runtime::spawn_blocking(move || {
            let conn = storage::open_db(&app_for_finish)?;
            let notification = finish_background_task_tool(
                &conn,
                &parent_session_id,
                TaskCompletion {
                    called_event_id,
                    call_name,
                    child_id,
                    description,
                    subagent_type,
                    job_id,
                    result,
                },
            )?;
            if let Some(prompt) = notification {
                tauri::async_runtime::block_on(prompt_session(
                    &app_for_finish,
                    &conn,
                    PromptSessionInput {
                        id: None,
                        session_id: parent_session_id,
                        prompt,
                        attachments: Vec::new(),
                        loaded_skills: Vec::new(),
                        delivery: Some(SessionInputDelivery::Queue),
                        resume: true,
                    },
                ))
                .map(|_| ())?;
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|inner| inner);
        if let Err(error) = finish {
            log::error!("background task completion failed: {error}");
        }
    });
}

struct TaskCompletion {
    called_event_id: String,
    call_name: String,
    child_id: String,
    description: String,
    subagent_type: String,
    job_id: String,
    result: Result<Result<SessionEventsResponse, String>, String>,
}

fn finish_background_task_tool(
    conn: &Connection,
    parent_session_id: &str,
    task: TaskCompletion,
) -> Result<Option<String>, String> {
    if storage::get_background_job(conn, &task.job_id)
        .map(|job| BackgroundTaskStatus::is_terminal(&job.status))
        .unwrap_or(false)
    {
        return Ok(None);
    }

    match task.result {
        Ok(Ok(response)) => {
            let output = task_output_text(&response);
            let cancelled = storage::get_background_job(conn, &task.job_id)
                .map(|job| BackgroundTaskStatus::is_cancelled(&job.status))
                .unwrap_or(false);
            if cancelled {
                storage::set_session_status(
                    conn,
                    &task.child_id,
                    BackgroundTaskStatus::Cancelled.as_str(),
                )?;
                storage::append_event(
                    conn,
                    parent_session_id,
                    "task.failed",
                    json!({
                        "toolCallEventId": task.called_event_id,
                        "name": task.call_name,
                        "sessionId": task.child_id,
                        "jobId": task.job_id,
                        "description": task.description,
                        "subagentType": task.subagent_type,
                        "status": BackgroundTaskStatus::Cancelled.as_str(),
                        "background": true,
                        "cancelled": true,
                        "output": output
                    }),
                )?;
                return Ok(None);
            }
            storage::update_background_job_status(
                conn,
                &task.job_id,
                BackgroundTaskStatus::Completed.as_str(),
            )?;
            storage::set_session_status(
                conn,
                &task.child_id,
                BackgroundTaskStatus::Completed.as_str(),
            )?;
            storage::append_event(
                conn,
                parent_session_id,
                "task.completed",
                json!({
                    "toolCallEventId": task.called_event_id,
                    "sessionId": task.child_id,
                    "jobId": task.job_id,
                    "description": task.description,
                    "subagentType": task.subagent_type,
                    "background": true,
                    "output": output
                }),
            )?;
            Ok(Some(render_background_task_prompt(
                &task.child_id,
                &task.description,
                BackgroundTaskStatus::Completed.as_str(),
                &output,
            )))
        }
        Ok(Err(error)) | Err(error) => {
            let cancelled = storage::get_background_job(conn, &task.job_id)
                .map(|job| BackgroundTaskStatus::is_cancelled(&job.status))
                .unwrap_or(false);
            let status = if cancelled {
                BackgroundTaskStatus::Cancelled
            } else {
                BackgroundTaskStatus::Failed
            };
            if !cancelled {
                storage::update_background_job_status(conn, &task.job_id, status.as_str())?;
            }
            storage::set_session_status(conn, &task.child_id, status.as_str())?;
            storage::append_event(
                conn,
                parent_session_id,
                "task.failed",
                json!({
                    "toolCallEventId": task.called_event_id,
                    "name": task.call_name,
                    "sessionId": task.child_id,
                    "jobId": task.job_id,
                    "description": task.description,
                    "subagentType": task.subagent_type,
                    "status": status.as_str(),
                    "background": true,
                    "cancelled": cancelled,
                    "error": error
                }),
            )?;
            Ok(Some(render_background_task_prompt(
                &task.child_id,
                &task.description,
                status.as_str(),
                &error,
            )))
        }
    }
}

pub(super) fn render_background_task_prompt(
    session_id: &str,
    description: &str,
    state: &str,
    text: &str,
) -> String {
    format!(
        "<task id=\"{session_id}\" state=\"{state}\">\n<summary>Background task {state}: {description}</summary>\n<task_result>\n{text}\n</task_result>\n</task>"
    )
}

fn task_string(input: &Value, keys: &[&str]) -> Result<String, String> {
    for key in keys {
        if let Some(value) = input.get(*key).and_then(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() {
                return Ok(value.to_string());
            }
        }
    }
    Err(format!("task 缺少必填字段: {}", keys[0]))
}

pub(super) fn task_optional_string(input: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(super) fn task_background(input: &Value) -> bool {
    input
        .get("background")
        .or_else(|| input.get("runInBackground"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn task_output_text(response: &SessionEventsResponse) -> String {
    response
        .events
        .iter()
        .rev()
        .find(|event| event.event_type == "assistant.message")
        .and_then(|event| event.data.get("text"))
        .and_then(Value::as_str)
        .unwrap_or(crate::i18n::subtask_completed_without_text())
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn memory_db() -> Connection {
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
        conn
    }

    #[test]
    fn status_round_trips_known_lifecycle_values() {
        let statuses = [
            BackgroundTaskStatus::Running,
            BackgroundTaskStatus::Completed,
            BackgroundTaskStatus::Failed,
            BackgroundTaskStatus::Cancelled,
            BackgroundTaskStatus::Orphaned,
            BackgroundTaskStatus::Recoverable,
        ];

        for status in statuses {
            assert_eq!(
                BackgroundTaskStatus::from_str(status.as_str()),
                Some(status)
            );
        }
    }

    #[test]
    fn active_and_cancelled_checks_are_explicit() {
        assert!(BackgroundTaskStatus::is_active("running"));
        assert!(!BackgroundTaskStatus::is_active("recoverable"));
        assert!(BackgroundTaskStatus::is_cancelled("cancelled"));
        assert!(!BackgroundTaskStatus::is_cancelled("failed"));
        assert!(BackgroundTaskStatus::is_terminal("completed"));
        assert!(BackgroundTaskStatus::is_terminal("failed"));
        assert!(BackgroundTaskStatus::is_terminal("cancelled"));
        assert!(!BackgroundTaskStatus::is_terminal("recoverable"));
    }

    #[test]
    fn background_completion_is_idempotent_for_parent_notification() {
        let conn = memory_db();
        storage::append_event(
            &conn,
            "child-1",
            "assistant.message",
            json!({ "text": "child result" }),
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

        let first = finish_background_task_tool(
            &conn,
            "parent-1",
            TaskCompletion {
                called_event_id: "called-1".to_string(),
                call_name: "task".to_string(),
                child_id: "child-1".to_string(),
                description: "child work".to_string(),
                subagent_type: "general".to_string(),
                job_id: job.id.clone(),
                result: Ok(Ok(
                    storage::session_events_response(&conn, "child-1").unwrap()
                )),
            },
        )
        .unwrap();
        let second = finish_background_task_tool(
            &conn,
            "parent-1",
            TaskCompletion {
                called_event_id: "called-1".to_string(),
                call_name: "task".to_string(),
                child_id: "child-1".to_string(),
                description: "child work".to_string(),
                subagent_type: "general".to_string(),
                job_id: job.id.clone(),
                result: Ok(Ok(
                    storage::session_events_response(&conn, "child-1").unwrap()
                )),
            },
        )
        .unwrap();
        let parent_events = storage::list_events(&conn, "parent-1").unwrap();

        assert!(first.is_some());
        assert!(second.is_none());
        assert_eq!(
            parent_events
                .iter()
                .filter(|event| event.event_type == "task.completed")
                .count(),
            1
        );
    }
}
