use super::*;

pub fn compact_session(
    conn: &Connection,
    session_id: &str,
) -> Result<ContextSummaryRecord, String> {
    let events = storage::list_events(conn, session_id)?;
    storage::append_event(
        conn,
        session_id,
        "context.compaction.started",
        json!({ "reason": "manual", "strategy": "local" }),
    )?;
    if events.is_empty() {
        let summary = storage::insert_context_summary(
            conn,
            session_id,
            crate::i18n::session_has_no_events(),
            0,
        )?;
        storage::append_event(
            conn,
            session_id,
            "context.compaction.ended",
            json!({
                "summaryId": summary.id,
                "recentEventSeq": summary.recent_event_seq,
                "strategy": "local"
            }),
        )?;
        storage::append_event(
            conn,
            session_id,
            "context.compacted",
            json!({
                "summaryId": summary.id,
                "recentEventSeq": summary.recent_event_seq
            }),
        )?;
        return Ok(summary);
    }

    let recent_event_seq = events.last().map(|event| event.seq).unwrap_or(0);
    let text = summarize_events(&events);
    let summary = storage::insert_context_summary(conn, session_id, text, recent_event_seq)?;
    storage::append_event(
        conn,
        session_id,
        "context.compaction.ended",
        json!({
            "summaryId": summary.id,
            "recentEventSeq": summary.recent_event_seq,
            "strategy": "local"
        }),
    )?;
    storage::append_event(
        conn,
        session_id,
        "context.compacted",
        json!({
            "summaryId": summary.id,
            "recentEventSeq": summary.recent_event_seq
        }),
    )?;
    Ok(summary)
}

pub async fn compact_session_with_provider(
    conn: &Connection,
    session_id: &str,
    provider: &ProviderRequestConfig,
) -> Result<ContextSummaryRecord, String> {
    let events = storage::list_events(conn, session_id)?;
    storage::append_event(
        conn,
        session_id,
        "context.compaction.started",
        json!({ "reason": "manual_or_auto", "strategy": "llm" }),
    )?;
    if events.is_empty() {
        let summary = storage::insert_context_summary(
            conn,
            session_id,
            crate::i18n::session_has_no_events(),
            0,
        )?;
        storage::append_event(
            conn,
            session_id,
            "context.compaction.ended",
            json!({
                "summaryId": summary.id,
                "recentEventSeq": summary.recent_event_seq,
                "strategy": "llm"
            }),
        )?;
        storage::append_event(
            conn,
            session_id,
            "context.compacted",
            json!({
                "summaryId": summary.id,
                "recentEventSeq": summary.recent_event_seq
            }),
        )?;
        return Ok(summary);
    }

    let context_limit = provider.context_token_limit.unwrap_or(0);
    let max_output_tokens = provider.output_token_limit.unwrap_or(4096);
    let (head_events, tail_events) =
        split_events_for_compaction(&events, context_limit, max_output_tokens);
    let text = if head_events.is_empty() {
        crate::i18n::earlier_context_empty_recent_kept()
    } else {
        match compact_with_llm(&head_events, provider).await {
            Ok(summary) if !summary.trim().is_empty() => summary,
            Err(error) => {
                storage::append_event(
                    conn,
                    session_id,
                    "context.compaction.failed",
                    json!({
                        "strategy": "llm",
                        "fallback": "local",
                        "error": error
                    }),
                )?;
                summarize_events(&head_events)
            }
            _ => summarize_events(&head_events),
        }
    };
    let latest_seq = events.last().map(|event| event.seq).unwrap_or(0);
    let recent_event_seq = tail_events
        .first()
        .map(|event| event.seq)
        .unwrap_or(latest_seq);
    let prune_before_seq = tail_events
        .first()
        .map(|event| event.seq)
        .unwrap_or_else(|| latest_seq.saturating_add(1));
    prune_tool_outputs(conn, session_id, prune_before_seq)?;
    let summary = storage::insert_context_summary(conn, session_id, text, recent_event_seq)?;
    storage::append_event(
        conn,
        session_id,
        "context.compaction.ended",
        json!({
            "summaryId": summary.id,
            "recentEventSeq": summary.recent_event_seq,
            "prunedBeforeEventSeq": prune_before_seq,
            "strategy": "llm"
        }),
    )?;
    storage::append_event(
        conn,
        session_id,
        "context.compacted",
        json!({
            "summaryId": summary.id,
            "recentEventSeq": summary.recent_event_seq,
            "prunedBeforeEventSeq": prune_before_seq
        }),
    )?;
    Ok(summary)
}

pub(super) async fn maybe_auto_compact(
    conn: &Connection,
    session_id: &str,
    provider: Option<&ProviderRequestConfig>,
    context_token_limit: Option<u64>,
    output_token_limit: Option<u64>,
) -> Result<(), String> {
    let events = storage::list_events(conn, session_id)?;
    let summaries = storage::list_context_summaries(conn, session_id)?;
    let latest_seq = events.last().map(|event| event.seq).unwrap_or(0);
    let latest_summary_seq = summaries
        .first()
        .map(|summary| summary.recent_event_seq)
        .unwrap_or(0);

    if latest_seq.saturating_sub(latest_summary_seq) <= AUTO_COMPACT_EVENT_THRESHOLD as i64 {
        return Ok(());
    }

    if let Some(context_limit) = context_token_limit.filter(|limit| *limit > 0) {
        let max_output = output_token_limit.unwrap_or(0);
        let reserved = if max_output > 0 {
            max_output.min(20_000)
        } else {
            DEFAULT_OUTPUT_TOKEN_LIMIT
        };
        let usable = context_limit.saturating_sub(reserved);
        if usable > 0 {
            let estimated: u64 = events
                .iter()
                .filter(|event| event.seq > latest_summary_seq)
                .map(estimate_event_tokens)
                .sum();
            if estimated >= usable {
                if let Some(provider) = provider {
                    let _ = compact_session_with_provider(conn, session_id, provider).await?;
                } else {
                    let _ = compact_session(conn, session_id)?;
                }
                return Ok(());
            }
        }

        let latest_usage = events
            .iter()
            .rev()
            .find(|event| event.event_type == "llm.stream.finished")
            .and_then(|event| event.data.get("usage"));

        if let Some(usage) = latest_usage {
            if is_overflow(usage, context_limit, max_output) {
                if let Some(provider) = provider {
                    let _ = compact_session_with_provider(conn, session_id, provider).await?;
                } else {
                    let _ = compact_session(conn, session_id)?;
                }
                return Ok(());
            }
        }
    }

    Ok(())
}

pub(super) fn is_overflow(usage: &Value, context_limit: u64, max_output_tokens: u64) -> bool {
    if context_limit == 0 {
        return false;
    }
    let reserved = if max_output_tokens > 0 {
        max_output_tokens.min(20_000)
    } else {
        4096
    };
    let usable = context_limit.saturating_sub(reserved);
    if usable == 0 {
        return false;
    }
    let total = usage_token_sum(usage);
    total >= usable
}

pub(super) fn usage_token_sum(usage: &Value) -> u64 {
    if let Some(tokens) = usage.get("tokens") {
        let input = tokens.get("input").and_then(value_as_u64).unwrap_or(0);
        let output = tokens.get("output").and_then(value_as_u64).unwrap_or(0);
        let reasoning = tokens.get("reasoning").and_then(value_as_u64).unwrap_or(0);
        let cache = tokens.get("cache").unwrap_or(&Value::Null);
        let cache_read = cache.get("read").and_then(value_as_u64).unwrap_or(0);
        let cache_write = cache.get("write").and_then(value_as_u64).unwrap_or(0);
        return input + output + reasoning + cache_read + cache_write;
    }

    let input_tokens = usage_number(
        usage,
        &["inputTokens", "prompt_tokens", "input_tokens"],
        &[],
    );
    let output_tokens = usage_number(
        usage,
        &["outputTokens", "completion_tokens", "output_tokens"],
        &[],
    );
    let cache_read_tokens = usage_number(
        usage,
        &[
            "cacheReadInputTokens",
            "cachedInputTokens",
            "cache_read_input_tokens",
        ],
        &[
            &["inputTokenDetails", "cacheReadTokens"],
            &["prompt_tokens_details", "cached_tokens"],
            &["promptTokensDetails", "cachedTokens"],
        ],
    );
    let cache_write_tokens = usage_number(
        usage,
        &["cacheWriteInputTokens", "cache_write_input_tokens"],
        &[
            &["inputTokenDetails", "cacheWriteTokens"],
            &["prompt_tokens_details", "cache_write_tokens"],
            &["promptTokensDetails", "cacheWriteTokens"],
        ],
    );
    let reasoning_tokens = usage_number(
        usage,
        &["reasoningTokens", "reasoning_tokens"],
        &[
            &["outputTokenDetails", "reasoningTokens"],
            &["completion_tokens_details", "reasoning_tokens"],
            &["completionTokensDetails", "reasoningTokens"],
        ],
    );
    let input = input_tokens
        .saturating_sub(cache_read_tokens)
        .saturating_sub(cache_write_tokens);
    let output = output_tokens.saturating_sub(reasoning_tokens);
    input + output + reasoning_tokens + cache_read_tokens + cache_write_tokens
}

pub(super) fn split_events_for_compaction(
    events: &[EventRecord],
    context_limit: u64,
    max_output_tokens: u64,
) -> (Vec<EventRecord>, Vec<EventRecord>) {
    if events.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let output_budget = if max_output_tokens > 0 {
        max_output_tokens
    } else {
        4096
    };
    let context_budget = if context_limit > 0 {
        context_limit.saturating_mul(15) / 100
    } else {
        output_budget
    };
    let preserve_budget = output_budget.min(context_budget).max(1);
    let mut used = 0_u64;
    let mut split_index = events.len();

    for (index, event) in events.iter().enumerate().rev() {
        let tokens = estimate_event_tokens(event).max(1);
        if used > 0 && used.saturating_add(tokens) > preserve_budget {
            break;
        }
        used = used.saturating_add(tokens);
        split_index = index;
    }

    (
        events[..split_index].to_vec(),
        events[split_index..].to_vec(),
    )
}

pub(super) fn estimate_event_tokens(event: &EventRecord) -> u64 {
    let text = serde_json::to_string(&event.data).unwrap_or_default();
    (text.chars().count() as u64 / 4).max(1)
}

async fn compact_with_llm(
    events: &[EventRecord],
    provider: &ProviderRequestConfig,
) -> Result<String, String> {
    let messages = events
        .iter()
        .filter_map(compaction_event_line)
        .collect::<Vec<_>>()
        .join("\n");
    if messages.trim().is_empty() {
        return Ok(crate::i18n::compaction_empty_history().to_string());
    }
    let user_prompt = crate::i18n::compaction_prompt(&truncate(&messages, 64_000));
    let mut compaction_provider = provider.clone();
    compaction_provider.tool_mode = ToolMode::Json;
    let completion = provider::complete(
        &compaction_provider,
        crate::i18n::compaction_system_prompt(),
        &user_prompt,
    )
    .await?;
    Ok(truncate(completion.raw_response.trim(), 24_000))
}

fn compaction_event_line(event: &EventRecord) -> Option<String> {
    let detail = match event.event_type.as_str() {
        "prompt.submitted" => event
            .data
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "assistant.message" | "assistant.message.delta" => event
            .data
            .get("text")
            .and_then(Value::as_str)
            .map(|text| sanitize_assistant_content(text).text)
            .unwrap_or_default(),
        "reasoning.summary" | "reasoning.summary.delta" => event
            .data
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "tool.called" => {
            let name = event.data.get("name").and_then(Value::as_str).unwrap_or("");
            let input = compact_json(event.data.get("input").unwrap_or(&Value::Null));
            format!("{name} input={input}")
        }
        "tool.success" | "tool.failed" | "tool.pending" | "tool.rejected" => {
            let name = event.data.get("name").and_then(Value::as_str).unwrap_or("");
            let result = tool_result_content(event);
            format!("{name} result={result}")
        }
        _ => return None,
    };
    let detail = detail.trim();
    if detail.is_empty() {
        None
    } else {
        Some(format!(
            "#{} {} {}",
            event.seq,
            event.event_type,
            truncate(detail, 2_000)
        ))
    }
}

pub(super) fn prune_tool_outputs(
    conn: &Connection,
    session_id: &str,
    before_event_seq: i64,
) -> Result<(), String> {
    for event in storage::list_events(conn, session_id)? {
        if event.seq >= before_event_seq || event.event_type != "tool.success" {
            continue;
        }
        let mut data = event.data.clone();
        if let Some(object) = data.as_object_mut() {
            if object.get("result") == Some(&json!("<erased>")) {
                continue;
            }
            object.insert("result".to_string(), json!("<erased>"));
            storage::update_event_data(conn, &event.id, &data)?;
        }
    }
    Ok(())
}

pub(super) fn summarize_events(events: &[crate::types::EventRecord]) -> String {
    let mut lines = vec![crate::i18n::local_context_summary_header().to_string()];
    for event in events.iter().rev().take(60).rev() {
        let detail = match event.event_type.as_str() {
            "prompt.submitted" => event
                .data
                .get("prompt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            "assistant.message" => event
                .data
                .get("text")
                .and_then(Value::as_str)
                .map(|text| sanitize_assistant_content(text).text)
                .unwrap_or_default(),
            "reasoning.summary" => event
                .data
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            "tool.success" | "tool.failed" | "tool.pending" => event
                .data
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            _ => String::new(),
        };
        lines.push(format!(
            "#{} {} {}",
            event.seq,
            event.event_type,
            truncate(&detail, 500)
        ));
    }
    truncate(&lines.join("\n"), 24_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ProviderKind, ProviderPricing};
    use rusqlite::Connection;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        conn.execute(
            "INSERT INTO session (id, project_root, mode, provider_id, title, status, shell_mode, created_at, updated_at)
             VALUES ('s1', 'E:/oDot', 'agent', 'p1', 'Test', 'active', 'auto', '1', '1')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn prune_tool_outputs_erases_old_tool_success_results_only() {
        let conn = memory_db();
        storage::append_event(
            &conn,
            "s1",
            "tool.success",
            json!({ "name": "shell", "result": "old large output" }),
        )
        .unwrap();
        let kept = storage::append_event(
            &conn,
            "s1",
            "tool.success",
            json!({ "name": "shell", "result": "recent output" }),
        )
        .unwrap();

        prune_tool_outputs(&conn, "s1", kept.seq).unwrap();
        let events = storage::list_events(&conn, "s1").unwrap();

        assert_eq!(events[0].data.get("result"), Some(&json!("<erased>")));
        assert_eq!(events[1].data.get("result"), Some(&json!("recent output")));
    }

    #[test]
    fn local_compaction_writes_started_ended_and_legacy_events() {
        let conn = memory_db();
        storage::append_event(&conn, "s1", "prompt.submitted", json!({ "prompt": "hi" })).unwrap();

        let summary = compact_session(&conn, "s1").unwrap();
        let events = storage::list_events(&conn, "s1").unwrap();

        assert_eq!(summary.recent_event_seq, 1);
        assert!(events
            .iter()
            .any(|event| event.event_type == "context.compaction.started"));
        assert!(events
            .iter()
            .any(|event| event.event_type == "context.compaction.ended"));
        assert!(events
            .iter()
            .any(|event| event.event_type == "context.compacted"));
    }

    #[test]
    fn local_compaction_of_empty_history_still_ends_cleanly() {
        let conn = memory_db();

        let summary = compact_session(&conn, "s1").unwrap();
        let events = storage::list_events(&conn, "s1").unwrap();

        assert_eq!(summary.recent_event_seq, 0);
        assert!(events
            .iter()
            .any(|event| event.event_type == "context.compaction.started"));
        assert!(events
            .iter()
            .any(|event| event.event_type == "context.compaction.ended"));
        assert!(events
            .iter()
            .any(|event| event.event_type == "context.compacted"));
    }

    #[test]
    fn provider_compaction_keeps_tail_and_prunes_head_tool_output() {
        let conn = memory_db();
        let old_tool = storage::append_event(
            &conn,
            "s1",
            "tool.success",
            json!({ "name": "shell", "result": "x".repeat(4_000) }),
        )
        .unwrap();
        let tail = storage::append_event(
            &conn,
            "s1",
            "assistant.message",
            json!({ "text": "recent", "padding": "y".repeat(900) }),
        )
        .unwrap();
        let provider = ProviderRequestConfig {
            kind: ProviderKind::OpenAiCompatible,
            tool_mode: ToolMode::Json,
            base_url: Some("http://localhost".to_string()),
            model: "test-model".to_string(),
            api_key: "test-key".to_string(),
            headers: HashMap::new(),
            body: serde_json::Map::new(),
            context_token_limit: Some(10_000),
            input_token_limit: None,
            output_token_limit: Some(250),
            pricing: ProviderPricing {
                input_per_million: 0.0,
                output_per_million: 0.0,
                cache_read_per_million: 0.0,
                cache_write_per_million: 0.0,
            },
            config_path: "test".to_string(),
        };

        let summary =
            tauri::async_runtime::block_on(compact_session_with_provider(&conn, "s1", &provider))
                .unwrap();
        let events = storage::list_events(&conn, "s1").unwrap();
        let old_tool_event = events.iter().find(|event| event.id == old_tool.id).unwrap();

        assert_eq!(summary.recent_event_seq, tail.seq);
        assert_eq!(old_tool_event.data.get("result"), Some(&json!("<erased>")));
        assert!(events
            .iter()
            .any(|event| event.event_type == "context.compaction.failed"));
        assert!(events
            .iter()
            .any(|event| event.event_type == "context.compaction.ended"));
    }
}
