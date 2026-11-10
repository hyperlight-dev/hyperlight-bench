mod config;
mod dummy;
#[cfg(feature = "hluk")]
mod hluk;
mod hyperlight_dummy;
#[cfg(feature = "classic")]
mod hyperlight_js;
#[cfg(feature = "classic")]
mod hyperlight_wasm;
#[cfg(feature = "classic")]
mod wasmtime;

pub use config::*;
pub use dummy::DummyHandler;
#[cfg(feature = "hluk")]
pub use hluk::{HlukConfig, HlukGuest, HlukHandler};
pub use hyperlight_dummy::HyperlightDummyHandler;
#[cfg(feature = "classic")]
pub use hyperlight_js::HyperlightJSHandler;
#[cfg(feature = "classic")]
pub use hyperlight_wasm::{HyperlightWASMHandler, HyperlightWasmConfig};
use sandbox_observer::observer::CpuTimeObserver;
use std::sync::Arc;
#[cfg(feature = "classic")]
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
