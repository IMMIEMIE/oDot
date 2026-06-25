mod config_file;
mod error_model;
mod event_bus;
mod llm_runtime;
mod mutation;
mod provider;
mod runner;
mod storage;
mod tools;
mod types;
mod util;
mod workspace;

use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use types::{
    ContextSummaryRecord, CreateSessionInput, EventRecord, ProjectFile, PromptSessionInput,
    ProviderConfigFileResponse, ProviderInput, ProviderRecord, RecoverSessionInput,
    ReplyPermissionInput, SessionEventsResponse, SessionRecord, ShellPolicy, SnapshotRecord,
    SubmitPromptInput, TailSessionEventsInput, UpdateSessionModeInput, UpdateSessionTitleInput,
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
) -> Result<ProviderConfigFileResponse, String> {
    config_file::load_provider_config_for_project(&app, project_root)
}

#[tauri::command]
fn save_provider_config(
    app: AppHandle,
    content: String,
    project_root: Option<String>,
) -> Result<ProviderConfigFileResponse, String> {
    config_file::save_provider_config(&app, content, project_root)
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
fn delete_session(app: AppHandle, session_id: String) -> Result<(), String> {
    let conn = storage::open_db(&app)?;
    storage::delete_session(&conn, &session_id)
}

#[tauri::command]
fn cancel_session(app: AppHandle, session_id: String) -> Result<EventRecord, String> {
    let conn = storage::open_db(&app)?;
    storage::cancel_session(&conn, &session_id)
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
fn update_session_mode(
    app: AppHandle,
    input: UpdateSessionModeInput,
) -> Result<SessionRecord, String> {
    let conn = storage::open_db(&app)?;
    storage::update_session_mode(&conn, &input.session_id, input.mode, input.shell_mode)
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
    })
}

#[tauri::command]
fn interrupt_session(app: AppHandle, session_id: String) -> Result<EventRecord, String> {
    let conn = storage::open_db(&app)?;
    storage::cancel_session(&conn, &session_id)
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
async fn approve_tool_call(app: AppHandle, event_id: String) -> Result<EventRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = storage::open_db(&app)?;
        tools::approve_tool_call(&conn, &event_id)
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
fn list_project_files(root: String) -> Result<Vec<ProjectFile>, String> {
    workspace::list_project_files(root)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            event_bus::init();
            let app_handle = app.handle().clone();
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
            save_provider,
            list_providers,
            delete_provider,
            load_provider_config,
            save_provider_config,
            create_session,
            list_sessions,
            delete_session,
            cancel_session,
            update_session_title,
            update_session_mode,
            get_session_events,
            tail_session_events,
            interrupt_session,
            submit_prompt,
            prompt_session,
            wait_session,
            continue_session,
            recover_session_from_checkpoint,
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
            list_project_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
