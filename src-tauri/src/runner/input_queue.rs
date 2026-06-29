use crate::{
    storage,
    types::{
        EventRecord, PromptAttachment, PromptSessionInput, SessionInputDelivery, SessionInputRecord,
    },
};
use rusqlite::Connection;
use serde_json::{json, Value};

pub(crate) struct AdmittedInput {
    pub(crate) input: SessionInputRecord,
    pub(crate) event: EventRecord,
}

pub(crate) struct PromotedInput {
    pub(crate) input: SessionInputRecord,
}

pub(crate) fn admit(conn: &Connection, input: PromptSessionInput) -> Result<AdmittedInput, String> {
    let input = storage::admit_session_input(
        conn,
        input.id,
        &input.session_id,
        &input.prompt,
        &input.attachments,
        input.delivery.unwrap_or(SessionInputDelivery::Queue),
        input.resume,
    )?;
    let event = storage::append_event(
        conn,
        &input.session_id,
        "session.input.admitted",
        json!({
            "inputId": input.id,
            "delivery": input.delivery,
            "resume": input.resume
        }),
    )?;
    Ok(AdmittedInput { input, event })
}

pub(crate) fn promote_next(
    conn: &Connection,
    session_id: &str,
    summarize_attachments: impl Fn(&[PromptAttachment]) -> Vec<Value>,
) -> Result<Option<PromotedInput>, String> {
    let Some(input) = storage::next_pending_session_input(conn, session_id)? else {
        return Ok(None);
    };
    let prompt_event = storage::append_event(
        conn,
        session_id,
        "prompt.submitted",
        json!({
            "inputId": input.id,
            "prompt": input.prompt,
            "attachments": summarize_attachments(&input.attachments),
            "delivery": input.delivery
        }),
    )?;
    storage::mark_session_input_promoted(conn, &input.id, &prompt_event.id)?;
    storage::append_event(
        conn,
        session_id,
        "session.input.promoted",
        json!({
            "inputId": input.id,
            "promptEventId": prompt_event.id,
            "delivery": input.delivery
        }),
    )?;
    Ok(Some(PromotedInput { input }))
}

pub(crate) fn delete_pending(
    conn: &Connection,
    input_id: &str,
) -> Result<SessionInputRecord, String> {
    let input = storage::delete_pending_session_input(conn, input_id)?;
    storage::append_event(
        conn,
        &input.session_id,
        "session.input.deleted",
        json!({
            "inputId": input.id,
            "delivery": input.delivery,
            "prompt": input.prompt
        }),
    )?;
    Ok(input)
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn prompt(id: &str, text: &str, delivery: SessionInputDelivery) -> PromptSessionInput {
        PromptSessionInput {
            id: Some(id.to_string()),
            session_id: "s1".to_string(),
            prompt: text.to_string(),
            attachments: Vec::new(),
            delivery: Some(delivery),
            resume: true,
        }
    }

    #[test]
    fn admit_writes_durable_input_and_admitted_event() {
        let conn = memory_db();

        let admitted = admit(
            &conn,
            prompt("input-1", "queued work", SessionInputDelivery::Queue),
        )
        .unwrap();

        assert_eq!(admitted.input.status, "pending");
        assert_eq!(admitted.event.event_type, "session.input.admitted");
        assert_eq!(
            storage::list_session_inputs(&conn, "s1").unwrap()[0].id,
            "input-1"
        );
    }

    #[test]
    fn promote_next_prioritizes_steer_then_preserves_queue_order() {
        let conn = memory_db();
        admit(
            &conn,
            prompt("queue-1", "first queue", SessionInputDelivery::Queue),
        )
        .unwrap();
        admit(
            &conn,
            prompt("steer-1", "urgent steer", SessionInputDelivery::Steer),
        )
        .unwrap();
        admit(
            &conn,
            prompt("queue-2", "second queue", SessionInputDelivery::Queue),
        )
        .unwrap();

        let first = promote_next(&conn, "s1", |_| Vec::new()).unwrap().unwrap();
        let second = promote_next(&conn, "s1", |_| Vec::new()).unwrap().unwrap();
        let third = promote_next(&conn, "s1", |_| Vec::new()).unwrap().unwrap();

        assert_eq!(first.input.id, "steer-1");
        assert_eq!(second.input.id, "queue-1");
        assert_eq!(third.input.id, "queue-2");
        assert!(promote_next(&conn, "s1", |_| Vec::new()).unwrap().is_none());
        assert_eq!(
            storage::list_session_inputs(&conn, "s1")
                .unwrap()
                .iter()
                .filter(|input| input.status == "promoted")
                .count(),
            3
        );
    }

    #[test]
    fn delete_pending_refuses_promoted_inputs() {
        let conn = memory_db();
        admit(
            &conn,
            prompt("input-1", "queued work", SessionInputDelivery::Queue),
        )
        .unwrap();

        let promoted = promote_next(&conn, "s1", |_| Vec::new()).unwrap().unwrap();

        assert_eq!(promoted.input.id, "input-1");
        assert!(delete_pending(&conn, "input-1").is_err());
        assert_eq!(storage::list_session_inputs(&conn, "s1").unwrap().len(), 1);
    }

    #[test]
    fn delete_pending_writes_deleted_event() {
        let conn = memory_db();
        admit(
            &conn,
            prompt("input-1", "queued work", SessionInputDelivery::Queue),
        )
        .unwrap();

        let deleted = delete_pending(&conn, "input-1").unwrap();
        let events = storage::list_events(&conn, "s1").unwrap();

        assert_eq!(deleted.id, "input-1");
        assert!(storage::list_session_inputs(&conn, "s1")
            .unwrap()
            .is_empty());
        assert!(events
            .iter()
            .any(|event| event.event_type == "session.input.deleted"));
    }
}
