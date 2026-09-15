use clap::ValueEnum;
use serde::Serialize;
use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tokio::signal;

use crate::{Runtime, SandboxReuseStrategy};

/// Structure for JSON output format
#[derive(Serialize)]
struct MemoryUsageEntry {
    name: String,
    unit: String,
    value: u64,
}

/// Monitors and logs memory usage every second
pub(crate) async fn monitor_memory_usage(peak_memory: Arc<AtomicU64>) {
    let mut system = System::new_all();
    let current_pid = Pid::from_u32(std::process::id());
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));

    let mut peak_resident_memory_usage_bytes = 0;

    loop {
        interval.tick().await;
        system.refresh_all();

        if let Some(process) = system.process(current_pid) {
            peak_resident_memory_usage_bytes =
                peak_resident_memory_usage_bytes.max(process.memory());

            // Update the shared atomic variable
            peak_memory.store(peak_resident_memory_usage_bytes, Ordering::Relaxed);
        } else {
            panic!(
                "Unable to get process information for PID: {}",
                current_pid.as_u32()
            );
        }
    }
}

/// Sets up signal handler for Ctrl+C to write peak memory usage to JSON file
pub(crate) async fn setup_signal_handler(
    peak_memory: Arc<AtomicU64>,
    runtime: Runtime,
    strategy: SandboxReuseStrategy,
    output: Option<std::path::PathBuf>,
    shutdown_stdin: bool,
) {
    let filename = output.unwrap_or_else(|| format!(
        "mem_{}_{}.json",
        runtime.to_possible_value().unwrap().get_name(),
        strategy.to_possible_value().unwrap().get_name()
    ).into());
    if shutdown_stdin {
        tokio::select! {
            result = signal::ctrl_c() => {
                result.expect("Failed to listen for ctrl-c");
                panic!("Supervised benchmark interrupted before shutdown command");
            },
            result = tokio::task::spawn_blocking(|| {
                let mut command = String::new();
                std::io::stdin().read_line(&mut command).expect("Failed to read shutdown command");
                assert_eq!(command.trim(), "shutdown", "Missing or invalid shutdown command");
            }) => result.expect("Shutdown listener failed"),
        }
    } else {
        signal::ctrl_c().await.expect("Failed to listen for ctrl-c");
    }
    let current_pid = Pid::from_u32(std::process::id());
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[current_pid]), true);
    let final_bytes = system.process(current_pid).expect("Missing benchmark process").memory();
    let peak_bytes = peak_memory.load(Ordering::Relaxed).max(final_bytes);

    // Write peak memory usage to JSON file
    let entry = MemoryUsageEntry {
        name: "Peak Resident Memory Usage".into(),
        unit: "bytes".into(),
        value: peak_bytes,
    };
    let json_array = vec![entry];
    let json = serde_json::to_string_pretty(&json_array).unwrap();
    fs::write(&filename, json).expect("Unable to write peak memory usage to file");
    println!("Write peak memory usage to {}", filename.display());

    #[cfg(feature = "time_phases")]
    crate::report_phases();
    std::process::exit(0);
}

/// Starts memory monitoring with signal handler for graceful shutdown
/// This function sets up both the memory monitoring task and the Ctrl+C signal handler
pub(crate) async fn start_monitoring(runtime: &Runtime, strategy: &SandboxReuseStrategy, output: Option<std::path::PathBuf>, shutdown_stdin: bool) {
    let peak_memory = Arc::new(AtomicU64::new(0));

    // Set up signal handler for Ctrl+C
    tokio::spawn(setup_signal_handler(
        peak_memory.clone(),
        *runtime,
        *strategy,
        output,
        shutdown_stdin,
    ));

    // Start memory monitoring task
    tokio::spawn(monitor_memory_usage(peak_memory));
}
