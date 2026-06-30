use crate::{
    llm_runtime::{
        sanitize_assistant_content, LlmStreamEvent, OpenAiChatStreamParser,
        OpenAiResponsesStreamParser,
    },
    types::{
        McpToolDefinition, ModelTurn, OpenAiApiMode, ProviderKind, ProviderRequestConfig,
        ToolCallRequest, ToolMode,
    },
};
use futures_util::StreamExt;
use reqwest::StatusCode;
use serde_json::{json, Value};

const KEYRING_SERVICE: &str = "dev.odot.desktop";

#[derive(Debug, Clone)]
pub struct ProviderCompletion {
    pub raw_response: String,
    pub turn: Option<ModelTurn>,
}

enum OpenAiStreamParser {
    Chat(OpenAiChatStreamParser),
    Responses(OpenAiResponsesStreamParser),
}

impl OpenAiStreamParser {
    fn push_str(&mut self, chunk: &str) -> Result<Vec<LlmStreamEvent>, String> {
        match self {
            Self::Chat(parser) => parser.push_str(chunk),
            Self::Responses(parser) => parser.push_str(chunk),
        }
    }

    fn finish(&mut self) -> Result<Vec<LlmStreamEvent>, String> {
        match self {
            Self::Chat(parser) => parser.finish(),
            Self::Responses(parser) => parser.finish(),
        }
    }
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
    provider.tool_mode == ToolMode::Native
        && matches!(
            provider.kind,
            ProviderKind::OpenAi | ProviderKind::OpenAiCompatible
        )
}

pub async fn stream_openai_compatible<F>(
    provider: &ProviderRequestConfig,
    messages: &[Value],
    mcp_tools: &[McpToolDefinition],
    mut on_event: F,
) -> Result<ModelTurn, String>
where
    F: FnMut(LlmStreamEvent) -> Result<(), String>,
{
    if !supports_native_tools(provider) {
        return Err("当前 provider 未启用 native streaming runtime。".to_string());
    }
    let base_url = openai_base_url(provider);
    let (endpoint, body, mut parser) = match provider.openai_api_mode {
        OpenAiApiMode::ChatCompletions => (
            to_chat_completions_endpoint(base_url),
            openai_stream_request_body(provider, messages, mcp_tools),
            OpenAiStreamParser::Chat(OpenAiChatStreamParser::new()),
        ),
        OpenAiApiMode::Responses => (
            to_responses_endpoint(base_url),
            openai_responses_stream_request_body(provider, messages, mcp_tools),
            OpenAiStreamParser::Responses(OpenAiResponsesStreamParser::new()),
        ),
    };
    let client = reqwest::Client::new();
    let mut request = client.post(&endpoint);
    for (key, value) in &provider.headers {
        request = request.header(key, value);
    }
    let response = request
        .bearer_auth(provider.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("AI 服务 streaming 请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let text = response
            .text()
            .await
            .map_err(|error| format!("无法读取 AI 服务响应: {error}"))?;
        return Err(provider_error_message(
            status,
            &text,
            &endpoint,
            "Authorization: Bearer <redacted>",
            &provider.config_path,
        ));
    }

    let mut turn = ModelTurn {
        summary: None,
        message: None,
        tool_calls: Vec::new(),
        done: true,
    };
    let mut stream = response.bytes_stream();
    let mut pending_utf8 = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取 AI 服务 streaming 响应失败: {error}"))?;
        pending_utf8.extend_from_slice(&chunk);
        loop {
            match std::str::from_utf8(&pending_utf8) {
                Ok(text) => {
                    for event in parser.push_str(text)? {
                        accumulate_stream_event(&mut turn, &event);
                        on_event(event)?;
                    }
                    pending_utf8.clear();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        let text = std::str::from_utf8(&pending_utf8[..valid_up_to])
                            .map_err(|error| error.to_string())?;
                        for event in parser.push_str(text)? {
                            accumulate_stream_event(&mut turn, &event);
                            on_event(event)?;
                        }
                        pending_utf8.drain(..valid_up_to);
                    }
                    if error.error_len().is_some() {
                        return Err(format!("AI 服务 streaming 响应包含无效 UTF-8: {error}"));
                    }
                    break;
                }
            }
        }
    }
    if !pending_utf8.is_empty() {
        return Err("AI 服务 streaming 响应以不完整 UTF-8 结尾。".to_string());
    }
    for event in parser.finish()? {
        accumulate_stream_event(&mut turn, &event);
        on_event(event)?;
    }
    turn.done = turn.tool_calls.is_empty();
    Ok(turn)
}

async fn complete_openai_compatible(
    provider: &ProviderRequestConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<ProviderCompletion, String> {
    if provider.openai_api_mode == OpenAiApiMode::Responses {
        return complete_openai_responses(provider, system_prompt, user_prompt).await;
    }

    let endpoint = to_chat_completions_endpoint(openai_base_url(provider));
    let native_tools = supports_native_tools(provider);
    let body = openai_request_body(provider, system_prompt, user_prompt);

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
    if native_tools {
        let turn = parse_openai_compatible_turn(&payload)?;
        let raw_response = if turn.is_some() {
            raw_response_from_payload(&payload)
        } else {
            openai_response_content(&payload)?
        };
        Ok(ProviderCompletion { raw_response, turn })
    } else {
        Ok(ProviderCompletion {
            raw_response: openai_response_content(&payload)?,
            turn: None,
        })
    }
}

async fn complete_openai_responses(
    provider: &ProviderRequestConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<ProviderCompletion, String> {
    let endpoint = to_responses_endpoint(openai_base_url(provider));
    let native_tools = supports_native_tools(provider);
    let body = openai_responses_request_body(provider, system_prompt, user_prompt);

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
    if native_tools {
        let turn = parse_openai_responses_turn(&payload)?;
        let raw_response = if turn.is_some() {
            raw_response_from_payload(&payload)
        } else {
            openai_responses_response_content(&payload)?
        };
        Ok(ProviderCompletion { raw_response, turn })
    } else {
        Ok(ProviderCompletion {
            raw_response: openai_responses_response_content(&payload)?,
            turn: None,
        })
    }
}

fn openai_chat_body(
    provider: &ProviderRequestConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> serde_json::Map<String, Value> {
    let mut body = openai_base_body(provider);
    body.insert(
        "messages".to_string(),
        json!([
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ]),
    );
    body
}

fn openai_messages_body(
    provider: &ProviderRequestConfig,
    messages: &[Value],
) -> serde_json::Map<String, Value> {
    let mut body = openai_base_body(provider);
    body.insert("messages".to_string(), Value::Array(messages.to_vec()));
    body
}

fn openai_base_body(provider: &ProviderRequestConfig) -> serde_json::Map<String, Value> {
    let mut body = provider.body.clone();
    body.remove("response_format");
    body.insert("model".to_string(), json!(provider.model));
    body.entry("temperature".to_string()).or_insert(json!(0.2));
    if let Some(limit) = provider.output_token_limit {
        if !body.contains_key("max_tokens") && !body.contains_key("max_completion_tokens") {
            body.insert("max_tokens".to_string(), json!(limit));
        }
    }
    body
}

fn openai_responses_base_body(provider: &ProviderRequestConfig) -> serde_json::Map<String, Value> {
    let mut body = provider.body.clone();
    body.remove("messages");
    body.remove("max_tokens");
    body.remove("max_completion_tokens");
    body.insert("model".to_string(), json!(provider.model));
    body.entry("temperature".to_string()).or_insert(json!(0.2));
    if let Some(limit) = provider.output_token_limit {
        body.entry("max_output_tokens".to_string())
            .or_insert(json!(limit));
    }
    body
}

fn openai_request_body(
    provider: &ProviderRequestConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> serde_json::Map<String, Value> {
    let mut body = openai_chat_body(provider, system_prompt, user_prompt);
    if supports_native_tools(provider) {
        body.entry("tools".to_string())
            .or_insert_with(native_tool_definitions);
        body.entry("tool_choice".to_string())
            .or_insert(json!("auto"));
    } else {
        body.remove("tools");
        body.remove("tool_choice");
    }
    body
}

fn openai_responses_request_body(
    provider: &ProviderRequestConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> serde_json::Map<String, Value> {
    let mut body = openai_responses_base_body(provider);
    body.insert("instructions".to_string(), json!(system_prompt));
    body.insert("input".to_string(), json!(user_prompt));
    if supports_native_tools(provider) {
        body.entry("tools".to_string())
            .or_insert_with(native_responses_tool_definitions);
        body.entry("tool_choice".to_string())
            .or_insert(json!("auto"));
    } else {
        body.remove("tools");
        body.remove("tool_choice");
    }
    body
}

fn openai_stream_request_body(
    provider: &ProviderRequestConfig,
    messages: &[Value],
    mcp_tools: &[McpToolDefinition],
) -> serde_json::Map<String, Value> {
    let mut body = openai_messages_body(provider, messages);
    body.insert("stream".to_string(), json!(true));
    body.entry("stream_options".to_string())
        .or_insert(json!({ "include_usage": true }));
    body.entry("tools".to_string())
        .or_insert_with(|| native_tool_definitions_for(mcp_tools));
    body.entry("tool_choice".to_string())
        .or_insert(json!("auto"));
    body
}

fn openai_responses_stream_request_body(
    provider: &ProviderRequestConfig,
    messages: &[Value],
    mcp_tools: &[McpToolDefinition],
) -> serde_json::Map<String, Value> {
    let mut body = openai_responses_base_body(provider);
    let (instructions, input) = responses_input_from_messages(messages);
    if let Some(instructions) = instructions {
        body.insert("instructions".to_string(), json!(instructions));
    }
    body.insert("input".to_string(), Value::Array(input));
    body.insert("stream".to_string(), json!(true));
    body.entry("tools".to_string())
        .or_insert_with(|| native_responses_tool_definitions_for(mcp_tools));
    body.entry("tool_choice".to_string())
        .or_insert(json!("auto"));
    body
}

fn responses_input_from_messages(messages: &[Value]) -> (Option<String>, Vec<Value>) {
    let mut instructions = None;
    let mut input = Vec::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role == "system" && instructions.is_none() {
            instructions = message_content_text(message.get("content"));
            continue;
        }
        if role == "tool" {
            let call_id = message
                .get("tool_call_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if call_id.is_empty() {
                continue;
            }
            input.push(json!({
                "type": "function_call_output",
                "call_id": call_id,
                "output": message_content_text(message.get("content")).unwrap_or_default()
            }));
            continue;
        }
        if role == "assistant" {
            if let Some(content) = message_content_text(message.get("content"))
                .filter(|value| !value.trim().is_empty())
            {
                input.push(json!({ "role": "assistant", "content": content }));
            }
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    if let Some(item) = chat_tool_call_to_responses_input(call) {
                        input.push(item);
                    }
                }
            }
            continue;
        }
        if matches!(role, "user" | "developer") {
            input.push(json!({
                "role": role,
                "content": responses_message_content(message.get("content"))
            }));
        }
    }
    (instructions, input)
}

fn chat_tool_call_to_responses_input(call: &Value) -> Option<Value> {
    let name = call
        .pointer("/function/name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?;
    let call_id = call
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?;
    Some(json!({
        "type": "function_call",
        "call_id": call_id,
        "name": name,
        "arguments": call.pointer("/function/arguments").and_then(Value::as_str).unwrap_or("{}")
    }))
}

fn responses_message_content(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Array(parts)) => Value::Array(
            parts
                .iter()
                .filter_map(|part| {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        return Some(json!({ "type": "input_text", "text": text }));
                    }
                    if let Some(url) = part.pointer("/image_url/url").and_then(Value::as_str) {
                        return Some(json!({ "type": "input_image", "image_url": url }));
                    }
                    Some(part.clone())
                })
                .collect(),
        ),
        Some(Value::String(text)) => json!(text),
        Some(value) => value.clone(),
        None => json!(""),
    }
}

fn message_content_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(parts)) => {
            let text = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("");
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn accumulate_stream_event(turn: &mut ModelTurn, event: &LlmStreamEvent) {
    match event {
        LlmStreamEvent::TextDelta { text, .. } => {
            let message = turn.message.get_or_insert_with(String::new);
            message.push_str(text);
        }
        LlmStreamEvent::ReasoningDelta { text, .. } => {
            let summary = turn.summary.get_or_insert_with(String::new);
            summary.push_str(text);
        }
        LlmStreamEvent::ToolCall(call) => {
            turn.tool_calls.push(call.clone());
        }
        LlmStreamEvent::ToolInputDelta { .. } | LlmStreamEvent::Finish { .. } => {}
    }
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
    let sanitized = content
        .as_deref()
        .map(sanitize_assistant_content)
        .filter(|value| !value.text.trim().is_empty() || !value.reasoning.trim().is_empty());
    let tool_calls = parse_openai_tool_calls(message.get("tool_calls"))?;
    let content = sanitized
        .as_ref()
        .and_then(|value| (!value.text.trim().is_empty()).then(|| value.text.clone()));
    let summary = sanitized
        .as_ref()
        .and_then(|value| (!value.reasoning.trim().is_empty()).then(|| value.reasoning.clone()));

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
        summary,
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

fn openai_response_content(payload: &Value) -> Result<String, String> {
    let message = payload
        .pointer("/choices/0/message")
        .ok_or_else(|| "AI 服务返回缺少 choices[0].message。".to_string())?;
    openai_message_content(message.get("content"))
        .ok_or_else(|| "AI 服务返回了空消息。".to_string())
}

fn parse_openai_responses_turn(payload: &Value) -> Result<Option<ModelTurn>, String> {
    let content = openai_responses_text(payload);
    let sanitized = content
        .as_deref()
        .map(sanitize_assistant_content)
        .filter(|value| !value.text.trim().is_empty() || !value.reasoning.trim().is_empty());
    let tool_calls = parse_openai_responses_tool_calls(payload.get("output"))?;
    let content = sanitized
        .as_ref()
        .and_then(|value| (!value.text.trim().is_empty()).then(|| value.text.clone()));
    let summary = sanitized
        .as_ref()
        .and_then(|value| (!value.reasoning.trim().is_empty()).then(|| value.reasoning.clone()));

    if content.as_deref().unwrap_or_default().trim().is_empty() && tool_calls.is_empty() {
        return Err("AI 服务返回了空消息。".to_string());
    }

    Ok(Some(ModelTurn {
        summary,
        message: content,
        done: tool_calls.is_empty(),
        tool_calls,
    }))
}

fn openai_responses_response_content(payload: &Value) -> Result<String, String> {
    openai_responses_text(payload).ok_or_else(|| "AI 服务返回了空消息。".to_string())
}

fn openai_responses_text(payload: &Value) -> Option<String> {
    if let Some(text) = payload
        .get("output_text")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return Some(text.to_string());
    }

    let text = payload
        .get("output")
        .and_then(Value::as_array)?
        .iter()
        .flat_map(|item| {
            item.get("content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|part| {
            part.get("text")
                .and_then(Value::as_str)
                .or_else(|| part.pointer("/text/value").and_then(Value::as_str))
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>()
        .join("");

    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn parse_openai_responses_tool_calls(
    value: Option<&Value>,
) -> Result<Vec<ToolCallRequest>, String> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Ok(Vec::new());
    };

    items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        .map(parse_openai_responses_tool_call)
        .collect()
}

fn parse_openai_responses_tool_call(call: &Value) -> Result<ToolCallRequest, String> {
    let original_name = call
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "AI 服务返回的工具调用缺少 name。".to_string())?;
    let name = normalize_tool_name(original_name);
    let arguments = call
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("{}");
    let call_id = call
        .get("call_id")
        .or_else(|| call.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let input = match serde_json::from_str(arguments) {
        Ok(input) => input,
        Err(error) => {
            return Ok(ToolCallRequest {
                tool_call_id: if call_id.is_empty() {
                    None
                } else {
                    Some(call_id.to_string())
                },
                name: "invalid".to_string(),
                input: json!({
                    "tool": original_name,
                    "error": error.to_string(),
                    "arguments": arguments,
                    "callId": call_id
                }),
            });
        }
    };
    Ok(ToolCallRequest {
        tool_call_id: if call_id.is_empty() {
            None
        } else {
            Some(call_id.to_string())
        },
        name,
        input,
    })
}

fn parse_openai_tool_calls(value: Option<&Value>) -> Result<Vec<ToolCallRequest>, String> {
    let Some(calls) = value.and_then(Value::as_array) else {
        return Ok(Vec::new());
    };

    calls
        .iter()
        .map(|call| {
            let original_name = call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .ok_or_else(|| "AI 服务返回的工具调用缺少 function.name。".to_string())?;
            let name = normalize_tool_name(original_name);
            let arguments = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let input = match serde_json::from_str(arguments) {
                Ok(input) => input,
                Err(error) => {
                    let call_id = call.get("id").and_then(Value::as_str).unwrap_or_default();
                    return Ok(ToolCallRequest {
                        tool_call_id: if call_id.is_empty() {
                            None
                        } else {
                            Some(call_id.to_string())
                        },
                        name: "invalid".to_string(),
                        input: json!({
                            "tool": original_name,
                            "error": error.to_string(),
                            "arguments": arguments,
                            "callId": call_id
                        }),
                    });
                }
            };
            let tool_call_id = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            Ok(ToolCallRequest {
                tool_call_id,
                name,
                input,
            })
        })
        .collect()
}

fn normalize_tool_name(name: &str) -> String {
    match name.trim().to_ascii_lowercase().as_str() {
        "bash" => "shell".to_string(),
        "grep" => "search".to_string(),
        "todowrite" => "todo_write".to_string(),
        other => other.to_string(),
    }
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
                "name": "grep",
                "description": "Search project text files for a query. Alias of search.",
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
                        "workdir": { "type": "string", "description": "Optional working directory, relative to the project root unless absolute." },
                        "timeoutSeconds": { "type": "integer", "description": "Optional foreground timeout in seconds, 1-600. Default 60." },
                        "background": { "type": "boolean", "description": "Start the command and return immediately. Use for npm run dev and other servers." },
                        "description": { "type": "string", "description": "Short purpose of the command." }
                    }),
                    &["command"]
                )
            }
        },
        {
            "type": "function",
            "function": {
                "name": "question",
                "description": "Ask the user a blocking question when user input is required.",
                "parameters": object_schema(
                    json!({ "question": { "type": "string", "description": "Question to ask." } }),
                    &["question"]
                )
            }
        },
        {
            "type": "function",
            "function": {
                "name": "task",
                "description": "Launch an isolated subagent session for a focused task. Use multiple task calls in the same turn for independent work that can run in parallel. Use background=true only for independent long-running work; the result is injected when ready.",
                "parameters": object_schema(
                    json!({
                        "description": { "type": "string", "description": "Short 3-7 word task label." },
                        "prompt": { "type": "string", "description": "Detailed task for the subagent." },
                        "subagent_type": { "type": "string", "description": "Agent type. Use general when no specialized type is needed." },
                        "task_id": { "type": "string", "description": "Existing child task session id to continue instead of creating a new subagent." },
                        "background": { "type": "boolean", "description": "Run independently and return immediately. Use only when the parent can continue without waiting." }
                    }),
                    &["description", "prompt"]
                )
            }
        },
        {
            "type": "function",
            "function": {
                "name": "todo_write",
                "description": "Create and maintain a structured task list for the current coding session. Send the complete updated list each time.",
                "parameters": object_schema(
                    json!({
                        "todos": {
                            "type": "array",
                            "description": "The complete updated todo list.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "content": { "type": "string", "description": "Brief task description." },
                                    "status": { "type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"] },
                                    "priority": { "type": "string", "enum": ["high", "medium", "low"] }
                                },
                                "required": ["content", "status", "priority"],
                                "additionalProperties": false
                            }
                        }
                    }),
                    &["todos"]
                )
            }
        },
        {
            "type": "function",
            "function": {
                "name": "skill_list",
                "description": "List project skills from .odot/skills.",
                "parameters": object_schema(json!({}), &[])
            }
        },
        {
            "type": "function",
            "function": {
                "name": "skill_read",
                "description": "Read a project skill SKILL.md by name or relative path.",
                "parameters": object_schema(
                    json!({
                        "name": { "type": "string", "description": "Skill name or .odot/skills/.../SKILL.md path." }
                    }),
                    &["name"]
                )
            }
        },
        {
            "type": "function",
            "function": {
                "name": "plan_exit",
                "description": "Use at the end of plan mode after the plan file is complete to request user approval to switch to execution.",
                "parameters": object_schema(json!({}), &[])
            }
        }
    ])
}

fn native_tool_definitions_for(mcp_tools: &[McpToolDefinition]) -> Value {
    let mut tools = native_tool_definitions().as_array().cloned().unwrap_or_default();
    tools.extend(mcp_tools.iter().map(|tool| {
        json!({
            "type": "function",
            "function": {
                "name": tool.display_name,
                "description": tool.description,
                "parameters": tool.input_schema
            }
        })
    }));
    Value::Array(tools)
}

fn native_responses_tool_definitions() -> Value {
    native_responses_tool_definitions_for(&[])
}

fn native_responses_tool_definitions_for(mcp_tools: &[McpToolDefinition]) -> Value {
    let tools = native_tool_definitions_for(mcp_tools);
    let Some(items) = tools.as_array() else {
        return json!([]);
    };
    Value::Array(
        items
            .iter()
            .filter_map(|tool| {
                let function = tool.get("function")?;
                let name = function.get("name")?.clone();
                let description = function.get("description")?.clone();
                let parameters = function.get("parameters")?.clone();
                Some(json!({
                    "type": "function",
                    "name": name,
                    "description": description,
                    "parameters": parameters
                }))
            })
            .collect(),
    )
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
        return Err(provider_error_message(
            status,
            &text,
            endpoint,
            auth_summary,
            config_path,
        ));
    }

    Ok(payload)
}

fn provider_error_message(
    status: StatusCode,
    text: &str,
    endpoint: &str,
    auth_summary: &str,
    config_path: &str,
) -> String {
    let payload: Option<Value> = serde_json::from_str(text).ok();
    let message = payload
        .as_ref()
        .and_then(|payload| {
            payload
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| payload.pointer("/error").and_then(Value::as_str))
        })
        .unwrap_or_else(|| {
            if text.trim().is_empty() {
                status.as_str()
            } else {
                text.trim()
            }
        });
    format!(
        "AI 服务请求失败: {message}\n请求端点: {endpoint}\n鉴权方式: {auth_summary}\n配置文件: {config_path}"
    )
}

fn openai_base_url(provider: &ProviderRequestConfig) -> &str {
    provider
        .base_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("https://api.openai.com/v1")
}

fn to_chat_completions_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn to_responses_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/responses") {
        trimmed.to_string()
    } else if let Some(root) = trimmed.strip_suffix("/chat/completions") {
        format!("{root}/responses")
    } else {
        format!("{trimmed}/responses")
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

    fn test_provider(kind: ProviderKind, tool_mode: ToolMode) -> ProviderRequestConfig {
        ProviderRequestConfig {
            kind,
            tool_mode,
            openai_api_mode: OpenAiApiMode::ChatCompletions,
            base_url: Some("https://example.com/v1".to_string()),
            model: "test-model".to_string(),
            api_key: "test-key".to_string(),
            headers: std::collections::HashMap::new(),
            body: serde_json::Map::new(),
            context_token_limit: None,
            input_token_limit: None,
            output_token_limit: None,
            pricing: Default::default(),
            config_path: "odot.json".to_string(),
        }
    }

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
    fn responses_endpoint_is_not_duplicated() {
        assert_eq!(
            to_responses_endpoint("https://example.com/v1/responses"),
            "https://example.com/v1/responses"
        );
        assert_eq!(
            to_responses_endpoint("https://example.com/v1/"),
            "https://example.com/v1/responses"
        );
        assert_eq!(
            to_responses_endpoint("https://example.com/v1/chat/completions"),
            "https://example.com/v1/responses"
        );
    }

    #[test]
    fn json_tool_mode_removes_native_tool_fields() {
        let mut provider = test_provider(ProviderKind::OpenAiCompatible, ToolMode::Json);
        provider.body.insert("tools".to_string(), json!(["stale"]));
        provider
            .body
            .insert("tool_choice".to_string(), json!("auto"));
        provider.output_token_limit = Some(4096);

        let body = openai_request_body(&provider, "system", "user");

        assert!(!body.contains_key("tools"));
        assert!(!body.contains_key("tool_choice"));
        assert_eq!(body.get("max_tokens"), Some(&json!(4096)));
    }

    #[test]
    fn explicit_max_token_body_is_not_overwritten() {
        let mut provider = test_provider(ProviderKind::OpenAiCompatible, ToolMode::Json);
        provider.output_token_limit = Some(4096);
        provider.body.insert("max_tokens".to_string(), json!(2048));

        let body = openai_request_body(&provider, "system", "user");

        assert_eq!(body.get("max_tokens"), Some(&json!(2048)));
    }

    #[test]
    fn responses_body_uses_input_and_max_output_tokens() {
        let mut provider = test_provider(ProviderKind::OpenAiCompatible, ToolMode::Native);
        provider.openai_api_mode = OpenAiApiMode::Responses;
        provider.output_token_limit = Some(4096);
        provider.body.insert("max_tokens".to_string(), json!(2048));
        provider
            .body
            .insert("max_completion_tokens".to_string(), json!(2048));

        let body = openai_responses_request_body(&provider, "system", "user");

        assert_eq!(body.get("model"), Some(&json!("test-model")));
        assert_eq!(body.get("instructions"), Some(&json!("system")));
        assert_eq!(body.get("input"), Some(&json!("user")));
        assert_eq!(body.get("max_output_tokens"), Some(&json!(4096)));
        assert!(!body.contains_key("messages"));
        assert!(!body.contains_key("max_tokens"));
        assert!(!body.contains_key("max_completion_tokens"));
        assert!(body.get("tools").and_then(Value::as_array).is_some());
    }

    #[test]
    fn responses_stream_body_converts_tool_messages() {
        let provider = test_provider(ProviderKind::OpenAiCompatible, ToolMode::Native);
        let messages = vec![
            json!({ "role": "system", "content": "system" }),
            json!({ "role": "assistant", "content": null, "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {
                    "name": "read",
                    "arguments": "{\"path\":\"src/main.rs\"}"
                }
            }]}),
            json!({ "role": "tool", "tool_call_id": "call_1", "content": "file" }),
        ];

        let body = openai_responses_stream_request_body(&provider, &messages);
        let input = body.get("input").and_then(Value::as_array).unwrap();

        assert_eq!(body.get("instructions"), Some(&json!("system")));
        assert_eq!(input[0]["type"], "function_call");
        assert_eq!(input[0]["call_id"], "call_1");
        assert_eq!(input[1]["type"], "function_call_output");
        assert_eq!(input[1]["call_id"], "call_1");
        assert_eq!(body.get("stream"), Some(&json!(true)));
    }

    #[test]
    fn responses_tool_schema_uses_responses_shape() {
        let tools = native_responses_tool_definitions();
        let tools = tools.as_array().expect("tool array");
        let read = tools
            .iter()
            .find(|tool| tool.get("name").and_then(Value::as_str) == Some("read"))
            .expect("read tool");

        assert_eq!(read.get("type"), Some(&json!("function")));
        assert!(read.get("parameters").is_some());
        assert!(read.get("function").is_none());
    }

    #[test]
    fn native_tool_schema_omits_bash_and_keeps_shell_description() {
        let tools = native_tool_definitions();
        let tools = tools.as_array().expect("tool array");
        let names = tools
            .iter()
            .filter_map(|tool| tool.pointer("/function/name").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert!(names.contains(&"shell"));
        assert!(names.contains(&"todo_write"));
        assert!(names.contains(&"plan_exit"));
        assert!(!names.contains(&"bash"));

        let shell = tools
            .iter()
            .find(|tool| tool.pointer("/function/name").and_then(Value::as_str) == Some("shell"))
            .expect("shell tool");
        assert!(shell
            .pointer("/function/parameters/properties/description")
            .is_some());
        let task = tools
            .iter()
            .find(|tool| tool.pointer("/function/name").and_then(Value::as_str) == Some("task"))
            .expect("task tool");
        assert!(task
            .pointer("/function/parameters/properties/task_id")
            .is_some());
        assert!(task
            .pointer("/function/parameters/properties/background")
            .is_some());
    }

    #[test]
    fn malformed_native_tool_arguments_become_invalid_tool_call() {
        let payload = json!({
            "choices": [{
                "message": {
                    "content": null,
                    "tool_calls": [{
                        "id": "call_bad",
                        "type": "function",
                        "function": {
                            "name": "shell",
                            "arguments": "{\"command\":\"Get-Content src\\\\main.rs\"<parameter name=\"description\">"
                        }
                    }]
                }
            }]
        });

        let turn = parse_openai_compatible_turn(&payload)
            .expect("provider payload should parse")
            .expect("native turn");

        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "invalid");
        assert_eq!(turn.tool_calls[0].input["tool"], "shell");
        assert_eq!(turn.tool_calls[0].input["callId"], "call_bad");
        assert!(turn.tool_calls[0].input["arguments"]
            .as_str()
            .unwrap()
            .contains("<parameter"));
    }

    #[test]
    fn native_tool_names_are_normalized() {
        let calls = json!([
            {
                "function": {
                    "name": "Shell",
                    "arguments": "{\"command\":\"npm run typecheck\"}"
                }
            },
            {
                "function": {
                    "name": "bash",
                    "arguments": "{\"command\":\"cargo test\"}"
                }
            },
            {
                "function": {
                    "name": "grep",
                    "arguments": "{\"query\":\"TODO\"}"
                }
            },
            {
                "function": {
                    "name": "todowrite",
                    "arguments": "{\"todos\":[]}"
                }
            }
        ]);

        let calls = parse_openai_tool_calls(Some(&calls)).expect("tool calls");

        assert_eq!(calls[0].name, "shell");
        assert_eq!(calls[1].name, "shell");
        assert_eq!(calls[2].name, "search");
        assert_eq!(calls[3].name, "todo_write");
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
    fn parses_responses_output_text_and_tool_calls() {
        let payload = json!({
            "output_text": "正在读取文件",
            "output": [{
                "type": "function_call",
                "call_id": "call_1",
                "name": "read",
                "arguments": "{\"path\":\"src/main.rs\"}"
            }]
        });

        let turn = parse_openai_responses_turn(&payload)
            .expect("valid provider payload")
            .expect("native turn");

        assert_eq!(turn.message.as_deref(), Some("正在读取文件"));
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(turn.tool_calls[0].name, "read");
        assert_eq!(turn.tool_calls[0].input["path"], "src/main.rs");
        assert!(!turn.done);
    }

    #[test]
    fn parses_responses_content_parts_without_output_text() {
        let payload = json!({
            "output": [{
                "type": "message",
                "content": [
                    { "type": "output_text", "text": "完成" },
                    { "type": "output_text", "text": "了。" }
                ]
            }]
        });

        let turn = parse_openai_responses_turn(&payload)
            .expect("valid provider payload")
            .expect("native final turn");

        assert_eq!(turn.message.as_deref(), Some("完成了。"));
        assert!(turn.done);
    }

    #[test]
    fn empty_responses_payload_is_rejected() {
        let error = parse_openai_responses_turn(&json!({ "output": [] }))
            .expect_err("empty response should fail");

        assert!(error.contains("空消息"));
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
