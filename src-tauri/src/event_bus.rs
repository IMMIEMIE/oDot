use crate::types::{
    BackgroundJobRecord, ContextSummaryRecord, EventRecord, PermissionRequestRecord, SnapshotRecord,
};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<EventRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission: Option<PermissionRequestRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job: Option<BackgroundJobRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<SnapshotRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<ContextSummaryRecord>,
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

pub fn publish_permission(permission: &PermissionRequestRecord) {
    if let Some(sender) = EVENT_BUS.get() {
        let _ = sender.send(realtime_permission(permission));
    }
}

pub fn publish_job(job: &BackgroundJobRecord) {
    if let Some(sender) = EVENT_BUS.get() {
        let _ = sender.send(realtime_job(job));
    }
}

pub fn publish_snapshot(snapshot: &SnapshotRecord) {
    if let Some(sender) = EVENT_BUS.get() {
        let _ = sender.send(realtime_snapshot(snapshot));
    }
}

pub fn publish_summary(summary: &ContextSummaryRecord) {
    if let Some(sender) = EVENT_BUS.get() {
        let _ = sender.send(realtime_summary(summary));
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
        event: Some(event.clone()),
        permission: None,
        job: None,
        snapshot: None,
        summary: None,
    }
}

fn realtime_permission(permission: &PermissionRequestRecord) -> RealtimeEvent {
    RealtimeEvent {
        version: 1,
        kind: if permission.status == "pending" {
            "permission.requested"
        } else {
            "permission.answered"
        }
        .to_string(),
        session_id: permission.session_id.clone(),
        seq: 0,
        event: None,
        permission: Some(permission.clone()),
        job: None,
        snapshot: None,
        summary: None,
    }
}

fn realtime_job(job: &BackgroundJobRecord) -> RealtimeEvent {
    RealtimeEvent {
        version: 1,
        kind: if job.status == "running" {
            "background.job.started"
        } else {
            "background.job.updated"
        }
        .to_string(),
        session_id: job.session_id.clone(),
        seq: 0,
        event: None,
        permission: None,
        job: Some(job.clone()),
        snapshot: None,
        summary: None,
    }
}

fn realtime_snapshot(snapshot: &SnapshotRecord) -> RealtimeEvent {
    RealtimeEvent {
        version: 1,
        kind: "snapshot.created".to_string(),
        session_id: snapshot.session_id.clone(),
        seq: 0,
        event: None,
        permission: None,
        job: None,
        snapshot: Some(snapshot.clone()),
        summary: None,
    }
}

fn realtime_summary(summary: &ContextSummaryRecord) -> RealtimeEvent {
    RealtimeEvent {
        version: 1,
        kind: "context.summary.created".to_string(),
        session_id: summary.session_id.clone(),
        seq: summary.recent_event_seq,
        event: None,
        permission: None,
        job: None,
        snapshot: None,
        summary: Some(summary.clone()),
    }
}

fn normalized_kind(event_type: &str) -> &str {
    match event_type {
        "session.input.admitted" | "step.started" => "session.start",
        "prompt.submitted" => "user.message",
        "assistant.message" | "assistant.message.delta" => "assistant.message",
        "tool.called" | "tool.input.delta" => "tool.call",
        "tool.success" | "tool.failed" | "tool.rejected" | "tool.pending" => "tool.result",
        "background.job.started" | "task.created" => "task.created",
        "agent.stopped" | "step.ended" | "task.completed" => "task.completed",
        _ => event_type,
    }
}
