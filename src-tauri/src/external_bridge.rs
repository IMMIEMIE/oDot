use crate::{storage, types::SessionRecord, util};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use uuid::Uuid;

const PROTOCOL_VERSION: u16 = 2;
const DEFAULT_BRIDGE_PORT: u16 = 39871;
const MAX_REQUEST_BYTES: usize = 1_250_000;
const BRIDGE_EVENT: &str = "odot:external-prompt-references";
const WORKSPACE_EVENT: &str = "odot:external-project-sessions";
const CLIENTS_EVENT: &str = "odot:bridge-clients";
const ENV_PORT: &str = "ODOT_BRIDGE_PORT";
// A client with no heartbeat within OFFLINE_MS is shown as offline; past
// REMOVE_MS it is pruned from the roster entirely. The reaper sweeps on this
// cadence so offline state stays fresh even when heartbeats stop arriving.
const CLIENT_OFFLINE_MS: u64 = 10_000;
const CLIENT_REMOVE_MS: u64 = 60_000;
const REAPER_INTERVAL_MS: u64 = 3_000;

static BRIDGE_STATUS: OnceLock<Arc<Mutex<BridgeStatus>>> = OnceLock::new();
static BRIDGE_RUNTIME: OnceLock<Arc<Mutex<BridgeRuntime>>> = OnceLock::new();
static WORKSPACE_ACTIVATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPromptReferencePayload {
    #[serde(default)]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub items: Vec<ExternalPromptReferenceItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPromptReferenceItem {
    #[serde(default)]
    pub item_type: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub absolute_path: Option<String>,
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub end_line: Option<u32>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceClientRequest {
    pub protocol_version: u16,
    pub client_id: String,
    pub sequence: u64,
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub installation_id: Option<String>,
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub sent_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceResolutionState {
    pub protocol_version: u16,
    pub request_id: String,
    pub action: String,
    pub workspace_root: String,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub installation_id: Option<String>,
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub busy_reason: Option<String>,
    #[serde(default)]
    pub active_session_id: Option<String>,
    pub sessions: Vec<SessionRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub enabled: bool,
    pub protocol_version: u16,
    pub host: String,
    pub port: u16,
    pub configured_port: u16,
    pub port_source: String,
    pub settings_path: Option<String>,
    pub discovery_path: Option<String>,
    pub error: Option<String>,
    pub restart_required: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeSettings {
    port: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeDiscovery {
    protocol_version: u16,
    host: String,
    port: u16,
    token: String,
    executable_path: Option<String>,
    pid: u32,
    started_at: u64,
}

#[derive(Debug, Default)]
struct ClientState {
    sequence: u64,
    focused: bool,
    workspace_root: Option<String>,
    source: Option<String>,
    display_name: Option<String>,
    installation_id: Option<String>,
    instance_id: Option<String>,
    active_session_id: Option<String>,
    active_workspace_key: Option<String>,
    last_seen: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientSnapshot {
    pub client_id: String,
    pub active_session_id: Option<String>,
    pub workspace_root: Option<String>,
    pub workspace_name: Option<String>,
    pub source: Option<String>,
    pub display_name: Option<String>,
    pub installation_id: Option<String>,
    pub instance_id: Option<String>,
    pub focused: bool,
    pub last_seen: u64,
    pub online: bool,
}

#[derive(Debug)]
struct BridgeRuntime {
    token: String,
    owner_client_id: Option<String>,
    clients: HashMap<String, ClientState>,
    current: Option<WorkspaceResolutionState>,
    pending_resolutions: HashMap<String, WorkspaceResolutionState>,
}

impl Default for BridgeRuntime {
    fn default() -> Self {
        Self {
            token: Uuid::new_v4().to_string(),
            owner_client_id: None,
            clients: HashMap::new(),
            current: None,
            pending_resolutions: HashMap::new(),
        }
    }
}

pub fn start(app: AppHandle) {
    clear_manual_shutdown();
    let config = resolve_config(&app);
    let discovery_path = discovery_path();
    update_status(BridgeStatus {
        enabled: false,
        protocol_version: PROTOCOL_VERSION,
        host: "127.0.0.1".to_string(),
        port: config.port,
        configured_port: config.port,
        port_source: config.source.clone(),
        settings_path: config
            .settings_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        discovery_path: discovery_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        error: None,
        restart_required: false,
    });

    spawn_reaper(app.clone());

    tauri::async_runtime::spawn(async move {
        match TcpListener::bind(("127.0.0.1", config.port)).await {
            Ok(listener) => {
                let actual_port = listener
                    .local_addr()
                    .map(|addr| addr.port())
                    .unwrap_or(config.port);
                let token = runtime_cell()
                    .lock()
                    .map(|runtime| runtime.token.clone())
                    .unwrap_or_default();
                if let Some(path) = discovery_path.as_ref() {
                    if let Err(error) = write_discovery(path, actual_port, &token) {
                        update_error(error);
                        return;
                    }
                } else {
                    update_error(
                        "Cannot resolve the user home directory for bridge discovery.".into(),
                    );
                    return;
                }
                update_status(BridgeStatus {
                    enabled: true,
                    protocol_version: PROTOCOL_VERSION,
                    host: "127.0.0.1".to_string(),
                    port: actual_port,
                    configured_port: config.port,
                    port_source: config.source,
                    settings_path: config
                        .settings_path
                        .as_ref()
                        .map(|path| path.to_string_lossy().to_string()),
                    discovery_path: discovery_path
                        .as_ref()
                        .map(|path| path.to_string_lossy().to_string()),
                    error: None,
                    restart_required: false,
                });
                loop {
                    match listener.accept().await {
                        Ok((stream, address)) if address.ip().is_loopback() => {
                            let app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = handle_connection(app, stream).await;
                            });
                        }
                        Ok((_stream, _)) => {}
                        Err(error) => {
                            update_error(error.to_string());
                            break;
                        }
                    }
                }
            }
            Err(error) => update_error(error.to_string()),
        }
    });
}

pub fn mark_manual_shutdown() -> Result<(), String> {
    let path = manual_shutdown_path()
        .ok_or_else(|| "Cannot resolve the manual shutdown marker path.".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        &path,
        format!(
            "{}\n",
            json!({
                "manualShutdown": true,
                "timestamp": SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64
            })
        ),
    )
    .map_err(|error| error.to_string())?;
    restrict_file_permissions(&path)
}

pub fn status() -> BridgeStatus {
    status_cell()
        .lock()
        .map(|status| status.clone())
        .unwrap_or_else(|_| default_status(Some("Bridge status lock is poisoned.".to_string())))
}

pub fn save_port(app: &AppHandle, port: u16) -> Result<BridgeStatus, String> {
    if port == 0 {
        return Err("Bridge port must be between 1 and 65535.".to_string());
    }
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_string_pretty(&BridgeSettings { port: Some(port) })
        .map_err(|error| error.to_string())?;
    fs::write(&path, format!("{content}\n")).map_err(|error| error.to_string())?;

    let mut next = status();
    next.configured_port = port;
    next.port_source = "settings".to_string();
    next.settings_path = Some(path.to_string_lossy().to_string());
    next.restart_required = next.port != port;
    update_status(next.clone());
    Ok(next)
}

pub fn update_resolution(
    app: &AppHandle,
    action: String,
    workspace_root: String,
    request_id: Option<String>,
    client_id: Option<String>,
    active_session_id: Option<String>,
    busy_reason: Option<String>,
) -> Result<WorkspaceResolutionState, String> {
    const ACTIONS: &[&str] = &[
        "ignored",
        "selected",
        "created",
        "choose",
        "deferredBusy",
        "needsSetup",
        "error",
    ];
    if !ACTIONS.contains(&action.as_str()) {
        return Err(format!("Unsupported workspace resolution action: {action}"));
    }
    let assigns_session = matches!(action.as_str(), "selected" | "created");
    let (state, binding) = {
        let mut runtime = runtime_cell()
            .lock()
            .map_err(|_| "Bridge state is unavailable.".to_string())?;
        let mut state = if let Some(request_id) = request_id.as_deref() {
            runtime
                .pending_resolutions
                .get(request_id)
                .cloned()
                .ok_or_else(|| "Workspace resolution request is stale or unknown.".to_string())?
        } else {
            runtime.current.clone().unwrap_or(WorkspaceResolutionState {
                protocol_version: PROTOCOL_VERSION,
                request_id: Uuid::new_v4().to_string(),
                action: action.clone(),
                workspace_root: workspace_root.clone(),
                client_id: client_id.clone(),
                source: None,
                display_name: None,
                installation_id: None,
                instance_id: None,
                busy_reason: None,
                active_session_id: None,
                sessions: Vec::new(),
            })
        };
        if let (Some(expected), Some(actual)) = (state.client_id.as_deref(), client_id.as_deref()) {
            if expected != actual {
                return Err("Workspace resolution client does not match the request.".to_string());
            }
        }
        if normalize_project_path(&state.workspace_root) != normalize_project_path(&workspace_root)
        {
            return Err("Workspace resolution path does not match the request.".to_string());
        }
        state.action = action.clone();
        state.workspace_root = workspace_root;
        state.client_id = client_id.clone().or(state.client_id);
        state.active_session_id = active_session_id.clone();
        state.busy_reason = busy_reason;

        let mut binding = None;
        if assigns_session {
            if let (Some(client_id), Some(session_id)) =
                (state.client_id.clone(), active_session_id.clone())
            {
                if let Some(client) = runtime.clients.get_mut(&client_id) {
                    client.active_session_id = Some(session_id.clone());
                    client.active_workspace_key =
                        Some(normalize_project_path(&state.workspace_root));
                }
                binding = Some(storage::IdeWorkspaceBinding {
                    client_id,
                    source: state
                        .source
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string()),
                    installation_id: state.installation_id.clone(),
                    instance_id: state.instance_id.clone(),
                    workspace_key: normalize_project_path(&state.workspace_root),
                    workspace_root: state.workspace_root.clone(),
                    session_id,
                });
            }
        }
        if matches!(
            action.as_str(),
            "selected" | "created" | "ignored" | "error"
        ) {
            runtime.pending_resolutions.remove(&state.request_id);
        } else {
            runtime
                .pending_resolutions
                .insert(state.request_id.clone(), state.clone());
        }
        runtime.current = Some(state.clone());
        (state, binding)
    };
    if let Some(binding) = binding {
        let conn = storage::open_db(app)?;
        storage::upsert_ide_workspace_binding(&conn, &binding)?;
    }
    Ok(state)
}

async fn handle_connection(app: AppHandle, mut stream: TcpStream) -> Result<(), String> {
    let response = match read_http_request(&mut stream).await {
        Ok(request) => route_request(app, request),
        Err(error) => json_response(413, json!({ "ok": false, "error": error })),
    };
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|error| error.to_string())
}

fn route_request(app: AppHandle, request: HttpRequest) -> String {
    if request.method == "OPTIONS" {
        return json_response(404, json!({ "ok": false, "error": "Not found." }));
    }
    if !request.path.starts_with("/v2/") {
        return json_response(
            426,
            json!({ "ok": false, "error": "Bridge protocol v2 is required.", "protocolVersion": PROTOCOL_VERSION }),
        );
    }
    if !authorized(&request) {
        return json_response(401, json!({ "ok": false, "error": "Unauthorized." }));
    }
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/v2/status") => route_status(),
        ("POST", "/v2/client/heartbeat") => route_heartbeat(app, request),
        ("POST", "/v2/client/disconnect") => route_disconnect(app, request),
        ("POST", "/v2/workspace/activate") => route_workspace_activate(app, request),
        ("POST", "/v2/prompt-references") => route_prompt_references(app, request),
        _ => json_response(404, json!({ "ok": false, "error": "Not found." })),
    }
}

fn route_status() -> String {
    let current = runtime_cell()
        .lock()
        .ok()
        .and_then(|runtime| runtime.current.clone());
    json_response(
        200,
        json!({
            "ok": true,
            "name": "oDot bridge",
            "protocolVersion": PROTOCOL_VERSION,
            "status": status(),
            "current": current
        }),
    )
}

fn route_heartbeat(app: AppHandle, request: HttpRequest) -> String {
    let payload = match parse_client_request(&request) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let now = now_ms();
    let mut runtime = match runtime_cell().lock() {
        Ok(runtime) => runtime,
        Err(_) => {
            return json_response(
                500,
                json!({ "ok": false, "error": "Bridge state is unavailable." }),
            )
        }
    };
    let accepted = {
        let client = runtime
            .clients
            .entry(payload.client_id.clone())
            .or_default();
        // Liveness + latest workspace/focus reflect every heartbeat, regardless of
        // sequence: the sequence gate only decides owner election, not presence.
        client.last_seen = now;
        client.focused = payload.focused;
        client.workspace_root = payload.workspace_root.clone();
        if payload.source.is_some() {
            client.source = payload.source.clone();
        }
        if payload.display_name.is_some() {
            client.display_name = payload.display_name.clone();
        }
        if payload.installation_id.is_some() {
            client.installation_id = payload.installation_id.clone();
        }
        if payload.instance_id.is_some() {
            client.instance_id = payload.instance_id.clone();
        }
        if payload.sequence > client.sequence {
            client.sequence = payload.sequence;
            true
        } else {
            false
        }
    };
    if accepted && payload.focused {
        runtime.owner_client_id = Some(payload.client_id.clone());
    }
    let roster = snapshot_from(&runtime, now);
    let owner = runtime.owner_client_id.clone();
    let current = runtime.current.clone();
    drop(runtime);
    let _ = app.emit(CLIENTS_EVENT, roster);
    json_response(
        200,
        json!({
            "ok": true,
            "protocolVersion": PROTOCOL_VERSION,
            "owner": owner,
            "current": current
        }),
    )
}

fn route_disconnect(app: AppHandle, request: HttpRequest) -> String {
    let payload = match parse_client_request(&request) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let roster = {
        let mut runtime = match runtime_cell().lock() {
            Ok(runtime) => runtime,
            Err(_) => {
                return json_response(
                    500,
                    json!({ "ok": false, "error": "Bridge state is unavailable." }),
                )
            }
        };
        runtime.clients.remove(&payload.client_id);
        runtime.pending_resolutions.retain(|_, resolution| {
            resolution.client_id.as_deref() != Some(payload.client_id.as_str())
        });
        if runtime.owner_client_id.as_deref() == Some(payload.client_id.as_str()) {
            runtime.owner_client_id = None;
        }
        snapshot_from(&runtime, now_ms())
    };
    let _ = app.emit(CLIENTS_EVENT, roster);
    json_response(
        200,
        json!({ "ok": true, "protocolVersion": PROTOCOL_VERSION }),
    )
}

fn route_workspace_activate(app: AppHandle, request: HttpRequest) -> String {
    let payload = match parse_client_request(&request) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    let workspace_root = match payload.workspace_root.as_deref().map(str::trim) {
        Some(root) if !root.is_empty() => root,
        _ => {
            return json_response(
                400,
                json!({ "ok": false, "error": "workspaceRoot cannot be empty." }),
            )
        }
    };
    let canonical_root = match canonical_project_path(workspace_root) {
        Ok(root) => root,
        Err(error) => return json_response(400, json!({ "ok": false, "error": error })),
    };
    let normalized_workspace = normalize_project_path(&canonical_root);
    // The frontend resolves an activation asynchronously (select/create/setup).
    // Serialize this route so a focus bounce cannot race through the gap before
    // the first request has been registered in pending_resolutions.
    let _activation_guard = match workspace_activation_lock().lock() {
        Ok(guard) => guard,
        Err(_) => {
            return json_response(
                500,
                json!({ "ok": false, "error": "Workspace activation state is unavailable." }),
            )
        }
    };

    let (runtime_session_id, claimed_session_ids) = {
        let mut runtime = match runtime_cell().lock() {
            Ok(runtime) => runtime,
            Err(_) => {
                return json_response(
                    500,
                    json!({ "ok": false, "error": "Bridge state is unavailable." }),
                )
            }
        };
        let owner_matches = runtime.owner_client_id.as_deref() == Some(payload.client_id.as_str());
        let last_sequence = runtime
            .clients
            .get(&payload.client_id)
            .map(|client| client.sequence)
            .unwrap_or_default();
        if !activation_is_allowed(
            owner_matches,
            payload.focused,
            payload.sequence,
            last_sequence,
        ) {
            return workspace_response(
                "ignored",
                &canonical_root,
                Vec::new(),
                runtime.current.clone(),
            );
        }
        if payload.focused {
            runtime.owner_client_id = Some(payload.client_id.clone());
        }
        let client = runtime
            .clients
            .entry(payload.client_id.clone())
            .or_default();
        let assigned = client
            .active_workspace_key
            .as_deref()
            .filter(|key| *key == normalized_workspace)
            .and(client.active_session_id.clone());
        client.sequence = payload.sequence;
        client.focused = payload.focused;
        client.workspace_root = Some(canonical_root.clone());
        if payload.source.is_some() {
            client.source = payload.source.clone();
        }
        if payload.display_name.is_some() {
            client.display_name = payload.display_name.clone();
        }
        if payload.installation_id.is_some() {
            client.installation_id = payload.installation_id.clone();
        }
        if payload.instance_id.is_some() {
            client.instance_id = payload.instance_id.clone();
        }
        client.last_seen = now_ms();
        if let Some(pending) = runtime
            .pending_resolutions
            .values()
            .find(|resolution| {
                resolution_matches_client_workspace(
                    resolution,
                    &payload.client_id,
                    &normalized_workspace,
                )
            })
            .cloned()
        {
            return json_response(
                200,
                json!({
                    "ok": true,
                    "protocolVersion": PROTOCOL_VERSION,
                    "deduplicated": true,
                    "resolution": pending
                }),
            );
        }
        let claimed = runtime
            .clients
            .iter()
            .filter(|(client_id, _)| client_id.as_str() != payload.client_id)
            .filter_map(|(_, client)| client.active_session_id.clone())
            .collect::<Vec<_>>();
        (assigned, claimed)
    };

    let conn = match storage::open_db(&app) {
        Ok(conn) => conn,
        Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
    };
    let persisted_session_id = match storage::get_ide_workspace_binding(
        &conn,
        &payload.client_id,
        &normalized_workspace,
    ) {
        Ok(binding) => binding.map(|binding| binding.session_id),
        Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
    };
    let reconnect_session_id = if runtime_session_id.is_none() && persisted_session_id.is_none() {
        match (
            payload.source.as_deref(),
            payload.installation_id.as_deref(),
        ) {
            (Some(source), Some(installation_id)) => {
                match storage::list_ide_workspace_reconnect_bindings(
                    &conn,
                    source,
                    installation_id,
                    &normalized_workspace,
                ) {
                    Ok(bindings) => available_reconnect_session_id(bindings, &claimed_session_ids),
                    Err(error) => {
                        return json_response(500, json!({ "ok": false, "error": error }))
                    }
                }
            }
            _ => None,
        }
    } else {
        None
    };
    let assigned_session_id = runtime_session_id
        .or(persisted_session_id)
        .or(reconnect_session_id);
    let mut sessions = match storage::list_sessions(&conn) {
        Ok(sessions) => sessions
            .into_iter()
            .filter(|session| normalize_project_path(&session.project_root) == normalized_workspace)
            .collect::<Vec<_>>(),
        Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
    };
    if let Some(assigned_session_id) = assigned_session_id.as_deref() {
        sessions.retain(|session| session.id == assigned_session_id);
    } else {
        // A newly connected IDE window owns a fresh conversation even when
        // another IDE already has a session for the same project directory.
        sessions.clear();
    }
    let assigned_session_id = sessions.first().map(|session| session.id.clone());
    if let Ok(mut runtime) = runtime_cell().lock() {
        if let Some(client) = runtime.clients.get_mut(&payload.client_id) {
            client.active_session_id = assigned_session_id.clone();
            client.active_workspace_key = assigned_session_id
                .as_ref()
                .map(|_| normalized_workspace.clone());
        }
    }
    if let Some(session_id) = assigned_session_id.as_deref() {
        let binding = storage::IdeWorkspaceBinding {
            client_id: payload.client_id.clone(),
            source: payload
                .source
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
            installation_id: payload.installation_id.clone(),
            instance_id: payload.instance_id.clone(),
            workspace_key: normalized_workspace.clone(),
            workspace_root: canonical_root.clone(),
            session_id: session_id.to_string(),
        };
        if let Err(error) = storage::upsert_ide_workspace_binding(&conn, &binding) {
            return json_response(500, json!({ "ok": false, "error": error }));
        }
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let action = resolution_action(sessions.len());
    let state = WorkspaceResolutionState {
        protocol_version: PROTOCOL_VERSION,
        request_id: Uuid::new_v4().to_string(),
        action: action.to_string(),
        workspace_root: canonical_root,
        client_id: Some(payload.client_id),
        source: payload.source,
        display_name: payload.display_name,
        installation_id: payload.installation_id,
        instance_id: payload.instance_id,
        busy_reason: None,
        active_session_id: assigned_session_id,
        sessions,
    };
    if let Ok(mut runtime) = runtime_cell().lock() {
        runtime.current = Some(state.clone());
        runtime
            .pending_resolutions
            .insert(state.request_id.clone(), state.clone());
        let roster = snapshot_from(&runtime, now_ms());
        drop(runtime);
        let _ = app.emit(CLIENTS_EVENT, roster);
    }
    if let Err(error) = app.emit(WORKSPACE_EVENT, state.clone()) {
        return json_response(500, json!({ "ok": false, "error": error.to_string() }));
    }
    json_response(
        200,
        json!({ "ok": true, "protocolVersion": PROTOCOL_VERSION, "resolution": state }),
    )
}

fn activation_is_allowed(
    owner_matches: bool,
    focused: bool,
    sequence: u64,
    last_sequence: u64,
) -> bool {
    (focused || owner_matches) && sequence > last_sequence
}

fn resolution_action(session_count: usize) -> &'static str {
    match session_count {
        0 => "created",
        1 => "selected",
        _ => "choose",
    }
}

fn available_reconnect_session_id(
    bindings: Vec<storage::IdeWorkspaceBinding>,
    claimed_session_ids: &[String],
) -> Option<String> {
    bindings
        .into_iter()
        .find(|binding| !claimed_session_ids.contains(&binding.session_id))
        .map(|binding| binding.session_id)
}

fn resolution_matches_client_workspace(
    resolution: &WorkspaceResolutionState,
    client_id: &str,
    workspace_key: &str,
) -> bool {
    resolution.client_id.as_deref() == Some(client_id)
        && normalize_project_path(&resolution.workspace_root) == workspace_key
}

fn route_prompt_references(app: AppHandle, request: HttpRequest) -> String {
    let payload = match serde_json::from_slice::<ExternalPromptReferencePayload>(&request.body) {
        Ok(payload) => payload,
        Err(error) => {
            return json_response(400, json!({ "ok": false, "error": error.to_string() }))
        }
    };
    if payload.items.is_empty() {
        return json_response(
            400,
            json!({ "ok": false, "error": "items cannot be empty." }),
        );
    }
    if payload.items.iter().any(|item| {
        item.absolute_path
            .as_deref()
            .or(item.path.as_deref())
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
    }) {
        return json_response(
            400,
            json!({ "ok": false, "error": "item path or absolutePath cannot be empty." }),
        );
    }
    if let Err(error) = app.emit(BRIDGE_EVENT, payload.clone()) {
        return json_response(500, json!({ "ok": false, "error": error.to_string() }));
    }
    json_response(200, json!({ "ok": true, "accepted": payload.items.len() }))
}

fn parse_client_request(request: &HttpRequest) -> Result<WorkspaceClientRequest, String> {
    let payload = serde_json::from_slice::<WorkspaceClientRequest>(&request.body)
        .map_err(|error| json_response(400, json!({ "ok": false, "error": error.to_string() })))?;
    if payload.protocol_version != PROTOCOL_VERSION {
        return Err(json_response(
            409,
            json!({ "ok": false, "error": "Protocol version mismatch.", "protocolVersion": PROTOCOL_VERSION }),
        ));
    }
    if payload.client_id.trim().is_empty() {
        return Err(json_response(
            400,
            json!({ "ok": false, "error": "clientId cannot be empty." }),
        ));
    }
    Ok(payload)
}

fn workspace_response(
    action: &str,
    workspace_root: &str,
    sessions: Vec<SessionRecord>,
    current: Option<WorkspaceResolutionState>,
) -> String {
    json_response(
        200,
        json!({
            "ok": true,
            "protocolVersion": PROTOCOL_VERSION,
            "resolution": {
                "requestId": Uuid::new_v4().to_string(),
                "action": action,
                "workspaceRoot": workspace_root,
                "sessions": sessions
            },
            "current": current
        }),
    )
}

fn authorized(request: &HttpRequest) -> bool {
    let expected = runtime_cell()
        .lock()
        .map(|runtime| format!("Bearer {}", runtime.token))
        .unwrap_or_default();
    request
        .headers
        .get("authorization")
        .is_some_and(|value| value == &expected)
}

fn canonical_project_path(path: &str) -> Result<String, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Workspace directory is unavailable: {error}"))?;
    if !canonical.is_dir() {
        return Err("Workspace root must be a directory.".to_string());
    }
    Ok(clean_canonical_path(&canonical.to_string_lossy()))
}

fn clean_canonical_path(path: &str) -> String {
    util::clean_windows_verbatim_path(path)
}

fn normalize_project_path(path: &str) -> String {
    let mut normalized = util::clean_windows_verbatim_path(path.trim()).replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    if cfg!(windows) {
        normalized = normalized.to_ascii_lowercase();
    }
    normalized
}

#[cfg(test)]
fn project_paths_equal(left: &str, right: &str) -> bool {
    normalize_project_path(left) == normalize_project_path(right)
}

async fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut buffer = Vec::new();
    let header_end;
    loop {
        let mut chunk = [0_u8; 4096];
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("Connection closed before a complete request was received.".to_string());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_REQUEST_BYTES {
            return Err("Request is too large.".to_string());
        }
        if let Some(index) = find_header_end(&buffer) {
            header_end = index;
            break;
        }
    }

    let headers_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let content_length = content_length(&headers_text)?;
    if content_length > MAX_REQUEST_BYTES {
        return Err("Request is too large.".to_string());
    }
    let total_needed = header_end + 4 + content_length;
    while buffer.len() < total_needed {
        let mut chunk = [0_u8; 4096];
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("Connection closed before the request body was received.".to_string());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_REQUEST_BYTES {
            return Err("Request is too large.".to_string());
        }
    }

    let request_line = headers_text
        .lines()
        .next()
        .ok_or_else(|| "Missing request line.".to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "Missing request method.".to_string())?
        .to_string();
    let path = parts
        .next()
        .ok_or_else(|| "Missing request path.".to_string())?
        .split('?')
        .next()
        .unwrap_or("/")
        .to_string();
    let headers = parse_headers(&headers_text);
    let body = buffer[header_end + 4..total_needed].to_vec();
    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn parse_headers(headers: &str) -> HashMap<String, String> {
    headers
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect()
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn content_length(headers: &str) -> Result<usize, String> {
    for line in headers.lines().skip(1) {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("content-length") {
            return value
                .trim()
                .parse::<usize>()
                .map_err(|_| "Invalid Content-Length header.".to_string());
        }
    }
    Ok(0)
}

fn json_response(status: u16, value: serde_json::Value) -> String {
    let body = value.to_string();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        426 => "Upgrade Required",
        500 => "Internal Server Error",
        _ => "OK",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct BridgeConfig {
    port: u16,
    source: String,
    settings_path: Option<PathBuf>,
}

fn resolve_config(app: &AppHandle) -> BridgeConfig {
    if let Ok(value) = env::var(ENV_PORT) {
        if let Ok(port) = value.trim().parse::<u16>() {
            if port > 0 {
                return BridgeConfig {
                    port,
                    source: "env".to_string(),
                    settings_path: settings_path(app).ok(),
                };
            }
        }
    }
    let settings_path = settings_path(app).ok();
    if let Some(path) = &settings_path {
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(settings) = serde_json::from_str::<BridgeSettings>(&content) {
                if let Some(port) = settings.port.filter(|port| *port > 0) {
                    return BridgeConfig {
                        port,
                        source: "settings".to_string(),
                        settings_path,
                    };
                }
            }
        }
    }
    BridgeConfig {
        port: DEFAULT_BRIDGE_PORT,
        source: "default".to_string(),
        settings_path,
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("bridge-settings.json"))
}

fn discovery_path() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .map(|home| home.join(".odot").join("bridge.json"))
}

fn manual_shutdown_path() -> Option<PathBuf> {
    discovery_path().and_then(|path| {
        path.parent()
            .map(|parent| parent.join("manual-shutdown.json"))
    })
}

fn clear_manual_shutdown() {
    if let Some(path) = manual_shutdown_path() {
        let _ = fs::remove_file(path);
    }
}

fn write_discovery(path: &Path, port: u16, token: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid discovery path.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let discovery = BridgeDiscovery {
        protocol_version: PROTOCOL_VERSION,
        host: "127.0.0.1".to_string(),
        port,
        token: token.to_string(),
        executable_path: env::current_exe()
            .ok()
            .map(|path| path.to_string_lossy().to_string()),
        pid: std::process::id(),
        started_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    };
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(
        &temporary,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&discovery).map_err(|error| error.to_string())?
        ),
    )
    .map_err(|error| error.to_string())?;
    restrict_file_permissions(&temporary)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[cfg(unix)]
fn restrict_file_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn restrict_file_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn update_error(error: String) {
    let mut next = status();
    next.enabled = false;
    next.error = Some(error);
    update_status(next);
}

fn update_status(next: BridgeStatus) {
    if let Ok(mut status) = status_cell().lock() {
        *status = next;
    }
}

fn default_status(error: Option<String>) -> BridgeStatus {
    BridgeStatus {
        enabled: false,
        protocol_version: PROTOCOL_VERSION,
        host: "127.0.0.1".to_string(),
        port: DEFAULT_BRIDGE_PORT,
        configured_port: DEFAULT_BRIDGE_PORT,
        port_source: "default".to_string(),
        settings_path: None,
        discovery_path: discovery_path().map(|path| path.to_string_lossy().to_string()),
        error,
        restart_required: false,
    }
}

fn status_cell() -> &'static Arc<Mutex<BridgeStatus>> {
    BRIDGE_STATUS.get_or_init(|| Arc::new(Mutex::new(default_status(None))))
}

fn runtime_cell() -> &'static Arc<Mutex<BridgeRuntime>> {
    BRIDGE_RUNTIME.get_or_init(|| Arc::new(Mutex::new(BridgeRuntime::default())))
}

fn workspace_activation_lock() -> &'static Mutex<()> {
    WORKSPACE_ACTIVATION_LOCK.get_or_init(|| Mutex::new(()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn workspace_name(root: &str) -> Option<String> {
    let name = root
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn snapshot_from(runtime: &BridgeRuntime, now: u64) -> Vec<ClientSnapshot> {
    let mut list: Vec<ClientSnapshot> = runtime
        .clients
        .iter()
        .map(|(client_id, state)| {
            let workspace_root = state.workspace_root.clone();
            ClientSnapshot {
                client_id: client_id.clone(),
                active_session_id: state.active_session_id.clone(),
                workspace_name: workspace_root.as_deref().and_then(workspace_name),
                workspace_root,
                source: state.source.clone(),
                display_name: state.display_name.clone(),
                installation_id: state.installation_id.clone(),
                instance_id: state.instance_id.clone(),
                focused: state.focused,
                last_seen: state.last_seen,
                online: now.saturating_sub(state.last_seen) <= CLIENT_OFFLINE_MS,
            }
        })
        .collect();
    list.sort_by(|left, right| {
        right
            .focused
            .cmp(&left.focused)
            .then_with(|| left.workspace_name.cmp(&right.workspace_name))
            .then_with(|| left.client_id.cmp(&right.client_id))
    });
    list
}

/// Current connected-client roster for initial frontend load / poll fallback.
pub fn clients() -> Vec<ClientSnapshot> {
    let now = now_ms();
    runtime_cell()
        .lock()
        .map(|runtime| snapshot_from(&runtime, now))
        .unwrap_or_default()
}

/// Sweep stale clients: prune entries past REMOVE_MS and re-emit the roster so the
/// frontend's online/offline flags stay current even when heartbeats stop arriving.
fn spawn_reaper(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(REAPER_INTERVAL_MS));
        loop {
            ticker.tick().await;
            let now = now_ms();
            let roster = {
                let mut runtime = match runtime_cell().lock() {
                    Ok(runtime) => runtime,
                    Err(_) => continue,
                };
                let before = runtime.clients.len();
                runtime
                    .clients
                    .retain(|_, state| now.saturating_sub(state.last_seen) <= CLIENT_REMOVE_MS);
                if runtime.clients.len() != before {
                    if let Some(owner) = runtime.owner_client_id.clone() {
                        if !runtime.clients.contains_key(&owner) {
                            runtime.owner_client_id = None;
                        }
                    }
                    let retained_client_ids = runtime.clients.keys().cloned().collect::<Vec<_>>();
                    runtime.pending_resolutions.retain(|_, resolution| {
                        resolution
                            .client_id
                            .as_ref()
                            .map(|client_id| retained_client_ids.contains(client_id))
                            .unwrap_or(true)
                    });
                }
                snapshot_from(&runtime, now)
            };
            if !roster.is_empty() {
                let _ = app.emit(CLIENTS_EVENT, roster);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_windows_style_paths() {
        let normalized = normalize_project_path(r"C:\Work\Demo\\");
        assert!(!normalized.ends_with('/'));
        assert!(normalized.contains("/Work/") || normalized.contains("/work/"));
        assert_eq!(
            normalize_project_path(r"\\?\C:\Work\Demo"),
            normalize_project_path(r"C:\Work\Demo")
        );
    }

    #[test]
    fn removes_windows_verbatim_prefixes() {
        if cfg!(windows) {
            assert_eq!(clean_canonical_path(r"\\?\C:\Work\Demo"), r"C:\Work\Demo");
            assert_eq!(
                clean_canonical_path(r"\\?\UNC\server\share\Demo"),
                r"\\server\share\Demo"
            );
        }
    }

    #[test]
    fn treats_separator_and_case_variants_as_the_same_windows_project() {
        if cfg!(windows) {
            assert!(project_paths_equal(r"C:\Work\Demo\\", "c:/work/demo"));
        } else {
            assert!(project_paths_equal("/work/demo/", "/work/demo"));
        }
    }

    #[test]
    fn rejects_missing_authorization() {
        let request = HttpRequest {
            method: "GET".into(),
            path: "/v2/status".into(),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        assert!(!authorized(&request));
    }

    #[test]
    fn accepts_current_bearer_token() {
        let token = runtime_cell().lock().unwrap().token.clone();
        let request = HttpRequest {
            method: "GET".into(),
            path: "/v2/status".into(),
            headers: HashMap::from([("authorization".into(), format!("Bearer {token}"))]),
            body: Vec::new(),
        };
        assert!(authorized(&request));
    }

    #[test]
    fn resolves_zero_one_and_many_sessions() {
        assert_eq!(resolution_action(0), "created");
        assert_eq!(resolution_action(1), "selected");
        assert_eq!(resolution_action(2), "choose");
    }

    #[test]
    fn reconnect_never_reuses_a_session_claimed_by_another_live_window() {
        let binding = |client_id: &str, session_id: &str| storage::IdeWorkspaceBinding {
            client_id: client_id.to_string(),
            source: "vscode".to_string(),
            installation_id: Some("install-a".to_string()),
            instance_id: Some(client_id.to_string()),
            workspace_key: "e:/odot".to_string(),
            workspace_root: "E:/oDot".to_string(),
            session_id: session_id.to_string(),
        };
        let bindings = vec![binding("old-a", "session-a"), binding("old-b", "session-b")];

        assert_eq!(
            available_reconnect_session_id(bindings, &["session-a".to_string()]).as_deref(),
            Some("session-b")
        );
    }

    #[test]
    fn pending_resolution_deduplicates_only_the_same_client_and_workspace() {
        let resolution = WorkspaceResolutionState {
            protocol_version: PROTOCOL_VERSION,
            request_id: "request-a".to_string(),
            action: "created".to_string(),
            workspace_root: r"C:\Work\Demo".to_string(),
            client_id: Some("vscode:window-a".to_string()),
            source: Some("vscode".to_string()),
            display_name: Some("VS Code".to_string()),
            installation_id: Some("install-a".to_string()),
            instance_id: Some("window-a".to_string()),
            busy_reason: None,
            active_session_id: None,
            sessions: Vec::new(),
        };
        let workspace_key = normalize_project_path(r"C:\Work\Demo");

        assert!(resolution_matches_client_workspace(
            &resolution,
            "vscode:window-a",
            &workspace_key
        ));
        assert!(!resolution_matches_client_workspace(
            &resolution,
            "vscode:window-b",
            &workspace_key
        ));
        assert!(!resolution_matches_client_workspace(
            &resolution,
            "vscode:window-a",
            &normalize_project_path(r"C:\Work\Other")
        ));
    }

    #[test]
    fn ignores_background_non_owner_and_duplicate_sequences() {
        assert!(!activation_is_allowed(false, false, 2, 1));
        assert!(!activation_is_allowed(true, false, 1, 1));
        assert!(activation_is_allowed(true, false, 2, 1));
        assert!(activation_is_allowed(false, true, 2, 1));
    }

    #[test]
    fn derives_workspace_name_from_root() {
        assert_eq!(workspace_name(r"C:\Work\Demo").as_deref(), Some("Demo"));
        assert_eq!(workspace_name("/home/me/proj/").as_deref(), Some("proj"));
        assert_eq!(workspace_name("").as_deref(), None);
    }

    #[test]
    fn snapshot_marks_clients_online_within_window() {
        let now = 1_000_000;
        let mut runtime = BridgeRuntime::default();
        runtime.clients.insert(
            "fresh".to_string(),
            ClientState {
                sequence: 1,
                focused: true,
                workspace_root: Some(r"C:\Work\Fresh".to_string()),
                source: Some("vscode".to_string()),
                active_session_id: Some("session-fresh".to_string()),
                last_seen: now - 2_000,
                ..ClientState::default()
            },
        );
        runtime.clients.insert(
            "stale".to_string(),
            ClientState {
                sequence: 1,
                focused: false,
                workspace_root: Some(r"C:\Work\Stale".to_string()),
                source: None,
                active_session_id: None,
                last_seen: now - (CLIENT_OFFLINE_MS + 5_000),
                ..ClientState::default()
            },
        );
        let roster = snapshot_from(&runtime, now);
        // Focused client sorts first.
        assert_eq!(roster[0].client_id, "fresh");
        assert!(roster[0].online);
        assert_eq!(roster[0].workspace_name.as_deref(), Some("Fresh"));
        assert_eq!(roster[0].source.as_deref(), Some("vscode"));
        assert_eq!(
            roster[0].active_session_id.as_deref(),
            Some("session-fresh")
        );
        let stale = roster.iter().find(|c| c.client_id == "stale").unwrap();
        assert!(!stale.online);
    }

    #[test]
    fn responses_do_not_enable_browser_cors() {
        let response = json_response(200, json!({ "ok": true }));
        assert!(!response
            .to_ascii_lowercase()
            .contains("access-control-allow"));
    }
}
