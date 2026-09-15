mod config;
mod dummy;
mod hyperlight_dummy;
mod hyperlight_js;
mod hyperlight_wasm;
mod wasmtime;

pub use config::*;
pub use dummy::DummyHandler;
pub use hyperlight_dummy::HyperlightDummyHandler;
pub use hyperlight_js::HyperlightJSHandler;
pub use hyperlight_wasm::{HyperlightWASMHandler, HyperlightWasmConfig};
use sandbox_observer::observer::CpuTimeObserver;
use std::sync::Arc;
pub use wasmtime::{ComponentSource, WasmtimeHandler};

use crate::SandboxReuseStrategy;

#[derive(Copy, Clone)]
pub struct PerStrategy<T> {
    pub new: T,
    pub reload: T,
    pub reuse: T,
}

impl<T: Copy> PerStrategy<T> {
    pub const fn uniform(value: T) -> Self {
        Self {
            new: value,
            reload: value,
            reuse: value,
        }
    }

    pub fn get(self, strategy: SandboxReuseStrategy) -> T {
        match strategy {
            SandboxReuseStrategy::New => self.new,
            SandboxReuseStrategy::Reload => self.reload,
            SandboxReuseStrategy::Reuse => self.reuse,
        }
    }
}

/// Common trait for all handlers
pub trait Handler: Send + Sync {
    type Config: Copy + Send + Sync + 'static;
    type Context: Send;
    type WorkerState: Send;

    fn prepare_worker(
        config: Self::Config,
        observer: Option<Arc<CpuTimeObserver>>,
    ) -> Self::WorkerState;

    /// Create a new context.
    /// Could be called once or multiple times depending on the
    /// per-request strategy
    fn new_context(
        worker: &Self::WorkerState,
        strategy: SandboxReuseStrategy,
    ) -> Self::Context;

    /// Load the context
    fn load(ctx: Self::Context) -> Self::Context;

    /// Unload the context
    fn unload(ctx: Self::Context) -> Self::Context;

    /// Handle a request
    fn handle_request(ctx: &mut Self::Context) -> String;
}
