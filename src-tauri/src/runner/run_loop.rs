use super::*;

const EARLY_STOP_REPEATED_TURN_LIMIT: usize = 4;

pub(super) async fn run_session_steps(
    app: &AppHandle,
    conn: &Connection,
    session: &crate::types::SessionRecord,
    current_prompt: &str,
    run_id: Option<&str>,
) -> Result<SessionEventsResponse, String> {
    run_session_steps_with_config_loader(app, conn, session, current_prompt, run_id, || {
        config_file::load_provider_request_config(app, &session.project_root, &session.provider_id)
    })
    .await
}

async fn run_session_steps_with_config_loader<F>(
    app: &AppHandle,
    conn: &Connection,
    session: &crate::types::SessionRecord,
    current_prompt: &str,
    run_id: Option<&str>,
    mut load_request_config: F,
) -> Result<SessionEventsResponse, String>
where
    F: FnMut() -> Result<ProviderRequestConfig, String>,
{
    let mut current_prompt = current_prompt.to_string();
    let prior_step_count = current_prompt_step_count(conn, &session.id)?;
    let mut step_index = 1;
    let mut last_executed_step = 0usize;
    let mut activity_status = "completed";
    let mut progress_guard = RepeatedTurnGuard::default();
    storage::append_event(
        conn,
        &session.id,
        "run.activity.started",
        json!({
            "runId": run_id,
            "maxActivitySteps": MAX_ACTIVITY_STEPS,
            "maxTotalSteps": MAX_TOTAL_STEPS
        }),
    )?;
    loop {
        match activity_budget_decision(prior_step_count, step_index) {
            ActivityBudgetDecision::Continue => {}
            ActivityBudgetDecision::ActivityLimitReached {
                completed_step,
                total_steps,
            } => {
                activity_status = "paused";
                storage::append_event(
                    conn,
                    &session.id,
                    "run.activity.limit_reached",
                    json!({
                        "step": completed_step,
                        "totalSteps": total_steps,
                        "limit": MAX_ACTIVITY_STEPS,
                        "maxTotalSteps": MAX_TOTAL_STEPS,
                        "canContinue": true,
                        "autoQueued": false,
                        "continueCommand": "continue_session",
                        "message": "Reached the per-activity step limit. Continue the session to start the next bounded activity."
                    }),
                )?;
                storage::save_session_checkpoint(
                    conn,
                    &session.id,
                    run_id,
                    "activity.limit_reached",
                    Some(completed_step as i64),
                    "ready",
                    json!({
                        "step": completed_step,
                        "totalSteps": total_steps,
                        "limit": MAX_ACTIVITY_STEPS,
                        "canContinue": true
                    }),
                )?;
                break;
            }
            ActivityBudgetDecision::TotalLimitExceeded {
                attempted_total_step,
            } => {
                let error = max_total_steps_error();
                storage::append_event(
                    conn,
                    &session.id,
                    "step.failed",
                    json!({
                        "step": last_executed_step.max(1),
                        "attemptedTotalStep": attempted_total_step,
                        "maxTotalSteps": MAX_TOTAL_STEPS,
                        "error": error
                    }),
                )?;
                append_activity_ended(conn, &session.id, run_id, last_executed_step, "failed")?;
                return Err(error);
            }
        }
        storage::append_event(
            conn,
            &session.id,
            "step.started",
            json!({
                "step": step_index
            }),
        )?;
        last_executed_step = step_index;
        if stop_if_cancelled(conn, &session.id, step_index)? {
            activity_status = "cancelled";
            break;
        }

        let request_config = match load_request_config() {
            Ok(value) => value,
            Err(error) => {
                if stop_if_cancelled(conn, &session.id, step_index)? {
                    activity_status = "cancelled";
                    break;
                }
                storage::append_event(
                    conn,
                    &session.id,
                    "step.failed",
                    json!({
                        "step": step_index,
                        "error": error
                    }),
                )?;
                append_activity_ended(conn, &session.id, run_id, last_executed_step, "failed")?;
                return Err(error);
            }
        };
        let (mcp_tools, capability_errors) = runtime_mcp_tools(app, &session.project_root).await;
        for error in capability_errors {
            let _ = storage::append_event(
                conn,
                &session.id,
                "mcp.capability.error",
                json!({
                    "step": step_index,
                    "error": error
                }),
            );
        }
        let native_runtime = provider::supports_native_tools(&request_config);
        let provider_id_str = provider_id_from_record(&session.provider_id);
        let plan_path = if matches!(session.mode, AgentMode::Plan) {
            Some(util::plan_file_path(&session.created_at, &session.title))
        } else {
            None
        };
        let system_prompt = build_system_prompt(
            session.mode.as_str(),
            native_runtime,
            &request_config.model,
            provider_id_str,
            plan_path.as_deref(),
        );
        let turn = if native_runtime {
            storage::append_event(
                conn,
                &session.id,
                "llm.stream.started",
                json!({
                    "step": step_index,
                    "runtime": "rust-openai-chat",
                    "providerId": provider_id_str,
                    "model": &request_config.model
                }),
            )?;
            let stream_system_prompt = build_stream_system_prompt(
                conn,
                session,
                session.mode.as_str(),
                native_runtime,
                &request_config.model,
                provider_id_str,
            )?;
            let messages = build_stream_messages(
                conn,
                &session.id,
                &stream_system_prompt,
                &current_prompt,
                &request_config,
            )?;
            match stream_openai_compatible_with_retry(
                conn,
                &session.id,
                step_index,
                &session.provider_id,
                &request_config,
                &mcp_tools,
                &stream_system_prompt,
                &current_prompt,
                &messages,
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    if stop_if_cancelled(conn, &session.id, step_index)? {
                        activity_status = "cancelled";
                        break;
                    }
                    storage::append_event(
                        conn,
                        &session.id,
                        "step.failed",
                        json!({
                            "step": step_index,
                            "error": error
                        }),
                    )?;
                    append_activity_ended(conn, &session.id, run_id, last_executed_step, "failed")?;
                    return Err(error);
                }
            }
        } else {
            let user_prompt =
                build_user_prompt(conn, &session.id, &current_prompt, &request_config)?;
            let completion = match complete_with_retry(
                conn,
                &session.id,
                step_index,
                &request_config,
                &system_prompt,
                &current_prompt,
                &user_prompt,
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    if stop_if_cancelled(conn, &session.id, step_index)? {
                        activity_status = "cancelled";
                        break;
                    }
                    storage::append_event(
                        conn,
                        &session.id,
                        "step.failed",
                        json!({
                            "step": step_index,
                            "error": error
                        }),
                    )?;
                    append_activity_ended(conn, &session.id, run_id, last_executed_step, "failed")?;
                    return Err(error);
                }
            };
            if let Some(turn) = completion.turn {
                turn
            } else {
                match parse_model_turn(&completion.raw_response) {
                    Ok(value) => value,
                    Err(error) => {
                        storage::append_event(
                            conn,
                            &session.id,
                            "step.failed",
                            json!({
                                "step": step_index,
                                "error": error,
                                "rawResponse": completion.raw_response
                            }),
                        )?;
                        append_activity_ended(
                            conn,
                            &session.id,
                            run_id,
                            last_executed_step,
                            "failed",
                        )?;
                        return Err(error);
                    }
                }
            }
        };

        if stop_if_cancelled(conn, &session.id, step_index)? {
            activity_status = "cancelled";
            break;
        }

        if let Some(repeated_count) = progress_guard.observe(&turn) {
            activity_status = "paused";
            storage::append_event(
                conn,
                &session.id,
                "run.activity.early_stop",
                json!({
                    "step": step_index,
                    "reason": "repeated_model_action",
                    "repeatedCount": repeated_count,
                    "limit": EARLY_STOP_REPEATED_TURN_LIMIT,
                    "message": "Stopped this activity after the model repeated the same tool action without visible progress."
                }),
            )?;
            storage::save_session_checkpoint(
                conn,
                &session.id,
                run_id,
                "activity.early_stop",
                Some(step_index as i64),
                "ready",
                json!({
                    "step": step_index,
                    "reason": "repeated_model_action",
                    "repeatedCount": repeated_count
                }),
            )?;
            break;
        }

        if let Some(summary) = turn
            .summary
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            storage::append_event(
                conn,
                &session.id,
                "reasoning.summary",
                json!({
                    "step": step_index,
                    "text": summary
                }),
            )?;
        }

        if let Some(message) = turn
            .message
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            storage::append_event(
                conn,
                &session.id,
                "assistant.message",
                json!({
                    "step": step_index,
                    "text": message
                }),
            )?;
        }

        match session.mode {
            AgentMode::Ask => {
                if turn.tool_calls.is_empty() {
                    storage::append_event(
                        conn,
                        &session.id,
                        "step.ended",
                        json!({
                            "step": step_index,
                            "done": true
                        }),
                    )?;
                    save_step_checkpoint(conn, &session.id, run_id, step_index, true)?;
                    break;
                }

                let mut has_pending = false;
                let mut stopped = false;
                for call in &turn.tool_calls {
                    if stop_if_cancelled(conn, &session.id, step_index)? {
                        stopped = true;
                        break;
                    }
                    let outcome =
                        execute_turn_tool(app, conn, session, call, tools::ToolExecutionMode::Ask)
                            .await?;
                    has_pending |= outcome.pending;
                }
                if stopped {
                    break;
                }

                storage::append_event(
                    conn,
                    &session.id,
                    "step.ended",
                    json!({
                        "step": step_index,
                        "done": turn.done
                    }),
                )?;
                save_step_checkpoint(conn, &session.id, run_id, step_index, turn.done)?;

                if has_pending {
                    break;
                }
                if should_continue_after_step_checkpoint(step_index, has_pending) {
                    current_prompt = step_checkpoint_continuation_prompt(step_index);
                    step_index += 1;
                    continue;
                }
            }
            AgentMode::Plan => {
                if turn.tool_calls.is_empty() {
                    storage::append_event(
                        conn,
                        &session.id,
                        "step.ended",
                        json!({
                            "step": step_index,
                            "done": true
                        }),
                    )?;
                    save_step_checkpoint(conn, &session.id, run_id, step_index, true)?;
                    break;
                }

                let mut has_pending = false;
                let mut stopped = false;
                for call in &turn.tool_calls {
                    if stop_if_cancelled(conn, &session.id, step_index)? {
                        stopped = true;
                        break;
                    }
                    let outcome =
                        execute_turn_tool(app, conn, session, call, tools::ToolExecutionMode::Plan)
                            .await?;
                    has_pending |= outcome.pending;
                }
                if stopped {
                    break;
                }

                storage::append_event(
                    conn,
                    &session.id,
                    "step.ended",
                    json!({
                        "step": step_index,
                        "done": has_pending,
                        "pending": has_pending
                    }),
                )?;
                save_step_checkpoint(conn, &session.id, run_id, step_index, has_pending)?;

                if has_pending {
                    break;
                }
                if should_continue_after_step_checkpoint(step_index, has_pending) {
                    current_prompt = step_checkpoint_continuation_prompt(step_index);
                    step_index += 1;
                    continue;
                }
            }
            AgentMode::Agent => {
                if turn.tool_calls.is_empty() {
                    storage::append_event(
                        conn,
                        &session.id,
                        "step.ended",
                        json!({
                            "step": step_index,
                            "done": true
                        }),
                    )?;
                    save_step_checkpoint(conn, &session.id, run_id, step_index, true)?;
                    break;
                }

                if stop_if_cancelled(conn, &session.id, step_index)? {
                    break;
                }
                let has_pending =
                    execute_agent_turn_tools(app, conn, session, &turn.tool_calls).await?;

                storage::append_event(
                    conn,
                    &session.id,
                    "step.ended",
                    json!({
                        "step": step_index,
                        "done": has_pending,
                        "pending": has_pending
                    }),
                )?;
                save_step_checkpoint(conn, &session.id, run_id, step_index, has_pending)?;

                if has_pending {
                    break;
                }
                if should_continue_after_step_checkpoint(step_index, has_pending) {
                    current_prompt = step_checkpoint_continuation_prompt(step_index);
                    step_index += 1;
                    continue;
                }
            }
        }

        step_index += 1;
    }

    append_activity_ended(
        conn,
        &session.id,
        run_id,
        last_executed_step,
        activity_status,
    )?;
    Ok(storage::session_events_response(conn, &session.id)?)
}

#[derive(Debug, PartialEq, Eq)]
enum ActivityBudgetDecision {
    Continue,
    ActivityLimitReached {
        completed_step: usize,
        total_steps: usize,
    },
    TotalLimitExceeded {
        attempted_total_step: usize,
    },
}

fn activity_budget_decision(
    prior_step_count: usize,
    activity_step: usize,
) -> ActivityBudgetDecision {
    let attempted_total_step = prior_step_count.saturating_add(activity_step);
    if attempted_total_step > MAX_TOTAL_STEPS {
        return ActivityBudgetDecision::TotalLimitExceeded {
            attempted_total_step,
        };
    }
    if activity_step > MAX_ACTIVITY_STEPS {
        return ActivityBudgetDecision::ActivityLimitReached {
            completed_step: activity_step - 1,
            total_steps: prior_step_count + activity_step - 1,
        };
    }
    ActivityBudgetDecision::Continue
}

fn current_prompt_step_count(conn: &Connection, session_id: &str) -> Result<usize, String> {
    let events = storage::list_events(conn, session_id)?;
    let latest_prompt_seq = events
        .iter()
        .rev()
        .find(|event| event.event_type == "prompt.submitted")
        .map(|event| event.seq)
        .unwrap_or(0);
    Ok(events
        .iter()
        .filter(|event| event.seq > latest_prompt_seq && event.event_type == "step.started")
        .count())
}

pub(super) fn should_continue_after_step_checkpoint(step_index: usize, has_pending: bool) -> bool {
    step_index > 0
        && step_index < MAX_TOTAL_STEPS
        && step_index % STEP_CHECKPOINT_INTERVAL == 0
        && !has_pending
}

pub(super) fn step_checkpoint_continuation_prompt(step_index: usize) -> String {
    format!(
        "You have reached step checkpoint {step_index}. Inspect the latest tool result and decide whether the user's request is complete. If it is complete, provide the final user-facing answer now. If it is not complete, continue working with the next needed tool call. Do not repeat already completed work."
    )
}

fn max_total_steps_error() -> String {
    format!(
        "Reached the maximum total step budget ({MAX_TOTAL_STEPS}) without completing the request."
    )
}

fn append_activity_ended(
    conn: &Connection,
    session_id: &str,
    run_id: Option<&str>,
    last_step: usize,
    status: &str,
) -> Result<EventRecord, String> {
    storage::append_event(
        conn,
        session_id,
        "run.activity.ended",
        json!({
            "runId": run_id,
            "lastStep": last_step,
            "status": status
        }),
    )
}

fn save_step_checkpoint(
    conn: &Connection,
    session_id: &str,
    run_id: Option<&str>,
    step_index: usize,
    done: bool,
) -> Result<(), String> {
    storage::save_session_checkpoint(
        conn,
        session_id,
        run_id,
        "step.completed",
        Some(step_index as i64),
        "ready",
        json!({
            "step": step_index,
            "done": done
        }),
    )?;
    Ok(())
}

#[derive(Default)]
struct RepeatedTurnGuard {
    last_signature: Option<String>,
    repeated_count: usize,
}

impl RepeatedTurnGuard {
    fn observe(&mut self, turn: &ModelTurn) -> Option<usize> {
        let Some(signature) = repeated_tool_action_signature(turn) else {
            self.last_signature = None;
            self.repeated_count = 0;
            return None;
        };

        if self.last_signature.as_deref() == Some(signature.as_str()) {
            self.repeated_count += 1;
        } else {
            self.last_signature = Some(signature);
            self.repeated_count = 1;
        }

        (self.repeated_count >= EARLY_STOP_REPEATED_TURN_LIMIT).then_some(self.repeated_count)
    }
}

fn repeated_tool_action_signature(turn: &ModelTurn) -> Option<String> {
    if turn.tool_calls.is_empty()
        || turn
            .message
            .as_deref()
            .map(str::trim)
            .is_some_and(|message| !message.is_empty())
    {
        return None;
    }
    let calls = turn
        .tool_calls
        .iter()
        .map(|call| {
            json!({
                "name": normalize_tool_name(&call.name),
                "input": call.input
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&calls).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn repeated_shell_turn(command: &str) -> ModelTurn {
        ModelTurn {
            summary: None,
            message: None,
            tool_calls: vec![ToolCallRequest {
                tool_call_id: None,
                name: "shell".to_string(),
                input: json!({ "command": command }),
            }],
            done: false,
        }
    }

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
    fn append_activity_ended_records_status() {
        let conn = memory_db();

        append_activity_ended(&conn, "s1", Some("run-1"), 3, "failed").unwrap();
        let events = storage::list_events(&conn, "s1").unwrap();

        assert_eq!(events[0].event_type, "run.activity.ended");
        assert_eq!(events[0].data.get("status"), Some(&json!("failed")));
        assert_eq!(events[0].data.get("lastStep"), Some(&json!(3)));
    }

    #[test]
    fn activity_budget_pauses_after_single_activity_limit() {
        assert_eq!(
            activity_budget_decision(0, MAX_ACTIVITY_STEPS),
            ActivityBudgetDecision::Continue
        );
        assert_eq!(
            activity_budget_decision(0, MAX_ACTIVITY_STEPS + 1),
            ActivityBudgetDecision::ActivityLimitReached {
                completed_step: MAX_ACTIVITY_STEPS,
                total_steps: MAX_ACTIVITY_STEPS
            }
        );
    }

    #[test]
    fn activity_budget_keeps_hard_total_across_continued_activities() {
        assert_eq!(
            activity_budget_decision(MAX_TOTAL_STEPS - MAX_ACTIVITY_STEPS, MAX_ACTIVITY_STEPS),
            ActivityBudgetDecision::Continue
        );
        assert_eq!(
            activity_budget_decision(MAX_TOTAL_STEPS - MAX_ACTIVITY_STEPS, MAX_ACTIVITY_STEPS + 1),
            ActivityBudgetDecision::TotalLimitExceeded {
                attempted_total_step: MAX_TOTAL_STEPS + 1
            }
        );
    }

    #[test]
    fn current_prompt_step_count_resets_after_new_prompt() {
        let conn = memory_db();
        storage::append_event(
            &conn,
            "s1",
            "prompt.submitted",
            json!({ "prompt": "first" }),
        )
        .unwrap();
        storage::append_event(&conn, "s1", "step.started", json!({ "step": 1 })).unwrap();
        storage::append_event(&conn, "s1", "step.started", json!({ "step": 2 })).unwrap();
        assert_eq!(current_prompt_step_count(&conn, "s1").unwrap(), 2);

        storage::append_event(
            &conn,
            "s1",
            "prompt.submitted",
            json!({ "prompt": "second" }),
        )
        .unwrap();
        assert_eq!(current_prompt_step_count(&conn, "s1").unwrap(), 0);

        storage::append_event(&conn, "s1", "step.started", json!({ "step": 1 })).unwrap();
        assert_eq!(current_prompt_step_count(&conn, "s1").unwrap(), 1);
    }

    #[test]
    fn repeated_turn_guard_stops_after_identical_tool_action_limit() {
        let mut guard = RepeatedTurnGuard::default();
        let turn = repeated_shell_turn("npm test");

        assert_eq!(guard.observe(&turn), None);
        assert_eq!(guard.observe(&turn), None);
        assert_eq!(guard.observe(&turn), None);
        assert_eq!(guard.observe(&turn), Some(EARLY_STOP_REPEATED_TURN_LIMIT));
    }

    #[test]
    fn repeated_turn_guard_resets_on_progress_message_or_changed_tool() {
        let mut guard = RepeatedTurnGuard::default();
        let turn = repeated_shell_turn("npm test");
        let mut message_turn = repeated_shell_turn("npm test");
        message_turn.message = Some("I found the issue.".to_string());

        assert_eq!(guard.observe(&turn), None);
        assert_eq!(guard.observe(&turn), None);
        assert_eq!(guard.observe(&message_turn), None);
        assert_eq!(guard.observe(&turn), None);
        assert_eq!(guard.observe(&repeated_shell_turn("cargo test")), None);
        assert_eq!(guard.observe(&repeated_shell_turn("cargo test")), None);
    }
}
