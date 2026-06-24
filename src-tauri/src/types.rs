use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolMode {
    Native,
    Json,
    Auto,
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
#[serde(rename_all = "lowercase")]
pub enum SessionInputDelivery {
    Steer,
    Queue,
}

impl SessionInputDelivery {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::Queue => "queue",
        }
    }

    pub fn from_str(value: &str) -> Result<Self, String> {
        match value {
            "steer" => Ok(Self::Steer),
            "queue" => Ok(Self::Queue),
            _ => Err(format!("Unsupported session input delivery: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionReply {
    Once,
    Always,
    Reject,
}

impl PermissionReply {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Always => "always",
            Self::Reject => "reject",
        }
    }

    pub fn from_str(value: &str) -> Result<Self, String> {
        match value {
            "once" => Ok(Self::Once),
            "always" => Ok(Self::Always),
            "reject" => Ok(Self::Reject),
            _ => Err(format!("Unsupported permission reply: {value}")),
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

#[derive(Debug, Clone, Default)]
pub struct ProviderPricing {
    pub input_per_million: f64,
    pub output_per_million: f64,
    pub cache_read_per_million: f64,
    pub cache_write_per_million: f64,
}

#[derive(Debug, Clone)]
pub struct ProviderRequestConfig {
    pub kind: ProviderKind,
    pub tool_mode: ToolMode,
    pub base_url: Option<String>,
    pub model: String,
    pub api_key: String,
    pub headers: HashMap<String, String>,
    pub body: serde_json::Map<String, Value>,
    pub context_token_limit: Option<u64>,
    pub input_token_limit: Option<u64>,
    pub output_token_limit: Option<u64>,
    pub pricing: ProviderPricing,
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
    pub parent_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub parent_session_id: Option<String>,
    pub project_root: String,
    pub mode: AgentMode,
    pub provider_id: String,
    pub title: String,
    pub status: String,
    pub shell_mode: ShellMode,
    pub total_cost: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionTitleInput {
    pub session_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionModeInput {
    pub session_id: String,
    pub mode: Option<AgentMode>,
    pub shell_mode: Option<ShellMode>,
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
pub struct SessionInputRecord {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    #[serde(default)]
    pub attachments: Vec<PromptAttachment>,
    pub delivery: SessionInputDelivery,
    pub resume: bool,
    pub status: String,
    pub promoted_event_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptAttachment {
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub kind: PromptAttachmentKind,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptAttachmentKind {
    Text,
    Image,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRunRecord {
    pub id: String,
    pub session_id: String,
    pub status: String,
    pub started_at: String,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCheckpointRecord {
    pub id: String,
    pub session_id: String,
    pub run_id: Option<String>,
    pub event_id: Option<String>,
    pub label: String,
    pub step_index: Option<i64>,
    pub status: String,
    pub data: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestRecord {
    pub id: String,
    pub session_id: String,
    pub action: String,
    pub resources: Vec<String>,
    pub save: Vec<String>,
    pub source_json: Value,
    pub status: String,
    pub reply: Option<PermissionReply>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJobRecord {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub pid: u32,
    pub status: String,
    pub log_path: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventsResponse {
    pub events: Vec<EventRecord>,
    pub snapshots: Vec<SnapshotRecord>,
    pub summaries: Vec<ContextSummaryRecord>,
    #[serde(default)]
    pub inputs: Vec<SessionInputRecord>,
    #[serde(default)]
    pub runs: Vec<SessionRunRecord>,
    #[serde(default)]
    pub checkpoints: Vec<SessionCheckpointRecord>,
    #[serde(default)]
    pub permissions: Vec<PermissionRequestRecord>,
    #[serde(default)]
    pub jobs: Vec<BackgroundJobRecord>,
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
    #[serde(default)]
    pub attachments: Vec<PromptAttachment>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSessionInput {
    pub id: Option<String>,
    pub session_id: String,
    pub prompt: String,
    #[serde(default)]
    pub attachments: Vec<PromptAttachment>,
    pub delivery: Option<SessionInputDelivery>,
    #[serde(default = "default_resume")]
    pub resume: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverSessionInput {
    pub session_id: String,
    pub checkpoint_id: Option<String>,
}

fn default_resume() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailSessionEventsInput {
    pub session_id: String,
    pub after_seq: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyPermissionInput {
    pub request_id: String,
    pub reply: PermissionReply,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRequest {
    #[serde(default, rename = "toolCallId", alias = "tool_call_id")]
    pub tool_call_id: Option<String>,
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
