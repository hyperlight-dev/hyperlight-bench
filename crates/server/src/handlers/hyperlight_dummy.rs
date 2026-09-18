use std::sync::Arc;

use hyperlight_host::MultiUseSandbox;
use hyperlight_host::sandbox::snapshot::Snapshot;
use sandbox_observer::observer::CpuTimeObserver;

use crate::{DEFAULT_REQUEST_BODY, SandboxReuseStrategy};

use super::Handler;

/// A dummy handler that simulates a request processing without any real logic.
/// Useful for seeing maximal performance of the server.
pub struct HyperlightDummyHandler;

enum DummyLifecycle {
    Renew,
    Restore(Arc<Snapshot>),
    Reuse,
}

pub struct HyperlightDummyContext {
    sandbox: MultiUseSandbox,
    lifecycle: DummyLifecycle,
}

impl Handler for HyperlightDummyHandler {
    type Config = ();
    type Context = HyperlightDummyContext;
    type WorkerState = Vec<u8>;

    fn prepare_worker(_: Self::Config, _: Option<Arc<CpuTimeObserver>>) -> Self::WorkerState {
        std::fs::read("./crates/hyperlight-dummy-guest/target/x86_64-hyperlight-none/release/hyperlight-dummy-guest").expect("hyperlight-dummy-guest must be compiled before running the server. Run `just build-hyperlight-dummy-guest`")
    }

    fn new_context(
        worker: &Self::WorkerState,
        strategy: SandboxReuseStrategy,
    ) -> Self::Context {
        let guest_binary = hyperlight_host::GuestBinary::Buffer(worker.clone());
        let mut sandbox = hyperlight_host::sandbox::UninitializedSandbox::new(guest_binary, None)
            .unwrap()
            .evolve()
            .unwrap();
        let lifecycle = match strategy {
            SandboxReuseStrategy::New => DummyLifecycle::Renew,
            SandboxReuseStrategy::Reload => DummyLifecycle::Restore(
                sandbox.snapshot().expect("Failed to snapshot the dummy sandbox"),
            ),
            SandboxReuseStrategy::Reuse => DummyLifecycle::Reuse,
        };
        HyperlightDummyContext { sandbox, lifecycle }
    }

    fn load(ctx: Self::Context) -> Self::Context {
        ctx
    }

    fn unload(mut ctx: Self::Context) -> Self::Context {
        let DummyLifecycle::Restore(snapshot) = &ctx.lifecycle else {
            panic!("Only Restore may unload a dummy sandbox");
        };
        ctx.sandbox.restore(snapshot.clone())
            .expect("Failed to restore the dummy sandbox snapshot");
        ctx
    }

    fn handle_request(ctx: &mut Self::Context) -> String {
        let res: String = ctx.sandbox
            .call("handle_request", DEFAULT_REQUEST_BODY.to_string())
            .unwrap();
        res
    }
}
