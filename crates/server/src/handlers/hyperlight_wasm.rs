use super::{Handler, SandboxMemory};
use crate::{DEFAULT_REQUEST_URI, SandboxReuseStrategy};

use bindings::hyperlight::bench::handler_interface::Request;
use hyperlight_host::sandbox::snapshot::Snapshot;
use hyperlight_wasm::{LoadedWasmSandbox, WasmSandbox};
use sandbox_observer::observer::{CpuTimeObserver, Observer};

use std::{os::fd::AsRawFd, sync::Arc};

mod bindings {
    use crate::alloc;
    hyperlight_component_macro::host_bindgen!();
}

pub struct MyState;

struct PreparedAot {
    base: *mut libc::c_void,
    len: usize,
}

unsafe impl Send for PreparedAot {}
unsafe impl Sync for PreparedAot {}

impl PreparedAot {
    fn open(path: &str) -> Self {
        let file = std::fs::File::options().read(true).write(true).open(path)
            .expect("Failed to open AOT component");
        let length = usize::try_from(file.metadata().unwrap().len()).unwrap();
        assert!(length > 0, "Empty AOT component");
        let len = length.checked_add(4095).unwrap() / 4096 * 4096;
        let base = unsafe {
            libc::mmap(
                std::ptr::null_mut(), len,
                libc::PROT_READ | libc::PROT_WRITE | libc::PROT_EXEC,
                libc::MAP_PRIVATE, file.as_raw_fd(), 0,
            )
        };
        assert_ne!(base, libc::MAP_FAILED, "Failed to map AOT component: {}", std::io::Error::last_os_error());
        Self { base, len }
    }
}

impl Drop for PreparedAot {
    fn drop(&mut self) {
        let result = unsafe { libc::munmap(self.base, self.len) };
        assert_eq!(result, 0, "Failed to unmap AOT component: {}", std::io::Error::last_os_error());
    }
}

impl bindings::hyperlight::bench::HandlerWorldImports<hyperlight_common::component::Negative>
    for MyState
{
}

enum WasmState {
    Unloaded {
        sandbox: WasmSandbox,
        resources: Arc<std::sync::Mutex<bindings::HandlerWorldResources<MyState>>>,
    },
    Loaded(bindings::HandlerWorldSandbox<MyState, LoadedWasmSandbox>),
}

enum WasmLifecycle {
    Renew,
    Restore(Arc<Snapshot>),
    Reuse(Arc<Snapshot>),
}

pub struct HyperlightWASMContext {
    state: WasmState,
    lifecycle: WasmLifecycle,
    aot: Arc<PreparedAot>,
    observer: Option<Arc<CpuTimeObserver>>,
}
unsafe impl Send for HyperlightWASMContext {}

#[derive(Copy, Clone)]
pub struct HyperlightWasmConfig {
    pub artifact: &'static str,
    pub memory: SandboxMemory,
}

pub struct WorkerState {
    aot: Arc<PreparedAot>,
    memory: SandboxMemory,
    observer: Option<Arc<CpuTimeObserver>>,
}

pub struct HyperlightWASMHandler;

impl Handler for HyperlightWASMHandler {
    type Config = HyperlightWasmConfig;
    type Context = HyperlightWASMContext;
    type WorkerState = WorkerState;

    fn prepare_worker(
        config: Self::Config,
        observer: Option<Arc<CpuTimeObserver>>,
    ) -> Self::WorkerState {
        WorkerState {
            aot: Arc::new(PreparedAot::open(config.artifact)),
            memory: config.memory,
            observer,
        }
    }

    fn new_context(
        worker: &Self::WorkerState,
        strategy: SandboxReuseStrategy,
    ) -> Self::Context {
        let state = MyState;
        let mut builder = hyperlight_wasm::SandboxBuilder::new();

        let observer = worker.observer.clone();

        builder = builder
            .with_guest_scratch_size(worker.memory.scratch.get(strategy))
            .with_guest_heap_size(worker.memory.heap);

        let mut sb = builder.build().unwrap();
        let rt = bindings::register_host_functions(&mut sb, state).unwrap();
        let sb = sb.load_runtime().unwrap();

        let prepare_snapshot = |sandbox: WasmSandbox, lifecycle: fn(Arc<Snapshot>) -> WasmLifecycle| {
            let mut loaded = unsafe {
                sandbox.load_module_by_mapping(worker.aot.base, worker.aot.len)
                    .expect("Failed to load the Wasm module for snapshot preparation")
            };
            let snapshot = loaded.snapshot().expect("Failed to snapshot the loaded Wasm module");
            let sandbox = loaded.unload_module().expect("Failed to unload the Wasm module after snapshot preparation");
            (sandbox, lifecycle(snapshot))
        };
        let (sb, lifecycle) = match strategy {
            SandboxReuseStrategy::New => (sb, WasmLifecycle::Renew),
            SandboxReuseStrategy::Reload => prepare_snapshot(sb, WasmLifecycle::Restore),
            SandboxReuseStrategy::Reuse => prepare_snapshot(sb, WasmLifecycle::Reuse),
        };

        HyperlightWASMContext {
            state: WasmState::Unloaded { sandbox: sb, resources: rt },
            lifecycle,
            aot: worker.aot.clone(),
            observer: observer,
        }
    }

    fn load(mut ctx: Self::Context) -> Self::Context {
        let WasmState::Unloaded { sandbox, resources } = ctx.state else {
            panic!("Wasm load requires an unloaded sandbox");
        };
        let sb = match &ctx.lifecycle {
            WasmLifecycle::Renew => {
                // The context retains the AOT mapping for the loaded module's lifetime.
                unsafe {
                    sandbox.load_module_by_mapping(ctx.aot.base, ctx.aot.len)
                        .expect("Failed to load the Wasm module for Renew")
                }
            }
            WasmLifecycle::Restore(snapshot) | WasmLifecycle::Reuse(snapshot) => sandbox
                .load_from_snapshot(snapshot.clone())
                .expect("Failed to restore the loaded Wasm module snapshot"),
        };

        ctx.state = WasmState::Loaded(bindings::HandlerWorldSandbox {
            sb,
            rt: resources,
        });
        ctx
    }

    fn unload(mut ctx: Self::Context) -> Self::Context {
        let WasmLifecycle::Restore(_) = &ctx.lifecycle else {
            panic!("Only Restore may unload a Wasm module");
        };
        let WasmState::Loaded(wrapped) = ctx.state else {
            panic!("Wasm unload requires a loaded module");
        };
        let unloaded = wrapped.sb.unload_module().expect("Failed to unload the Wasm module");

        ctx.state = WasmState::Unloaded { sandbox: unloaded, resources: wrapped.rt };
        ctx
    }

    fn handle_request(ctx: &mut Self::Context) -> String {
        use bindings::hyperlight::bench::HandlerInterface;

        let WasmState::Loaded(world_sb) = &mut ctx.state else {
            panic!("Wasm handle_request requires a loaded module");
        };
        let handle = world_sb.sb.interrupt_handle().unwrap();

        if let Some(obs) = &ctx.observer {
            obs.start_timeout(&handle);
        }

        let handler = bindings::hyperlight::bench::HandlerWorldExports::handler_interface(
            world_sb,
        );

        let request = Request {
            uri: DEFAULT_REQUEST_URI.to_string(),
        };

        let response = handler.handleevent(request).unwrap();
        let uri = response.uri;

        if let Some(obs) = &ctx.observer {
            obs.stop_timeout(&handle);
        }

        format!("{{\"uri\":\"{}\"}}", uri)
    }
}
