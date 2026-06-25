use std::sync::RwLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppLocale {
    Zh,
    En,
}

static LOCALE: RwLock<AppLocale> = RwLock::new(AppLocale::Zh);

pub fn set_app_locale(locale: &str) {
    let next = if locale == "en" {
        AppLocale::En
    } else {
        AppLocale::Zh
    };
    if let Ok(mut guard) = LOCALE.write() {
        *guard = next;
    }
}

pub fn app_locale() -> AppLocale {
    LOCALE.read().map(|guard| *guard).unwrap_or(AppLocale::Zh)
}

fn pick<'a>(zh: &'a str, en: &'a str) -> &'a str {
    match app_locale() {
        AppLocale::Zh => zh,
        AppLocale::En => en,
    }
}

pub fn continue_from_attachment_prompt() -> &'static str {
    pick("请根据附件内容继续。", "Continue based on the attachments.")
}

pub fn user_uploaded_attachments_header() -> &'static str {
    pick("用户上传附件:", "User uploaded attachments:")
}

pub fn attachment_file_template(name: &str, mime: &str, size: u64, content: &str) -> String {
    match app_locale() {
        AppLocale::Zh => format!(
            "附件文件: {name}\nMIME: {mime}\n大小: {size} bytes\n\n{content}"
        ),
        AppLocale::En => format!(
            "Attachment file: {name}\nMIME: {mime}\nSize: {size} bytes\n\n{content}"
        ),
    }
}

pub fn attachment_image_text(name: &str, mime: &str, size: u64) -> String {
    match app_locale() {
        AppLocale::Zh => format!("附件图片: {name} ({mime}, {size} bytes)"),
        AppLocale::En => format!("Attachment image: {name} ({mime}, {size} bytes)"),
    }
}

pub fn attachment_image_replay_note(name: &str, mime: &str, size: u64) -> String {
    match app_locale() {
        AppLocale::Zh => format!(
            "{name} ({mime}, {size} bytes): [图片附件已上传，当前文本协议不内联 base64]"
        ),
        AppLocale::En => format!(
            "{name} ({mime}, {size} bytes): [Image attachment uploaded; base64 omitted in text protocol]"
        ),
    }
}

pub fn compaction_system_prompt() -> &'static str {
    pick(
        "你是上下文压缩器。只输出结构化摘要，不调用工具。",
        "You are a context compactor. Output a structured summary only; do not call tools.",
    )
}

pub fn compaction_prompt(messages: &str) -> String {
    let template = match app_locale() {
        AppLocale::Zh => {
            r#"请对以下对话历史生成结构化摘要，包含以下部分：
- Goal: 用户的核心目标
- Constraints: 已确认的约束和限制
- Progress: 已完成的工作
- Decisions: 做出的关键决策及理由
- Next Steps: 待完成的下一步

要求：
- 只保留后续继续任务必需的信息。
- 保留文件路径、命令、错误、决策和未完成事项。
- 不要编造未在历史中出现的事实。

对话历史：
{messages}"#
        }
        AppLocale::En => {
            r#"Summarize the conversation history below with these sections:
- Goal: the user's core objective
- Constraints: confirmed constraints and limits
- Progress: completed work
- Decisions: key decisions and rationale
- Next Steps: remaining next steps

Requirements:
- Keep only information required to continue the task.
- Preserve file paths, commands, errors, decisions, and unfinished items.
- Do not invent facts that never appeared in the history.

Conversation history:
{messages}"#
        }
    };
    template.replace("{messages}", messages)
}

pub fn compaction_empty_history() -> &'static str {
    pick(
        "较早上下文没有可摘要内容。",
        "There is no earlier context to summarize.",
    )
}

pub fn local_context_summary_header() -> &'static str {
    pick("本地上下文摘要:", "Local context summary:")
}

pub fn truncated_suffix() -> &'static str {
    pick("...[已截断]", "...[truncated]")
}

pub fn no_compressed_context_yet() -> &'static str {
    pick("当前还没有压缩上下文。", "No compressed context yet.")
}

pub fn session_has_no_events() -> String {
    pick("当前会话还没有事件。", "This session has no events yet.").to_string()
}

pub fn earlier_context_empty_recent_kept() -> String {
    pick(
        "较早上下文为空；最近对话已保留原文。",
        "Earlier context is empty; recent conversation was kept verbatim.",
    )
    .to_string()
}

pub fn recent_safe_boundary() -> &'static str {
    pick("最近的安全边界", "latest safe boundary")
}

pub fn recovery_prompt(
    checkpoint_id: &str,
    label: &str,
    status: &str,
    boundary: &str,
    checkpoint_data: &str,
) -> String {
    match app_locale() {
        AppLocale::Zh => format!(
            "从会话检查点恢复执行。\n\
             checkpointId: {checkpoint_id}\n\
             label: {label}\n\
             status: {status}\n\
             boundary: {boundary}\n\
             checkpointData: {checkpoint_data}\n\n\
             请把该检查点之后的失败事件仅作为诊断信息，不要重复已经成功完成的工作。\
             先检查最近事件和工作区状态，然后从该安全边界继续完成用户目标。"
        ),
        AppLocale::En => format!(
            "Resume execution from a session checkpoint.\n\
             checkpointId: {checkpoint_id}\n\
             label: {label}\n\
             status: {status}\n\
             boundary: {boundary}\n\
             checkpointData: {checkpoint_data}\n\n\
             Treat failures after this checkpoint as diagnostics only; do not repeat work that already succeeded.\
             Review recent events and workspace state first, then continue toward the user's goal from this safe boundary."
        ),
    }
}

pub fn subtask_completed_without_text() -> &'static str {
    pick(
        "子任务已完成，但没有返回文本结果。",
        "Subtask completed without returning text output.",
    )
}

pub fn agent_stopped_by_user() -> &'static str {
    pick("用户停止了 Agent", "User stopped the agent")
}

pub fn task_blocked_in_current_mode() -> &'static str {
    pick(
        "当前模式禁止执行 task，请切换到 Agent 模式。",
        "task is blocked in the current mode; switch to Agent mode.",
    )
}

pub fn no_recoverable_checkpoint() -> String {
    pick("没有可恢复的检查点。", "No recoverable checkpoint.").to_string()
}

pub fn checkpoint_wrong_session() -> String {
    pick("检查点不属于当前会话。", "Checkpoint does not belong to this session.").to_string()
}

pub fn ai_request_failed() -> String {
    pick("AI 服务请求失败。", "AI service request failed.").to_string()
}

pub fn tool_call_json_protocol_error(detail: &str) -> String {
    match app_locale() {
        AppLocale::Zh => format!("模型响应不符合工具调用 JSON 协议: {detail}"),
        AppLocale::En => format!("Model response violates tool-call JSON protocol: {detail}"),
    }
}

pub fn unknown_parse_error() -> &'static str {
    pick("未知解析错误", "Unknown parse error")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switches_attachment_prompt_by_locale() {
        set_app_locale("en");
        assert_eq!(
            continue_from_attachment_prompt(),
            "Continue based on the attachments."
        );
        set_app_locale("zh");
        assert!(continue_from_attachment_prompt().contains("附件"));
    }
}
