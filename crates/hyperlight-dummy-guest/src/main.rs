#![no_std]
#![no_main]

extern crate alloc;

use alloc::string::String;
use hyperlight_guest::error::Result;
use hyperlight_guest_bin::guest_function;

#[guest_function]
fn handle_request(req: String) -> Result<String> {
    assert_eq!(req, r#"{"uri": "/index.html"}"#);
    Ok(String::from(r#"{"uri":"/redirected.html"}"#))
}
