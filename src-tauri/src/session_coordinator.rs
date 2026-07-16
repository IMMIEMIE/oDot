use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{Arc, Mutex, OnceLock},
};

type SessionLock = Arc<tokio::sync::Mutex<()>>;
type InterruptSignal = tokio::sync::watch::Sender<u64>;

static SESSION_LOCKS: OnceLock<Mutex<HashMap<String, SessionLock>>> = OnceLock::new();
static INTERRUPT_SEQS: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
static INTERRUPT_SIGNALS: OnceLock<Mutex<HashMap<String, InterruptSignal>>> = OnceLock::new();
static RUNNING_SESSIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static PENDING_WAKE_SEQS: OnceLock<Mutex<HashMap<String, Option<i64>>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunDemand {
    Run,
    Wake { seq: Option<i64> },
    Interrupt { seq: Option<i64> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunActivityStatus {
    Idle,
    Running,
    Interrupted,
}

pub async fn with_session_lock<T, Fut>(session_id: &str, run: Fut) -> T
where
    Fut: Future<Output = T>,
{
    let lock = session_lock(session_id);
    let _guard = lock.lock().await;
    set_running(session_id, true);
    let result = run.await;
    set_running(session_id, false);
    result
}

pub async fn with_session_demand<T, Fut>(session_id: &str, demand: RunDemand, run: Fut) -> Option<T>
where
    Fut: Future<Output = T>,
{
    match demand {
        RunDemand::Wake { seq } => with_wake_demand(session_id, seq, run).await,
        RunDemand::Run => with_run_demand(session_id, run).await,
        RunDemand::Interrupt { seq } => {
            record_interrupt(session_id, seq);
            None
        }
    }
}

pub fn record_interrupt(session_id: &str, seq: Option<i64>) {
    record_demand(session_id, RunDemand::Interrupt { seq });
}

pub fn record_demand(session_id: &str, demand: RunDemand) {
    let RunDemand::Interrupt { seq } = demand else {
        return;
    };
    if let Some(seq) = seq {
        let interrupts = INTERRUPT_SEQS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut interrupts = interrupts.lock().unwrap_or_else(|error| error.into_inner());
        let entry = interrupts.entry(session_id.to_string()).or_insert(seq);
        *entry = (*entry).max(seq);
    }
    notify_interrupt(session_id);
}

pub fn subscribe_interrupt(session_id: &str) -> tokio::sync::watch::Receiver<u64> {
    interrupt_signal(session_id).subscribe()
}

pub async fn await_idle(session_id: &str) -> RunActivityStatus {
    with_session_lock(session_id, async {}).await;
    activity_status(session_id)
}

pub fn stale_wake(session_id: &str, demand: RunDemand) -> bool {
    let RunDemand::Wake { seq: Some(seq) } = demand else {
        return false;
    };
    let Some(interrupts) = INTERRUPT_SEQS.get() else {
        return false;
    };
    interrupts
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(session_id)
        .map(|latest| seq <= *latest)
        .unwrap_or(false)
}

pub fn activity_status(session_id: &str) -> RunActivityStatus {
    if RUNNING_SESSIONS
        .get()
        .and_then(|running| {
            running
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .contains(session_id)
                .then_some(())
        })
        .is_some()
    {
        return RunActivityStatus::Running;
    }
    if INTERRUPT_SEQS
        .get()
        .and_then(|interrupts| {
            interrupts
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get(session_id)
                .copied()
        })
        .is_some()
    {
        return RunActivityStatus::Interrupted;
    }
    RunActivityStatus::Idle
}

fn session_lock(session_id: &str) -> SessionLock {
    let locks = SESSION_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().unwrap_or_else(|error| error.into_inner());
    locks
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn interrupt_signal(session_id: &str) -> InterruptSignal {
    let signals = INTERRUPT_SIGNALS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut signals = signals.lock().unwrap_or_else(|error| error.into_inner());
    signals
        .entry(session_id.to_string())
        .or_insert_with(|| tokio::sync::watch::channel(0).0)
        .clone()
}

fn notify_interrupt(session_id: &str) {
    let signal = interrupt_signal(session_id);
    let next = (*signal.borrow()).wrapping_add(1);
    signal.send_replace(next);
}

fn set_running(session_id: &str, running: bool) {
    let running_sessions = RUNNING_SESSIONS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut running_sessions = running_sessions
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if running {
        running_sessions.insert(session_id.to_string());
    } else {
        running_sessions.remove(session_id);
    }
}

async fn with_run_demand<T, Fut>(session_id: &str, run: Fut) -> Option<T>
where
    Fut: Future<Output = T>,
{
    let lock = session_lock(session_id);
    let result = match lock.try_lock() {
        Ok(_guard) => Some(run_with_running_status(session_id, run).await),
        Err(_) => {
            let _guard = lock.lock().await;
            None
        }
    };
    result
}

async fn with_wake_demand<T, Fut>(session_id: &str, seq: Option<i64>, run: Fut) -> Option<T>
where
    Fut: Future<Output = T>,
{
    if stale_wake(session_id, RunDemand::Wake { seq }) {
        return None;
    }

    let lock = session_lock(session_id);
    let result = match lock.try_lock() {
        Ok(_guard) => {
            if stale_wake(session_id, RunDemand::Wake { seq }) {
                return None;
            }
            Some(run_with_running_status(session_id, run).await)
        }
        Err(_) => {
            if !reserve_pending_wake(session_id, seq) {
                return None;
            }
            let _guard = lock.lock().await;
            let coalesced_seq = take_pending_wake_seq(session_id).or(seq);
            if stale_wake(session_id, RunDemand::Wake { seq: coalesced_seq }) {
                return None;
            }
            Some(run_with_running_status(session_id, run).await)
        }
    };
    result
}

async fn run_with_running_status<T, Fut>(session_id: &str, run: Fut) -> T
where
    Fut: Future<Output = T>,
{
    set_running(session_id, true);
    let result = run.await;
    set_running(session_id, false);
    result
}

fn reserve_pending_wake(session_id: &str, seq: Option<i64>) -> bool {
    let pending = PENDING_WAKE_SEQS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut pending = pending.lock().unwrap_or_else(|error| error.into_inner());
    match pending.get_mut(session_id) {
        Some(existing) => {
            *existing = max_optional_seq(*existing, seq);
            false
        }
        None => {
            pending.insert(session_id.to_string(), seq);
            true
        }
    }
}

fn take_pending_wake_seq(session_id: &str) -> Option<i64> {
    PENDING_WAKE_SEQS
        .get()
        .and_then(|pending| {
            pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(session_id)
        })
        .flatten()
}

fn max_optional_seq(left: Option<i64>, right: Option<i64>) -> Option<i64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc,
    };
    use std::time::Duration;

    #[test]
    fn same_session_work_is_serialized() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let second_entered = Arc::new(AtomicBool::new(false));

        let first = std::thread::spawn(move || {
            tauri::async_runtime::block_on(with_session_lock(
                "session-coordinator-test",
                async move {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                },
            ));
        });

        entered_rx.recv().unwrap();

        let second_entered_for_task = second_entered.clone();
        let second = std::thread::spawn(move || {
            tauri::async_runtime::block_on(with_session_lock(
                "session-coordinator-test",
                async move {
                    second_entered_for_task.store(true, Ordering::SeqCst);
                },
            ));
        });

        std::thread::sleep(Duration::from_millis(25));
        assert!(!second_entered.load(Ordering::SeqCst));

        release_tx.send(()).unwrap();
        first.join().unwrap();
        second.join().unwrap();
        assert!(second_entered.load(Ordering::SeqCst));
    }

    #[test]
    fn different_sessions_can_run_concurrently() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let second_entered = Arc::new(AtomicBool::new(false));

        let first = std::thread::spawn(move || {
            tauri::async_runtime::block_on(with_session_lock(
                "session-coordinator-concurrent-a",
                async move {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                },
            ));
        });

        entered_rx.recv().unwrap();

        let second_entered_for_task = second_entered.clone();
        let second = std::thread::spawn(move || {
            tauri::async_runtime::block_on(with_session_lock(
                "session-coordinator-concurrent-b",
                async move {
                    second_entered_for_task.store(true, Ordering::SeqCst);
                },
            ));
        });

        second.join().unwrap();
        assert!(second_entered.load(Ordering::SeqCst));

        release_tx.send(()).unwrap();
        first.join().unwrap();
    }

    #[test]
    fn stale_wake_after_interrupt_is_suppressed() {
        let session_id = "session-coordinator-stale-wake";
        record_interrupt(session_id, Some(2));

        let stale = tauri::async_runtime::block_on(with_session_demand(
            session_id,
            RunDemand::Wake { seq: Some(1) },
            async { 1 },
        ));
        assert_eq!(stale, None);

        let fresh = tauri::async_runtime::block_on(with_session_demand(
            session_id,
            RunDemand::Wake { seq: Some(3) },
            async { 2 },
        ));
        assert_eq!(fresh, Some(2));
    }

    #[test]
    fn interrupt_notifies_active_subscribers() {
        let session_id = "session-coordinator-interrupt-signal";
        let mut interrupt = subscribe_interrupt(session_id);

        record_interrupt(session_id, Some(1));

        assert!(interrupt.has_changed().unwrap());
        assert_eq!(*interrupt.borrow_and_update(), 1);
    }

    #[test]
    fn wake_demands_are_coalesced_while_session_is_busy() {
        let session_id = "session-coordinator-coalesced-wake";
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let executions = Arc::new(AtomicUsize::new(0));

        let holder = std::thread::spawn(move || {
            tauri::async_runtime::block_on(with_session_lock(session_id, async move {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            }));
        });
        entered_rx.recv().unwrap();

        let first_executions = executions.clone();
        let first = std::thread::spawn(move || {
            tauri::async_runtime::block_on(with_session_demand(
                session_id,
                RunDemand::Wake { seq: Some(1) },
                async move {
                    first_executions.fetch_add(1, Ordering::SeqCst);
                    1
                },
            ))
        });
        std::thread::sleep(Duration::from_millis(25));

        let second_executions = executions.clone();
        let second = std::thread::spawn(move || {
            tauri::async_runtime::block_on(with_session_demand(
                session_id,
                RunDemand::Wake { seq: Some(2) },
                async move {
                    second_executions.fetch_add(10, Ordering::SeqCst);
                    2
                },
            ))
        });

        assert_eq!(second.join().unwrap(), None);
        assert_eq!(executions.load(Ordering::SeqCst), 0);

        release_tx.send(()).unwrap();
        holder.join().unwrap();
        assert_eq!(first.join().unwrap(), Some(1));
        assert_eq!(executions.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn run_demand_joins_current_activity_without_starting_another_run() {
        let session_id = "session-coordinator-run-joins";
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let executions = Arc::new(AtomicUsize::new(0));

        let holder = std::thread::spawn(move || {
            tauri::async_runtime::block_on(with_session_lock(session_id, async move {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            }));
        });
        entered_rx.recv().unwrap();

        let run_executions = executions.clone();
        let joined = std::thread::spawn(move || {
            tauri::async_runtime::block_on(with_session_demand(
                session_id,
                RunDemand::Run,
                async move {
                    run_executions.fetch_add(1, Ordering::SeqCst);
                    1
                },
            ))
        });

        std::thread::sleep(Duration::from_millis(25));
        assert_eq!(executions.load(Ordering::SeqCst), 0);

        release_tx.send(()).unwrap();
        holder.join().unwrap();
        assert_eq!(joined.join().unwrap(), None);
        assert_eq!(executions.load(Ordering::SeqCst), 0);
    }
}
