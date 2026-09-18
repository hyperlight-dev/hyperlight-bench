use std::sync::Arc;

use sandbox_observer::observer::CpuTimeObserver;

use super::Handler;
use crate::{DEFAULT_REQUEST_URI, SandboxReuseStrategy};

mod bindings {
    wasmtime::component::bindgen!(in "../../js/src/wit");
}

#[derive(Copy, Clone)]
pub enum ComponentSource {
    Wasm(&'static str),
    NativeAot(&'static str),
    PulleyAot(&'static str),
}

pub struct WasmtimeHandler;

pub struct WorkerState {
    bytes: Vec<u8>,
    source: ComponentSource,
}

pub struct WasmtimeContext {
    engine: wasmtime::Engine,
    component: wasmtime::component::Component,
    linker: wasmtime::component::Linker<()>,
    store: Option<wasmtime::Store<()>>,
    instance: Option<bindings::HandlerWorld>,
}

impl Handler for WasmtimeHandler {
    type Config = ComponentSource;
    type Context = WasmtimeContext;
    type WorkerState = WorkerState;

    fn prepare_worker(source: Self::Config, _: Option<Arc<CpuTimeObserver>>) -> Self::WorkerState {
        let path = match source {
            ComponentSource::Wasm(path)
            | ComponentSource::NativeAot(path)
            | ComponentSource::PulleyAot(path) => path,
        };
        WorkerState {
            bytes: std::fs::read(path).expect(&format!("Failed to read {path}")),
            source,
        }
    }

    fn new_context(worker: &Self::WorkerState, _strategy: SandboxReuseStrategy) -> Self::Context {
        let mut config = wasmtime::Config::new();
        match worker.source {
            ComponentSource::Wasm(_) => {}
            ComponentSource::NativeAot(_) => {
                config.target("x86_64-unknown-none").unwrap();
            }
            ComponentSource::PulleyAot(_) => {
                config.target("pulley64").unwrap();
            }
        }
        // Enable pooling allocator for better performance
        let pooling_config = wasmtime::PoolingAllocationConfig::default();
        config.allocation_strategy(wasmtime::InstanceAllocationStrategy::Pooling(
            pooling_config,
        ));

        let engine = wasmtime::Engine::new(&config).unwrap();
        let component = match worker.source {
            ComponentSource::Wasm(_) => {
                wasmtime::component::Component::from_binary(&engine, &worker.bytes).unwrap()
            }
            ComponentSource::NativeAot(_) | ComponentSource::PulleyAot(_) => unsafe {
                wasmtime::component::Component::deserialize(&engine, &worker.bytes).unwrap()
            },
        };
        let linker = wasmtime::component::Linker::new(&engine);

        WasmtimeContext {
            engine,
            component,
            linker,
            store: None,
            instance: None,
        }
    }

    fn load(mut ctx: Self::Context) -> Self::Context {
        let mut store = wasmtime::Store::new(&ctx.engine, ());

        let instance =
            bindings::HandlerWorld::instantiate(&mut store, &ctx.component, &ctx.linker).unwrap();
        let _ = ctx.instance.insert(instance);
        let _ = ctx.store.insert(store);
        ctx
    }

    fn unload(mut ctx: Self::Context) -> Self::Context {
        ctx.instance.take().unwrap();
        ctx.store.take().unwrap();
        ctx
    }

    fn handle_request(ctx: &mut Self::Context) -> String {
        let instance = ctx.instance.as_ref().unwrap();

        let request = bindings::exports::hyperlight::bench::handler_interface::Request {
            uri: DEFAULT_REQUEST_URI.to_string(),
        };

        // Call the WIT handler
        let handler = instance.hyperlight_bench_handler_interface();
        let result = handler
            .call_handleevent(ctx.store.as_mut().unwrap(), &request)
            .unwrap();

        format!("{{\"uri\":\"{}\"}}", result.uri)
    }
}
