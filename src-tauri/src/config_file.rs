use crate::{
    storage,
    types::{
        McpConfigFileResponse, McpServerConfig, OpenAiApiMode, ProviderConfigFileResponse,
        ProviderInput, ProviderKind, ProviderPricing, ProviderRecord, ProviderRequestConfig,
        ToolMode,
    },
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize)]
struct ODotConfig {
    model: Option<String>,
    #[serde(default)]
    provider: HashMap<String, ConfigProvider>,
    #[serde(default)]
    enabled_providers: Vec<String>,
    #[serde(default)]
    disabled_providers: Vec<String>,
    #[serde(default)]
    skills: Option<Value>,
    #[serde(default, rename = "loadedSkills", alias = "loaded_skills")]
    loaded_skills: Option<Value>,
    mcp: Option<ConfigMcp>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ConfigMcp {
    #[serde(default)]
    servers: HashMap<String, ConfigMcpServer>,
}

#[derive(Debug, Clone, Deserialize)]
struct ConfigMcpServer {
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    disabled: Option<bool>,
    #[serde(default)]
    command: Option<Value>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default, alias = "environment")]
    env: HashMap<String, String>,
    cwd: Option<String>,
    #[serde(default, rename = "timeoutSeconds", alias = "timeout_seconds")]
    timeout_seconds: Option<u64>,
    #[serde(default)]
    timeout: Option<u64>,
    #[serde(
        default = "default_true",
        rename = "requireApproval",
        alias = "require_approval"
    )]
    require_approval: bool,
    #[serde(default, rename = "readOnly", alias = "read_only")]
    read_only: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SkillConfig {
    pub sources: Vec<String>,
    pub loaded: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ConfigProvider {
    name: Option<String>,
    api: Option<String>,
    npm: Option<String>,
    #[serde(default, rename = "toolMode", alias = "tool_mode")]
    tool_mode: Option<ToolMode>,
    request: Option<ConfigRequest>,
    #[serde(default)]
    env: Vec<String>,
    #[serde(default)]
    options: HashMap<String, Value>,
    #[serde(default)]
    models: HashMap<String, ConfigModel>,
}

#[derive(Debug, Clone, Deserialize)]
struct ConfigModel {
    id: Option<String>,
    name: Option<String>,
    provider: Option<ModelProvider>,
    #[serde(default, rename = "toolMode", alias = "tool_mode")]
    tool_mode: Option<ToolMode>,
    limit: Option<ModelLimit>,
    pricing: Option<ModelPricing>,
    request: Option<ConfigRequest>,
    #[serde(default)]
    options: HashMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModelLimit {
    context: Option<u64>,
    input: Option<u64>,
    output: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ModelPricing {
    #[serde(default)]
    input: f64, // price per 1M input tokens (USD)
    #[serde(default)]
    output: f64, // price per 1M output tokens (USD)
    #[serde(default)]
    cache_read: Option<f64>, // price per 1M cache read tokens (USD)
    #[serde(default)]
    cache_write: Option<f64>, // price per 1M cache write tokens (USD)
}

#[derive(Debug, Clone, Deserialize)]
struct ModelProvider {
    api: Option<String>,
    npm: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ConfigRequest {
    api: Option<OpenAiApiMode>,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: serde_json::Map<String, Value>,
}

#[derive(Debug, PartialEq, Eq)]
enum CredentialProblem {
    Missing,
    Placeholder,
}

fn default_true() -> bool {
    true
}

pub fn load_provider_config_for_project(
    app: &AppHandle,
    project_root: Option<String>,
    config_path: Option<String>,
) -> Result<ProviderConfigFileResponse, String> {
    let path =
        resolve_config_path_from_input(app, project_root.as_deref(), config_path.as_deref())?;
    if !path.exists() {
        return Err("CONFIG_NOT_FOUND".to_string());
    }

    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let (providers, selected_provider_id) = sync_provider_config(app, &content, &path)?;
    Ok(ProviderConfigFileResponse {
        path: path.to_string_lossy().to_string(),
        content,
        providers,
        selected_provider_id,
    })
}

pub fn save_provider_config(
    app: &AppHandle,
    content: String,
    project_root: Option<String>,
    config_path: Option<String>,
) -> Result<ProviderConfigFileResponse, String> {
    parse_provider_inputs(&content)?;

    let path =
        resolve_config_path_from_input(app, project_root.as_deref(), config_path.as_deref())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, &content).map_err(|error| error.to_string())?;
    let (providers, selected_provider_id) = sync_provider_config(app, &content, &path)?;
    Ok(ProviderConfigFileResponse {
        path: path.to_string_lossy().to_string(),
        content,
        providers,
        selected_provider_id,
    })
}

pub fn load_provider_request_config(
    app: &AppHandle,
    project_root: &str,
    provider_record_id: &str,
) -> Result<ProviderRequestConfig, String> {
    let path = provider_config_path(app, project_root, provider_record_id)?;
    load_provider_request_config_from_path(&path, provider_record_id)
}

pub fn load_provider_request_config_for_session(
    app: &AppHandle,
    project_root: &str,
    provider_record_id: &str,
    config_path: Option<&str>,
) -> Result<ProviderRequestConfig, String> {
    let path = if config_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        resolve_config_path_from_input(app, Some(project_root), config_path)?
    } else {
        provider_config_path(app, project_root, provider_record_id)?
    };
    load_provider_request_config_from_path(&path, provider_record_id)
}

fn load_provider_request_config_from_path(
    path: &Path,
    provider_record_id: &str,
) -> Result<ProviderRequestConfig, String> {
    ensure_config_file(path)?;
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    resolve_provider_request_config_with_env(&content, provider_record_id, path, |name| {
        env::var(name).ok()
    })
}

pub fn load_mcp_server_configs(
    app: &AppHandle,
    project_root: &str,
    config_path: Option<&str>,
) -> Result<Vec<McpServerConfig>, String> {
    let path = resolve_config_path_from_input(app, Some(project_root), config_path)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let config = parse_config(&content)?;
    let Some(mcp) = config.mcp else {
        return Ok(Vec::new());
    };
    let mut servers = mcp
        .servers
        .into_iter()
        .filter_map(|(id, server)| config_mcp_server(&id, server).transpose())
        .collect::<Result<Vec<_>, _>>()?;
    servers.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(servers)
}

pub fn resolved_config_path_for_project(
    app: &AppHandle,
    project_root: &str,
    config_path: Option<&str>,
) -> Result<PathBuf, String> {
    resolve_config_path_from_input(app, Some(project_root), config_path)
}

pub fn odot_global_skill_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(app_dir.join("skills"))
}

pub fn load_skill_config(
    app: &AppHandle,
    project_root: &str,
    config_path: Option<&str>,
) -> Result<SkillConfig, String> {
    let global_skill_dir = odot_global_skill_dir(app)?.to_string_lossy().to_string();
    let path = resolve_config_path_from_input(app, Some(project_root), config_path)?;
    if !path.exists() {
        return Ok(SkillConfig {
            sources: vec![global_skill_dir],
            loaded: Vec::new(),
        });
    }
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let config = parse_config(&content)?;
    let mut skill_config =
        skill_config_from_values(config.skills.as_ref(), config.loaded_skills.as_ref());
    if !skill_config
        .sources
        .iter()
        .any(|source| source == &global_skill_dir)
    {
        skill_config.sources.insert(0, global_skill_dir);
    }
    Ok(skill_config)
}

pub fn save_mcp_server_entry(
    app: &AppHandle,
    project_root: &str,
    config_path: Option<&str>,
    server: &McpServerConfig,
) -> Result<McpConfigFileResponse, String> {
    let path = resolve_config_path_from_input(app, Some(project_root), config_path)?;

    let mut config: Value = if path.exists() {
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        serde_json::from_str(&content)
            .map_err(|error| format!("配置文件 JSON 解析失败: {error}"))?
    } else {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        serde_json::json!({})
    };

    let root = config
        .as_object_mut()
        .ok_or_else(|| "配置文件必须是 JSON 对象。".to_string())?;

    let mcp_value = root
        .entry("mcp")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let mcp_obj = mcp_value
        .as_object_mut()
        .ok_or_else(|| "mcp 字段必须是 JSON 对象。".to_string())?;

    let servers_value = mcp_obj
        .entry("servers")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let servers_obj = servers_value
        .as_object_mut()
        .ok_or_else(|| "mcp.servers 字段必须是 JSON 对象。".to_string())?;

    servers_obj.insert(
        server.id.clone(),
        serde_json::json!({
            "enabled": server.enabled,
            "command": server.command,
            "args": server.args,
            "env": server.env,
            "cwd": server.cwd,
            "timeoutSeconds": server.timeout_seconds,
            "requireApproval": server.require_approval,
            "readOnly": server.read_only,
        }),
    );

    let content = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(&path, format!("{content}\n")).map_err(|error| error.to_string())?;

    mcp_config_file_response(app, project_root, &path, format!("{content}\n"))
}

pub fn remove_mcp_server_entry(
    app: &AppHandle,
    project_root: &str,
    config_path: Option<&str>,
    server_id: &str,
) -> Result<McpConfigFileResponse, String> {
    let path = resolve_config_path_from_input(app, Some(project_root), config_path)?;
    if !path.exists() {
        return Ok(McpConfigFileResponse {
            path: path.to_string_lossy().to_string(),
            content: String::new(),
            mcp_servers: Vec::new(),
        });
    }

    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut config: Value = serde_json::from_str(&content)
        .map_err(|error| format!("配置文件 JSON 解析失败: {error}"))?;

    if let Some(root) = config.as_object_mut() {
        if let Some(mcp) = root.get_mut("mcp").and_then(Value::as_object_mut) {
            if let Some(servers) = mcp.get_mut("servers").and_then(Value::as_object_mut) {
                servers.remove(server_id);
            }
        }
    }

    let content = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(&path, format!("{content}\n")).map_err(|error| error.to_string())?;

    mcp_config_file_response(app, project_root, &path, format!("{content}\n"))
}

fn mcp_config_file_response(
    app: &AppHandle,
    project_root: &str,
    path: &Path,
    content: String,
) -> Result<McpConfigFileResponse, String> {
    let path_string = path.to_string_lossy().to_string();
    let mcp_servers = load_mcp_server_configs(app, project_root, Some(&path_string))?;
    Ok(McpConfigFileResponse {
        path: path_string,
        content,
        mcp_servers,
    })
}

fn config_mcp_server(id: &str, server: ConfigMcpServer) -> Result<Option<McpServerConfig>, String> {
    let Some(command_value) = server.command else {
        return Ok(None);
    };
    let (command, mut command_args) = mcp_command_parts(id, command_value)?;
    command_args.extend(server.args);
    let timeout_seconds = mcp_timeout_seconds(server.timeout_seconds, server.timeout);
    Ok(Some(McpServerConfig {
        id: id.to_string(),
        enabled: server
            .disabled
            .map(|value| !value)
            .unwrap_or(server.enabled),
        command,
        args: command_args,
        env: server.env,
        cwd: server.cwd,
        timeout_seconds,
        require_approval: server.require_approval,
        read_only: server.read_only,
    }))
}

fn mcp_command_parts(id: &str, value: Value) -> Result<(String, Vec<String>), String> {
    match value {
        Value::String(command) if !command.trim().is_empty() => {
            Ok((command.trim().to_string(), Vec::new()))
        }
        Value::Array(items) => {
            let mut parts = items
                .into_iter()
                .filter_map(|item| item.as_str().map(str::trim).map(ToString::to_string))
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>();
            if parts.is_empty() {
                return Err(format!("MCP server '{id}' command 不能为空。"));
            }
            let command = parts.remove(0);
            Ok((command, parts))
        }
        _ => Err(format!(
            "MCP server '{id}' command 必须是字符串或字符串数组。"
        )),
    }
}

fn mcp_timeout_seconds(timeout_seconds: Option<u64>, timeout: Option<u64>) -> u64 {
    if let Some(seconds) = timeout_seconds {
        return seconds.clamp(1, 600);
    }
    match timeout {
        Some(value) if value > 600 => value.div_ceil(1000).clamp(1, 600),
        Some(value) => value.clamp(1, 600),
        None => 60,
    }
}

fn skill_config_from_values(skills: Option<&Value>, loaded_skills: Option<&Value>) -> SkillConfig {
    let mut config = SkillConfig::default();
    if let Some(skills) = skills {
        match skills {
            Value::Array(items) => config.sources.extend(string_list(items)),
            Value::Object(object) => {
                for key in ["sources", "paths", "dirs", "directories"] {
                    config.sources.extend(value_string_list(object.get(key)));
                }
                for key in ["load", "loaded", "default", "defaults"] {
                    config.loaded.extend(value_string_list(object.get(key)));
                }
            }
            _ => {}
        }
    }
    config.loaded.extend(value_string_list(loaded_skills));
    dedupe_strings(&mut config.sources);
    dedupe_strings(&mut config.loaded);
    config
}

fn value_string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => string_list(items),
        Some(Value::String(item)) => {
            let trimmed = item.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed.to_string()]
            }
        }
        _ => Vec::new(),
    }
}

fn string_list(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn dedupe_strings(items: &mut Vec<String>) {
    let mut seen = HashSet::new();
    items.retain(|item| seen.insert(item.clone()));
}

fn sync_provider_config(
    app: &AppHandle,
    content: &str,
    config_path: &Path,
) -> Result<(Vec<ProviderRecord>, Option<String>), String> {
    let (inputs, selected_provider_id) = parse_provider_inputs(content)?;
    let conn = storage::open_db(app)?;
    let mut records = Vec::with_capacity(inputs.len());

    let config_path = config_path.to_string_lossy().to_string();
    for mut input in inputs {
        input.config_path = Some(config_path.clone());
        records.push(storage::save_provider(&conn, input)?);
    }

    Ok((records, selected_provider_id))
}

fn parse_config(content: &str) -> Result<ODotConfig, String> {
    serde_json::from_str(content).map_err(|error| format!("Provider JSON 配置解析失败: {error}"))
}

fn parse_provider_inputs(content: &str) -> Result<(Vec<ProviderInput>, Option<String>), String> {
    let config = parse_config(content)?;
    let selected_provider_id = config.model.clone();
    let enabled_providers: HashSet<String> = config.enabled_providers.into_iter().collect();
    let disabled_providers: HashSet<String> = config.disabled_providers.into_iter().collect();
    let mut records = Vec::new();

    for (provider_id, provider) in config.provider {
        if disabled_providers.contains(&provider_id)
            || (!enabled_providers.is_empty() && !enabled_providers.contains(&provider_id))
        {
            continue;
        }

        for (model_key, model) in model_entries(&provider) {
            let record_id = format!("{provider_id}/{model_key}");
            let api_model = model.id.clone().unwrap_or_else(|| model_key.clone());
            let display_name = format!(
                "{} / {}",
                provider.name.clone().unwrap_or_else(|| provider_id.clone()),
                model.name.clone().unwrap_or_else(|| model_key.clone())
            );
            let npm = model
                .provider
                .as_ref()
                .and_then(|item| item.npm.as_deref())
                .or(provider.npm.as_deref())
                .unwrap_or_default();
            let api = model
                .provider
                .as_ref()
                .and_then(|item| item.api.clone())
                .or_else(|| provider.api.clone())
                .or_else(|| provider_option_string(&provider, "baseURL"))
                .or_else(|| provider_option_string(&provider, "base_url"))
                .or_else(|| provider_option_string(&provider, "api"));

            records.push(ProviderInput {
                id: Some(record_id),
                kind: infer_provider_kind(&provider_id, npm),
                name: display_name,
                base_url: api,
                model: api_model,
                api_key: None,
                config_path: None,
            });
        }
    }

    records.sort_by(|a, b| a.name.cmp(&b.name));
    let selected_provider_id = selected_provider_id.filter(|id| {
        records
            .iter()
            .any(|record| record.id.as_deref() == Some(id))
    });
    Ok((records, selected_provider_id))
}

fn resolve_provider_request_config_with_env<F>(
    content: &str,
    provider_record_id: &str,
    config_path: &Path,
    env_get: F,
) -> Result<ProviderRequestConfig, String>
where
    F: Fn(&str) -> Option<String>,
{
    let config = parse_config(content)?;
    let (provider_id, model_key) =
        split_provider_record_id(provider_record_id).ok_or_else(|| {
            format!(
            "AI 服务配置 id 无效: {provider_record_id}. 期望格式为 provider/model，配置文件: {}",
            config_path.display()
        )
        })?;

    if config
        .disabled_providers
        .iter()
        .any(|item| item == provider_id)
    {
        return Err(format!(
            "AI 服务配置已被禁用: {provider_record_id}，配置文件: {}",
            config_path.display()
        ));
    }
    if !config.enabled_providers.is_empty()
        && !config
            .enabled_providers
            .iter()
            .any(|item| item == provider_id)
    {
        return Err(format!(
            "AI 服务配置未在 enabled_providers 中启用: {provider_record_id}，配置文件: {}",
            config_path.display()
        ));
    }

    let provider = config.provider.get(provider_id).ok_or_else(|| {
        format!(
            "找不到 AI 服务配置: {provider_record_id}，配置文件: {}",
            config_path.display()
        )
    })?;
    let default_model;
    let model = if provider.models.is_empty() && model_key == "default" {
        default_model = ConfigModel {
            id: None,
            name: None,
            provider: None,
            tool_mode: None,
            limit: None,
            pricing: None,
            request: None,
            options: HashMap::new(),
        };
        &default_model
    } else {
        provider.models.get(model_key).ok_or_else(|| {
            format!(
                "找不到 AI 模型配置: {provider_record_id}，配置文件: {}",
                config_path.display()
            )
        })?
    };

    let npm = model
        .provider
        .as_ref()
        .and_then(|item| item.npm.as_deref())
        .or(provider.npm.as_deref())
        .unwrap_or_default();
    let kind = infer_provider_kind(provider_id, npm);
    let tool_mode = resolve_tool_mode(
        &kind,
        model
            .tool_mode
            .or(provider.tool_mode)
            .unwrap_or(ToolMode::Auto),
    );
    let openai_api_mode = model
        .request
        .as_ref()
        .and_then(|request| request.api)
        .or_else(|| provider.request.as_ref().and_then(|request| request.api))
        .unwrap_or_default();
    let base_url = model
        .provider
        .as_ref()
        .and_then(|item| item.api.clone())
        .or_else(|| provider.api.clone())
        .or_else(|| provider_option_string(provider, "baseURL"))
        .or_else(|| provider_option_string(provider, "base_url"))
        .or_else(|| provider_option_string(provider, "api"));
    let api_key = resolve_api_key(provider, env_get).map_err(|problem| {
        credential_error(
            config_path,
            provider_id,
            provider_record_id,
            provider,
            problem,
        )
    })?;
    let headers = merge_headers(provider, model);
    let body = merge_body(provider, model);
    let context_token_limit = model.limit.as_ref().and_then(|limit| limit.context);
    let input_token_limit = model.limit.as_ref().and_then(|limit| limit.input);
    let output_token_limit = model.limit.as_ref().and_then(|limit| limit.output);
    let pricing = model
        .pricing
        .as_ref()
        .map(provider_pricing)
        .unwrap_or_default();

    Ok(ProviderRequestConfig {
        kind,
        tool_mode,
        openai_api_mode,
        base_url,
        model: model.id.clone().unwrap_or_else(|| model_key.to_string()),
        api_key,
        headers,
        body,
        context_token_limit,
        input_token_limit,
        output_token_limit,
        pricing,
        config_path: config_path.to_string_lossy().to_string(),
    })
}

fn config_path(app: &AppHandle, project_root: Option<&str>) -> Result<PathBuf, String> {
    let fallback = app_config_path(app)?;
    Ok(resolve_config_path(project_root, &fallback))
}

fn resolve_config_path_from_input(
    app: &AppHandle,
    project_root: Option<&str>,
    selected_config_path: Option<&str>,
) -> Result<PathBuf, String> {
    let Some(value) = selected_config_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return config_path(app, project_root);
    };
    let path = PathBuf::from(value);
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| !extension.eq_ignore_ascii_case("json"))
        .unwrap_or(true)
    {
        return Err("配置文件必须是 .json 文件。".to_string());
    }

    let absolute = if path.is_absolute() {
        path
    } else if let Some(root) = project_root.map(str::trim).filter(|root| !root.is_empty()) {
        PathBuf::from(root).join(path)
    } else {
        app_config_path(app)?
            .parent()
            .map(|parent| parent.join(&path))
            .unwrap_or(path)
    };
    let parent = absolute
        .parent()
        .ok_or_else(|| "配置文件路径缺少父目录。".to_string())?;
    if !parent.exists() {
        return Err(format!("配置文件父目录不存在: {}", parent.display()));
    }

    let parent = parent.canonicalize().map_err(|error| error.to_string())?;
    let filename = absolute
        .file_name()
        .ok_or_else(|| "配置文件路径缺少文件名。".to_string())?;
    let resolved = parent.join(filename);
    ensure_config_path_allowed(app, project_root, &resolved)?;
    Ok(resolved)
}

fn ensure_config_path_allowed(
    app: &AppHandle,
    project_root: Option<&str>,
    path: &Path,
) -> Result<(), String> {
    let mut roots = app_config_path(app)?
        .parent()
        .map(|path| vec![path.to_path_buf()])
        .unwrap_or_default();
    if let Some(root) = project_root.map(str::trim).filter(|root| !root.is_empty()) {
        roots.push(PathBuf::from(root));
    }
    let allowed = roots.into_iter().any(|root| {
        root.canonicalize()
            .ok()
            .map(|root| path.starts_with(root))
            .unwrap_or(false)
    });
    if allowed {
        Ok(())
    } else {
        Err(format!(
            "配置文件必须位于当前项目目录或应用配置目录内: {}",
            path.display()
        ))
    }
}

fn provider_config_path(
    app: &AppHandle,
    project_root: &str,
    provider_record_id: &str,
) -> Result<PathBuf, String> {
    let conn = storage::open_db(app)?;
    if let Ok(provider) = storage::get_provider(&conn, provider_record_id) {
        if let Some(path) = provider.config_path.as_deref() {
            return resolve_config_path_from_input(app, Some(project_root), Some(path));
        }
    }
    config_path(app, Some(project_root))
}

fn app_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(app_dir.join("odot.json"))
}

fn resolve_config_path(project_root: Option<&str>, fallback: &Path) -> PathBuf {
    if let Some(root) = project_root
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let candidate = PathBuf::from(root).join("odot.json");
        if candidate.exists() {
            return candidate;
        }
    }

    fallback.to_path_buf()
}

fn ensure_config_file(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, default_config()).map_err(|error| error.to_string())
}

pub fn find_opencode_config(project_root: Option<&str>) -> Result<Option<String>, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(root) = project_root.map(str::trim).filter(|v| !v.is_empty()) {
        candidates.push(PathBuf::from(root).join("opencode.json"));
    }

    let home = env::var("USERPROFILE").or_else(|_| env::var("HOME"));
    if let Ok(home) = home {
        let h = PathBuf::from(&home);
        candidates.push(h.join(".config").join("opencode").join("opencode.json"));
        candidates.push(h.join("opencode.json"));
        candidates.push(h.join(".opencode.json"));
        candidates.push(
            h.join("AppData")
                .join("Roaming")
                .join("opencode")
                .join("opencode.json"),
        );
        candidates.push(
            h.join("AppData")
                .join("Local")
                .join("opencode")
                .join("opencode.json"),
        );
    }

    if let Ok(appdata) = env::var("APPDATA") {
        candidates.push(
            PathBuf::from(appdata)
                .join("opencode")
                .join("opencode.json"),
        );
    }

    for candidate in candidates {
        if candidate.exists() {
            let content = fs::read_to_string(&candidate).map_err(|e| e.to_string())?;
            if let Ok(config) = serde_json::from_str::<Value>(&content) {
                if config.get("provider").is_some() {
                    return Ok(Some(content));
                }
            }
        }
    }

    Ok(None)
}

fn model_entries(provider: &ConfigProvider) -> Vec<(String, ConfigModel)> {
    if provider.models.is_empty() {
        vec![(
            "default".to_string(),
            ConfigModel {
                id: None,
                name: None,
                provider: None,
                tool_mode: None,
                limit: None,
                pricing: None,
                request: None,
                options: HashMap::new(),
            },
        )]
    } else {
        provider.models.clone().into_iter().collect()
    }
}

fn provider_pricing(pricing: &ModelPricing) -> ProviderPricing {
    ProviderPricing {
        input_per_million: pricing.input,
        output_per_million: pricing.output,
        cache_read_per_million: pricing.cache_read.unwrap_or(pricing.input),
        cache_write_per_million: pricing.cache_write.unwrap_or(pricing.input),
    }
}

fn merge_headers(provider: &ConfigProvider, model: &ConfigModel) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    extend_headers(&mut headers, provider_options_headers(provider));
    if let Some(request) = &provider.request {
        extend_headers(&mut headers, request.headers.clone());
    }
    extend_headers(&mut headers, model_options_headers(model));
    if let Some(request) = &model.request {
        extend_headers(&mut headers, request.headers.clone());
    }
    headers
}

fn extend_headers(target: &mut HashMap<String, String>, source: HashMap<String, String>) {
    for (key, value) in source {
        if !key.trim().is_empty() && !value.trim().is_empty() {
            target.insert(key, value);
        }
    }
}

fn provider_options_headers(provider: &ConfigProvider) -> HashMap<String, String> {
    option_string_map(&provider.options, "headers")
}

fn model_options_headers(model: &ConfigModel) -> HashMap<String, String> {
    option_string_map(&model.options, "headers")
}

fn option_string_map(options: &HashMap<String, Value>, key: &str) -> HashMap<String, String> {
    options
        .get(key)
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn merge_body(provider: &ConfigProvider, model: &ConfigModel) -> serde_json::Map<String, Value> {
    let mut body = serde_json::Map::new();
    extend_body(&mut body, provider_options_body(provider));
    if let Some(request) = &provider.request {
        extend_body(&mut body, request.body.clone());
    }
    extend_body(&mut body, model_options_body(model));
    if let Some(request) = &model.request {
        extend_body(&mut body, request.body.clone());
    }
    body
}

fn extend_body(
    target: &mut serde_json::Map<String, Value>,
    source: serde_json::Map<String, Value>,
) {
    for (key, value) in source {
        if !key.trim().is_empty() {
            target.insert(key, value);
        }
    }
}

fn provider_options_body(provider: &ConfigProvider) -> serde_json::Map<String, Value> {
    option_object(&provider.options, "body")
}

fn model_options_body(model: &ConfigModel) -> serde_json::Map<String, Value> {
    let mut body = model
        .options
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), "headers" | "body"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<serde_json::Map<_, _>>();
    extend_body(&mut body, option_object(&model.options, "body"));
    body
}

fn option_object(options: &HashMap<String, Value>, key: &str) -> serde_json::Map<String, Value> {
    options
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn split_provider_record_id(value: &str) -> Option<(&str, &str)> {
    value
        .split_once('/')
        .filter(|(provider_id, model_id)| !provider_id.is_empty() && !model_id.is_empty())
}

fn infer_provider_kind(provider_id: &str, npm: &str) -> ProviderKind {
    let value = format!("{provider_id} {npm}").to_ascii_lowercase();
    if value.contains("anthropic") {
        if provider_id == "anthropic" {
            ProviderKind::Anthropic
        } else {
            ProviderKind::AnthropicCompatible
        }
    } else if provider_id == "openai" {
        ProviderKind::OpenAi
    } else {
        ProviderKind::OpenAiCompatible
    }
}

fn resolve_tool_mode(kind: &ProviderKind, requested: ToolMode) -> ToolMode {
    match requested {
        ToolMode::Auto => match kind {
            ProviderKind::OpenAi | ProviderKind::OpenAiCompatible => ToolMode::Native,
            ProviderKind::Anthropic | ProviderKind::AnthropicCompatible => ToolMode::Json,
        },
        other => other,
    }
}

fn resolve_api_key<F>(provider: &ConfigProvider, env_get: F) -> Result<String, CredentialProblem>
where
    F: Fn(&str) -> Option<String>,
{
    let mut saw_placeholder = false;
    for key in ["apiKey", "api_key", "key"] {
        if let Some(value) = provider.options.get(key).and_then(Value::as_str) {
            match usable_secret(value) {
                Some(secret) => return Ok(secret),
                None if !value.trim().is_empty() => saw_placeholder = true,
                None => {}
            }
        }
    }

    for name in &provider.env {
        if let Some(value) = env_get(name) {
            match usable_secret(&value) {
                Some(secret) => return Ok(secret),
                None if !value.trim().is_empty() => saw_placeholder = true,
                None => {}
            }
        }
    }

    if saw_placeholder {
        Err(CredentialProblem::Placeholder)
    } else {
        Err(CredentialProblem::Missing)
    }
}

fn usable_secret(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || is_placeholder_secret(trimmed) {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn is_placeholder_secret(value: &str) -> bool {
    value.len() >= 2 && value.starts_with('<') && value.ends_with('>')
}

fn credential_error(
    config_path: &Path,
    provider_id: &str,
    provider_record_id: &str,
    provider: &ConfigProvider,
    problem: CredentialProblem,
) -> String {
    let env_hint = if provider.env.is_empty() {
        "也可以在 provider.<id>.env 中声明环境变量名".to_string()
    } else {
        format!("或设置这些环境变量之一: {}", provider.env.join(", "))
    };
    match problem {
        CredentialProblem::Missing => format!(
            "AI 服务配置缺少 API Key: {provider_record_id}，配置文件: {}。请在 provider.{provider_id}.options.apiKey 写入真实密钥，{env_hint}。",
            config_path.display()
        ),
        CredentialProblem::Placeholder => format!(
            "AI 服务配置中的 API Key 仍是占位符: {provider_record_id}，配置文件: {}。请把 provider.{provider_id}.options.apiKey 的 <...> 替换为真实密钥，{env_hint}。",
            config_path.display()
        ),
    }
}

fn provider_option_string(provider: &ConfigProvider, key: &str) -> Option<String> {
    provider
        .options
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn default_config() -> &'static str {
    r#"{
  "$schema": "https://opencode.ai/config.json",
  "model": "openai/gpt-4.1-mini",
  "skills": {
    "sources": [],
    "load": []
  },
  "mcp": {
    "servers": {}
  },
  "provider": {
    "openai": {
      "name": "OpenAI",
      "api": "https://api.openai.com/v1",
      "env": ["OPENAI_API_KEY"],
      "models": {
        "gpt-4.1-mini": {
          "name": "GPT-4.1 Mini"
        }
      }
    },
    "openai-compatible": {
      "name": "OpenAI Compatible",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://example.com/v1",
        "apiKey": "<YOUR_API_KEY>"
      },
      "models": {
        "your-model": {
          "name": "Your Model"
        }
      }
    },
    "anthropic": {
      "name": "Anthropic",
      "api": "https://api.anthropic.com/v1",
      "env": ["ANTHROPIC_API_KEY"],
      "npm": "@ai-sdk/anthropic",
      "models": {
        "claude-3-5-sonnet-latest": {
          "name": "Claude 3.5 Sonnet"
        }
      }
    }
  }
}
"#
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_config(api_key: &str) -> String {
        format!(
            r#"{{
  "$schema": "https://opencode.ai/config.json",
  "model": "volcengine-plan/ark-code-latest",
  "provider": {{
    "volcengine-plan": {{
      "npm": "@ai-sdk/openai-compatible",
      "name": "Volcano Engine",
      "env": ["VOLCENGINE_API_KEY"],
      "options": {{
        "baseURL": "https://ark.cn-beijing.volces.com/api/coding/v3",
        "apiKey": "{api_key}"
      }},
      "models": {{
        "ark-code-latest": {{
          "name": "ark-code-latest",
          "limit": {{
            "context": 256000,
            "input": 240000,
            "output": 4096
          }}
        }}
      }}
    }}
  }}
}}"#
        )
    }

    #[test]
    fn expands_opencode_style_provider_models() {
        let (providers, selected) = parse_provider_inputs(&sample_config("ark-real-key")).unwrap();
        let provider = providers
            .iter()
            .find(|provider| provider.id.as_deref() == Some("volcengine-plan/ark-code-latest"))
            .unwrap();

        assert_eq!(selected.as_deref(), Some("volcengine-plan/ark-code-latest"));
        assert!(matches!(provider.kind, ProviderKind::OpenAiCompatible));
        assert_eq!(
            provider.base_url.as_deref(),
            Some("https://ark.cn-beijing.volces.com/api/coding/v3")
        );
        assert_eq!(provider.model, "ark-code-latest");
        assert!(provider.api_key.is_none());
    }

    #[test]
    fn request_config_reads_json_api_key_before_env() {
        let config = sample_config("ark-json-key");
        let request = resolve_provider_request_config_with_env(
            &config,
            "volcengine-plan/ark-code-latest",
            Path::new("C:/Users/test/AppData/Roaming/dev.odot.desktop/odot.json"),
            |name| (name == "VOLCENGINE_API_KEY").then(|| "ark-env-key".to_string()),
        )
        .unwrap();

        assert_eq!(request.api_key, "ark-json-key");
        assert_eq!(request.tool_mode, ToolMode::Native);
        assert_eq!(request.openai_api_mode, OpenAiApiMode::ChatCompletions);
        assert_eq!(request.context_token_limit, Some(256000));
        assert_eq!(request.input_token_limit, Some(240000));
        assert_eq!(request.output_token_limit, Some(4096));
        assert_eq!(
            request.base_url.as_deref(),
            Some("https://ark.cn-beijing.volces.com/api/coding/v3")
        );
    }

    #[test]
    fn request_config_falls_back_to_env_api_key() {
        let config = sample_config("");
        let request = resolve_provider_request_config_with_env(
            &config,
            "volcengine-plan/ark-code-latest",
            Path::new("C:/Users/test/AppData/Roaming/dev.odot.desktop/odot.json"),
            |name| (name == "VOLCENGINE_API_KEY").then(|| "ark-env-key".to_string()),
        )
        .unwrap();

        assert_eq!(request.api_key, "ark-env-key");
    }

    #[test]
    fn provider_request_api_can_enable_responses() {
        let config = r#"{
  "model": "volcengine-plan/ark-code-latest",
  "provider": {
    "volcengine-plan": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://ark.cn-beijing.volces.com/api/coding/v3",
        "apiKey": "ark-json-key"
      },
      "request": {
        "api": "responses"
      },
      "models": {
        "ark-code-latest": {}
      }
    }
  }
}"#;

        let request = resolve_provider_request_config_with_env(
            config,
            "volcengine-plan/ark-code-latest",
            Path::new("C:/Users/test/AppData/Roaming/dev.odot.desktop/odot.json"),
            |_| None,
        )
        .unwrap();

        assert_eq!(request.openai_api_mode, OpenAiApiMode::Responses);
    }

    #[test]
    fn model_request_api_overrides_provider_request_api() {
        let config = r#"{
  "model": "volcengine-plan/ark-code-latest",
  "provider": {
    "volcengine-plan": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://ark.cn-beijing.volces.com/api/coding/v3",
        "apiKey": "ark-json-key"
      },
      "request": {
        "api": "responses"
      },
      "models": {
        "ark-code-latest": {
          "request": {
            "api": "chatCompletions"
          }
        }
      }
    }
  }
}"#;

        let request = resolve_provider_request_config_with_env(
            config,
            "volcengine-plan/ark-code-latest",
            Path::new("C:/Users/test/AppData/Roaming/dev.odot.desktop/odot.json"),
            |_| None,
        )
        .unwrap();

        assert_eq!(request.openai_api_mode, OpenAiApiMode::ChatCompletions);
    }

    #[test]
    fn openai_defaults_to_native_tool_mode() {
        let config = r#"{
  "model": "openai/gpt-4.1-mini",
  "provider": {
    "openai": {
      "api": "https://api.openai.com/v1",
      "options": {
        "apiKey": "openai-key"
      },
      "models": {
        "gpt-4.1-mini": {
          "name": "GPT-4.1 Mini"
        }
      }
    }
  }
}"#;

        let request = resolve_provider_request_config_with_env(
            config,
            "openai/gpt-4.1-mini",
            Path::new("C:/Users/test/AppData/Roaming/dev.odot.desktop/odot.json"),
            |_| None,
        )
        .unwrap();

        assert!(matches!(request.kind, ProviderKind::OpenAi));
        assert_eq!(request.tool_mode, ToolMode::Native);
    }

    #[test]
    fn model_tool_mode_overrides_compatible_default() {
        let config = r#"{
  "model": "volcengine-plan/ark-code-latest",
  "provider": {
    "volcengine-plan": {
      "npm": "@ai-sdk/openai-compatible",
      "tool_mode": "json",
      "options": {
        "baseURL": "https://ark.cn-beijing.volces.com/api/coding/v3",
        "apiKey": "ark-json-key"
      },
      "models": {
        "ark-code-latest": {
          "toolMode": "native"
        }
      }
    }
  }
}"#;

        let request = resolve_provider_request_config_with_env(
            config,
            "volcengine-plan/ark-code-latest",
            Path::new("C:/Users/test/AppData/Roaming/dev.odot.desktop/odot.json"),
            |_| None,
        )
        .unwrap();

        assert!(matches!(request.kind, ProviderKind::OpenAiCompatible));
        assert_eq!(request.tool_mode, ToolMode::Native);
    }

    #[test]
    fn explicit_json_tool_mode_keeps_json_protocol() {
        let config = r#"{
  "model": "volcengine-plan/ark-code-latest",
  "provider": {
    "volcengine-plan": {
      "npm": "@ai-sdk/openai-compatible",
      "toolMode": "json",
      "options": {
        "baseURL": "https://ark.cn-beijing.volces.com/api/coding/v3",
        "apiKey": "ark-json-key"
      },
      "models": {
        "ark-code-latest": {}
      }
    }
  }
}"#;

        let request = resolve_provider_request_config_with_env(
            config,
            "volcengine-plan/ark-code-latest",
            Path::new("C:/Users/test/AppData/Roaming/dev.odot.desktop/odot.json"),
            |_| None,
        )
        .unwrap();

        assert!(matches!(request.kind, ProviderKind::OpenAiCompatible));
        assert_eq!(request.tool_mode, ToolMode::Json);
    }

    #[test]
    fn request_config_carries_opencode_headers_and_body_options() {
        let config = r#"{
  "$schema": "https://opencode.ai/config.json",
  "model": "volcengine-plan/ark-code-latest",
  "provider": {
    "volcengine-plan": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://ark.cn-beijing.volces.com/api/coding/v3",
        "apiKey": "ark-json-key",
        "headers": {
          "x-provider": "provider"
        },
        "body": {
          "providerOnly": true
        }
      },
      "request": {
        "headers": {
          "x-request": "provider-request"
        },
        "body": {
          "service_tier": "priority"
        }
      },
      "models": {
        "ark-code-latest": {
          "name": "ark-code-latest",
          "options": {
            "reasoningEffort": "high",
            "body": {
              "temperature": 0.1
            }
          },
          "request": {
            "headers": {
              "x-model": "model-request"
            },
            "body": {
              "top_p": 0.8
            }
          }
        }
      }
    }
  }
}"#;

        let request = resolve_provider_request_config_with_env(
            config,
            "volcengine-plan/ark-code-latest",
            Path::new("C:/Users/test/AppData/Roaming/dev.odot.desktop/odot.json"),
            |_| None,
        )
        .unwrap();

        assert_eq!(
            request.headers.get("x-provider").map(String::as_str),
            Some("provider")
        );
        assert_eq!(
            request.headers.get("x-request").map(String::as_str),
            Some("provider-request")
        );
        assert_eq!(
            request.headers.get("x-model").map(String::as_str),
            Some("model-request")
        );
        assert_eq!(request.body.get("providerOnly"), Some(&Value::Bool(true)));
        assert_eq!(
            request.body.get("service_tier"),
            Some(&Value::String("priority".to_string()))
        );
        assert_eq!(
            request.body.get("reasoningEffort"),
            Some(&Value::String("high".to_string()))
        );
        assert_eq!(request.body.get("temperature"), Some(&json!(0.1)));
        assert_eq!(request.body.get("top_p"), Some(&json!(0.8)));
        assert!(!request.body.contains_key("apiKey"));
        assert!(!request.body.contains_key("baseURL"));
    }

    #[test]
    fn placeholder_api_key_is_rejected_without_env() {
        let error = resolve_provider_request_config_with_env(
            &sample_config("<ARK_API_KEY>"),
            "volcengine-plan/ark-code-latest",
            Path::new("C:/Users/test/AppData/Roaming/dev.odot.desktop/odot.json"),
            |_| None,
        )
        .unwrap_err();

        assert!(error.contains("占位符"));
        assert!(error.contains("volcengine-plan/ark-code-latest"));
        assert!(!error.contains("<ARK_API_KEY>"));
    }

    #[test]
    fn project_local_config_path_wins_over_app_data_config() {
        let root = env::temp_dir().join(format!("odot-config-test-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        let app_data = root.join("app-data");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&app_data).unwrap();

        let fallback = app_data.join("odot.json");
        let project_config = project.join("odot.json");
        fs::write(&project_config, sample_config("ark-project-key")).unwrap();

        assert_eq!(
            resolve_config_path(Some(project.to_string_lossy().as_ref()), &fallback),
            project_config
        );
        assert_eq!(
            resolve_config_path(
                Some(project.join("missing").to_string_lossy().as_ref()),
                &fallback
            ),
            fallback
        );

        let _ = fs::remove_dir_all(root);
    }
}
