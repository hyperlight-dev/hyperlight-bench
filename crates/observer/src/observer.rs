use std::{
    collections::HashMap,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use hyperlight_host::{hypervisor::InterruptHandle};

pub trait Observer {
    /// Call before starting guest execution. Must be called on the thread that will be running the guest.
    /// # NOTE
    /// A sandbox must not be moved accross threads while being observed.
    fn start_timeout(&self, interrupt_handle: &Arc<dyn InterruptHandle>) -> Duration;

    /// Call after guest call completes. Must be called on the thread that was running the guest.
    fn stop_timeout(&self, interrupt_handle: &Arc<dyn InterruptHandle>);
}

pub struct CpuTimeObserver {
    shared_state: Arc<ObserverState>,
    _thread_handle: JoinHandle<()>,
}

struct ObserverState {
    should_stop: AtomicBool,
    active_monitors: Mutex<HashMap<usize, MonitoringInfo>>, // Arc pointer address as key (as usize)
    condvar: Condvar,
}

struct MonitoringInfo {
    start_cpu_time: Duration,
    thread_id: libc::pthread_t,
    interrupt_handle: Arc<dyn InterruptHandle>,
}

impl CpuTimeObserver {
    /// Creates a new CPU time observer
    ///
    /// # Arguments
    /// * `timeout` - Maximum CPU time allowed before interrupting execution
    /// * `check_interval` - How often to check for timeouts (resolution of timeout detection)
    ///   - Smaller values = more precise timeout detection but higher CPU usage
    ///   - Larger values = less precise but more CPU efficient
    ///   - Recommended: 1ms for general use, 100μs for high precision, 10ms for low overhead
    pub fn new(timeout: Duration, check_interval: Duration) -> Self {
        let shared_state = Arc::new(ObserverState {
            should_stop: AtomicBool::new(false),
            active_monitors: Mutex::new(HashMap::new()),
            condvar: Condvar::new(),
        });

        let state_clone = shared_state.clone();

        let thread_handle = thread::spawn(move || {
            observer_thread_main(state_clone, timeout, check_interval);
        });

        Self {
            shared_state,
            _thread_handle: thread_handle,
        }
    }
}

impl Observer for CpuTimeObserver {
    fn start_timeout(&self, interrupt_handle: &Arc<dyn InterruptHandle>) -> Duration {
        let thread_id = unsafe { libc::pthread_self() };
        let start_cpu_time = get_thread_cpu_time(thread_id).unwrap();

        let monitoring_info = MonitoringInfo {
            start_cpu_time,
            thread_id,
            interrupt_handle: interrupt_handle.clone(),
        };

        // Use pointer address as key. This is safe because the Arc is also part of the value, ensuring it lives as long as needed, guaranteeing uniqueness in hashmap
        let key = Arc::as_ptr(&interrupt_handle) as *const () as usize;

        self.shared_state
            .active_monitors
            .lock()
            .unwrap() // Replaces any existing entry for this handle
            .insert(key, monitoring_info);
        self.shared_state.condvar.notify_one();
        start_cpu_time
    }

    fn stop_timeout(&self, interrupt_handle: &Arc<dyn InterruptHandle>) {
        let key = Arc::as_ptr(interrupt_handle) as *const () as usize;
        self.shared_state
            .active_monitors
            .lock()
            .unwrap()
            .remove(&key);
    }
}

impl Drop for CpuTimeObserver {
    fn drop(&mut self) {
        // Signal thread to shut down
        self.shared_state.should_stop.store(true, Ordering::Relaxed);
        self.shared_state.condvar.notify_one();

        // Thread handle will be joined automatically when dropped
    }
}

fn observer_thread_main(state: Arc<ObserverState>, timeout: Duration, check_interval: Duration) {
    loop {
        // Check if we should stop
        if state.should_stop.load(Ordering::Relaxed) {
            break;
        }

        // Wait for monitors to exist
        {
            let mut monitors = state.active_monitors.lock().unwrap();
            while monitors.is_empty() && !state.should_stop.load(Ordering::Relaxed) {
                monitors = state.condvar.wait(monitors).unwrap();
            }
        }

        // Check all monitors for timeouts in a single lock acquisition
        {
            let mut monitors = state.active_monitors.lock().unwrap();

            monitors.retain(|_key, info| {
                let current_time = get_thread_cpu_time(info.thread_id).unwrap();
                let elapsed = current_time - info.start_cpu_time;
                if elapsed >= timeout {
                    info.interrupt_handle.kill();
                    false // Remove this monitor
                } else {
                    true // Keep this monitor
                }
            });
        }

        // Sleep for the check interval
        thread::sleep(check_interval);
    }
}

// CPU time measurement of given thread (as a duration since epoch)
fn get_thread_cpu_time(thread_id: libc::pthread_t) -> Result<Duration, Box<dyn std::error::Error>> {
    // Convert pthread_t to clockid_t for the specific thread
    let mut clock_id: libc::clockid_t = 0;
    let result = unsafe { libc::pthread_getcpuclockid(thread_id, &mut clock_id) };

    if result != 0 {
        return Err(
            "pthread_getcpuclockid is not supported by system or thread does not exist.".into(),
        );
    }

    let mut timespec = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };

    let result = unsafe { libc::clock_gettime(clock_id, &mut timespec) };

    if result == 0 {
        Ok(Duration::new(
            timespec.tv_sec as u64,
            timespec.tv_nsec as u32,
        ))
    } else {
        Err("Failed to get thread CPU time".into())
    }
}

