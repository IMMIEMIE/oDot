use crate::types::EventRecord;
use serde::Serialize;
use std::sync::OnceLock;
use tokio::sync::broadcast;

const BUS_CAPACITY: usize = 1024;

static EVENT_BUS: OnceLock<broadcast::Sender<RealtimeEvent>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeEvent {
    pub version: u32,
    pub kind: String,
    pub session_id: String,
    pub seq: i64,
    pub event: EventRecord,
}

pub fn init() {
    let _ = sender();
}

pub fn subscribe() -> broadcast::Receiver<RealtimeEvent> {
    sender().subscribe()
}

pub fn publish_event(event: &EventRecord) {
    if let Some(sender) = EVENT_BUS.get() {
        let _ = sender.send(realtime_event(event));
    }
}

fn sender() -> &'static broadcast::Sender<RealtimeEvent> {
    EVENT_BUS.get_or_init(|| {
        let (sender, _) = broadcast::channel(BUS_CAPACITY);
        sender
    })
}

fn realtime_event(event: &EventRecord) -> RealtimeEvent {
    RealtimeEvent {
        version: 1,
        kind: normalized_kind(&event.event_type).to_string(),
        session_id: event.session_id.clone(),
        seq: event.seq,
        event: event.clone(),
    }
}

fn normalized_kind(event_type: &str) -> &str {
    match event_type {
        "session.input.admitted" | "step.started" => "session.start",
        "prompt.submitted" => "user.message",
        "assistant.message" | "assistant.message.delta" => "assistant.message",
        "tool.called" | "tool.input.delta" => "tool.call",
        "tool.success" | "tool.failed" | "tool.rejected" | "tool.pending" => "tool.result",
        "background.job.started" => "task.created",
        "agent.stopped" | "step.ended" => "task.completed",
        _ => event_type,
    }
}
