#![no_std]
#![no_main]

extern crate alloc;
extern crate hyperlight_guest_bin;

use alloc::string::String;
use alloc::vec::Vec;

use hyperlight_common::flatbuffer_wrappers::function_call::FunctionCall;
use hyperlight_common::flatbuffer_wrappers::guest_error::ErrorCode;
use hyperlight_guest::bail;
use hyperlight_guest::error::Result;

#[hyperlight_guest_bin::guest_function("handle_request")]
fn handle_request(req: String) -> Result<String> {
    assert_eq!(req, r#"{"uri": "/index.html"}"#);
    Ok(String::from(r#"{"uri":"/redirected.html"}"#))
}

#[unsafe(no_mangle)]
pub extern "C" fn hyperlight_main() {}

#[unsafe(no_mangle)]
pub fn guest_dispatch_function(function_call: FunctionCall) -> Result<Vec<u8>> {
    let function_name = function_call.function_name;
    bail!(ErrorCode::GuestFunctionNotFound => "{function_name}");
}

#[unsafe(no_mangle)]
pub extern "C" fn srand(_seed: u32) {}
