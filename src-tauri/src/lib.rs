mod config_file;
mod error_model;
mod event_bus;
mod external_bridge;
mod i18n;
mod llm_runtime;
mod mcp;
mod mutation;
mod provider;
mod runner;
mod session_coordinator;
mod skills;
mod storage;
mod task_registry;
mod tools;
mod types;
mod util;
mod workspace;

use serde_json::json;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::time::Duration;
use std::{
    path::Path,
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Emitter};
use types::{
    ContextSummaryRecord, CreateSessionInput, EventRecord, McpConfigFileResponse, McpServerConfig,
    McpToolDefinition, ModelReasoningEffortsResponse, PersistPlanInput, ProjectCapabilities,
    ProjectCapabilityError, ProjectFile, PromptSessionInput, ProviderConfigFileResponse,
    ProviderInput, ProviderRecord, RecoverBackgroundTaskInput, RecoverSessionInput,
    ReplyPermissionInput, RevealPathInput, SessionEventsResponse, SessionRecord, ShellPolicy,
    SkillRecord, SnapshotRecord, SubmitPromptInput, TailSessionEventsInput, UpdateSessionModeInput,
    UpdateSessionTitleInput,
};

const FLOAT_WINDOW_LABEL: &str = "float";
#[cfg(any(target_os = "windows", target_os = "macos"))]
const FLOAT_DRAG_FRAME_MS: u64 = 8;
static FLOAT_DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);

struct FloatDragGuard;

impl Drop for FloatDragGuard {
    fn drop(&mut self) {
        FLOAT_DRAG_ACTIVE.store(false, Ordering::Release);
    }
}

fn acquire_float_drag() -> Result<FloatDragGuard, String> {
    if FLOAT_DRAG_ACTIVE.swap(true, Ordering::AcqRel) {
        return Err("悬浮球正在拖动".to_string());
    }
    Ok(FloatDragGuard)
}

#[cfg(target_os = "windows")]
fn left_mouse_button_is_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};

    (unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } as u16 & 0x8000) != 0
}

#[cfg(target_os = "macos")]
fn left_mouse_button_is_down() -> bool {
    const K_CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE: i32 = 0;
    const K_CG_MOUSE_BUTTON_LEFT: u32 = 0;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    }

    unsafe {
        CGEventSourceButtonState(
            K_CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE,
            K_CG_MOUSE_BUTTON_LEFT,
        )
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn physical_i32(value: f64) -> i32 {
    value
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
async fn drag_float_window_native(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let cursor = app.cursor_position().map_err(|error| error.to_string())?;
    let origin = window.outer_position().map_err(|error| error.to_string())?;
    let offset_x = cursor.x - f64::from(origin.x);
    let offset_y = cursor.y - f64::from(origin.y);

    while left_mouse_button_is_down() {
        let cursor = app.cursor_position().map_err(|error| error.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(
                physical_i32(cursor.x - offset_x),
                physical_i32(cursor.y - offset_y),
            ))
            .map_err(|error| error.to_string())?;
        tokio::time::sleep(Duration::from_millis(FLOAT_DRAG_FRAME_MS)).await;
    }

    Ok(())
}

#[tauri::command]
async fn start_float_drag(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != FLOAT_WINDOW_LABEL {
        return Err("只能拖动悬浮球窗口".to_string());
    }
    let _guard = acquire_float_drag()?;

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        drag_float_window_native(app, window).await
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = app;
        window.start_dragging().map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn save_provider(app: AppHandle, input: ProviderInput) -> Result<ProviderRecord, String> {
    let conn = storage::open_db(&app)?;
    storage::save_provider(&conn, input)
}

#[tauri::command]
fn list_providers(app: AppHandle) -> Result<Vec<ProviderRecord>, String> {
    let conn = storage::open_db(&app)?;
    storage::list_providers(&conn)
}

#[tauri::command]
fn delete_provider(app: AppHandle, id: String) -> Result<(), String> {
    let conn = storage::open_db(&app)?;
    storage::delete_provider(&conn, &id)
}

#[tauri::command]
fn load_provider_config(
    app: AppHandle,
    project_root: Option<String>,
    config_path: Option<String>,
) -> Result<ProviderConfigFileResponse, String> {
    config_file::load_provider_config_for_project(&app, project_root, config_path)
}

#[tauri::command]
fn save_provider_config(
    app: AppHandle,
    content: String,
    project_root: Option<String>,
    config_path: Option<String>,
) -> Result<ProviderConfigFileResponse, String> {
    config_file::save_provider_config(&app, content, project_root, config_path)
}

#[tauri::command]
fn get_model_reasoning_efforts(
    content: String,
    provider_id: String,
    model_id: String,
) -> Result<ModelReasoningEffortsResponse, String> {
    config_file::model_reasoning_efforts(&content, &provider_id, &model_id)
}

#[tauri::command]
fn find_opencode_config(project_root: Option<String>) -> Result<Option<String>, String> {
    config_file::find_opencode_config(project_root.as_deref())
}

#[tauri::command]
async fn list_project_capabilities(
    app: AppHandle,
    project_root: String,
    config_path: Option<String>,
) -> Result<ProjectCapabilities, String> {
    let mut errors = Vec::new();
    let resolved_config_path =
        config_file::resolved_config_path_for_project(&app, &project_root, config_path.as_deref())?;
    let resolved_config_path_string = resolved_config_path.to_string_lossy().to_string();
    let skill_config = match config_file::load_skill_config(
        &app,
        &project_root,
        Some(&resolved_config_path_string),
    ) {
        Ok(value) => value,
        Err(error) => {
            errors.push(ProjectCapabilityError {
                source: "skills".to_string(),
                message: error,
            });
            config_file::SkillConfig::default()
        }
    };
    let skills =
        match skills::list_project_skills_with_sources(&project_root, &skill_config.sources) {
            Ok(value) => value,
            Err(error) => {
                errors.push(ProjectCapabilityError {
                    source: "skills".to_string(),
                    message: error,
                });
                Vec::new()
            }
        };
    let mcp_servers = match config_file::load_mcp_server_configs(
        &app,
        &project_root,
        Some(&resolved_config_path_string),
    ) {
        Ok(value) => value,
        Err(error) => {
            errors.push(ProjectCapabilityError {
                source: "mcp".to_string(),
                message: error,
            });
            Vec::new()
        }
    };
    let mut mcp_tools = Vec::new();
    for server in &mcp_servers {
        match mcp::list_server_tools(&project_root, server).await {
            Ok(tools) => mcp_tools.extend(tools),
            Err(error) => errors.push(ProjectCapabilityError {
                source: format!("mcp:{}", server.id),
                message: error,
            }),
        }
    }
    Ok(ProjectCapabilities {
        config_path: resolved_config_path_string,
        skills,
        mcp_servers,
        mcp_tools,
        errors,
    })
}

#[tauri::command]
fn save_mcp_server(
    app: AppHandle,
    project_root: String,
    config_path: Option<String>,
    server: McpServerConfig,
) -> Result<McpConfigFileResponse, String> {
    config_file::save_mcp_server_entry(&app, &project_root, config_path.as_deref(), &server)
}

#[tauri::command]
fn delete_mcp_server(
    app: AppHandle,
    project_root: String,
    config_path: Option<String>,
    server_id: String,
) -> Result<McpConfigFileResponse, String> {
    config_file::remove_mcp_server_entry(&app, &project_root, config_path.as_deref(), &server_id)
}

#[tauri::command]
async fn test_mcp_connection(
    project_root: String,
    server: McpServerConfig,
) -> Result<Vec<McpToolDefinition>, String> {
    mcp::list_server_tools(&project_root, &server).await
}

#[tauri::command]
fn import_skill(
    app: AppHandle,
    project_root: String,
    source_path: String,
) -> Result<SkillRecord, String> {
    let global_dir = config_file::odot_global_skill_dir(&app)?;
    skills::import_skill_to_dir(&project_root, &global_dir, &source_path)
}

#[tauri::command]
fn delete_skill(app: AppHandle, _project_root: String, skill_path: String) -> Result<(), String> {
    let global_dir = config_file::odot_global_skill_dir(&app)?;
    skills::delete_skill_from_dir(&global_dir, &skill_path)
}

#[tauri::command]
fn read_skill_content(
    app: AppHandle,
    project_root: String,
    config_path: Option<String>,
    name_or_path: String,
) -> Result<serde_json::Value, String> {
    let skill_config = config_file::load_skill_config(&app, &project_root, config_path.as_deref())?;
    let (skill, content) = skills::read_project_skill_with_sources(
        &project_root,
        &name_or_path,
        &skill_config.sources,
    )?;
    Ok(serde_json::json!({
        "name": skill.name,
        "description": skill.description,
        "path": skill.path,
        "content": content
    }))
}

#[tauri::command]
fn create_session(app: AppHandle, input: CreateSessionInput) -> Result<SessionRecord, String> {
    let conn = storage::open_db(&app)?;
    storage::create_session(&conn, input)
}

#[tauri::command]
fn list_sessions(app: AppHandle) -> Result<Vec<SessionRecord>, String> {
    let conn = storage::open_db(&app)?;
    storage::list_sessions(&conn)
}

#[tauri::command]
fn get_session(app: AppHandle, session_id: String) -> Result<SessionRecord, String> {
    let conn = storage::open_db(&app)?;
    storage::get_session(&conn, &session_id)
}

#[tauri::command]
fn delete_session(app: AppHandle, session_id: String) -> Result<(), String> {
    let conn = storage::open_db(&app)?;
    storage::delete_session(&conn, &session_id)
}

#[tauri::command]
fn cancel_session(app: AppHandle, session_id: String) -> Result<EventRecord, String> {
    let conn = storage::open_db(&app)?;
    runner::cancel_session(&conn, &session_id)
}

#[tauri::command]
fn update_session_title(
    app: AppHandle,
    input: UpdateSessionTitleInput,
) -> Result<SessionRecord, String> {
    let conn = storage::open_db(&app)?;
    storage::update_session_title(&conn, &input.session_id, &input.title)
}

#[tauri::command]
fn rename_session(app: AppHandle, input: UpdateSessionTitleInput) -> Result<SessionRecord, String> {
    let conn = storage::open_db(&app)?;
    storage::update_session_title(&conn, &input.session_id, &input.title)
}

#[tauri::command]
fn update_session_mode(
    app: AppHandle,
    input: UpdateSessionModeInput,
) -> Result<SessionRecord, String> {
    let conn = storage::open_db(&app)?;
    storage::update_session_mode(
        &conn,
        &input.session_id,
        input.mode,
        input.shell_mode,
        input.provider_id,
    )
}

#[tauri::command]
fn get_session_events(app: AppHandle, session_id: String) -> Result<SessionEventsResponse, String> {
    let conn = storage::open_db(&app)?;
    storage::session_events_response(&conn, &session_id)
}

#[tauri::command]
fn tail_session_events(
    app: AppHandle,
    input: TailSessionEventsInput,
) -> Result<SessionEventsResponse, String> {
    let conn = storage::open_db(&app)?;
    Ok(SessionEventsResponse {
        events: storage::list_events_after(&conn, &input.session_id, input.after_seq.unwrap_or(0))?,
        snapshots: storage::list_snapshots(&conn, &input.session_id)?,
        summaries: storage::list_context_summaries(&conn, &input.session_id)?,
        inputs: storage::list_public_session_inputs(&conn, &input.session_id)?,
        runs: storage::list_session_runs(&conn, &input.session_id)?,
        checkpoints: storage::list_session_checkpoints(&conn, &input.session_id)?,
        permissions: storage::list_permission_requests(&conn, &input.session_id)?,
        jobs: storage::list_background_jobs(&conn, &input.session_id)?,
        todos: storage::list_todos(&conn, &input.session_id)?,
    })
}

#[tauri::command]
fn interrupt_session(app: AppHandle, session_id: String) -> Result<EventRecord, String> {
    let conn = storage::open_db(&app)?;
    runner::cancel_session(&conn, &session_id)
}

#[tauri::command]
async fn submit_prompt(
    app: AppHandle,
    input: SubmitPromptInput,
) -> Result<SessionEventsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = storage::open_db(&app)?;
        tauri::async_runtime::block_on(runner::submit_prompt(&app, &conn, input))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn prompt_session(
    app: AppHandle,
    input: PromptSessionInput,
) -> Result<SessionEventsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = storage::open_db(&app)?;
        tauri::async_runtime::block_on(runner::prompt_session(&app, &conn, input))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn wait_session(app: AppHandle, session_id: String) -> Result<SessionEventsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = storage::open_db(&app)?;
        tauri::async_runtime::block_on(runner::resume_session(&app, &conn, session_id))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn continue_session(
    app: AppHandle,
    session_id: String,
) -> Result<SessionEventsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = storage::open_db(&app)?;
        tauri::async_runtime::block_on(runner::continue_session(&app, &conn, session_id))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn await_session_idle(
    app: AppHandle,
    session_id: String,
) -> Result<SessionEventsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = storage::open_db(&app)?;
        tauri::async_runtime::block_on(runner::await_session_idle(&conn, session_id))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn recover_session_from_checkpoint(
    app: AppHandle,
    input: RecoverSessionInput,
) -> Result<SessionEventsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = storage::open_db(&app)?;
        tauri::async_runtime::block_on(runner::recover_session_from_checkpoint(
            &app,
            &conn,
            input.session_id,
            input.checkpoint_id,
        ))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn promote_task(
    app: AppHandle,
    session_id: String,
    task_session_id: String,
) -> Result<SessionEventsResponse, String> {
    let conn = storage::open_db(&app)?;
    runner::promote_task(&conn, &session_id, &task_session_id)
}

#[tauri::command]
async fn approve_tool_call(app: AppHandle, event_id: String) -> Result<EventRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = storage::open_db(&app)?;
        tauri::async_runtime::block_on(tools::approve_tool_call(&app, &conn, &event_id))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn reject_tool_call(app: AppHandle, event_id: String) -> Result<EventRecord, String> {
    let conn = storage::open_db(&app)?;
    tools::reject_tool_call(&conn, &event_id)
}

#[tauri::command]
fn delete_queued_input(app: AppHandle, input_id: String) -> Result<SessionEventsResponse, String> {
    let conn = storage::open_db(&app)?;
    runner::delete_queued_input(&conn, &input_id)
}

#[tauri::command]
async fn recover_background_task(
    app: AppHandle,
    input: RecoverBackgroundTaskInput,
) -> Result<SessionEventsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = storage::open_db(&app)?;
        tauri::async_runtime::block_on(runner::recover_background_task(&app, &conn, input))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn reply_permission(
    app: AppHandle,
    input: ReplyPermissionInput,
) -> Result<types::PermissionRequestRecord, String> {
    let conn = storage::open_db(&app)?;
    let request = storage::get_permission_request(&conn, &input.request_id)?;
    let session = storage::get_session(&conn, &request.session_id)?;
    storage::reply_permission_request(&conn, &input.request_id, input.reply, &session.project_root)
}

#[tauri::command]
fn wait_job(app: AppHandle, job_id: String) -> Result<serde_json::Value, String> {
    let conn = storage::open_db(&app)?;
    tools::wait_job(&conn, &job_id)
}

#[tauri::command]
fn cancel_job(app: AppHandle, job_id: String) -> Result<serde_json::Value, String> {
    let conn = storage::open_db(&app)?;
    tools::cancel_job(&conn, &job_id)
}

#[tauri::command]
fn read_job_logs(app: AppHandle, job_id: String) -> Result<serde_json::Value, String> {
    let conn = storage::open_db(&app)?;
    tools::read_job_logs(&conn, &job_id)
}

#[tauri::command]
fn rollback_snapshot(app: AppHandle, snapshot_id: String) -> Result<SnapshotRecord, String> {
    let conn = storage::open_db(&app)?;
    mutation::rollback_snapshot(&conn, &snapshot_id)
}

#[tauri::command]
async fn compact_session(
    app: AppHandle,
    session_id: String,
) -> Result<ContextSummaryRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = storage::open_db(&app)?;
        let session = storage::get_session(&conn, &session_id)?;
        match config_file::load_provider_request_config(
            &app,
            &session.project_root,
            &session.provider_id,
        ) {
            Ok(provider) => tauri::async_runtime::block_on(runner::compact_session_with_provider(
                &conn,
                &session_id,
                &provider,
            )),
            Err(_) => runner::compact_session(&conn, &session_id),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn load_shell_policy(app: AppHandle) -> Result<ShellPolicy, String> {
    let conn = storage::open_db(&app)?;
    storage::load_shell_policy(&conn)
}

#[tauri::command]
fn save_shell_policy(app: AppHandle, policy: ShellPolicy) -> Result<ShellPolicy, String> {
    let conn = storage::open_db(&app)?;
    storage::save_shell_policy(&conn, policy)
}

#[tauri::command]
fn persist_plan_file(app: AppHandle, input: PersistPlanInput) -> Result<String, String> {
    let conn = storage::open_db(&app)?;
    let session = storage::get_session(&conn, &input.session_id)?;
    let plan_text = input.plan_text.trim();
    if plan_text.is_empty() {
        return Err("计划内容不能为空。".to_string());
    }
    let path = util::plan_file_path(&session.created_at, &session.title);
    let event = storage::append_event(
        &conn,
        &session.id,
        "plan.persisted",
        json!({ "path": path }),
    )?;
    let content = if plan_text.starts_with('#') {
        format!("{}\n", plan_text.trim_end())
    } else {
        format!("# {}\n\n{}\n", session.title, plan_text)
    };
    let snapshot = mutation::write_file(&conn, &session, &event.id, &path, &content, None)?;
    storage::update_event_data(
        &conn,
        &event.id,
        &json!({ "path": snapshot.path, "snapshotId": snapshot.id }),
    )?;
    Ok(snapshot.path)
}

#[tauri::command]
fn reveal_project_path(app: AppHandle, input: RevealPathInput) -> Result<(), String> {
    let conn = storage::open_db(&app)?;
    let session = storage::get_session(&conn, &input.session_id)?;
    let root = std::fs::canonicalize(&session.project_root).map_err(|error| error.to_string())?;
    let target = util::resolve_writable_inside(&root, &input.path)?;
    let target_to_open = if target.exists() {
        target
    } else {
        target
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| format!("路径没有父目录: {}", input.path))?
    };
    reveal_in_file_manager(&target_to_open)
}

fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let directory = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        Command::new("xdg-open")
            .arg(directory)
            .spawn()
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

async fn recover_durable_state(app: AppHandle) {
    let app_for_prepare = app.clone();
    let pending_sessions = tauri::async_runtime::spawn_blocking(move || {
        let conn = storage::open_db(&app_for_prepare)?;
        runner::prepare_durable_recovery(&conn)
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|inner| inner);

    let pending_sessions = match pending_sessions {
        Ok(value) => value,
        Err(error) => {
            log::error!("durable recovery prepare failed: {error}");
            return;
        }
    };

    for session_id in pending_sessions {
        let app_for_session = app.clone();
        tauri::async_runtime::spawn(async move {
            let session_for_log = session_id.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                let conn = storage::open_db(&app_for_session)?;
                tauri::async_runtime::block_on(runner::wake_pending_session(
                    &app_for_session,
                    &conn,
                    session_id,
                ))
                .map(|_| ())
            })
            .await
            .map_err(|error| error.to_string())
            .and_then(|inner| inner);
            if let Err(error) = result {
                log::error!("durable recovery wake failed for {session_for_log}: {error}");
            }
        });
    }
}

#[tauri::command]
fn set_app_locale(locale: String) {
    i18n::set_app_locale(&locale);
}

#[tauri::command]
fn list_project_files(root: String) -> Result<Vec<ProjectFile>, String> {
    workspace::list_project_files(root)
}

#[tauri::command]
fn get_bridge_status() -> external_bridge::BridgeStatus {
    external_bridge::status()
}

#[tauri::command]
fn get_bridge_clients() -> Vec<external_bridge::ClientSnapshot> {
    external_bridge::clients()
}

#[tauri::command]
fn set_bridge_port(app: AppHandle, port: u16) -> Result<external_bridge::BridgeStatus, String> {
    external_bridge::save_port(&app, port)
}

#[tauri::command]
fn report_workspace_resolution(
    action: String,
    workspace_root: String,
    active_session_id: Option<String>,
    busy_reason: Option<String>,
) -> Result<external_bridge::WorkspaceResolutionState, String> {
    external_bridge::update_resolution(action, workspace_root, active_session_id, busy_reason)
}

#[tauri::command]
fn quit_app(app: AppHandle) -> Result<(), String> {
    external_bridge::mark_manual_shutdown()?;
    app.exit(0);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        let _ = app.emit("odot:bridge-wake", json!({ "source": "deep-link" }));
    }));
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(any(target_os = "linux", all(debug_assertions, target_os = "windows")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }
            event_bus::init();
            external_bridge::start(app.handle().clone());
            let app_handle = app.handle().clone();
            let recovery_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut receiver = event_bus::subscribe();
                loop {
                    match receiver.recv().await {
                        Ok(event) => {
                            let _ = app_handle.emit("odot:event", event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
            tauri::async_runtime::spawn(async move {
                recover_durable_state(recovery_app).await;
            });
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_float_drag,
            set_app_locale,
            save_provider,
            list_providers,
            delete_provider,
            load_provider_config,
            save_provider_config,
            get_model_reasoning_efforts,
            find_opencode_config,
            list_project_capabilities,
            save_mcp_server,
            delete_mcp_server,
            test_mcp_connection,
            import_skill,
            delete_skill,
            read_skill_content,
            create_session,
            list_sessions,
            get_session,
            delete_session,
            cancel_session,
            update_session_title,
            rename_session,
            update_session_mode,
            get_session_events,
            tail_session_events,
            interrupt_session,
            submit_prompt,
            prompt_session,
            wait_session,
            continue_session,
            await_session_idle,
            recover_session_from_checkpoint,
            recover_background_task,
            delete_queued_input,
            promote_task,
            approve_tool_call,
            reject_tool_call,
            reply_permission,
            wait_job,
            cancel_job,
            read_job_logs,
            rollback_snapshot,
            compact_session,
            load_shell_policy,
            save_shell_policy,
            persist_plan_file,
            reveal_project_path,
            list_project_files,
            get_bridge_status,
            get_bridge_clients,
            set_bridge_port,
            report_workspace_resolution,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
