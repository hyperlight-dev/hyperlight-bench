use std::sync::Arc;

use sandbox_observer::observer::CpuTimeObserver;

use super::Handler;
use crate::SandboxReuseStrategy;

/// A dummy handler that simulates a request processing without any real logic.
/// Useful for seeing maximal performance of the server.
pub struct DummyHandler;

impl Handler for DummyHandler {
    type Config = ();
    type Context = ();
    type WorkerState = ();

    fn prepare_worker(_: Self::Config, _: Option<Arc<CpuTimeObserver>>) -> Self::WorkerState {}

    fn new_context(
        _worker: &Self::WorkerState,
        _strategy: SandboxReuseStrategy,
    ) -> Self::Context {
    }

    fn load(ctx: Self::Context) -> Self::Context {
        ctx
    }

    fn unload(ctx: Self::Context) -> Self::Context {
        ctx
    }

    fn handle_request(_ctx: &mut Self::Context) -> String {
        r#"{"uri":"/redirected.html"}"#.to_string()
    }
}
