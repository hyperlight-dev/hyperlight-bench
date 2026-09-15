use super::{Handler, SandboxMemory};
use crate::SandboxReuseStrategy;

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

pub struct HyperlightWASMContext {
    unloaded: Option<WasmSandbox>,
    loaded_snapshot: Arc<Snapshot>,
    wrapped: Option<bindings::HandlerWorldSandbox<MyState, LoadedWasmSandbox>>,
    rt: Option<std::sync::Arc<std::sync::Mutex<bindings::HandlerWorldResources<MyState>>>>,
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

        let mut loaded_sb = unsafe {
            sb.load_module_by_mapping(worker.aot.base, worker.aot.len).unwrap()
        };
        let loaded_snapshot = loaded_sb.snapshot().unwrap();
        let sb = loaded_sb.unload_module().unwrap();

        HyperlightWASMContext {
            unloaded: Some(sb),
            loaded_snapshot,
            wrapped: None,
            rt: Some(rt),
            aot: worker.aot.clone(),
            observer: observer,
        }
    }

    fn load(mut ctx: Self::Context) -> Self::Context {
        let wasm_sandbox = ctx.unloaded.take().unwrap();
        let sb = wasm_sandbox
            .load_from_snapshot(ctx.loaded_snapshot.clone())
            .unwrap();

        let wrapped = bindings::HandlerWorldSandbox {
            sb,
            rt: ctx.rt.unwrap(),
        };

        HyperlightWASMContext {
            unloaded: None,
            wrapped: Some(wrapped),
            loaded_snapshot: ctx.loaded_snapshot,
            rt: None,
            aot: ctx.aot,
            observer: ctx.observer,
        }
    }

    fn unload(mut ctx: Self::Context) -> Self::Context {
        let wrapped = ctx.wrapped.take().unwrap();
        let unloaded = wrapped.sb.unload_module().unwrap();

        HyperlightWASMContext {
            unloaded: Some(unloaded),
            wrapped: None,
            loaded_snapshot: ctx.loaded_snapshot,
            rt: Some(wrapped.rt),
            aot: ctx.aot,
            observer: ctx.observer,
        }
    }

    fn handle_request(ctx: &mut Self::Context) -> String {
        use bindings::hyperlight::bench::HandlerInterface;

        let world_sb = ctx.wrapped.as_ref().unwrap();
        let handle = world_sb.sb.interrupt_handle().unwrap();

        if let Some(obs) = &ctx.observer {
            obs.start_timeout(&handle);
        }

        let handler = bindings::hyperlight::bench::HandlerWorldExports::handler_interface(
            ctx.wrapped.as_mut().unwrap(),
        );

        let request = Request {
            uri: "/default.html".to_string(),
        };

        let response = handler.handleevent(request).unwrap();
        let uri = response.uri;

        if let Some(obs) = &ctx.observer {
            obs.stop_timeout(&handle);
        }

        format!("{{\"uri\":\"{}\"}}", uri).to_string()
    }
}
