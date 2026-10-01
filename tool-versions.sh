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
# hyperlight-unikraft: the rootfs images fetched from GHCR, and the crate
# pinned by crates/server/Cargo.toml, must be the same release.
: "${HLUK_VERSION:=0.16.0}"
# The rootfs images of that release, by manifest digest: a tag can move,
# a digest cannot.  Update them with HLUK_VERSION.
: "${HLUK_DIGEST_QUICKJS:=sha256:4854f957957dc3570fbe552830d7d64a5b381ae4cf54ac3dffa44b704580e04c}"
: "${HLUK_DIGEST_NODE:=sha256:f9b081e644de58b08bb283a08610eaf5f31b54b22551dfa6ddfafb4345e81439}"
: "${HLUK_DIGEST_PYTHON:=sha256:b4b478524292b2c28dbdc6bffa921b299636527f6525d9261bea53bc3855f483}"
: "${HLUK_DIGEST_DOTNET_JIT:=sha256:c0ebc1a3854d7a303c05314c2cb75851252bc9257175de1bc2eb10cd8e0c1761}"
: "${HLUK_DIGEST_WASMTIME:=sha256:18278e8d272c45e4ac3e016fab78dff9b708fab7e65c30cd4e9ee8d4cddd4775}"
