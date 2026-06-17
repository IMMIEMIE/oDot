mod config_file;
mod mutation;
mod provider;
mod runner;
mod storage;
mod tools;
mod types;
mod util;
mod workspace;

use tauri::AppHandle;
use types::{
    ContextSummaryRecord, CreateSessionInput, EventRecord, ProjectFile, ProviderConfigFileResponse,
    ProviderInput, ProviderRecord, SessionEventsResponse, SessionRecord, ShellPolicy,
    SnapshotRecord, SubmitPromptInput, UpdateSessionModeInput, UpdateSessionTitleInput,
};

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
    storage::update_session_mode(&conn, &input.session_id, input.mode)
}

#[tauri::command]
fn get_session_events(app: AppHandle, session_id: String) -> Result<SessionEventsResponse, String> {
    let conn = storage::open_db(&app)?;
    storage::session_events_response(&conn, &session_id)
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
fn rollback_snapshot(app: AppHandle, snapshot_id: String) -> Result<SnapshotRecord, String> {
    let conn = storage::open_db(&app)?;
    mutation::rollback_snapshot(&conn, &snapshot_id)
}

#[tauri::command]
fn compact_session(app: AppHandle, session_id: String) -> Result<ContextSummaryRecord, String> {
    let conn = storage::open_db(&app)?;
    runner::compact_session(&conn, &session_id)
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
            submit_prompt,
            continue_session,
            approve_tool_call,
            reject_tool_call,
            rollback_snapshot,
            compact_session,
            load_shell_policy,
            save_shell_policy,
            list_project_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
