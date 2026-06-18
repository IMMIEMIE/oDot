use crate::{
    storage,
    types::{
        ProviderConfigFileResponse, ProviderInput, ProviderKind, ProviderRecord,
        ProviderRequestConfig, ToolMode,
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
    request: Option<ConfigRequest>,
    #[serde(default)]
    options: HashMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModelLimit {
    output: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModelProvider {
    api: Option<String>,
    npm: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ConfigRequest {
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

pub fn load_provider_config_for_project(
    app: &AppHandle,
    project_root: Option<String>,
) -> Result<ProviderConfigFileResponse, String> {
    let path = config_path(app, project_root.as_deref())?;
    ensure_config_file(&path)?;

    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let (providers, selected_provider_id) = sync_provider_config(app, &content)?;
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
) -> Result<ProviderConfigFileResponse, String> {
    parse_provider_inputs(&content)?;

    let path = config_path(app, project_root.as_deref())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, &content).map_err(|error| error.to_string())?;
    let (providers, selected_provider_id) = sync_provider_config(app, &content)?;
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
    let path = config_path(app, Some(project_root))?;
    ensure_config_file(&path)?;
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    resolve_provider_request_config_with_env(&content, provider_record_id, &path, |name| {
        env::var(name).ok()
    })
}

fn sync_provider_config(
    app: &AppHandle,
    content: &str,
) -> Result<(Vec<ProviderRecord>, Option<String>), String> {
    let (inputs, selected_provider_id) = parse_provider_inputs(content)?;
    let conn = storage::open_db(app)?;
    let mut records = Vec::with_capacity(inputs.len());

    for input in inputs {
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
    let output_token_limit = model.limit.as_ref().and_then(|limit| limit.output);

    Ok(ProviderRequestConfig {
        kind,
        tool_mode,
        base_url,
        model: model.id.clone().unwrap_or_else(|| model_key.to_string()),
        api_key,
        headers,
        body,
        output_token_limit,
        config_path: config_path.to_string_lossy().to_string(),
    })
}

fn config_path(app: &AppHandle, project_root: Option<&str>) -> Result<PathBuf, String> {
    let fallback = app_config_path(app)?;
    Ok(resolve_config_path(project_root, &fallback))
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
                request: None,
                options: HashMap::new(),
            },
        )]
    } else {
        provider.models.clone().into_iter().collect()
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
            ProviderKind::OpenAi => ToolMode::Native,
            ProviderKind::OpenAiCompatible
            | ProviderKind::Anthropic
            | ProviderKind::AnthropicCompatible => ToolMode::Json,
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
        assert_eq!(request.tool_mode, ToolMode::Json);
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
