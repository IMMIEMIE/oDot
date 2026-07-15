use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
};

use tokio::sync::oneshot;

const TASK_COMMAND_PREFIX: &str = "task:";

static RUNNING_TASKS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static PROMOTE_WAITERS: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();

pub fn task_command(child_session_id: &str) -> String {
    format!("{TASK_COMMAND_PREFIX}{child_session_id}")
}

pub fn is_task_command(command: &str) -> bool {
    command.starts_with(TASK_COMMAND_PREFIX)
}

pub fn task_session_id(command: &str) -> Option<&str> {
    command.strip_prefix(TASK_COMMAND_PREFIX)
}

pub fn register(job_id: &str) {
    let tasks = RUNNING_TASKS.get_or_init(|| Mutex::new(HashSet::new()));
    tasks
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(job_id.to_string());
}

pub fn cancel(job_id: &str) -> bool {
    RUNNING_TASKS
        .get()
        .map(|tasks| {
            tasks
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(job_id)
        })
        .unwrap_or(false)
}

pub fn is_registered(job_id: &str) -> bool {
    RUNNING_TASKS
        .get()
        .map(|tasks| {
            tasks
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .contains(job_id)
        })
        .unwrap_or(false)
}

pub fn unregister(job_id: &str) {
    if let Some(tasks) = RUNNING_TASKS.get() {
        tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(job_id);
    }
}

pub fn register_promotable(child_session_id: &str, sender: oneshot::Sender<()>) {
    let waiters = PROMOTE_WAITERS.get_or_init(|| Mutex::new(HashMap::new()));
    waiters
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(child_session_id.to_string(), sender);
}

pub fn unregister_promotable(child_session_id: &str) {
    if let Some(waiters) = PROMOTE_WAITERS.get() {
        waiters
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(child_session_id);
    }
}

pub fn promote(child_session_id: &str) -> bool {
    PROMOTE_WAITERS
        .get()
        .and_then(|waiters| {
            waiters
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(child_session_id)
        })
        .map(|sender| sender.send(()).is_ok())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_command_is_identifiable() {
        assert_eq!(task_command("child-1"), "task:child-1");
        assert!(is_task_command("task:child-1"));
        assert!(!is_task_command("npm run dev"));
    }

    #[test]
    fn task_registry_tracks_running_jobs() {
        let job_id = "task-registry-test";
        unregister(job_id);
        assert!(!is_registered(job_id));

        register(job_id);
        assert!(is_registered(job_id));
        assert!(cancel(job_id));
        assert!(!is_registered(job_id));
        assert!(!cancel(job_id));
    }

    #[test]
    fn task_registry_promotes_waiting_task() {
        let child_session_id = "child-promote-test";
        unregister_promotable(child_session_id);
        let (sender, mut receiver) = oneshot::channel();

        register_promotable(child_session_id, sender);

        assert!(promote(child_session_id));
        assert!(receiver.try_recv().is_ok());
        assert!(!promote(child_session_id));
    }
}
