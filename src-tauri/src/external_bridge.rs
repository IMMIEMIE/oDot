use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    env, fs,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

const DEFAULT_BRIDGE_PORT: u16 = 39871;
const MAX_REQUEST_BYTES: usize = 1_250_000;
const BRIDGE_EVENT: &str = "odot:external-prompt-references";
const ENV_PORT: &str = "ODOT_BRIDGE_PORT";

static BRIDGE_STATUS: OnceLock<Arc<Mutex<BridgeStatus>>> = OnceLock::new();

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
pub struct BridgeStatus {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub configured_port: u16,
    pub port_source: String,
    pub settings_path: Option<String>,
    pub error: Option<String>,
    pub restart_required: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeSettings {
    port: Option<u16>,
}

pub fn start(app: AppHandle) {
    let config = resolve_config(&app);
    update_status(BridgeStatus {
        enabled: false,
        host: "127.0.0.1".to_string(),
        port: config.port,
        configured_port: config.port,
        port_source: config.source.clone(),
        settings_path: config
            .settings_path
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
                update_status(BridgeStatus {
                    enabled: true,
                    host: "127.0.0.1".to_string(),
                    port: actual_port,
                    configured_port: config.port,
                    port_source: config.source,
                    settings_path: config
                        .settings_path
                        .as_ref()
                        .map(|path| path.to_string_lossy().to_string()),
                    error: None,
                    restart_required: false,
                });
                loop {
                    match listener.accept().await {
                        Ok((stream, _)) => {
                            let app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = handle_connection(app, stream).await;
                            });
                        }
                        Err(error) => {
                            update_error(error.to_string());
                            break;
                        }
                    }
                }
            }
            Err(error) => {
                update_error(error.to_string());
            }
        }
    });
}

pub fn status() -> BridgeStatus {
    status_cell()
        .lock()
        .map(|status| status.clone())
        .unwrap_or_else(|_| BridgeStatus {
            enabled: false,
            host: "127.0.0.1".to_string(),
            port: DEFAULT_BRIDGE_PORT,
            configured_port: DEFAULT_BRIDGE_PORT,
            port_source: "default".to_string(),
            settings_path: None,
            error: Some("Bridge status lock is poisoned.".to_string()),
            restart_required: false,
        })
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

async fn handle_connection(app: AppHandle, mut stream: TcpStream) -> Result<(), String> {
    let request = read_http_request(&mut stream).await?;
    let response = route_request(app, request);
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn route_request(app: AppHandle, request: HttpRequest) -> String {
    if request.method == "OPTIONS" {
        return empty_response(204);
    }
    if request.method == "GET" && request.path == "/health" {
        return json_response(
            200,
            json!({ "ok": true, "name": "oDot bridge", "status": status() }),
        );
    }
    if request.method != "POST" || request.path != "/v1/prompt-references" {
        return json_response(404, json!({ "ok": false, "error": "Not found." }));
    }

    let payload = match serde_json::from_slice::<ExternalPromptReferencePayload>(&request.body) {
        Ok(payload) => payload,
        Err(error) => {
            return json_response(400, json!({ "ok": false, "error": error.to_string() }));
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

    let headers = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let content_length = content_length(&headers)?;
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

    let request_line = headers
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
    let body = buffer[header_end + 4..total_needed].to_vec();
    Ok(HttpRequest { method, path, body })
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
    response(status, "application/json; charset=utf-8", &body)
}

fn empty_response(status: u16) -> String {
    response(status, "text/plain; charset=utf-8", "")
}

fn response(status: u16, content_type: &str, body: &str) -> String {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nConnection: close\r\n\r\n{body}",
        body.as_bytes().len()
    )
}

struct HttpRequest {
    method: String,
    path: String,
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

fn status_cell() -> &'static Arc<Mutex<BridgeStatus>> {
    BRIDGE_STATUS.get_or_init(|| {
        Arc::new(Mutex::new(BridgeStatus {
            enabled: false,
            host: "127.0.0.1".to_string(),
            port: DEFAULT_BRIDGE_PORT,
            configured_port: DEFAULT_BRIDGE_PORT,
            port_source: "default".to_string(),
            settings_path: None,
            error: None,
            restart_required: false,
        }))
    })
}
