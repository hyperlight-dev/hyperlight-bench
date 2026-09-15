use super::Handler;
use crate::{DEFAULT_REQUEST_BODY, SandboxReuseStrategy};
use hyperlight_js::SandboxBuilder;
use sandbox_observer::observer::{CpuTimeObserver, Observer};
use std::sync::Arc;

pub struct HyperlightJSHandler;

pub struct HyperlightJSWorkerState {
    observer: Option<Arc<CpuTimeObserver>>,
}
pub struct HyperlightJSContext {
    sandbox: Option<hyperlight_js::JSSandbox>,
    loaded_sandbox: Option<hyperlight_js::LoadedJSSandbox>,
    observer: Option<Arc<CpuTimeObserver>>,
}

// Hyperlight-js does not support
// the syntax that is used for a starling-monkey handler:
//
// export const handlerInterface = {
//     handleevent(event) {
//         event.uri = '/redirected.html';
//         return event;
//     }
// };
//
// so we have a similar one here instead
const HANDLER: &str = "function handler(request){
    request.uri = '/redirected.html';
    return request
}";

impl Handler for HyperlightJSHandler {
    type Config = ();
    type Context = HyperlightJSContext;
    type WorkerState = HyperlightJSWorkerState;

    fn prepare_worker(_: Self::Config, observer: Option<Arc<CpuTimeObserver>>) -> Self::WorkerState {
        HyperlightJSWorkerState { observer: observer }
    }

    fn new_context(
        worker: &Self::WorkerState,
        _strategy: SandboxReuseStrategy,
    ) -> Self::Context {
        let js = SandboxBuilder::new()
            .build()
            .unwrap()
            .load_runtime()
            .unwrap();

        let observer = worker.observer.clone();

        HyperlightJSContext {
            sandbox: Some(js),
            loaded_sandbox: None,
            observer: observer,
        }
    }

    fn load(mut ctx: Self::Context) -> Self::Context {
        let mut js = ctx.sandbox.take().unwrap();
        js.add_handler("handler".to_string(), HANDLER.to_string().into())
            .unwrap();
        let loaded = js.get_loaded_sandbox().unwrap();
        HyperlightJSContext {
            sandbox: None,
            loaded_sandbox: Some(loaded),
            observer: ctx.observer,
        }
    }

    fn unload(mut ctx: Self::Context) -> Self::Context {
        let loaded = ctx.loaded_sandbox.take().unwrap();
        let js = loaded.unload().unwrap();
        HyperlightJSContext {
            sandbox: Some(js),
            loaded_sandbox: None,
            observer: ctx.observer,
        }
    }

    fn handle_request(ctx: &mut Self::Context) -> String {
        let loaded = ctx.loaded_sandbox.as_mut().unwrap();
        let interrupt_handle = loaded.interrupt_handle();

        if let Some(obs) = &ctx.observer {
            obs.start_timeout(&interrupt_handle);
        }

        let result = loaded
            .handle_event(
                "handler".to_string(),
                DEFAULT_REQUEST_BODY.to_string(),
                None,
            )
            .unwrap();

        if let Some(obs) = &ctx.observer {
            obs.stop_timeout(&interrupt_handle);
        }

        result
    }
}
