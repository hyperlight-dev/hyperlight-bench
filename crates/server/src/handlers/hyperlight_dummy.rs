use std::sync::Arc;

use hyperlight_host::MultiUseSandbox;
use sandbox_observer::observer::CpuTimeObserver;

use crate::{DEFAULT_REQUEST_BODY, SandboxReuseStrategy};

use super::Handler;

/// A dummy handler that simulates a request processing without any real logic.
/// Useful for seeing maximal performance of the server.
pub struct HyperlightDummyHandler;

impl Handler for HyperlightDummyHandler {
    type Config = ();
    type Context = MultiUseSandbox;
    type WorkerState = Vec<u8>;

    fn prepare_worker(_: Self::Config, _: Option<Arc<CpuTimeObserver>>) -> Self::WorkerState {
        std::fs::read("./crates/hyperlight-dummy-guest/target/x86_64-hyperlight-none/release/hyperlight-dummy-guest").expect("hyperlight-dummy-guest must be compiled before running the server. Run `just build-hyperlight-dummy-guest`")
    }

    fn new_context(
        worker: &Self::WorkerState,
        _strategy: SandboxReuseStrategy,
    ) -> Self::Context {
        let guest_binary = hyperlight_host::GuestBinary::Buffer(worker.clone());
        hyperlight_host::sandbox::UninitializedSandbox::new(guest_binary, None)
            .unwrap()
            .evolve()
            .unwrap()
    }

    fn load(ctx: Self::Context) -> Self::Context {
        ctx
    }

    fn unload(ctx: Self::Context) -> Self::Context {
        ctx
    }

    fn handle_request(ctx: &mut Self::Context) -> String {
        let res: String = ctx
            .call("handle_request", DEFAULT_REQUEST_BODY.to_string())
            .unwrap();
        res
    }
}
