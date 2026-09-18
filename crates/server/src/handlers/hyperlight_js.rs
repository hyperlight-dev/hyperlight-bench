use super::Handler;
use crate::{DEFAULT_REQUEST_BODY, SandboxReuseStrategy};
use hyperlight_js::SandboxBuilder;
use sandbox_observer::observer::{CpuTimeObserver, Observer};
use std::sync::Arc;

pub struct HyperlightJSHandler;

pub struct HyperlightJSWorkerState {
    observer: Option<Arc<CpuTimeObserver>>,
}

enum JSState {
    Unloaded(hyperlight_js::JSSandbox),
    Loaded(hyperlight_js::LoadedJSSandbox),
}

pub struct HyperlightJSContext {
    state: JSState,
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

    fn prepare_worker(
        _: Self::Config,
        observer: Option<Arc<CpuTimeObserver>>,
    ) -> Self::WorkerState {
        HyperlightJSWorkerState { observer: observer }
    }

    fn new_context(worker: &Self::WorkerState, _strategy: SandboxReuseStrategy) -> Self::Context {
        let js = SandboxBuilder::new()
            .build()
            .unwrap()
            .load_runtime()
            .unwrap();

        HyperlightJSContext {
            state: JSState::Unloaded(js),
            observer: worker.observer.clone(),
        }
    }

    fn load(ctx: Self::Context) -> Self::Context {
        let JSState::Unloaded(mut js) = ctx.state else {
            panic!("JS load requires an unloaded sandbox");
        };
        // Restore models a different customer's handler on each request, so registration belongs here.
        js.add_handler("handler".to_string(), HANDLER.to_string().into())
            .unwrap();
        let loaded = js.get_loaded_sandbox().unwrap();
        HyperlightJSContext {
            state: JSState::Loaded(loaded),
            observer: ctx.observer,
        }
    }

    fn unload(ctx: Self::Context) -> Self::Context {
        let JSState::Loaded(loaded) = ctx.state else {
            panic!("JS unload requires a loaded sandbox");
        };
        let js = loaded.unload().unwrap();
        HyperlightJSContext {
            state: JSState::Unloaded(js),
            observer: ctx.observer,
        }
    }

    fn handle_request(ctx: &mut Self::Context) -> String {
        let JSState::Loaded(loaded) = &mut ctx.state else {
            panic!("JS handle_request requires a loaded sandbox");
        };
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
