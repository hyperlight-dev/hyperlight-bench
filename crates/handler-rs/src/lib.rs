use crate::exports::hyperlight::bench::handler_interface;

wit_bindgen::generate!({
    world: "handler-world",
    path: "../../js/src/wit/handler.wit",
});

struct Component;

impl handler_interface::Guest for Component {
    fn handleevent(mut request: handler_interface::Request) -> handler_interface::Request {
        request.uri = "/redirected.html".to_string();
        request
    }
}

export!(Component);
