use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ProviderKind {
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
    #[serde(rename = "anthropic-compatible")]
    AnthropicCompatible,
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::OpenAiCompatible => "openai-compatible",
            Self::AnthropicCompatible => "anthropic-compatible",
        }
    }

    pub fn from_str(value: &str) -> Result<Self, String> {
        match value {
            "openai" => Ok(Self::OpenAi),
            "anthropic" => Ok(Self::Anthropic),
            "openai-compatible" => Ok(Self::OpenAiCompatible),
            "anthropic-compatible" => Ok(Self::AnthropicCompatible),
            _ => Err(format!("Unsupported provider kind: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    Ask,
    Plan,
    Agent,
}

impl AgentMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Plan => "plan",
            Self::Agent => "agent",
        }
    }

    pub fn from_str(value: &str) -> Result<Self, String> {
        match value {
            "ask" => Ok(Self::Ask),
            "plan" => Ok(Self::Plan),
            "agent" => Ok(Self::Agent),
            _ => Err(format!("Unsupported agent mode: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellMode {
    Manual,
    Auto,
}

impl ShellMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Auto => "auto",
        }
    }

    pub fn from_str(value: &str) -> Result<Self, String> {
        match value {
            "manual" => Ok(Self::Manual),
            "auto" => Ok(Self::Auto),
            _ => Err(format!("Unsupported shell mode: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    pub id: Option<String>,
    pub kind: ProviderKind,
    pub name: String,
    pub base_url: Option<String>,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigFileResponse {
    pub path: String,
    pub content: String,
    pub providers: Vec<ProviderRecord>,
    pub selected_provider_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRecord {
    pub id: String,
    pub kind: ProviderKind,
    pub name: String,
    pub base_url: Option<String>,
    pub model: String,
    pub credential_ref: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct ProviderRequestConfig {
    pub kind: ProviderKind,
    pub base_url: Option<String>,
    pub model: String,
    pub api_key: String,
    pub headers: HashMap<String, String>,
    pub body: serde_json::Map<String, Value>,
    pub config_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionInput {
    pub project_root: String,
    pub mode: AgentMode,
    pub provider_id: String,
    pub shell_mode: ShellMode,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub project_root: String,
    pub mode: AgentMode,
    pub provider_id: String,
    pub title: String,
    pub status: String,
    pub shell_mode: ShellMode,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub data: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRecord {
    pub id: String,
    pub session_id: String,
    pub event_id: Option<String>,
    pub path: String,
    pub before_hash: String,
    pub after_hash: String,
    pub before_content: Option<String>,
    pub after_content: Option<String>,
    pub patch: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSummaryRecord {
    pub id: String,
    pub session_id: String,
    pub text: String,
    pub recent_event_seq: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventsResponse {
    pub events: Vec<EventRecord>,
    pub snapshots: Vec<SnapshotRecord>,
    pub summaries: Vec<ContextSummaryRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellPolicy {
    pub auto_allowlist: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub path: String,
    pub size: u64,
    pub modified_at: String,
    pub language: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitPromptInput {
    pub session_id: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRequest {
    pub name: String,
    #[serde(default)]
    pub input: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTurn {
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default, rename = "toolCalls", alias = "tool_calls")]
    pub tool_calls: Vec<ToolCallRequest>,
    #[serde(default)]
    pub done: bool,
}
