use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppErrorInfo {
    pub id: String,
    pub kind: ErrorKind,
    pub message: String,
    pub causes: Vec<String>,
    pub retryable: bool,
    pub recoverable: bool,
    pub suggested_actions: Vec<RecoveryAction>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Network,
    Provider,
    Authentication,
    RateLimit,
    ContextLimit,
    ModelResponse,
    ToolExecution,
    Permission,
    Storage,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryAction {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

impl AppErrorInfo {
    pub fn from_message(message: impl Into<String>) -> Self {
        let message = message.into();
        let kind = classify_error(&message);
        let retryable = is_retryable(kind, &message);
        let recoverable = is_recoverable(kind);
        let suggested_actions = suggested_actions(kind, retryable, recoverable);
        Self {
            id: Uuid::new_v4().to_string(),
            kind,
            message: first_non_empty_line(&message),
            causes: cause_chain(&message),
            retryable,
            recoverable,
            suggested_actions,
        }
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| {
            json!({
                "id": self.id,
                "kind": "unknown",
                "message": self.message,
                "causes": self.causes,
                "retryable": self.retryable,
                "recoverable": self.recoverable
            })
        })
    }
}

pub fn classify_error(message: &str) -> ErrorKind {
    let lower = message.to_ascii_lowercase();
    if lower.contains("cancel") || message.contains("停止") || message.contains("中断") {
        return ErrorKind::Cancelled;
    }
    if lower.contains("401")
        || lower.contains("403")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("authentication")
        || lower.contains("api key")
        || message.contains("鉴权")
        || message.contains("钥匙串")
    {
        return ErrorKind::Authentication;
    }
    if lower.contains("429")
        || lower.contains("rate limit")
        || lower.contains("too many requests")
        || message.contains("限流")
    {
        return ErrorKind::RateLimit;
    }
    if lower.contains("context")
        || lower.contains("token")
        || lower.contains("maximum context")
        || lower.contains("context_length")
        || message.contains("上下文")
    {
        return ErrorKind::ContextLimit;
    }
    if lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("dns")
        || lower.contains("connection")
        || lower.contains("network")
        || message.contains("网络")
        || message.contains("请求失败")
        || message.contains("读取 AI 服务")
    {
        return ErrorKind::Network;
    }
    if lower.contains("json")
        || lower.contains("utf-8")
        || lower.contains("parse")
        || message.contains("响应")
    {
        return ErrorKind::ModelResponse;
    }
    if message.contains("AI 服务") || lower.contains("http 状态码") || lower.contains("provider")
    {
        return ErrorKind::Provider;
    }
    if message.contains("工具") || lower.contains("tool") || lower.contains("exit code") {
        return ErrorKind::ToolExecution;
    }
    if message.contains("权限") || lower.contains("permission") || lower.contains("denied") {
        return ErrorKind::Permission;
    }
    if lower.contains("sqlite")
        || lower.contains("database")
        || lower.contains("db")
        || message.contains("数据库")
    {
        return ErrorKind::Storage;
    }
    ErrorKind::Unknown
}

fn is_retryable(kind: ErrorKind, message: &str) -> bool {
    if matches!(
        kind,
        ErrorKind::Network | ErrorKind::RateLimit | ErrorKind::Provider
    ) {
        return true;
    }
    let lower = message.to_ascii_lowercase();
    lower.contains("502")
        || lower.contains("503")
        || lower.contains("504")
        || lower.contains("temporar")
        || lower.contains("try again")
}

fn is_recoverable(kind: ErrorKind) -> bool {
    !matches!(kind, ErrorKind::Cancelled | ErrorKind::Storage)
}

fn suggested_actions(kind: ErrorKind, retryable: bool, recoverable: bool) -> Vec<RecoveryAction> {
    let mut actions = Vec::new();
    if retryable {
        actions.push(RecoveryAction {
            id: "retry",
            label: "重试",
            description: "重新发送同一段输入，并从当前会话继续执行。",
        });
    }
    if recoverable {
        actions.push(RecoveryAction {
            id: "continue",
            label: "继续",
            description: "保留当前上下文，让 Agent 根据最近错误继续修复。",
        });
    }
    match kind {
        ErrorKind::Authentication => actions.push(RecoveryAction {
            id: "settings",
            label: "检查设置",
            description: "检查 API Key、模型和服务端点配置。",
        }),
        ErrorKind::ContextLimit => actions.push(RecoveryAction {
            id: "compact",
            label: "压缩上下文",
            description: "压缩较早历史后再继续。",
        }),
        _ => {}
    }
    actions
}

fn cause_chain(message: &str) -> Vec<String> {
    let mut causes = Vec::new();
    for part in message
        .lines()
        .flat_map(|line| line.split(" caused by: "))
        .flat_map(|line| line.split("Caused by: "))
    {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !causes.iter().any(|item| item == trimmed) {
            causes.push(trimmed.to_string());
        }
    }
    if causes.is_empty() {
        causes.push(first_non_empty_line(message));
    }
    causes
}

fn first_non_empty_line(message: &str) -> String {
    message
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("未知错误")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_rate_limit_as_retryable() {
        let info = AppErrorInfo::from_message("AI 服务请求失败，HTTP 状态码 429: rate limit");
        assert_eq!(info.kind, ErrorKind::RateLimit);
        assert!(info.retryable);
        assert!(info.suggested_actions.iter().any(|item| item.id == "retry"));
    }

    #[test]
    fn classifies_auth_as_settings_action() {
        let info = AppErrorInfo::from_message("AI 服务请求失败: unauthorized api key");
        assert_eq!(info.kind, ErrorKind::Authentication);
        assert!(!info.retryable);
        assert!(info
            .suggested_actions
            .iter()
            .any(|item| item.id == "settings"));
    }
}
