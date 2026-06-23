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
}
