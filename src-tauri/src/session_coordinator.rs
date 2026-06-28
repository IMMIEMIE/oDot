use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, OnceLock},
};

type SessionLock = Arc<tokio::sync::Mutex<()>>;

static SESSION_LOCKS: OnceLock<Mutex<HashMap<String, SessionLock>>> = OnceLock::new();

pub async fn with_session_lock<T, Fut>(session_id: &str, run: Fut) -> T
where
    Fut: Future<Output = T>,
{
    let lock = {
        let locks = SESSION_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut locks = locks.lock().expect("session lock map poisoned");
        locks
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _guard = lock.lock().await;
    run.await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
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
}
