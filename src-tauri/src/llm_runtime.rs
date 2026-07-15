use crate::types::ToolCallRequest;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub enum LlmStreamEvent {
    TextDelta {
        part_id: String,
        text: String,
    },
    ReasoningDelta {
        part_id: String,
        text: String,
    },
    ToolInputDelta {
        tool_call_id: String,
        name: Option<String>,
        text: String,
    },
    ToolCall(ToolCallRequest),
    Finish {
        finish_reason: Option<String>,
        usage: Option<Value>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct SanitizedAssistantContent {
    pub text: String,
    pub reasoning: String,
}

#[derive(Debug, Default)]
pub struct OpenAiChatStreamParser {
    buffer: String,
    content: ReasoningTagSplitter,
    tools: HashMap<usize, ToolAccumulator>,
    finish_reason: Option<String>,
    usage: Option<Value>,
    finished: bool,
}

#[derive(Debug, Default)]
struct ToolAccumulator {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
    emitted: bool,
}

/// Anthropic Messages API streaming parser.
///
/// Handles SSE events: message_start, content_block_start, content_block_delta,
/// content_block_stop, message_delta, message_stop, ping, error.
#[derive(Debug, Default)]
pub struct AnthropicStreamParser {
    buffer: String,
    /// Current content blocks keyed by index.
    blocks: HashMap<usize, AnthropicContentBlock>,
    finish_reason: Option<String>,
    usage: Option<Value>,
    finished: bool,
}

#[derive(Debug, Default)]
struct AnthropicContentBlock {
    block_type: String,
    /// Accumulated text for "text" or "thinking" blocks.
    text: String,
    /// Cryptographic signature for a thinking block. It must be replayed unchanged.
    signature: Option<String>,
    /// Opaque payload for a redacted_thinking block.
    redacted_data: Option<String>,
    /// Tool call fields for "tool_use" blocks.
    tool_id: Option<String>,
    tool_name: Option<String>,
    tool_input_json: String,
    emitted: bool,
}

impl AnthropicStreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_str(&mut self, chunk: &str) -> Result<Vec<LlmStreamEvent>, String> {
        self.buffer.push_str(chunk);
        let mut events = Vec::new();
        while let Some((block, consumed)) = next_sse_block(&self.buffer) {
            self.buffer.drain(..consumed);
            if let Some(data) = sse_data(&block) {
                events.extend(self.parse_data(&data)?);
            }
        }
        Ok(events)
    }

    pub fn finish(&mut self) -> Result<Vec<LlmStreamEvent>, String> {
        let mut events = Vec::new();
        if !self.buffer.trim().is_empty() {
            let block = std::mem::take(&mut self.buffer);
            if let Some(data) = sse_data(&block) {
                events.extend(self.parse_data(&data)?);
            }
        }
        events.extend(self.emit_terminal_events());
        events.extend(self.emit_finish());
        Ok(events)
    }

    pub fn native_content(&self) -> Vec<Value> {
        let mut blocks = self.blocks.iter().collect::<Vec<_>>();
        blocks.sort_by_key(|(index, _)| **index);
        blocks
            .into_iter()
            .filter_map(|(_, block)| block.native_value())
            .collect()
    }

    fn parse_data(&mut self, data: &str) -> Result<Vec<LlmStreamEvent>, String> {
        let trimmed = data.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        let payload: Value = serde_json::from_str(trimmed)
            .map_err(|error| format!("AI 服务返回了无效 streaming JSON: {error}"))?;
        self.parse_payload(&payload)
    }

    fn parse_payload(&mut self, payload: &Value) -> Result<Vec<LlmStreamEvent>, String> {
        let mut events = Vec::new();
        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();

        match event_type {
            "message_start" => {
                if let Some(message) = payload.get("message") {
                    if let Some(usage) = message.get("usage") {
                        merge_usage(&mut self.usage, usage);
                    }
                }
            }
            "content_block_start" => {
                let index = payload.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                if let Some(block) = payload.get("content_block") {
                    let block_type = block
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("text")
                        .to_string();
                    let entry = self.blocks.entry(index).or_default();
                    entry.block_type = block_type.clone();
                    match block_type.as_str() {
                        "text" => {
                            if let Some(text) = block.get("text").and_then(Value::as_str) {
                                entry.text.push_str(text);
                            }
                        }
                        "thinking" => {
                            if let Some(thinking) = block.get("thinking").and_then(Value::as_str) {
                                entry.text.push_str(thinking);
                            }
                            entry.signature = block
                                .get("signature")
                                .and_then(Value::as_str)
                                .map(String::from);
                        }
                        "redacted_thinking" => {
                            entry.redacted_data =
                                block.get("data").and_then(Value::as_str).map(String::from);
                        }
                        "tool_use" => {
                            entry.tool_id =
                                block.get("id").and_then(Value::as_str).map(String::from);
                            entry.tool_name =
                                block.get("name").and_then(Value::as_str).map(String::from);
                            if let Some(input) = block.get("input").filter(|value| {
                                !value.is_null()
                                    && value.as_object().map(|map| !map.is_empty()).unwrap_or(true)
                            }) {
                                entry.tool_input_json = input.to_string();
                            }
                        }
                        _ => {}
                    }
                }
            }
            "content_block_delta" => {
                let index = payload.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                if let Some(delta) = payload.get("delta") {
                    let delta_type = delta
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default();

                    match delta_type {
                        "text_delta" => {
                            if let Some(text) = delta
                                .get("text")
                                .and_then(Value::as_str)
                                .filter(|t| !t.is_empty())
                            {
                                let entry = self.blocks.entry(index).or_default();
                                entry.text.push_str(text);
                                events.push(LlmStreamEvent::TextDelta {
                                    part_id: format!("text-{index}"),
                                    text: text.to_string(),
                                });
                            }
                        }
                        "thinking_delta" => {
                            if let Some(text) = delta
                                .get("thinking")
                                .and_then(Value::as_str)
                                .filter(|t| !t.is_empty())
                            {
                                self.blocks.entry(index).or_default().text.push_str(text);
                                events.push(LlmStreamEvent::ReasoningDelta {
                                    part_id: format!("reasoning-{index}"),
                                    text: text.to_string(),
                                });
                            }
                        }
                        "signature_delta" => {
                            if let Some(signature) = delta.get("signature").and_then(Value::as_str)
                            {
                                self.blocks.entry(index).or_default().signature =
                                    Some(signature.to_string());
                            }
                        }
                        "input_json_delta" => {
                            if let Some(json_str) = delta
                                .get("partial_json")
                                .and_then(Value::as_str)
                                .filter(|t| !t.is_empty())
                            {
                                let entry = self.blocks.entry(index).or_default();
                                entry.tool_input_json.push_str(json_str);
                                let tool_call_id = entry
                                    .tool_id
                                    .clone()
                                    .unwrap_or_else(|| format!("tool-{index}"));
                                events.push(LlmStreamEvent::ToolInputDelta {
                                    tool_call_id,
                                    name: entry.tool_name.clone(),
                                    text: json_str.to_string(),
                                });
                            }
                        }
                        _ => {}
                    }
                }
            }
            "content_block_stop" => {
                let index = payload.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let should_emit = self
                    .blocks
                    .get(&index)
                    .map(|b| b.block_type == "tool_use" && !b.emitted)
                    .unwrap_or(false);
                if should_emit {
                    if let Some(block) = self.blocks.get_mut(&index) {
                        block.emitted = true;
                    }
                    if let Some(block) = self.blocks.get(&index) {
                        events.push(self.emit_tool_call(index, block));
                    }
                }
            }
            "message_delta" => {
                if let Some(delta) = payload.get("delta") {
                    if let Some(reason) = delta.get("stop_reason").and_then(Value::as_str) {
                        self.finish_reason = Some(reason.to_string());
                    }
                }
                if let Some(usage) = payload.get("usage") {
                    merge_usage(&mut self.usage, usage);
                }
                events.extend(self.emit_terminal_events());
                events.extend(self.emit_finish());
            }
            "message_stop" => {
                events.extend(self.emit_terminal_events());
                events.extend(self.emit_finish());
            }
            "ping" => {}
            "error" => {
                let error_type = payload
                    .pointer("/error/type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown_error");
                let message = payload
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Anthropic streaming 请求失败");
                return Err(format!(
                    "AI 服务 streaming 请求失败: {error_type}: {message}"
                ));
            }
            _ => {}
        }

        Ok(events)
    }

    fn emit_tool_call(&self, index: usize, block: &AnthropicContentBlock) -> LlmStreamEvent {
        let original_name = block.tool_name.clone().unwrap_or_default();
        let call_id = block
            .tool_id
            .clone()
            .unwrap_or_else(|| format!("tool-{index}"));
        let input_json = if block.tool_input_json.trim().is_empty() {
            "{}"
        } else {
            &block.tool_input_json
        };
        let (name, input) = match serde_json::from_str(input_json) {
            Ok(value) => (normalize_tool_name(&original_name), value),
            Err(error) => (
                "invalid".to_string(),
                serde_json::json!({
                    "tool": original_name,
                    "error": error.to_string(),
                    "arguments": block.tool_input_json,
                    "callId": call_id
                }),
            ),
        };
        LlmStreamEvent::ToolCall(ToolCallRequest {
            tool_call_id: Some(call_id),
            name,
            input,
        })
    }

    fn emit_terminal_events(&mut self) -> Vec<LlmStreamEvent> {
        let mut events = Vec::new();
        for block in self.blocks.values_mut() {
            if block.block_type == "tool_use" && !block.emitted {
                block.emitted = true;
                // Can't call emit_tool_call here because we need index;
                // Use tool_id as fallback.
                let original_name = block.tool_name.clone().unwrap_or_default();
                let call_id = block.tool_id.clone().unwrap_or_default();
                let input_json = if block.tool_input_json.trim().is_empty() {
                    "{}"
                } else {
                    &block.tool_input_json
                };
                let (name, input) = match serde_json::from_str(input_json) {
                    Ok(value) => (normalize_tool_name(&original_name), value),
                    Err(error) => (
                        "invalid".to_string(),
                        serde_json::json!({
                            "tool": original_name,
                            "error": error.to_string(),
                            "arguments": block.tool_input_json,
                            "callId": call_id
                        }),
                    ),
                };
                events.push(LlmStreamEvent::ToolCall(ToolCallRequest {
                    tool_call_id: Some(call_id),
                    name,
                    input,
                }));
            }
        }
        events
    }

    fn emit_finish(&mut self) -> Vec<LlmStreamEvent> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        vec![LlmStreamEvent::Finish {
            finish_reason: self.finish_reason.clone(),
            usage: self.usage.clone(),
        }]
    }
}

impl AnthropicContentBlock {
    fn native_value(&self) -> Option<Value> {
        match self.block_type.as_str() {
            "text" => Some(serde_json::json!({ "type": "text", "text": self.text })),
            "thinking" => {
                let mut block = serde_json::Map::new();
                block.insert("type".to_string(), serde_json::json!("thinking"));
                block.insert("thinking".to_string(), serde_json::json!(self.text));
                if let Some(signature) = &self.signature {
                    block.insert("signature".to_string(), serde_json::json!(signature));
                }
                Some(Value::Object(block))
            }
            "redacted_thinking" => Some(serde_json::json!({
                "type": "redacted_thinking",
                "data": self.redacted_data.as_deref().unwrap_or_default()
            })),
            "tool_use" => {
                let input = serde_json::from_str(&self.tool_input_json)
                    .unwrap_or_else(|_| serde_json::json!({}));
                Some(serde_json::json!({
                    "type": "tool_use",
                    "id": self.tool_id.as_deref().unwrap_or_default(),
                    "name": self.tool_name.as_deref().unwrap_or_default(),
                    "input": input
                }))
            }
            _ => None,
        }
    }
}

fn merge_usage(target: &mut Option<Value>, update: &Value) {
    match (
        target.as_mut().and_then(Value::as_object_mut),
        update.as_object(),
    ) {
        (Some(target), Some(update)) => {
            for (key, value) in update {
                target.insert(key.clone(), value.clone());
            }
        }
        _ => *target = Some(update.clone()),
    }
}

#[derive(Debug, Default)]
pub struct OpenAiResponsesStreamParser {
    buffer: String,
    content: ReasoningTagSplitter,
    tools: HashMap<String, ToolAccumulator>,
    finish_reason: Option<String>,
    usage: Option<Value>,
    finished: bool,
}

impl OpenAiChatStreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_str(&mut self, chunk: &str) -> Result<Vec<LlmStreamEvent>, String> {
        self.buffer.push_str(chunk);
        let mut events = Vec::new();
        while let Some((block, consumed)) = next_sse_block(&self.buffer) {
            self.buffer.drain(..consumed);
            if let Some(data) = sse_data(&block) {
                events.extend(self.parse_data(&data)?);
            }
        }
        Ok(events)
    }

    pub fn finish(&mut self) -> Result<Vec<LlmStreamEvent>, String> {
        let mut events = Vec::new();
        if !self.buffer.trim().is_empty() {
            let block = std::mem::take(&mut self.buffer);
            if let Some(data) = sse_data(&block) {
                events.extend(self.parse_data(&data)?);
            }
        }
        events.extend(self.emit_terminal_events()?);
        events.extend(self.emit_finish());
        Ok(events)
    }

    fn parse_data(&mut self, data: &str) -> Result<Vec<LlmStreamEvent>, String> {
        let trimmed = data.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        if trimmed == "[DONE]" {
            let mut events = self.emit_terminal_events()?;
            events.extend(self.emit_finish());
            return Ok(events);
        }

        let payload: Value = serde_json::from_str(trimmed)
            .map_err(|error| format!("AI 服务返回了无效 streaming JSON: {error}"))?;
        self.parse_payload(&payload)
    }

    fn parse_payload(&mut self, payload: &Value) -> Result<Vec<LlmStreamEvent>, String> {
        let mut events = Vec::new();
        let usage = payload
            .get("usage")
            .filter(|value| !value.is_null())
            .cloned();
        let choices = payload
            .get("choices")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        if let Some(usage) = usage.clone() {
            self.usage = Some(usage);
        }

        if choices.is_empty() && self.usage.is_some() {
            events.extend(self.emit_terminal_events()?);
            events.extend(self.emit_finish());
            return Ok(events);
        }

        for choice in choices {
            if let Some(delta) = choice.get("delta") {
                if let Some(text) = delta.get("content").and_then(Value::as_str) {
                    events.extend(self.content.push(text).into_iter().map(content_delta_event));
                }
                if let Some(text) = delta
                    .get("reasoning_content")
                    .or_else(|| delta.get("reasoning"))
                    .and_then(Value::as_str)
                {
                    if !text.is_empty() {
                        events.push(LlmStreamEvent::ReasoningDelta {
                            part_id: "reasoning-0".to_string(),
                            text: text.to_string(),
                        });
                    }
                }
                if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                    for call in calls {
                        if let Some(event) = self.push_tool_delta(call) {
                            events.push(event);
                        }
                    }
                }
            }

            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                self.finish_reason = Some(reason.to_string());
                events.extend(self.emit_terminal_events()?);
                if self.usage.is_some() {
                    events.extend(self.emit_finish());
                }
            }
        }

        Ok(events)
    }

    fn push_tool_delta(&mut self, call: &Value) -> Option<LlmStreamEvent> {
        let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let item = self.tools.entry(index).or_default();
        if let Some(id) = call.get("id").and_then(Value::as_str) {
            if !id.is_empty() {
                item.id = Some(id.to_string());
            }
        }
        if let Some(name) = call
            .pointer("/function/name")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            item.name = Some(name.to_string());
        }
        let arguments = call
            .pointer("/function/arguments")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if arguments.is_empty() {
            return None;
        }
        item.arguments.push_str(arguments);
        Some(LlmStreamEvent::ToolInputDelta {
            tool_call_id: item
                .id
                .clone()
                .unwrap_or_else(|| format!("tool-call-{index}")),
            name: item.name.clone(),
            text: arguments.to_string(),
        })
    }

    fn emit_tool_calls(&mut self) -> Result<Vec<LlmStreamEvent>, String> {
        let mut events = Vec::new();
        let mut indexes = self.tools.keys().copied().collect::<Vec<_>>();
        indexes.sort_unstable();
        for index in indexes {
            let Some(item) = self.tools.get_mut(&index) else {
                continue;
            };
            if item.emitted {
                continue;
            }
            let Some(name) = item.name.clone() else {
                continue;
            };
            item.emitted = true;
            let (name, input) = match serde_json::from_str(&item.arguments) {
                Ok(value) => (normalize_tool_name(&name), value),
                Err(error) => {
                    let call_id = item
                        .id
                        .clone()
                        .unwrap_or_else(|| format!("tool-call-{index}"));
                    (
                        "invalid".to_string(),
                        serde_json::json!({
                            "tool": name,
                            "error": error.to_string(),
                            "arguments": item.arguments,
                            "callId": call_id
                        }),
                    )
                }
            };
            events.push(LlmStreamEvent::ToolCall(ToolCallRequest {
                tool_call_id: item
                    .id
                    .clone()
                    .or_else(|| Some(format!("tool-call-{index}"))),
                name,
                input,
            }));
        }
        Ok(events)
    }

    fn emit_finish(&mut self) -> Vec<LlmStreamEvent> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        vec![LlmStreamEvent::Finish {
            finish_reason: self.finish_reason.clone(),
            usage: self.usage.clone(),
        }]
    }

    fn emit_terminal_events(&mut self) -> Result<Vec<LlmStreamEvent>, String> {
        let mut events = self
            .content
            .finish()
            .into_iter()
            .map(content_delta_event)
            .collect::<Vec<_>>();
        events.extend(self.emit_tool_calls()?);
        Ok(events)
    }
}

impl OpenAiResponsesStreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_str(&mut self, chunk: &str) -> Result<Vec<LlmStreamEvent>, String> {
        self.buffer.push_str(chunk);
        let mut events = Vec::new();
        while let Some((block, consumed)) = next_sse_block(&self.buffer) {
            self.buffer.drain(..consumed);
            if let Some(data) = sse_data(&block) {
                events.extend(self.parse_data(&data)?);
            }
        }
        Ok(events)
    }

    pub fn finish(&mut self) -> Result<Vec<LlmStreamEvent>, String> {
        let mut events = Vec::new();
        if !self.buffer.trim().is_empty() {
            let block = std::mem::take(&mut self.buffer);
            if let Some(data) = sse_data(&block) {
                events.extend(self.parse_data(&data)?);
            }
        }
        events.extend(self.emit_terminal_events()?);
        events.extend(self.emit_finish());
        Ok(events)
    }

    fn parse_data(&mut self, data: &str) -> Result<Vec<LlmStreamEvent>, String> {
        let trimmed = data.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        if trimmed == "[DONE]" {
            let mut events = self.emit_terminal_events()?;
            events.extend(self.emit_finish());
            return Ok(events);
        }

        let payload: Value = serde_json::from_str(trimmed)
            .map_err(|error| format!("AI 服务返回了无效 streaming JSON: {error}"))?;
        self.parse_payload(&payload)
    }

    fn parse_payload(&mut self, payload: &Value) -> Result<Vec<LlmStreamEvent>, String> {
        let mut events = Vec::new();
        if let Some(usage) = payload
            .pointer("/response/usage")
            .or_else(|| payload.get("usage"))
            .filter(|value| !value.is_null())
            .cloned()
        {
            self.usage = Some(usage);
        }

        match payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "response.output_text.delta" => {
                if let Some(text) = payload.get("delta").and_then(Value::as_str) {
                    events.extend(self.content.push(text).into_iter().map(content_delta_event));
                }
            }
            "response.reasoning_summary_text.delta"
            | "response.reasoning_text.delta"
            | "response.reasoning.delta" => {
                if let Some(text) = payload
                    .get("delta")
                    .or_else(|| payload.get("text"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    events.push(LlmStreamEvent::ReasoningDelta {
                        part_id: payload
                            .get("item_id")
                            .or_else(|| payload.get("output_index"))
                            .and_then(value_to_part_id)
                            .unwrap_or_else(|| "reasoning-0".to_string()),
                        text: text.to_string(),
                    });
                }
            }
            "response.output_item.added" | "response.output_item.done" => {
                if let Some(item) = payload.get("item") {
                    self.ingest_response_item(item);
                    if payload.get("type").and_then(Value::as_str)
                        == Some("response.output_item.done")
                    {
                        events.extend(self.emit_tool_call_for_item(item)?);
                    }
                }
            }
            "response.function_call_arguments.delta" => {
                if let Some(event) = self.push_function_arguments_delta(payload) {
                    events.push(event);
                }
            }
            "response.function_call_arguments.done" => {
                self.ingest_function_arguments_done(payload);
                if let Some(item_id) = responses_item_key(payload) {
                    events.extend(self.emit_tool_call_by_key(&item_id)?);
                }
            }
            "response.completed" => {
                self.finish_reason = Some("stop".to_string());
                if let Some(output) = payload
                    .pointer("/response/output")
                    .and_then(Value::as_array)
                {
                    for item in output {
                        self.ingest_response_item(item);
                    }
                }
                events.extend(self.emit_terminal_events()?);
                events.extend(self.emit_finish());
            }
            "response.incomplete" => {
                self.finish_reason = payload
                    .pointer("/response/incomplete_details/reason")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .or_else(|| Some("incomplete".to_string()));
                events.extend(self.emit_terminal_events()?);
                events.extend(self.emit_finish());
            }
            "response.failed" => {
                let message = payload
                    .pointer("/response/error/message")
                    .or_else(|| payload.pointer("/error/message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Responses streaming 请求失败");
                return Err(format!("AI 服务 streaming 请求失败: {message}"));
            }
            _ => {}
        }

        Ok(events)
    }

    fn ingest_response_item(&mut self, item: &Value) {
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            return;
        }
        let Some(key) = responses_item_key(item) else {
            return;
        };
        let entry = self.tools.entry(key).or_default();
        if let Some(id) = item
            .get("call_id")
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            entry.id = Some(id.to_string());
        }
        if let Some(name) = item
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            entry.name = Some(name.to_string());
        }
        if let Some(arguments) = item
            .get("arguments")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            entry.arguments = arguments.to_string();
        }
    }

    fn push_function_arguments_delta(&mut self, payload: &Value) -> Option<LlmStreamEvent> {
        let key = responses_item_key(payload)?;
        let delta = payload
            .get("delta")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if delta.is_empty() {
            return None;
        }
        let item = self.tools.entry(key.clone()).or_default();
        item.arguments.push_str(delta);
        Some(LlmStreamEvent::ToolInputDelta {
            tool_call_id: item.id.clone().unwrap_or(key),
            name: item.name.clone(),
            text: delta.to_string(),
        })
    }

    fn ingest_function_arguments_done(&mut self, payload: &Value) {
        let Some(key) = responses_item_key(payload) else {
            return;
        };
        let Some(arguments) = payload
            .get("arguments")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            return;
        };
        self.tools.entry(key).or_default().arguments = arguments.to_string();
    }

    fn emit_tool_call_for_item(&mut self, item: &Value) -> Result<Vec<LlmStreamEvent>, String> {
        let Some(key) = responses_item_key(item) else {
            return Ok(Vec::new());
        };
        self.emit_tool_call_by_key(&key)
    }

    fn emit_tool_call_by_key(&mut self, key: &str) -> Result<Vec<LlmStreamEvent>, String> {
        let Some(item) = self.tools.get_mut(key) else {
            return Ok(Vec::new());
        };
        if item.emitted {
            return Ok(Vec::new());
        }
        let Some(name) = item.name.clone() else {
            return Ok(Vec::new());
        };
        item.emitted = true;
        Ok(vec![tool_call_event(key, item, name)])
    }

    fn emit_tool_calls(&mut self) -> Vec<LlmStreamEvent> {
        let mut events = Vec::new();
        let mut keys = self.tools.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        for key in keys {
            let Some(item) = self.tools.get_mut(&key) else {
                continue;
            };
            if item.emitted {
                continue;
            }
            let Some(name) = item.name.clone() else {
                continue;
            };
            item.emitted = true;
            events.push(tool_call_event(&key, item, name));
        }
        events
    }

    fn emit_finish(&mut self) -> Vec<LlmStreamEvent> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        vec![LlmStreamEvent::Finish {
            finish_reason: self.finish_reason.clone(),
            usage: self.usage.clone(),
        }]
    }

    fn emit_terminal_events(&mut self) -> Result<Vec<LlmStreamEvent>, String> {
        let mut events = self
            .content
            .finish()
            .into_iter()
            .map(content_delta_event)
            .collect::<Vec<_>>();
        events.extend(self.emit_tool_calls());
        Ok(events)
    }
}

fn value_to_part_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(ToString::to_string)
        .or_else(|| value.as_u64().map(|value| value.to_string()))
}

fn responses_item_key(value: &Value) -> Option<String> {
    value
        .get("item_id")
        .or_else(|| value.get("id"))
        .or_else(|| value.get("call_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            value
                .get("output_index")
                .and_then(value_to_part_id)
                .map(|index| format!("output-{index}"))
        })
}

fn tool_call_event(key: &str, item: &ToolAccumulator, original_name: String) -> LlmStreamEvent {
    let (name, input) = match serde_json::from_str(&item.arguments) {
        Ok(value) => (normalize_tool_name(&original_name), value),
        Err(error) => {
            let call_id = item.id.clone().unwrap_or_else(|| key.to_string());
            (
                "invalid".to_string(),
                serde_json::json!({
                    "tool": original_name,
                    "error": error.to_string(),
                    "arguments": item.arguments,
                    "callId": call_id
                }),
            )
        }
    };
    LlmStreamEvent::ToolCall(ToolCallRequest {
        tool_call_id: item.id.clone().or_else(|| Some(key.to_string())),
        name,
        input,
    })
}

#[derive(Debug, Default)]
struct ReasoningTagSplitter {
    pending: String,
    in_reasoning: bool,
}

#[derive(Debug, Clone, PartialEq)]
enum ContentDelta {
    Text(String),
    Reasoning(String),
}

impl ReasoningTagSplitter {
    fn push(&mut self, text: &str) -> Vec<ContentDelta> {
        self.pending.push_str(text);
        self.drain(false)
    }

    fn finish(&mut self) -> Vec<ContentDelta> {
        self.drain(true)
    }

    fn drain(&mut self, final_chunk: bool) -> Vec<ContentDelta> {
        let input = std::mem::take(&mut self.pending);
        let mut events = Vec::new();
        let mut cursor = 0;

        while cursor < input.len() {
            let Some(relative_tag_start) = input[cursor..].find('<') else {
                push_content_delta(&mut events, self.in_reasoning, &input[cursor..]);
                break;
            };
            let tag_start = cursor + relative_tag_start;
            if tag_start > cursor {
                push_content_delta(&mut events, self.in_reasoning, &input[cursor..tag_start]);
            }

            match parse_reasoning_tag(&input[tag_start..]) {
                TagScan::Complete { byte_len, closing } => {
                    self.in_reasoning = !closing;
                    cursor = tag_start + byte_len;
                }
                TagScan::Incomplete if !final_chunk => {
                    self.pending.push_str(&input[tag_start..]);
                    break;
                }
                TagScan::Incomplete | TagScan::NotTag => {
                    push_content_delta(&mut events, self.in_reasoning, "<");
                    cursor = tag_start + 1;
                }
            }
        }

        events
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TagScan {
    Complete { byte_len: usize, closing: bool },
    Incomplete,
    NotTag,
}

fn parse_reasoning_tag(input: &str) -> TagScan {
    if !input.starts_with('<') {
        return TagScan::NotTag;
    }
    let Some(end) = input.find('>') else {
        return TagScan::Incomplete;
    };
    let mut body = input[1..end].trim();
    let closing = body.starts_with('/');
    if closing {
        body = body[1..].trim_start();
    }
    let name = body.split_whitespace().next().unwrap_or_default();
    if name == "think" || name.starts_with("think_") {
        TagScan::Complete {
            byte_len: end + 1,
            closing,
        }
    } else {
        TagScan::NotTag
    }
}

fn push_content_delta(events: &mut Vec<ContentDelta>, in_reasoning: bool, text: &str) {
    if text.is_empty() {
        return;
    }
    let next = if in_reasoning {
        ContentDelta::Reasoning(text.to_string())
    } else {
        ContentDelta::Text(text.to_string())
    };
    if let Some(last) = events.last_mut() {
        match (last, &next) {
            (ContentDelta::Text(existing), ContentDelta::Text(value))
            | (ContentDelta::Reasoning(existing), ContentDelta::Reasoning(value)) => {
                existing.push_str(value);
                return;
            }
            _ => {}
        }
    }
    events.push(next);
}

fn content_delta_event(delta: ContentDelta) -> LlmStreamEvent {
    match delta {
        ContentDelta::Text(text) => LlmStreamEvent::TextDelta {
            part_id: "text-0".to_string(),
            text,
        },
        ContentDelta::Reasoning(text) => LlmStreamEvent::ReasoningDelta {
            part_id: "reasoning-0".to_string(),
            text,
        },
    }
}

pub fn sanitize_assistant_content(text: &str) -> SanitizedAssistantContent {
    let mut splitter = ReasoningTagSplitter::default();
    let mut result = SanitizedAssistantContent {
        text: String::new(),
        reasoning: String::new(),
    };
    for delta in splitter.push(text).into_iter().chain(splitter.finish()) {
        match delta {
            ContentDelta::Text(text) => result.text.push_str(&text),
            ContentDelta::Reasoning(text) => result.reasoning.push_str(&text),
        }
    }
    result
}

fn next_sse_block(buffer: &str) -> Option<(String, usize)> {
    if let Some(index) = buffer.find("\r\n\r\n") {
        return Some((buffer[..index].to_string(), index + 4));
    }
    buffer
        .find("\n\n")
        .map(|index| (buffer[..index].to_string(), index + 2))
}

fn sse_data(block: &str) -> Option<String> {
    let lines = block
        .lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
        .collect::<Vec<_>>();
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

pub fn normalize_tool_name(name: &str) -> String {
    match name.trim().to_ascii_lowercase().as_str() {
        "bash" => "shell".to_string(),
        "grep" => "search".to_string(),
        "todowrite" => "todo_write".to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(input: &str) -> Vec<LlmStreamEvent> {
        let mut parser = OpenAiChatStreamParser::new();
        parser.push_str(input).expect("stream events")
    }

    #[test]
    fn parses_text_delta_and_done() {
        let events = parse(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}],\"usage\":{\"total_tokens\":3}}\n\n",
        );

        assert_eq!(
            events,
            vec![
                LlmStreamEvent::TextDelta {
                    part_id: "text-0".to_string(),
                    text: "hel".to_string()
                },
                LlmStreamEvent::TextDelta {
                    part_id: "text-0".to_string(),
                    text: "lo".to_string()
                },
                LlmStreamEvent::Finish {
                    finish_reason: Some("stop".to_string()),
                    usage: Some(serde_json::json!({ "total_tokens": 3 }))
                }
            ]
        );
    }

    #[test]
    fn carries_usage_from_late_usage_chunk() {
        let events = parse(
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
             data: {\"choices\":[],\"usage\":{\"total_tokens\":7}}\n\n",
        );

        assert_eq!(
            events,
            vec![LlmStreamEvent::Finish {
                finish_reason: Some("stop".to_string()),
                usage: Some(serde_json::json!({ "total_tokens": 7 }))
            }]
        );
    }

    #[test]
    fn parses_reasoning_delta() {
        let events =
            parse("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"}}]}\n\n");

        assert_eq!(
            events,
            vec![LlmStreamEvent::ReasoningDelta {
                part_id: "reasoning-0".to_string(),
                text: "think".to_string()
            }]
        );
    }

    #[test]
    fn strips_unmatched_think_never_used_closing_tag() {
        let events = parse(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello</think_never_used_51bce0c785ca2f68081bfa7d91973934>\"}}]}\n\n",
        );

        assert_eq!(
            events,
            vec![LlmStreamEvent::TextDelta {
                part_id: "text-0".to_string(),
                text: "hello".to_string()
            }]
        );
    }

    #[test]
    fn strips_split_think_never_used_closing_tag() {
        let events = parse(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello</think_never_\"}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"used_51bce0c785ca2f68081bfa7d91973934>\"}}]}\n\n",
        );

        assert_eq!(
            events,
            vec![LlmStreamEvent::TextDelta {
                part_id: "text-0".to_string(),
                text: "hello".to_string()
            }]
        );
    }

    #[test]
    fn moves_content_think_block_to_reasoning() {
        let events = parse(
            "data: {\"choices\":[{\"delta\":{\"content\":\"<think>hidden</think>visible\"}}]}\n\n",
        );

        assert_eq!(
            events,
            vec![
                LlmStreamEvent::ReasoningDelta {
                    part_id: "reasoning-0".to_string(),
                    text: "hidden".to_string()
                },
                LlmStreamEvent::TextDelta {
                    part_id: "text-0".to_string(),
                    text: "visible".to_string()
                }
            ]
        );
    }

    #[test]
    fn accumulates_tool_arguments() {
        let events = parse(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"pa\"}}]}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"th\\\":\\\"src/main.rs\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
        );

        assert!(matches!(
            &events[0],
            LlmStreamEvent::ToolInputDelta { tool_call_id, .. } if tool_call_id == "call_1"
        ));
        let call = events
            .iter()
            .find_map(|event| match event {
                LlmStreamEvent::ToolCall(call) => Some(call),
                _ => None,
            })
            .expect("tool call");
        assert_eq!(call.tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(call.name, "read");
        assert_eq!(call.input["path"], "src/main.rs");
    }

    #[test]
    fn done_finishes_stream() {
        let events = parse("data: [DONE]\n\n");

        assert_eq!(
            events,
            vec![LlmStreamEvent::Finish {
                finish_reason: None,
                usage: None
            }]
        );
    }

    #[test]
    fn rejects_invalid_json() {
        let mut parser = OpenAiChatStreamParser::new();
        let error = parser
            .push_str("data: {not-json}\n\n")
            .expect_err("invalid json");

        assert!(error.contains("无效 streaming JSON"));
    }

    #[test]
    fn responses_parser_streams_text_and_finish() {
        let mut parser = OpenAiResponsesStreamParser::new();
        let events = parser
            .push_str(
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"完成\"}\n\n\
                 data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1}}}\n\n",
            )
            .expect("stream events");

        assert!(events.contains(&LlmStreamEvent::TextDelta {
            part_id: "text-0".to_string(),
            text: "完成".to_string()
        }));
        assert!(events.iter().any(|event| {
            matches!(
                event,
                LlmStreamEvent::Finish {
                    finish_reason: Some(reason),
                    usage: Some(_)
                } if reason == "stop"
            )
        }));
    }

    #[test]
    fn responses_parser_streams_tool_arguments_and_call() {
        let mut parser = OpenAiResponsesStreamParser::new();
        let events = parser
            .push_str(
                "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"read\",\"arguments\":\"\"}}\n\n\
                 data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"{\\\"path\\\":\"}\n\n\
                 data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"\\\"src/main.rs\\\"}\"}\n\n\
                 data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"arguments\":\"{\\\"path\\\":\\\"src/main.rs\\\"}\"}\n\n",
            )
            .expect("stream events");

        assert!(events.iter().any(|event| {
            matches!(
                event,
                LlmStreamEvent::ToolInputDelta {
                    tool_call_id,
                    name: Some(name),
                    text,
                } if tool_call_id == "call_1" && name == "read" && text.contains("path")
            )
        }));
        let tool = events
            .iter()
            .find_map(|event| match event {
                LlmStreamEvent::ToolCall(call) => Some(call),
                _ => None,
            })
            .expect("tool call");
        assert_eq!(tool.tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(tool.name, "read");
        assert_eq!(tool.input["path"], "src/main.rs");
    }

    #[test]
    fn responses_parser_rejects_invalid_json() {
        let mut parser = OpenAiResponsesStreamParser::new();
        let error = parser
            .push_str("data: {not-json}\n\n")
            .expect_err("invalid json");

        assert!(error.contains("无效 streaming JSON"));
    }

    // ── Anthropic streaming parser tests ──

    fn anthropic_parse(input: &str) -> Vec<LlmStreamEvent> {
        let mut parser = AnthropicStreamParser::new();
        parser.push_str(input).expect("stream events")
    }

    #[test]
    fn anthropic_parses_text_delta() {
        let events = anthropic_parse(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10}}}\n\n\
             data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}\n\n\
             data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n\
             data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" world\"}}\n\n\
             data: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
             data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n\
             data: {\"type\":\"message_stop\"}\n\n",
        );

        assert!(events.contains(&LlmStreamEvent::TextDelta {
            part_id: "text-0".to_string(),
            text: "hello".to_string()
        }));
        assert!(events.contains(&LlmStreamEvent::TextDelta {
            part_id: "text-0".to_string(),
            text: " world".to_string()
        }));
        assert!(events.iter().any(|e| matches!(
            e,
            LlmStreamEvent::Finish {
                finish_reason: Some(reason),
                usage: Some(_)
            } if reason == "end_turn"
        )));
    }

    #[test]
    fn anthropic_parses_tool_use() {
        let events = anthropic_parse(
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_123\",\"name\":\"read\"}}\n\n\
             data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\"}}\n\n\
             data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"src/main.rs\\\"}\"}}\n\n\
             data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        );

        assert!(events.iter().any(|event| {
            matches!(
                event,
                LlmStreamEvent::ToolInputDelta {
                    tool_call_id,
                    name: Some(name),
                    text,
                } if tool_call_id == "toolu_123" && name == "read" && text.contains("path")
            )
        }));
        let tool = events
            .iter()
            .find_map(|event| match event {
                LlmStreamEvent::ToolCall(call) => Some(call),
                _ => None,
            })
            .expect("tool call");
        assert_eq!(tool.tool_call_id.as_deref(), Some("toolu_123"));
        assert_eq!(tool.name, "read");
        assert_eq!(tool.input["path"], "src/main.rs");
    }

    #[test]
    fn anthropic_parses_thinking_delta() {
        let events = anthropic_parse(
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\"}}\n\n\
             data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"let me think...\"}}\n\n",
        );

        assert!(events.contains(&LlmStreamEvent::ReasoningDelta {
            part_id: "reasoning-0".to_string(),
            text: "let me think...".to_string()
        }));
    }

    #[test]
    fn anthropic_preserves_signed_and_redacted_thinking_blocks() {
        let mut parser = AnthropicStreamParser::new();
        parser
            .push_str(
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n\
                 data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"plan\"}}\n\n\
                 data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"signed-value\"}}\n\n\
                 data: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
                 data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"redacted_thinking\",\"data\":\"opaque\"}}\n\n\
                 data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
            )
            .expect("stream events");

        assert_eq!(
            parser.native_content(),
            vec![
                json!({"type":"thinking","thinking":"plan","signature":"signed-value"}),
                json!({"type":"redacted_thinking","data":"opaque"})
            ]
        );
    }

    #[test]
    fn anthropic_merges_start_and_delta_usage() {
        let mut parser = AnthropicStreamParser::new();
        let events = parser
            .push_str(
                "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":3}}}\n\n\
                 data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n",
            )
            .expect("stream events");
        let usage = events.iter().find_map(|event| match event {
            LlmStreamEvent::Finish { usage, .. } => usage.as_ref(),
            _ => None,
        });
        assert_eq!(
            usage.and_then(|value| value.get("input_tokens")),
            Some(&json!(10))
        );
        assert_eq!(
            usage.and_then(|value| value.get("output_tokens")),
            Some(&json!(5))
        );
        assert_eq!(
            usage.and_then(|value| value.get("cache_read_input_tokens")),
            Some(&json!(3))
        );
    }

    #[test]
    fn anthropic_empty_tool_input_is_an_empty_object() {
        let events = anthropic_parse(
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"skill_list\",\"input\":{}}}\n\n\
             data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        );
        let call = events.iter().find_map(|event| match event {
            LlmStreamEvent::ToolCall(call) => Some(call),
            _ => None,
        });
        assert_eq!(call.map(|call| &call.input), Some(&json!({})));
    }

    #[test]
    fn anthropic_handles_error_event() {
        let mut parser = AnthropicStreamParser::new();
        let error = parser
            .push_str("data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n")
            .expect_err("error event");

        assert!(error.contains("Overloaded"));
    }

    #[test]
    fn anthropic_rejects_invalid_json() {
        let mut parser = AnthropicStreamParser::new();
        let error = parser
            .push_str("data: {not-json}\n\n")
            .expect_err("invalid json");

        assert!(error.contains("无效 streaming JSON"));
    }
}
