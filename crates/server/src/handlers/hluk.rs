//! hyperlight-unikraft (hluk): a Linux runtime in a Unikraft guest,
//! serving the handler as a guest function call.
//!
//! One base snapshot per process, shared by the pool: the runtime booted,
//! with a Wasm component already loaded (the hyperlight-wasm approach), or
//! with no handler for a script runtime (the hyperlight-js approach, which
//! defines the handler on each load).
//!
//! - Renew: a new sandbox from the base snapshot for each request. A cold
//!   boot costs from tens of milliseconds to seconds, so hluk starts guests
//!   from a snapshot.
//! - Restore: one sandbox; each request loads the handler, calls it and
//!   restores the base snapshot.
//! - Reuse: one sandbox, handler loaded once.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use hyperlight_unikraft::{AppSandbox, Exec, Mount, SandboxBuilder, Snapshot};
use sandbox_observer::observer::{CpuTimeObserver, Observer};

use super::{HLUK_ROOTFS_DIR, Handler};
use crate::{DEFAULT_REQUEST_BODY, SandboxReuseStrategy};

/// What the guest runs.
#[derive(Copy, Clone)]
pub enum HlukGuest {
    /// Source that defines `function`, run on each load.
    Script {
        source: &'static str,
        function: &'static str,
    },
    /// A Wasm component, loaded (and compiled by Wasmtime in the guest)
    /// once, before the base snapshot.
    Component { path: &'static str },
    /// The dummy driver answers every call with the redirect itself.
    Fixed,
}

#[derive(Copy, Clone)]
pub struct HlukConfig {
    /// The rootfs under HLUK_ROOTFS_DIR, e.g. `quickjs.cpio`.
    pub rootfs: &'static str,
    /// Guest memory; None takes the size hluk tests the runtime with.
    pub scratch_mb: Option<usize>,
    pub guest: HlukGuest,
}

/// The component's export: handleevent of the bench's handler-interface.
const COMPONENT_FUNCTION: &str = "hyperlight:bench/handler-interface#handleevent";

pub struct HlukHandler;

pub struct HlukWorkerState {
    config: HlukConfig,
    base: Arc<Snapshot>,
    observer: Option<Arc<CpuTimeObserver>>,
}

pub struct HlukContext {
    sandbox: AppSandbox,
    config: HlukConfig,
    base: Arc<Snapshot>,
    observer: Option<Arc<CpuTimeObserver>>,
}

/// The base snapshot, booted once by whichever worker gets here first.
static BASE: OnceLock<Arc<Snapshot>> = OnceLock::new();

fn boot_base(config: HlukConfig) -> Arc<Snapshot> {
    let rootfs = Path::new(HLUK_ROOTFS_DIR).join(config.rootfs);
    assert!(
        rootfs.is_file(),
        "{} is missing: run `node scripts/build-harness.ts hluk`",
        rootfs.display()
    );
    let mut builder = SandboxBuilder::from_initrd(&rootfs);
    if let Some(mb) = config.scratch_mb {
        builder = builder.scratch_mb(mb);
    }
    let mut sandbox = match config.guest {
        HlukGuest::Component { path } => {
            let path = Path::new(path);
            let dir = path.parent().expect("component path has a directory");
            let file = path.file_name().unwrap().to_str().unwrap();
            let mut sandbox = builder
                .mount(Mount::ro(dir, "/app"))
                .boot()
                .expect("hluk guest failed to boot");
            // No wasi:cli/run export, so the driver keeps it as a library.
            sandbox
                .run(Exec::Guest(format!("/app/{file}")))
                .expect("Failed to load the Wasm component");
            sandbox
        }
        _ => builder.boot().expect("hluk guest failed to boot"),
    };
    sandbox.snapshot().expect("Failed to snapshot the hluk guest")
}

impl Handler for HlukHandler {
    type Config = HlukConfig;
    type Context = HlukContext;
    type WorkerState = HlukWorkerState;

    fn prepare_worker(config: Self::Config, observer: Option<Arc<CpuTimeObserver>>) -> Self::WorkerState {
        HlukWorkerState {
            config,
            base: BASE.get_or_init(|| boot_base(config)).clone(),
            observer,
        }
    }

    fn new_context(worker: &Self::WorkerState, _strategy: SandboxReuseStrategy) -> Self::Context {
        let sandbox = SandboxBuilder::from_snapshot(worker.base.clone())
            .boot()
            .expect("Failed to start a hluk sandbox from the base snapshot");
        HlukContext {
            sandbox,
            config: worker.config,
            base: worker.base.clone(),
            observer: worker.observer.clone(),
        }
    }

    fn load(mut ctx: Self::Context) -> Self::Context {
        // Restore models a different customer's handler on each request,
        // so a script's handler is defined here.
        if let HlukGuest::Script { source, .. } = ctx.config.guest {
            ctx.sandbox.run(source).expect("Failed to define the handler");
        }
        ctx
    }

    fn unload(mut ctx: Self::Context) -> Self::Context {
        ctx.sandbox
            .restore(ctx.base.clone())
            .expect("Failed to restore the base snapshot");
        ctx
    }

    fn handle_request(ctx: &mut Self::Context) -> String {
        let (function, input) = match ctx.config.guest {
            HlukGuest::Script { function, .. } => (function, DEFAULT_REQUEST_BODY.to_string()),
            HlukGuest::Component { .. } => (COMPONENT_FUNCTION, format!("[{DEFAULT_REQUEST_BODY}]")),
            HlukGuest::Fixed => ("handler", DEFAULT_REQUEST_BODY.to_string()),
        };
        let interrupt_handle = ctx.sandbox.interrupt_handle();
        if let Some(obs) = &ctx.observer {
            obs.start_timeout(&interrupt_handle);
        }
        let result = ctx.sandbox.call(function, &input).expect("The guest function call failed");
        if let Some(obs) = &ctx.observer {
            obs.stop_timeout(&interrupt_handle);
        }
        result
    }
}
