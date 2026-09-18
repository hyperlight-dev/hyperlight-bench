//! Example HTTP server using hyperlight_js sandboxes with configurable JS handler and sandbox reuse strategy.
//! Uses a pool of persistent threads to handle requests concurrently.
//!
//! To run, do something like
//! cargo run --example http --release -- --pool-size=4 --worker-threads=4 --sandbox-mode reuse

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;

extern crate alloc;

use clap::Parser;
use clap::ValueEnum;
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::Response;
use hyper_util::rt::TokioIo;
use sandbox_observer::observer::CpuTimeObserver;
#[cfg(feature = "time_phases")]
use std::sync::Mutex;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
#[cfg(feature = "time_phases")]
use tokio::time::Instant;

mod handlers;
use handlers::Handler;

mod memory_monitor;

const DEFAULT_REQUEST_URI: &str = "/index.html";
const DEFAULT_REQUEST_BODY: &str = r#"{"uri": "/index.html"}"#;

#[cfg(feature = "time_phases")]
static N_CONNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(feature = "time_phases")]
static N_REQS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
// Size experimentally arrived at to be large enough for the hyperlight ones we care about
#[cfg(feature = "time_phases")]
const N_TIMES: usize = 32768 * 8;
#[cfg(feature = "time_phases")]
static TIMES: Mutex<[Option<Instant>; N_TIMES]> = Mutex::new([None; N_TIMES]);

struct JobRequest {
    response_tx: oneshot::Sender<String>,
    #[cfg(feature = "time_phases")]
    reqnum: usize,
}

/// Pool of sandbox worker threads for handling requests.
struct SandboxPool {
    senders: Vec<mpsc::UnboundedSender<JobRequest>>,
    counter: AtomicUsize,
}

#[derive(Copy, Clone)]
struct ObserverConfig {
    timeout: Duration,
    check_in: Duration,
}

impl SandboxPool {
    /// Worker thread for `New` strategy: creates a new sandbox for each request.
    fn worker_new<H: Handler>(
        mut rx: mpsc::UnboundedReceiver<JobRequest>,
        i: usize,
        worker: &H::WorkerState,
        ready: std::sync::mpsc::Sender<()>,
    ) {
        println!("Sandbox worker {} started in NEW mode", i);
        ready.send(()).expect("Startup receiver closed");
        drop(ready);
        while let Some(job) = rx.blocking_recv() {
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 1] = Some(Instant::now());
            }
            let ctx = H::new_context(worker, SandboxReuseStrategy::New);
            let mut ctx = H::load(ctx);
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 2] = Some(Instant::now());
            }
            let result = H::handle_request(&mut ctx);
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 3] = Some(Instant::now());
            }
            if job.response_tx.send(result).is_err() {
                eprintln!("Worker {i} finished after the response receiver was dropped");
            }
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 4] = Some(Instant::now());
            }
            drop(ctx);
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 5] = Some(Instant::now());
            }
        }
    }

    /// Worker thread for `Reload` strategy: reuses the sandbox, but reloads/unloads for each request.
    fn worker_reload<H: Handler>(
        mut rx: mpsc::UnboundedReceiver<JobRequest>,
        i: usize,
        worker: &H::WorkerState,
        ready: std::sync::mpsc::Sender<()>,
    ) {
        let mut ctx = H::new_context(worker, SandboxReuseStrategy::Reload);
        println!("Sandbox worker {} started in RELOAD mode", i);
        ready.send(()).expect("Startup receiver closed");
        drop(ready);
        while let Some(job) = rx.blocking_recv() {
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 1] = Some(Instant::now());
            }
            let mut ctx_loaded = H::load(ctx);
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 2] = Some(Instant::now());
            }
            let result = H::handle_request(&mut ctx_loaded);
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 3] = Some(Instant::now());
            }
            if job.response_tx.send(result).is_err() {
                eprintln!("Worker {i} finished after the response receiver was dropped");
            }
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 4] = Some(Instant::now());
            }
            ctx = H::unload(ctx_loaded); // reset context for next request
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 5] = Some(Instant::now());
            }
        }
    }

    /// Worker thread for `Reuse` strategy: reuses the same sandbox and handler for all requests.
    fn worker_reuse<H: Handler>(
        mut rx: mpsc::UnboundedReceiver<JobRequest>,
        i: usize,
        worker: &H::WorkerState,
        ready: std::sync::mpsc::Sender<()>,
    ) {
        let ctx = H::new_context(worker, SandboxReuseStrategy::Reuse);
        let mut ctx = H::load(ctx);
        println!("Sandbox worker {} started in REUSE mode", i);
        ready.send(()).expect("Startup receiver closed");
        drop(ready);
        while let Some(job) = rx.blocking_recv() {
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 1] = Some(Instant::now());
            }
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 2] = Some(Instant::now());
            }
            let result = H::handle_request(&mut ctx);
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 3] = Some(Instant::now());
            }
            if job.response_tx.send(result).is_err() {
                eprintln!("Worker {i} finished after the response receiver was dropped");
            }
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 4] = Some(Instant::now());
            }
            #[cfg(feature = "time_phases")]
            {
                (*TIMES.lock().unwrap())[job.reqnum + 5] = Some(Instant::now());
            }
        }
    }

    /// Create a new sandbox pool with the given number of workers, mode, and handler.
    fn start<H: Handler + Send + Sync + 'static>(
        pool_size: usize,
        mode: SandboxReuseStrategy,
        config: Option<ObserverConfig>,
        handler_config: H::Config,
    ) -> Arc<Self> {
        assert!(pool_size > 0, "Pool size must be positive");
        let mut senders = Vec::with_capacity(pool_size);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let startup_deadline = std::time::Instant::now() + Duration::from_secs(120);

        let observer = config.map(|conf| {
            Arc::new(CpuTimeObserver::new(conf.timeout, conf.check_in))
        });

        for i in 0..pool_size {
            let (tx, rx) = mpsc::unbounded_channel::<JobRequest>();
            senders.push(tx);
            let obs = observer.clone();
            let ready = ready_tx.clone();
            std::thread::spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    eprintln!("Worker thread {} starting...", i);
                    let worker = H::prepare_worker(handler_config, obs);
                    eprintln!("Worker thread {} preparation completed", i);
                    match mode {
                        SandboxReuseStrategy::New => Self::worker_new::<H>(rx, i, &worker, ready),
                        SandboxReuseStrategy::Reload => Self::worker_reload::<H>(rx, i, &worker, ready),
                        SandboxReuseStrategy::Reuse => Self::worker_reuse::<H>(rx, i, &worker, ready),
                    }
                }));

                match result {
                    Ok(_) => {
                        eprintln!("Worker thread {} completed normally", i);
                    }
                    Err(panic) => {
                        eprintln!("=== WORKER THREAD {} PANIC CAUGHT ===", i);
                        eprintln!("Worker thread {} panicked: {:?}", i, panic);
                        if let Some(s) = panic.downcast_ref::<&str>() {
                            eprintln!("  panic message: {}", s);
                        } else if let Some(s) = panic.downcast_ref::<String>() {
                            eprintln!("  panic message: {}", s);
                        }
                        eprintln!("=== END WORKER PANIC INFO ===");

                        // Flush stderr
                        use std::io::Write;
                        let _ = std::io::stderr().flush();
                        std::process::exit(1);
                    }
                }
            });
        }
        drop(ready_tx);
        for _ in 0..pool_size {
            ready_rx
                .recv_timeout(startup_deadline.saturating_duration_since(std::time::Instant::now()))
                .expect("Sandbox worker startup failed or timed out");
        }
        Arc::new(Self {
            senders,
            counter: AtomicUsize::new(0),
        })
    }

    /// Send a job to the pool and await the result.
    async fn execute(&self) -> String {
        #[cfg(feature = "time_phases")]
        let reqnum = N_REQS.fetch_add(8, std::sync::atomic::Ordering::Relaxed) % N_TIMES;
        #[cfg(feature = "time_phases")]
        { (*TIMES.lock().unwrap())[reqnum] = Some(Instant::now()); }
        // Round-robin distribution: cycle through workers sequentially
        let index = self
            .counter
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            % self.senders.len();
        let (response_tx, response_rx) = oneshot::channel();
        self.senders[index]
            .send(JobRequest {
                response_tx,
                #[cfg(feature = "time_phases")]
                reqnum,
            })
            .unwrap();
        let result = response_rx.await.unwrap();
        #[cfg(feature = "time_phases")]
        { (*TIMES.lock().unwrap())[reqnum + 6] = Some(Instant::now()); }
        result
    }
}

/// Main HTTP handler: runs the JS handler in a sandbox and returns the response.
async fn handler(
    pool: Arc<SandboxPool>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let res = pool.execute().await;
    // make sure the handler ran
    assert!(
        res.starts_with(r#"{"uri":"/redirected"#),
        "Expected handler to modify the URI, got: {}",
        res
    );
    Ok(Response::new(Full::new(res.into())))
}

/// Strategy for sandbox reuse between requests.
///
/// - `New`: Create a new sandbox for each request.
/// - `Reload`: Reuse the sandbox, but reload/unload for each request.
/// - `Reuse`: Reuse the same sandbox and handler for all requests.
#[derive(Copy, Clone, Debug, ValueEnum)]
pub enum SandboxReuseStrategy {
    /// For each request, create a brand new sandbox instance. This is expected to be the slowest option.
    New,
    /// For each request, reuse the sandbox instance, but reload/unload the handler. This can have different meanings depending on the runtime. This is expected to be slower than `Reuse`, but faster than `New`.
    Reload,
    /// Reuse the same sandbox instance for all requests, reusing the handler as well. This is expected to be the fastest option.
    Reuse,
}

#[derive(Copy, Clone, Debug, ValueEnum)]
enum Runtime {
    #[value(name = "wasmtime-jco")]
    WasmtimeJco,
    WasmtimeQjs,
    WasmtimeDummy,
    #[value(name = "wasmtime-aot-jco")]
    WasmtimeAOTJco,
    WasmtimeAOTQjs,
    WasmtimeAOTDummy,
    WasmtimePulleyJco,
    WasmtimePulleyQjs,
    WasmtimePulleyDummy,
    HyperlightDummy,
    #[value(name = "hyperlight-wasm-jco")]
    HyperlightWASMJco,
    #[value(name = "hyperlight-wasm-pulley-jco")]
    HyperlightWASMPulleyJco,
    HyperlightWASMPulleyQjs,
    HyperlightWASMPulleyDummy,
    HyperlightWASMQjs,
    HyperlightWASMDummy,
    HyperlightJS,
    Dummy,
}

impl Runtime {
    fn start_pool(
        self,
        pool_size: usize,
        strategy: SandboxReuseStrategy,
        observer: Option<ObserverConfig>,
    ) -> Arc<SandboxPool> {
        use handlers::{ComponentSource::*, *};

        let wasmtime = |source| {
            SandboxPool::start::<WasmtimeHandler>(pool_size, strategy, observer, source)
        };
        let hyperlight_wasm = |artifact, memory| {
            SandboxPool::start::<HyperlightWASMHandler>(
                pool_size,
                strategy,
                observer,
                HyperlightWasmConfig { artifact, memory },
            )
        };

        match self {
            Self::WasmtimeJco => wasmtime(Wasm(JCO_WASM)),
            Self::WasmtimeQjs => wasmtime(Wasm(QJS_WASM)),
            Self::WasmtimeDummy => wasmtime(Wasm(RUST_WASM)),
            Self::WasmtimeAOTJco => wasmtime(NativeAot(JCO_AOT)),
            Self::WasmtimeAOTQjs => wasmtime(NativeAot(QJS_AOT)),
            Self::WasmtimeAOTDummy => wasmtime(NativeAot(RUST_AOT)),
            Self::WasmtimePulleyJco => wasmtime(PulleyAot(JCO_PULLEY)),
            Self::WasmtimePulleyQjs => wasmtime(PulleyAot(QJS_PULLEY)),
            Self::WasmtimePulleyDummy => wasmtime(PulleyAot(RUST_PULLEY)),
            Self::HyperlightWASMJco => hyperlight_wasm(JCO_AOT, JCO_MEMORY),
            Self::HyperlightWASMQjs => hyperlight_wasm(QJS_AOT, QJS_MEMORY),
            Self::HyperlightWASMDummy => hyperlight_wasm(RUST_AOT, RUST_MEMORY),
            Self::HyperlightWASMPulleyJco => hyperlight_wasm(JCO_PULLEY, JCO_PULLEY_MEMORY),
            Self::HyperlightWASMPulleyQjs => hyperlight_wasm(QJS_PULLEY, QJS_MEMORY),
            Self::HyperlightWASMPulleyDummy => hyperlight_wasm(RUST_PULLEY, RUST_MEMORY),
            Self::HyperlightJS => {
                SandboxPool::start::<HyperlightJSHandler>(pool_size, strategy, observer, ())
            }
            Self::HyperlightDummy => {
                SandboxPool::start::<HyperlightDummyHandler>(pool_size, strategy, observer, ())
            }
            Self::Dummy => {
                SandboxPool::start::<DummyHandler>(pool_size, strategy, observer, ())
            }
        }
    }
}

/// Create a HTTP server using a specific runtime and testing strategy.
#[derive(Parser, Debug, Clone)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Sandbox reuse strategy. Determines what to do for each request.
    #[arg(long, value_enum)]
    strategy: SandboxReuseStrategy,

    /// Which runtime to use
    #[arg(long, value_enum)]
    runtime: Runtime,

    #[arg(long, default_value_t = 3000)]
    port: u16,

    #[arg(long)]
    memory_output: Option<std::path::PathBuf>,

    #[arg(long, default_value_t = false)]
    shutdown_stdin: bool,

    /// Number of sandbox workers
    #[arg(long, default_value_t = 4)]
    pool_size: usize,

    /// Number of Tokio runtime worker threads
    #[arg(long, default_value_t = std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get))]
    worker_threads: usize,

    /// Enable sandbox timeout
    #[arg(long, default_value_t = false)]
    with_timeout: bool,

    /// Timeout duration in milliseconds
    #[arg(long, default_value_t = 50, requires = "with_timeout")]
    timeout_ms: u64,

    /// Check-in interval in milliseconds
    #[arg(long, default_value_t = 10, requires = "with_timeout")]
    timeout_check_interval_ms: u64,
}

/// Entry point: starts the Tokio runtime and HTTP server.
fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args: Args = Args::parse();
    if args.shutdown_stdin {
        let report_panic = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            report_panic(info);
            std::process::exit(1);
        }));
    }
    let num_worker_threads = args.worker_threads;
    let pool_size = args.pool_size;
    let sandbox_mode = args.strategy;
    let runtime = args.runtime;
    let is_pulley = matches!(runtime, Runtime::HyperlightWASMPulleyJco | Runtime::HyperlightWASMPulleyQjs | Runtime::HyperlightWASMPulleyDummy);
    let is_native_wasm = matches!(runtime, Runtime::HyperlightWASMJco | Runtime::HyperlightWASMQjs | Runtime::HyperlightWASMDummy);
    if (is_pulley && !cfg!(feature = "pulley")) || (is_native_wasm && cfg!(feature = "pulley")) {
        return Err("Hyperlight Wasm runtime does not match this binary's pulley feature".into());
    }
    let timeout = Duration::from_millis(args.timeout_ms);
    let check_in = Duration::from_millis(args.timeout_check_interval_ms);

    println!(
        "Starting server with {} tokio-worker-threads, vm-pool-size: {}, mode: {:?}",
        num_worker_threads, pool_size, sandbox_mode
    );

    if args.with_timeout {
        println!("Sandbox timeout enabled for {:?} with Check-in Frequency {:?}", timeout, check_in);
    }

    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(num_worker_threads)
        .enable_all()
        .build()
        .unwrap()
        .block_on(async move {
            // Start memory monitoring with signal handler
            memory_monitor::start_monitoring(&runtime, &sandbox_mode, args.memory_output, args.shutdown_stdin).await;
            let observer_config = if args.with_timeout {
                Some(ObserverConfig{
                    timeout: timeout,
                    check_in: check_in
                })
            } else { None };
            

            let pool = runtime.start_pool(pool_size, sandbox_mode, observer_config);

            let addr = SocketAddr::from(([127, 0, 0, 1], args.port));
            let listener = TcpListener::bind(addr).await?;
            println!("{}", serde_json::json!({ "event": "ready", "pid": std::process::id(), "port": listener.local_addr()?.port(), "workerThreads": num_worker_threads, "poolSize": pool_size }));

            loop {
                let (stream, _) = listener.accept().await?;
                #[cfg(feature = "time_phases")]
                N_CONNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let io = TokioIo::new(stream);
                let pool = pool.clone();

                tokio::task::spawn(async move {
                    let service = service_fn(move |_req| {
                        let pool = pool.clone();
                        async move { handler(pool).await }
                    });

                    if let Err(err) = http1::Builder::new().serve_connection(io, service).await {
                        eprintln!("Error serving connection: {:?}", err);
                    }
                });
            }
        })
}

#[cfg(feature = "time_phases")]
fn report_phases() {
    let mut total = Duration::ZERO;
    let mut sandbox = Duration::ZERO;
    let mut load = Duration::ZERO;
    let mut execute = Duration::ZERO;
    let mut unload = Duration::ZERO;
    let mut requests = 0;
    let times = TIMES.lock().unwrap();
    for request in times.chunks(8) {
        if let [Some(start), Some(entered), Some(loaded), Some(handled), Some(sent), Some(left), Some(end), None] = request {
            total += end.saturating_duration_since(*start);
            sandbox += left.saturating_duration_since(*entered);
            load += loaded.saturating_duration_since(*entered);
            execute += handled.saturating_duration_since(*loaded);
            unload += left.saturating_duration_since(*sent);
            requests += 1;
        }
    }
    println!("Phase totals for {requests} requests on {} connections: total={total:?} sandbox={sandbox:?} load={load:?} execute={execute:?} unload={unload:?}", N_CONNS.load(std::sync::atomic::Ordering::Relaxed));
}
