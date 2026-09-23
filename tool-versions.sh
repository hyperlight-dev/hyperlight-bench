: "${WASM_TOOLS_MIN_VERSION:=1.259.0}"
: "${CARGO_HYPERLIGHT_VERSION:=0.1.14}"
: "${OHA_VERSION:=1.9.0}"

# Must use the Wasmtime version pinned by crates/server/Cargo.toml.
: "${HYPERLIGHT_WASM_AOT_VERSION:=0.15.0}"
: "${HYPERLIGHT_WASM_AOT_GIT_URL:=https://github.com/hyperlight-dev/hyperlight-wasm}"
: "${HYPERLIGHT_WASM_AOT_GIT_REV:=}"

: "${COMPONENTIZE_QJS_VERSION:=0.3.0}"
: "${COMPONENTIZE_QJS_GIT_URL:=https://github.com/andreiltd/componentize-qjs}"
: "${COMPONENTIZE_QJS_GIT_REV:=}"