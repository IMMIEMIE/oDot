use crate::types::{ModelTurn, ProviderKind, ProviderRequestConfig, ToolCallRequest};
use reqwest::StatusCode;
use serde_json::{json, Value};

const KEYRING_SERVICE: &str = "dev.odot.desktop";

#[derive(Debug, Clone)]
pub struct ProviderCompletion {
    pub raw_response: String,
    pub turn: Option<ModelTurn>,
}

pub fn save_api_key(credential_ref: &str, api_key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, credential_ref)
        .map_err(|error| format!("无法打开系统钥匙串: {error}"))?;
    entry
        .set_password(api_key)
        .map_err(|error| format!("无法把 API Key 保存到系统钥匙串: {error}"))
}

pub fn delete_api_key(credential_ref: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, credential_ref)
        .map_err(|error| format!("无法打开系统钥匙串: {error}"))?;
    entry
        .delete_credential()
        .map_err(|error| format!("无法从系统钥匙串删除 API Key: {error}"))
}

pub async fn complete(
    provider: &ProviderRequestConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<ProviderCompletion, String> {
    match provider.kind {
        ProviderKind::OpenAi | ProviderKind::OpenAiCompatible => {
            complete_openai_compatible(provider, system_prompt, user_prompt).await
        }
        ProviderKind::Anthropic | ProviderKind::AnthropicCompatible => {
            complete_anthropic_compatible(provider, system_prompt, user_prompt).await
        }
    }
}

pub fn supports_native_tools(provider: &ProviderRequestConfig) -> bool {
    matches!(
        provider.kind,
        ProviderKind::OpenAi | ProviderKind::OpenAiCompatible
    )
}

async fn complete_openai_compatible(
    provider: &ProviderRequestConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<ProviderCompletion, String> {
    let endpoint = to_chat_completions_endpoint(
        provider
            .base_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("https://api.openai.com/v1"),
    );
    let mut body = provider.body.clone();
    body.remove("response_format");
    body.insert("model".to_string(), json!(provider.model));
    body.entry("temperature".to_string()).or_insert(json!(0.2));
    body.insert(
        "messages".to_string(),
        json!([
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ]),
    );
    body.entry("tools".to_string())
        .or_insert_with(native_tool_definitions);
    body.entry("tool_choice".to_string())
        .or_insert(json!("auto"));

    let client = reqwest::Client::new();
    let mut request = client.post(&endpoint);
    for (key, value) in &provider.headers {
        request = request.header(key, value);
    }
    let request = request.bearer_auth(provider.api_key.trim()).json(&body);

    let payload = send_json_request(
        request,
        &endpoint,
        "Authorization: Bearer <redacted>",
        &provider.config_path,
    )
    .await?;
    let raw_response = raw_response_from_payload(&payload);
    let turn = parse_openai_compatible_turn(&payload)?;
    Ok(ProviderCompletion { raw_response, turn })
}

async fn complete_anthropic_compatible(
    provider: &ProviderRequestConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<ProviderCompletion, String> {
    let endpoint = to_anthropic_messages_endpoint(
        provider
            .base_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("https://api.anthropic.com/v1"),
    );
    let mut body = provider.body.clone();
    body.insert("model".to_string(), json!(provider.model));
    body.entry("max_tokens".to_string()).or_insert(json!(4096));
    body.insert("system".to_string(), json!(system_prompt));
    body.insert(
        "messages".to_string(),
        json!([
            { "role": "user", "content": user_prompt }
        ]),
    );

    let client = reqwest::Client::new();
    let mut request = client.post(&endpoint);
    for (key, value) in &provider.headers {
        request = request.header(key, value);
    }
    let request = request
        .header("anthropic-version", "2023-06-01")
        .header("x-api-key", provider.api_key.trim())
        .json(&body);

    let payload = send_json_request(
        request,
        &endpoint,
        "x-api-key: <redacted>",
        &provider.config_path,
    )
    .await?;
    let content = payload
        .pointer("/content")
        .and_then(|value| value.as_array())
        .and_then(|items| {
            items
                .iter()
                .find_map(|item| item.get("text").and_then(|value| value.as_str()))
        })
        .map(|content| content.to_string())
        .ok_or_else(|| "AI 服务返回了空消息。".to_string())?;

    Ok(ProviderCompletion {
        raw_response: content,
        turn: None,
    })
}

fn parse_openai_compatible_turn(payload: &Value) -> Result<Option<ModelTurn>, String> {
    let message = payload
        .pointer("/choices/0/message")
        .ok_or_else(|| "AI 服务返回缺少 choices[0].message。".to_string())?;
    let content = openai_message_content(message.get("content"));
    let tool_calls = parse_openai_tool_calls(message.get("tool_calls"))?;

    if tool_calls.is_empty()
        && content
            .as_deref()
            .map(|value| value.trim_start().starts_with('{'))
            .unwrap_or(false)
    {
        return Ok(None);
    }

    if content.as_deref().unwrap_or_default().trim().is_empty() && tool_calls.is_empty() {
        return Err("AI 服务返回了空消息。".to_string());
    }

    Ok(Some(ModelTurn {
        summary: None,
        message: content,
        done: tool_calls.is_empty(),
        tool_calls,
    }))
}

fn openai_message_content(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.clone()),
        Some(Value::Array(parts)) => {
            let text = parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| part.pointer("/text/value").and_then(Value::as_str))
                })
                .collect::<Vec<_>>()
                .join("");
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

fn parse_openai_tool_calls(value: Option<&Value>) -> Result<Vec<ToolCallRequest>, String> {
    let Some(calls) = value.and_then(Value::as_array) else {
        return Ok(Vec::new());
    };

    calls
        .iter()
        .map(|call| {
            let name = call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .ok_or_else(|| "AI 服务返回的工具调用缺少 function.name。".to_string())?
                .to_string();
            let arguments = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let input = serde_json::from_str(arguments).map_err(|error| {
                format!(
                    "AI 服务返回的工具参数不是合法 JSON: {error}\n工具: {name}\n参数: {arguments}"
                )
            })?;
            Ok(ToolCallRequest { name, input })
        })
        .collect()
}

fn native_tool_definitions() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "read",
                "description": "Read a UTF-8 or GBK text file inside the selected project.",
                "parameters": object_schema(
                    json!({ "path": { "type": "string", "description": "Relative file path." } }),
                    &["path"]
                )
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search",
                "description": "Search project text files for a query.",
                "parameters": object_schema(
                    json!({ "query": { "type": "string", "description": "Search text." } }),
                    &["query"]
                )
            }
        },
        {
            "type": "function",
            "function": {
                "name": "edit",
                "description": "Replace one exact text span in an existing file. Prefer this for code changes.",
                "parameters": object_schema(
                    json!({
                        "path": { "type": "string", "description": "Relative file path." },
                        "oldString": { "type": "string", "description": "Exact text to replace." },
                        "newString": { "type": "string", "description": "Replacement text." }
                    }),
                    &["path", "oldString", "newString"]
                )
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write",
                "description": "Create or intentionally replace a whole file. Use edit for existing large files.",
                "parameters": object_schema(
                    json!({
                        "path": { "type": "string", "description": "Relative file path." },
                        "content": { "type": "string", "description": "Complete file content." },
                        "expectedHash": { "type": "string", "description": "Optional sha256 read before writing." }
                    }),
                    &["path", "content"]
                )
            }
        },
        {
            "type": "function",
            "function": {
                "name": "delete",
                "description": "Delete a file inside the selected project.",
                "parameters": object_schema(
                    json!({ "path": { "type": "string", "description": "Relative file path." } }),
                    &["path"]
                )
            }
        },
        {
            "type": "function",
            "function": {
                "name": "shell",
                "description": "Run a project command. On Windows this runs in PowerShell. Use background=true for long-running dev servers.",
                "parameters": object_schema(
                    json!({
                        "command": { "type": "string", "description": "Command to run." },
                        "timeoutSeconds": { "type": "integer", "description": "Optional foreground timeout in seconds, 1-600. Default 60." },
                        "background": { "type": "boolean", "description": "Start the command and return immediately. Use for npm run dev and other servers." }
                    }),
                    &["command"]
                )
            }
        }
    ])
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

fn raw_response_from_payload(payload: &Value) -> String {
    serde_json::to_string(payload).unwrap_or_else(|_| payload.to_string())
}

async fn send_json_request(
    request: reqwest::RequestBuilder,
    endpoint: &str,
    auth_summary: &str,
    config_path: &str,
) -> Result<Value, String> {
    let response = request
        .send()
        .await
        .map_err(|error| format!("AI 服务请求失败: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("无法读取 AI 服务响应: {error}"))?;

    let payload: Value = serde_json::from_str(&text).map_err(|error| {
        if status == StatusCode::OK {
            format!("AI 服务返回了无效 JSON: {error}\n\n原始响应:\n{text}")
        } else {
            format!("AI 服务请求失败，HTTP 状态码 {status}:\n{text}")
        }
    })?;

    if !status.is_success() {
        let message = payload
            .pointer("/error/message")
            .and_then(|value| value.as_str())
            .or_else(|| payload.pointer("/error").and_then(|value| value.as_str()))
            .unwrap_or(status.as_str());
        return Err(format!(
            "AI 服务请求失败: {message}\n请求端点: {endpoint}\n鉴权方式: {auth_summary}\n配置文件: {config_path}"
        ));
    }

    Ok(payload)
}

fn to_chat_completions_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn to_anthropic_messages_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/messages") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/messages")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_completions_endpoint_is_not_duplicated() {
        assert_eq!(
            to_chat_completions_endpoint("https://example.com/v1/chat/completions"),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(
            to_chat_completions_endpoint("https://example.com/v1/"),
            "https://example.com/v1/chat/completions"
        );
    }

    #[test]
    fn parses_openai_content_and_tool_calls() {
        let payload = json!({
            "choices": [{
                "message": {
                    "content": "正在读取文件",
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "read",
                            "arguments": "{\"path\":\"src/main.rs\"}"
                        }
                    }]
                }
            }]
        });

        let turn = parse_openai_compatible_turn(&payload)
            .expect("valid provider payload")
            .expect("native turn");

        assert_eq!(turn.message.as_deref(), Some("正在读取文件"));
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "read");
        assert_eq!(turn.tool_calls[0].input["path"], "src/main.rs");
        assert!(!turn.done);
    }

    #[test]
    fn parses_openai_tool_calls_without_content() {
        let payload = json!({
            "choices": [{
                "message": {
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search",
                            "arguments": "{\"query\":\"TODO\"}"
                        }
                    }]
                }
            }]
        });

        let turn = parse_openai_compatible_turn(&payload)
            .expect("valid provider payload")
            .expect("native turn");

        assert!(turn.message.is_none());
        assert_eq!(turn.tool_calls[0].name, "search");
        assert!(!turn.done);
    }

    #[test]
    fn parses_openai_content_without_tool_calls_as_final_message() {
        let payload = json!({
            "choices": [{
                "message": {
                    "content": "完成了。"
                }
            }]
        });

        let turn = parse_openai_compatible_turn(&payload)
            .expect("valid provider payload")
            .expect("native final turn");

        assert_eq!(turn.message.as_deref(), Some("完成了。"));
        assert!(turn.tool_calls.is_empty());
        assert!(turn.done);
    }
}
