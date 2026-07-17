use crate::{
    config_file, mcp, mutation, session_coordinator, skills, storage, task_registry,
    types::{
        AgentMode, EventRecord, PromptAttachment, QuestionAnswerInput, SessionInputDelivery,
        SessionRecord, ShellMode, ShellPolicy, TodoRecord, ToolCallRequest,
    },
    util::{
        hide_console, ignored_directories, normalize_project_path, plan_file_path,
        MAX_FILE_SIZE_BYTES,
    },
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
use tauri::AppHandle;

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

pub async fn execute_tool(
    app: &AppHandle,
    conn: &Connection,
    session: &SessionRecord,
    shell_mode: &ShellMode,
    call: &ToolCallRequest,
) -> Result<ToolOutcome, String> {
    execute_tool_with_mode(
        app,
        conn,
        session,
        shell_mode,
        call,
        ToolExecutionMode::Agent,
    )
    .await
}

pub async fn execute_tool_with_mode(
    app: &AppHandle,
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
        Some(app),
        conn,
        session,
        shell_mode,
        &shell_policy,
        call,
        &called,
        execution_mode,
    )
    .await
    {
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

pub async fn approve_tool_call(
    app: &AppHandle,
    conn: &Connection,
    event_id: &str,
) -> Result<EventRecord, String> {
    let event = unresolved_pending_event(conn, event_id)?;

    let session = storage::get_session(conn, &event.session_id)?;
    let name = event
        .data
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tool_name = normalize_tool_name(name);
    if tool_name == "plan_exit" || tool_name == "request_mode" {
        return resolve_mode_change(conn, event_id, true);
    }
    if tool_name.starts_with("mcp__") {
        return approve_mcp_tool_call(app, conn, &session, &event).await;
    }
    if tool_name != "shell" {
        return Err("当前版本只支持确认等待中的 shell/bash、MCP 工具或计划退出。".to_string());
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
        run_shell_command_for_session(conn, &session.id, &cwd, command, options.timeout_seconds)?
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

pub fn answer_tool_question(
    conn: &Connection,
    event_id: &str,
    answers: &[QuestionAnswerInput],
) -> Result<EventRecord, String> {
    let event = unresolved_pending_event(conn, event_id)?;
    let tool_name = normalize_tool_name(
        event
            .data
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    if tool_name != "question"
        && event.data.pointer("/pending/kind").and_then(Value::as_str) != Some("question")
    {
        return Err("该待处理事件不是问题集。".to_string());
    }

    let questions = event
        .data
        .pointer("/pending/questions")
        .and_then(Value::as_array)
        .ok_or_else(|| "待处理问题缺少 questions。".to_string())?;
    if answers.len() != questions.len() {
        return Err("请回答问题集中的每一个问题。".to_string());
    }

    let mut normalized_answers = Vec::with_capacity(questions.len());
    let mut summary_lines = Vec::with_capacity(questions.len());
    for question in questions {
        let id = question
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let prompt = question
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or(id);
        let multiple = question
            .get("multiple")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let allowed = question
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .filter_map(|option| option.get("label").and_then(Value::as_str))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let answer = answers
            .iter()
            .find(|answer| answer.id.trim() == id)
            .ok_or_else(|| format!("问题 {id} 缺少答案。"))?;
        let mut selected = Vec::new();
        for option in &answer.selected_options {
            let option = option.trim();
            if option.is_empty() || !allowed.iter().any(|allowed| *allowed == option) {
                return Err(format!("问题 {id} 包含未知选项：{option}"));
            }
            if !selected.iter().any(|current: &String| current == option) {
                selected.push(option.to_string());
            }
        }
        if !multiple && selected.len() > 1 {
            return Err(format!("问题 {id} 只能选择一个选项。"));
        }
        let custom_text = answer
            .custom_text
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if selected.is_empty() && custom_text.is_none() {
            return Err(format!("问题 {id} 必须选择选项或填写补充内容。"));
        }
        let mut display = selected.join("、");
        if let Some(text) = &custom_text {
            if !display.is_empty() {
                display.push_str("；补充：");
            }
            display.push_str(text);
        }
        summary_lines.push(format!("{prompt}: {display}"));
        normalized_answers.push(json!({
            "id": id,
            "question": prompt,
            "selectedOptions": selected,
            "customText": custom_text
        }));
    }

    storage::append_event(
        conn,
        &event.session_id,
        "tool.success",
        json!({
            "pendingEventId": event.id,
            "name": event.data.get("name").cloned().unwrap_or_else(|| json!("question")),
            "result": {
                "version": 1,
                "kind": "question",
                "answers": normalized_answers,
                "summary": summary_lines.join("\n")
            }
        }),
    )
}

pub fn resolve_mode_change(
    conn: &Connection,
    event_id: &str,
    approved: bool,
) -> Result<EventRecord, String> {
    let event = unresolved_pending_event(conn, event_id)?;
    let session = storage::get_session(conn, &event.session_id)?;
    let name = event
        .data
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("request_mode");
    let tool_name = normalize_tool_name(name);
    let kind = event
        .data
        .pointer("/pending/kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if tool_name != "request_mode" && tool_name != "plan_exit" && kind != "mode_change" {
        return Err("该待处理事件不是模式切换请求。".to_string());
    }
    let target_mode_name = event
        .data
        .pointer("/pending/targetMode")
        .and_then(Value::as_str)
        .unwrap_or("agent");
    let target_mode = AgentMode::from_str(target_mode_name)?;
    let from_mode = session.mode.as_str().to_string();
    let reason = event
        .data
        .pointer("/pending/reason")
        .and_then(Value::as_str)
        .unwrap_or_default();

    if !approved {
        return storage::append_event(
            conn,
            &session.id,
            "tool.rejected",
            json!({
                "pendingEventId": event.id,
                "name": name,
                "result": {
                    "version": 1,
                    "kind": "mode_change",
                    "approved": false,
                    "fromMode": from_mode,
                    "targetMode": target_mode_name,
                    "reason": "User rejected the requested mode change. Continue in the current mode."
                }
            }),
        );
    }

    storage::update_session_mode(conn, &session.id, Some(target_mode.clone()), None, None)?;
    let prompt = build_mode_change_prompt(&session, &target_mode, &event);
    let admitted = storage::admit_session_input(
        conn,
        None,
        &session.id,
        &prompt,
        &Vec::<PromptAttachment>::new(),
        &[],
        SessionInputDelivery::Queue,
        true,
    )?;
    storage::append_event(
        conn,
        &session.id,
        "session.input.admitted",
        json!({
            "inputId": admitted.id,
            "delivery": admitted.delivery,
            "resume": admitted.resume
        }),
    )?;
    storage::append_event(
        conn,
        &session.id,
        "tool.approved",
        json!({
            "pendingEventId": event.id,
            "name": name,
            "fromMode": from_mode,
            "targetMode": target_mode_name
        }),
    )?;
    storage::append_event(
        conn,
        &session.id,
        "tool.success",
        json!({
            "pendingEventId": event.id,
            "name": name,
            "result": {
                "version": 1,
                "kind": "mode_change",
                "approved": true,
                "fromMode": from_mode,
                "targetMode": target_mode_name,
                "reason": reason,
                "message": format!("User approved switching to {target_mode_name} mode. Continue the original task in the new mode.")
            }
        }),
    )
}

async fn approve_mcp_tool_call(
    app: &AppHandle,
    conn: &Connection,
    session: &SessionRecord,
    event: &EventRecord,
) -> Result<EventRecord, String> {
    let server_id = event
        .data
        .pointer("/pending/mcp/serverId")
        .and_then(Value::as_str)
        .ok_or_else(|| "等待确认的 MCP 事件中没有 serverId。".to_string())?;
    let tool_name = event
        .data
        .pointer("/pending/mcp/toolName")
        .and_then(Value::as_str)
        .ok_or_else(|| "等待确认的 MCP 事件中没有 toolName。".to_string())?;
    let arguments = event
        .data
        .pointer("/pending/mcp/arguments")
        .cloned()
        .unwrap_or(Value::Null);
    let config_path = session_provider_config_path(conn, session);
    let server = find_mcp_server(
        app,
        &session.project_root,
        config_path.as_deref(),
        server_id,
    )?;
    storage::append_event(
        conn,
        &session.id,
        "tool.approved",
        json!({
            "pendingEventId": event.id,
            "name": event.data.get("name").cloned().unwrap_or(Value::Null),
            "mcp": {
                "serverId": server_id,
                "toolName": tool_name
            }
        }),
    )?;
    let result = mcp::call_tool(&session.project_root, &server, tool_name, arguments).await;
    let (event_type, data) = match result {
        Ok(value) => ("tool.success", json!({ "result": value })),
        Err(error) => ("tool.failed", json!({ "error": error })),
    };
    storage::append_event(
        conn,
        &session.id,
        event_type,
        json!({
            "pendingEventId": event.id,
            "name": event.data.get("name").cloned().unwrap_or(Value::Null),
            "mcp": {
                "serverId": server_id,
                "toolName": tool_name
            },
            "result": data
        }),
    )
}

pub fn reject_tool_call(conn: &Connection, event_id: &str) -> Result<EventRecord, String> {
    let event = unresolved_pending_event(conn, event_id)?;
    let name = event
        .data
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tool_name = normalize_tool_name(name);
    if tool_name == "request_mode" || tool_name == "plan_exit" {
        return resolve_mode_change(conn, event_id, false);
    }

    storage::append_event(
        conn,
        &event.session_id,
        "tool.rejected",
        json!({
            "pendingEventId": event.id,
            "name": event.data.get("name").cloned().unwrap_or(Value::Null),
            "result": {
                "message": "User declined this interaction. Continue the task and adapt to the rejection."
            }
        }),
    )
}

#[derive(Debug)]
enum ToolRun {
    Success(Value),
    Pending(Value),
    Failure(Value),
}

async fn execute_tool_inner(
    app: Option<&AppHandle>,
    conn: &Connection,
    session: &SessionRecord,
    shell_mode: &ShellMode,
    shell_policy: &ShellPolicy,
    call: &ToolCallRequest,
    called_event: &EventRecord,
    execution_mode: ToolExecutionMode,
) -> Result<ToolRun, String> {
    let tool_name = normalize_tool_name(&call.name);
    if let Some(run) =
        execute_mcp_tool_if_matched(app, conn, session, shell_mode, call, execution_mode).await?
    {
        return Ok(run);
    }
    match tool_name.as_str() {
        "invalid" => Ok(ToolRun::Failure(invalid_tool_result(&call.input))),
        "skill_list" => {
            let skill_sources = session_skill_sources(app, session);
            Ok(ToolRun::Success(skills::skill_list_result_with_sources(
                &session.project_root,
                &skill_sources,
            )))
        }
        "skill_read" => {
            let name = required_string(&call.input, "name")?;
            let skill_sources = session_skill_sources(app, session);
            Ok(ToolRun::Success(skills::skill_read_result_with_sources(
                &session.project_root,
                &name,
                &skill_sources,
            )))
        }
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
            let path = required_string(&call.input, "path")?;
            if execution_mode != ToolExecutionMode::Agent
                && !(execution_mode == ToolExecutionMode::Plan && is_plan_file_path(&path))
            {
                return Ok(read_only_mode_mutation_blocked(execution_mode, "edit"));
            }
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
            let path = required_string(&call.input, "path")?;
            if execution_mode != ToolExecutionMode::Agent
                && !(execution_mode == ToolExecutionMode::Plan && is_plan_file_path(&path))
            {
                return Ok(read_only_mode_mutation_blocked(execution_mode, "write"));
            }
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
        "question" => Ok(ToolRun::Pending(normalize_question_request(&call.input)?)),
        "todo_write" => {
            let todos = parse_todos(call.input.get("todos").unwrap_or(&Value::Null))?;
            let saved = storage::replace_todos(conn, &session.id, todos)?;
            storage::append_event(
                conn,
                &session.id,
                "todo.updated",
                json!({
                    "todos": saved.clone()
                }),
            )?;
            Ok(ToolRun::Success(json!({
                "todos": saved
            })))
        }
        "plan_exit" => {
            if execution_mode != ToolExecutionMode::Plan {
                return Ok(ToolRun::Failure(json!({
                    "blocked": true,
                    "reason": "plan_exit 只能在计划模式结束时调用。"
                })));
            }
            let plan_path = plan_file_path(&session.created_at, &session.title);
            Ok(ToolRun::Pending(json!({
                "version": 1,
                "kind": "mode_change",
                "command": format!("计划文件 {plan_path} 已完成，是否切换到执行模式并开始实现？"),
                "fromMode": session.mode.as_str(),
                "targetMode": "agent",
                "planPath": plan_path,
                "reason": "计划已完成，等待用户确认是否开始执行。"
            })))
        }
        "request_mode" => {
            let target_mode_name =
                required_string_any(&call.input, &["targetMode", "target_mode"])?;
            let target_mode = AgentMode::from_str(&target_mode_name)?;
            if target_mode.as_str() == session.mode.as_str() {
                return Ok(ToolRun::Failure(json!({
                    "blocked": true,
                    "reason": format!("Session is already in {} mode.", target_mode.as_str())
                })));
            }
            let reason = required_string(&call.input, "reason")?;
            Ok(ToolRun::Pending(json!({
                "version": 1,
                "kind": "mode_change",
                "fromMode": session.mode.as_str(),
                "targetMode": target_mode.as_str(),
                "reason": reason
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
                run_shell_command_for_session(
                    conn,
                    &session.id,
                    &cwd,
                    &command,
                    options.timeout_seconds,
                )?
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

fn session_skill_sources(app: Option<&AppHandle>, session: &SessionRecord) -> Vec<String> {
    app.and_then(|app| {
        config_file::load_skill_config(app, &session.project_root, session.config_path.as_deref())
            .ok()
            .map(|config| config.sources)
    })
    .unwrap_or_default()
}

async fn execute_mcp_tool_if_matched(
    app: Option<&AppHandle>,
    conn: &Connection,
    session: &SessionRecord,
    shell_mode: &ShellMode,
    call: &ToolCallRequest,
    execution_mode: ToolExecutionMode,
) -> Result<Option<ToolRun>, String> {
    if !call.name.starts_with("mcp__") {
        return Ok(None);
    }
    let Some(app) = app else {
        return Err("MCP tool execution requires app handle".to_string());
    };
    let mut interrupt = session_coordinator::subscribe_interrupt(&session.id);
    if storage::is_session_cancel_requested(conn, &session.id)? {
        return Err("MCP tool interrupted by user.".to_string());
    }
    let config_path = session_provider_config_path(conn, session);
    let servers =
        config_file::load_mcp_server_configs(app, &session.project_root, config_path.as_deref())?;
    for server in servers.iter().filter(|server| server.enabled) {
        let list_tools = mcp::list_server_tools(&session.project_root, server);
        let tools = match tokio::select! {
            result = list_tools => result,
            changed = interrupt.changed() => {
                let _ = changed;
                return Err("MCP tool interrupted by user.".to_string());
            }
        } {
            Ok(value) => value,
            Err(error) => {
                return Ok(Some(ToolRun::Failure(json!({
                    "error": error,
                    "serverId": server.id
                }))));
            }
        };
        let Some(tool) = tools.iter().find(|tool| tool.display_name == call.name) else {
            continue;
        };
        if execution_mode != ToolExecutionMode::Agent && !tool.read_only {
            return Ok(Some(read_only_mode_mutation_blocked(
                execution_mode,
                &call.name,
            )));
        }
        if mcp_tool_needs_approval(tool.require_approval, shell_mode) {
            return Ok(Some(ToolRun::Pending(json!({
                "command": format!("{} / {}", server.id, tool.name),
                "mcp": {
                    "serverId": server.id,
                    "toolName": tool.name,
                    "arguments": call.input
                },
                "reason": "MCP tool requires approval"
            }))));
        }
        let call_tool = mcp::call_tool(
            &session.project_root,
            server,
            &tool.name,
            call.input.clone(),
        );
        let result = tokio::select! {
            result = call_tool => result,
            changed = interrupt.changed() => {
                let _ = changed;
                return Err("MCP tool interrupted by user.".to_string());
            }
        };
        return Ok(Some(match result {
            Ok(value) => ToolRun::Success(json!({
                "serverId": server.id,
                "toolName": tool.name,
                "content": value
            })),
            Err(error) => ToolRun::Failure(json!({
                "serverId": server.id,
                "toolName": tool.name,
                "error": error
            })),
        }));
    }
    Ok(Some(ToolRun::Failure(json!({
        "error": format!("Unknown MCP tool: {}", call.name)
    }))))
}

fn find_mcp_server(
    app: &AppHandle,
    project_root: &str,
    config_path: Option<&str>,
    server_id: &str,
) -> Result<crate::types::McpServerConfig, String> {
    config_file::load_mcp_server_configs(app, project_root, config_path)?
        .into_iter()
        .find(|server| server.id == server_id)
        .ok_or_else(|| format!("未找到 MCP server: {server_id}"))
}

fn session_provider_config_path(conn: &Connection, session: &SessionRecord) -> Option<String> {
    if let Some(path) = session
        .config_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        return Some(path.to_string());
    }
    storage::get_provider(conn, &session.provider_id)
        .ok()
        .and_then(|provider| provider.config_path)
}

fn mcp_tool_needs_approval(require_approval: bool, shell_mode: &ShellMode) -> bool {
    require_approval && !matches!(shell_mode, ShellMode::Auto)
}

fn normalize_tool_name(name: &str) -> String {
    match name.trim().to_ascii_lowercase().as_str() {
        "bash" => "shell".to_string(),
        "grep" => "search".to_string(),
        "todowrite" => "todo_write".to_string(),
        "planexit" => "plan_exit".to_string(),
        "requestmode" => "request_mode".to_string(),
        other => other.to_string(),
    }
}

fn is_plan_file_path(path: &str) -> bool {
    let normalized = normalize_project_path(path);
    let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
    normalized.starts_with(".odot/plans/") && normalized.ends_with(".md")
}

fn unresolved_pending_event(conn: &Connection, event_id: &str) -> Result<EventRecord, String> {
    let event = storage::get_event(conn, event_id)?;
    if event.event_type != "tool.pending" {
        return Err("只能处理等待用户输入的工具事件。".to_string());
    }
    let already_resolved = storage::list_events(conn, &event.session_id)?
        .iter()
        .any(|candidate| {
            candidate.data.get("pendingEventId").and_then(Value::as_str) == Some(event_id)
        });
    if already_resolved {
        return Err("该交互已经处理，请刷新会话查看最新结果。".to_string());
    }
    Ok(event)
}

fn normalize_question_request(input: &Value) -> Result<Value, String> {
    if let Some(questions) = input.get("questions") {
        let questions = questions
            .as_array()
            .ok_or_else(|| "question.questions 必须是数组。".to_string())?;
        if questions.is_empty() || questions.len() > 3 {
            return Err("question.questions 必须包含 1 到 3 个问题。".to_string());
        }
        let mut ids = Vec::with_capacity(questions.len());
        let mut normalized = Vec::with_capacity(questions.len());
        for question in questions {
            let id = required_string(question, "id")?;
            if ids.iter().any(|current| current == &id) {
                return Err(format!("问题 id 重复：{id}"));
            }
            ids.push(id.clone());
            let header = required_string(question, "header")?;
            if header.chars().count() > 24 {
                return Err(format!("问题 {id} 的 header 不能超过 24 个字符。"));
            }
            let prompt = required_string(question, "question")?;
            let multiple = question
                .get("multiple")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("问题 {id} 缺少 options 数组。"))?;
            if options.len() < 2 || options.len() > 4 {
                return Err(format!("问题 {id} 必须提供 2 到 4 个选项。"));
            }
            let mut labels = Vec::with_capacity(options.len());
            let mut normalized_options = Vec::with_capacity(options.len());
            for option in options {
                let label = required_string(option, "label")?;
                if labels.iter().any(|current| current == &label) {
                    return Err(format!("问题 {id} 的选项重复：{label}"));
                }
                labels.push(label.clone());
                normalized_options.push(json!({
                    "label": label,
                    "description": required_string(option, "description")?
                }));
            }
            normalized.push(json!({
                "id": id,
                "header": header,
                "question": prompt,
                "multiple": multiple,
                "options": normalized_options,
                "allowCustom": true
            }));
        }
        return Ok(json!({
            "version": 1,
            "kind": "question",
            "questions": normalized,
            "reason": "Agent requires user input before continuing."
        }));
    }

    let question = required_string_any(input, &["question", "text"])?;
    Ok(json!({
        "version": 1,
        "kind": "question",
        "legacy": true,
        "questions": [{
            "id": "question_1",
            "header": "",
            "question": question,
            "multiple": false,
            "options": [],
            "allowCustom": true
        }],
        "reason": "Agent requires user input before continuing."
    }))
}

fn build_mode_change_prompt(
    session: &SessionRecord,
    target_mode: &AgentMode,
    event: &EventRecord,
) -> String {
    let target = target_mode.as_str();
    let capability = match target_mode {
        AgentMode::Agent => "You may edit files, run commands, and use all available tools.",
        AgentMode::Plan => "You are now read-only except for the session plan file. Research and produce a decision-complete plan; do not modify project files.",
        AgentMode::Ask => "You are now read-only. Inspect as needed and answer the user without modifying project files.",
    };
    let plan_path = event
        .data
        .pointer("/pending/planPath")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| plan_file_path(&session.created_at, &session.title));
    let plan_note = if matches!(target_mode, AgentMode::Agent)
        && event.data.pointer("/pending/planPath").is_some()
    {
        format!("\nThe approved plan is at {plan_path}; read it before implementing and track its steps with todo_write.")
    } else {
        String::new()
    };
    format!(
        "[odot-mode-change]\n\n<system-reminder>\nYour operational mode has changed to {target}.\n{capability}{plan_note}\nContinue the original task under the new mode constraints.\n</system-reminder>"
    )
}

fn parse_todos(value: &Value) -> Result<Vec<TodoRecord>, String> {
    let items = value
        .as_array()
        .ok_or_else(|| "todo_write.todos 必须是数组。".to_string())?;
    items
        .iter()
        .enumerate()
        .map(|(position, item)| parse_todo(item, position))
        .collect()
}

fn parse_todo(value: &Value, position: usize) -> Result<TodoRecord, String> {
    let content = value
        .get("content")
        .or_else(|| value.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("todo_write.todos[{position}].content 不能为空。"))?
        .to_string();
    let status = normalize_todo_status(
        value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("pending"),
    )?;
    let priority = normalize_todo_priority(
        value
            .get("priority")
            .and_then(Value::as_str)
            .unwrap_or("medium"),
    )?;
    Ok(TodoRecord {
        content,
        status,
        priority,
        position: position as i64,
    })
}

fn normalize_todo_status(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "pending" => Ok("pending".to_string()),
        "in_progress" | "in-progress" | "running" => Ok("in_progress".to_string()),
        "completed" | "complete" | "done" => Ok("completed".to_string()),
        "cancelled" | "canceled" => Ok("cancelled".to_string()),
        other => Err(format!(
            "不支持的 todo 状态: {other}，可用 pending/in_progress/completed/cancelled。"
        )),
    }
}

fn normalize_todo_priority(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "high" => Ok("high".to_string()),
        "medium" | "normal" => Ok("medium".to_string()),
        "low" => Ok("low".to_string()),
        other => Err(format!(
            "不支持的 todo 优先级: {other}，可用 high/medium/low。"
        )),
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
    let reason = if execution_mode == ToolExecutionMode::Plan {
        format!(
            "{mode_label}禁止执行 {tool_name}，除 .odot/plans/*.md 计划文件外，请只读取、搜索或运行不会修改代码的检查命令。"
        )
    } else {
        format!("{mode_label}禁止执行 {tool_name}，请只读取、搜索或运行不会修改代码的检查命令。")
    };
    ToolRun::Failure(json!({
        "blocked": true,
        "reason": reason
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

            if !metadata.is_file() || metadata.len() > MAX_FILE_SIZE_BYTES {
                continue;
            }

            // Read the file once and reuse the bytes for both the binary sniff and
            // the text decode, instead of opening it twice.
            let bytes = fs::read(&path).map_err(|error| error.to_string())?;
            if bytes.iter().take(512).any(|byte| *byte == 0) {
                continue;
            }
            let content = decode_bytes(&bytes);
            let relative = path
                .strip_prefix(&root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if relative.contains(query) && matches.len() < 100 {
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

fn run_shell_command_for_session(
    conn: &Connection,
    session_id: &str,
    root: &str,
    command: &str,
    timeout_seconds: u64,
) -> Result<Value, String> {
    run_shell_command_until(root, command, timeout_seconds, || {
        storage::is_session_cancel_requested(conn, session_id).unwrap_or(false)
    })
}

#[cfg(test)]
fn run_shell_command(root: &str, command: &str, timeout_seconds: u64) -> Result<Value, String> {
    run_shell_command_until(root, command, timeout_seconds, || false)
}

fn run_shell_command_until<F>(
    root: &str,
    command: &str,
    timeout_seconds: u64,
    mut should_cancel: F,
) -> Result<Value, String>
where
    F: FnMut() -> bool,
{
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
    let mut cancelled = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if started_at.elapsed() >= timeout {
            timed_out = true;
            terminate_process_tree(&mut child);
            break child.wait().map_err(|error| error.to_string())?;
        }
        if should_cancel() {
            cancelled = true;
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
        "cancelled": cancelled,
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
        hide_console(&mut process);
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
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &pid, "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut command);
        let _ = command.status();
    }
    let _ = child.kill();
}

pub fn wait_job(conn: &Connection, job_id: &str) -> Result<Value, String> {
    let job = storage::get_background_job(conn, job_id)?;
    if task_registry::is_task_command(&job.command) {
        let job = if job.status == "running" && !task_registry::is_registered(job_id) {
            storage::update_background_job_status(conn, job_id, "orphaned")?
        } else {
            job
        };
        let running = job.status == "running";
        return Ok(json!({
            "job": job,
            "running": running
        }));
    }
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
    if task_registry::is_task_command(&job.command) {
        let aborted = task_registry::cancel(job_id);
        let job = storage::update_background_job_status(conn, job_id, "cancelled")?;
        return Ok(json!({ "job": job, "aborted": aborted }));
    }
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
        let mut command = Command::new("tasklist");
        command.args(["/FI", &format!("PID eq {pid}")]);
        hide_console(&mut command);
        command
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
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut command);
        let _ = command.status();
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
    use crate::types::{AgentMode, ProviderInput, ProviderKind};

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
            config_path: None,
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
    fn shell_command_can_be_cancelled() {
        let result = run_shell_command_until(".", slow_command(), 10, || true).unwrap();

        assert_eq!(result["cancelled"], true);
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
    fn auto_mode_runs_mcp_tools_without_manual_approval() {
        assert!(mcp_tool_needs_approval(true, &ShellMode::Manual));
        assert!(!mcp_tool_needs_approval(true, &ShellMode::Auto));
        assert!(!mcp_tool_needs_approval(false, &ShellMode::Manual));
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

        let result = tauri::async_runtime::block_on(execute_tool_inner(
            None,
            &conn,
            &session,
            &ShellMode::Auto,
            &policy,
            &call,
            &event,
            ToolExecutionMode::Plan,
        ))
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

        let result = tauri::async_runtime::block_on(execute_tool_inner(
            None,
            &conn,
            &session,
            &ShellMode::Manual,
            &policy(&[]),
            &call,
            &event,
            ToolExecutionMode::Ask,
        ))
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

        let result = tauri::async_runtime::block_on(execute_tool_inner(
            None,
            &conn,
            &session,
            &ShellMode::Manual,
            &policy(&[]),
            &call,
            &event,
            ToolExecutionMode::Ask,
        ))
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
    fn todo_parser_normalizes_legacy_status_and_priority() {
        let todos = parse_todos(&json!([
            { "text": "Implement the plan", "status": "done", "priority": "normal" },
            { "content": "Verify right panel progress", "status": "in-progress", "priority": "high" }
        ]))
        .unwrap();

        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].content, "Implement the plan");
        assert_eq!(todos[0].status, "completed");
        assert_eq!(todos[0].priority, "medium");
        assert_eq!(todos[0].position, 0);
        assert_eq!(todos[1].status, "in_progress");
        assert_eq!(todos[1].priority, "high");
        assert_eq!(todos[1].position, 1);
    }

    #[test]
    fn plan_mode_write_scope_only_allows_markdown_plan_files() {
        assert!(is_plan_file_path(".odot/plans/2026-06-27-ship-plan.md"));
        assert!(is_plan_file_path(".odot\\plans\\2026-06-27-ship-plan.md"));
        assert!(is_plan_file_path(
            ".\\.odot\\plans\\2026-06-27-ship-plan.md"
        ));
        assert!(!is_plan_file_path(".odot/plans/2026-06-27-ship-plan.txt"));
        assert!(!is_plan_file_path("src-tauri/src/tools.rs"));
        assert!(!is_plan_file_path(".odot/other/plan.md"));
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

        let result = tauri::async_runtime::block_on(execute_tool_inner(
            None,
            &conn,
            &session,
            &ShellMode::Auto,
            &policy,
            &call,
            &event,
            ToolExecutionMode::Agent,
        ))
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
    fn structured_question_normalizes_and_validates_schema() {
        let pending = normalize_question_request(&json!({
            "questions": [{
                "id": "direction",
                "header": "Direction",
                "question": "Which direction?",
                "multiple": false,
                "options": [
                    { "label": "A", "description": "First" },
                    { "label": "B", "description": "Second" }
                ]
            }]
        }))
        .unwrap();

        assert_eq!(pending["kind"], "question");
        assert_eq!(pending["questions"][0]["allowCustom"], true);
        assert!(normalize_question_request(&json!({ "questions": [] })).is_err());
        assert!(normalize_question_request(&json!({
            "questions": [{
                "id": "bad",
                "header": "Bad",
                "question": "Bad?",
                "multiple": false,
                "options": [{ "label": "Only", "description": "One" }]
            }]
        }))
        .is_err());
    }

    #[test]
    fn question_answers_are_structured_and_only_resolve_once() {
        let conn = Connection::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        conn.execute(
            "INSERT INTO session (id, project_root, mode, provider_id, title, status, shell_mode, created_at, updated_at) VALUES ('s1', '.', 'ask', 'p1', 'test', 'active', 'manual', 'now', 'now')",
            [],
        )
        .unwrap();
        let pending = storage::append_event(
            &conn,
            "s1",
            "tool.pending",
            json!({
                "name": "question",
                "pending": normalize_question_request(&json!({
                    "questions": [{
                        "id": "direction",
                        "header": "Direction",
                        "question": "Which direction?",
                        "multiple": false,
                        "options": [
                            { "label": "A", "description": "First" },
                            { "label": "B", "description": "Second" }
                        ]
                    }]
                })).unwrap()
            }),
        )
        .unwrap();
        let answers = vec![QuestionAnswerInput {
            id: "direction".to_string(),
            selected_options: vec!["A".to_string()],
            custom_text: Some("Prefer the simpler path".to_string()),
        }];

        let result = answer_tool_question(&conn, &pending.id, &answers).unwrap();
        assert_eq!(result.event_type, "tool.success");
        assert_eq!(
            result.data["result"]["answers"][0]["selectedOptions"][0],
            "A"
        );
        assert!(answer_tool_question(&conn, &pending.id, &answers).is_err());
    }

    #[test]
    fn mode_change_approval_updates_mode_and_reject_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        storage::save_provider(
            &conn,
            ProviderInput {
                id: Some("p1".to_string()),
                kind: ProviderKind::OpenAiCompatible,
                name: "Test".to_string(),
                base_url: Some("https://example.com/v1".to_string()),
                model: "test".to_string(),
                api_key: None,
                config_path: None,
            },
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session (id, project_root, mode, provider_id, title, status, shell_mode, created_at, updated_at) VALUES ('s1', '.', 'plan', 'p1', 'test', 'active', 'manual', 'now', 'now')",
            [],
        )
        .unwrap();
        let pending = storage::append_event(
            &conn,
            "s1",
            "tool.pending",
            json!({
                "name": "request_mode",
                "pending": {
                    "version": 1,
                    "kind": "mode_change",
                    "fromMode": "plan",
                    "targetMode": "agent",
                    "reason": "Implementation is required"
                }
            }),
        )
        .unwrap();

        let result = resolve_mode_change(&conn, &pending.id, true).unwrap();
        assert_eq!(result.event_type, "tool.success");
        assert_eq!(
            storage::get_session(&conn, "s1").unwrap().mode.as_str(),
            "agent"
        );
        assert!(resolve_mode_change(&conn, &pending.id, false).is_err());
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
