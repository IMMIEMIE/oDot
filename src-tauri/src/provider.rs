use crate::types::{ProviderKind, ProviderRequestConfig};
use reqwest::StatusCode;
use serde_json::{json, Value};

const KEYRING_SERVICE: &str = "dev.odot.desktop";

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
) -> Result<String, String> {
    match provider.kind {
        ProviderKind::OpenAi | ProviderKind::OpenAiCompatible => {
            complete_openai_compatible(provider, system_prompt, user_prompt).await
        }
        ProviderKind::Anthropic | ProviderKind::AnthropicCompatible => {
            complete_anthropic_compatible(provider, system_prompt, user_prompt).await
        }
    }
}

async fn complete_openai_compatible(
    provider: &ProviderRequestConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
    let endpoint = to_chat_completions_endpoint(
        provider
            .base_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("https://api.openai.com/v1"),
    );
    let mut body = provider.body.clone();
    body.insert("model".to_string(), json!(provider.model));
    body.entry("temperature".to_string()).or_insert(json!(0.2));
    body.insert(
        "messages".to_string(),
        json!([
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ]),
    );

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
    payload
        .pointer("/choices/0/message/content")
        .and_then(|value| value.as_str())
        .map(|content| content.to_string())
        .ok_or_else(|| "AI 服务返回了空消息。".to_string())
}

async fn complete_anthropic_compatible(
    provider: &ProviderRequestConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
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
    payload
        .pointer("/content")
        .and_then(|value| value.as_array())
        .and_then(|items| {
            items
                .iter()
                .find_map(|item| item.get("text").and_then(|value| value.as_str()))
        })
        .map(|content| content.to_string())
        .ok_or_else(|| "AI 服务返回了空消息。".to_string())
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
}
