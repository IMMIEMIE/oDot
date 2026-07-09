use crate::{storage, types::SessionRecord};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
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
const ENV_PORT: &str = "ODOT_BRIDGE_PORT";

static BRIDGE_STATUS: OnceLock<Arc<Mutex<BridgeStatus>>> = OnceLock::new();
static BRIDGE_RUNTIME: OnceLock<Arc<Mutex<BridgeRuntime>>> = OnceLock::new();

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
    pub source: Option<String>,
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
}

#[derive(Debug)]
struct BridgeRuntime {
    token: String,
    owner_client_id: Option<String>,
    clients: HashMap<String, ClientState>,
    current: Option<WorkspaceResolutionState>,
}

impl Default for BridgeRuntime {
    fn default() -> Self {
        Self {
            token: Uuid::new_v4().to_string(),
            owner_client_id: None,
            clients: HashMap::new(),
            current: None,
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
    action: String,
    workspace_root: String,
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
    let mut runtime = runtime_cell()
        .lock()
        .map_err(|_| "Bridge state is unavailable.".to_string())?;
    let mut state = runtime.current.clone().unwrap_or(WorkspaceResolutionState {
        protocol_version: PROTOCOL_VERSION,
        request_id: Uuid::new_v4().to_string(),
        action: action.clone(),
        workspace_root: workspace_root.clone(),
        source: Some("vscode".to_string()),
        busy_reason: None,
        active_session_id: None,
        sessions: Vec::new(),
    });
    state.action = action;
    state.workspace_root = workspace_root;
    state.active_session_id = active_session_id;
    state.busy_reason = busy_reason;
    runtime.current = Some(state.clone());
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
        ("POST", "/v2/client/heartbeat") => route_heartbeat(request),
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

fn route_heartbeat(request: HttpRequest) -> String {
    let payload = match parse_client_request(&request) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
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
        if payload.sequence <= client.sequence {
            false
        } else {
            client.sequence = payload.sequence;
            client.focused = payload.focused;
            client.workspace_root = payload.workspace_root.clone();
            true
        }
    };
    if accepted && payload.focused {
        runtime.owner_client_id = Some(payload.client_id);
    }
    json_response(
        200,
        json!({
            "ok": true,
            "protocolVersion": PROTOCOL_VERSION,
            "owner": runtime.owner_client_id,
            "current": runtime.current
        }),
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

    {
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
        client.sequence = payload.sequence;
        client.focused = payload.focused;
        client.workspace_root = Some(canonical_root.clone());
        if runtime
            .current
            .as_ref()
            .is_some_and(|current| project_paths_equal(&current.workspace_root, &canonical_root))
        {
            return workspace_response(
                "ignored",
                &canonical_root,
                Vec::new(),
                runtime.current.clone(),
            );
        }
    }

    let conn = match storage::open_db(&app) {
        Ok(conn) => conn,
        Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
    };
    let normalized_workspace = normalize_project_path(&canonical_root);
    let mut sessions = match storage::list_sessions(&conn) {
        Ok(sessions) => sessions
            .into_iter()
            .filter(|session| normalize_project_path(&session.project_root) == normalized_workspace)
            .collect::<Vec<_>>(),
        Err(error) => return json_response(500, json!({ "ok": false, "error": error })),
    };
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let action = resolution_action(sessions.len());
    let state = WorkspaceResolutionState {
        protocol_version: PROTOCOL_VERSION,
        request_id: Uuid::new_v4().to_string(),
        action: action.to_string(),
        workspace_root: canonical_root,
        source: Some("vscode".to_string()),
        busy_reason: None,
        active_session_id: None,
        sessions,
    };
    if let Ok(mut runtime) = runtime_cell().lock() {
        runtime.current = Some(state.clone());
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
    if cfg!(windows) {
        if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = path.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    path.to_string()
}

fn normalize_project_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    if cfg!(windows) {
        normalized = normalized.to_ascii_lowercase();
    }
    normalized
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_windows_style_paths() {
        let normalized = normalize_project_path(r"C:\Work\Demo\\");
        assert!(!normalized.ends_with('/'));
        assert!(normalized.contains("/Work/") || normalized.contains("/work/"));
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
    fn ignores_background_non_owner_and_duplicate_sequences() {
        assert!(!activation_is_allowed(false, false, 2, 1));
        assert!(!activation_is_allowed(true, false, 1, 1));
        assert!(activation_is_allowed(true, false, 2, 1));
        assert!(activation_is_allowed(false, true, 2, 1));
    }

    #[test]
    fn responses_do_not_enable_browser_cors() {
        let response = json_response(200, json!({ "ok": true }));
        assert!(!response
            .to_ascii_lowercase()
            .contains("access-control-allow"));
    }
}
