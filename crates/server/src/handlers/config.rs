use super::PerStrategy;

pub const JCO_WASM: &str = "./js/default/handler.wasm";
pub const JCO_AOT: &str = "./js/default/handler.aot";
pub const JCO_PULLEY: &str = "./js/pulley/handler.aot";
pub const QJS_WASM: &str = "./js/componentize-qjs/handler.wasm";
pub const QJS_AOT: &str = "./js/componentize-qjs/handler.aot";
pub const QJS_PULLEY: &str = "./js/componentize-qjs/handler.pulley.aot";
pub const RUST_WASM: &str = "./crates/handler-rs/target/wasm32-wasip2/release/handler_rs.wasm";
pub const RUST_AOT: &str = "./crates/handler-rs/target/wasm32-wasip2/release/handler_rs.aot";
pub const RUST_PULLEY: &str = "./crates/handler-rs/target/wasm32-wasip2/release/handler_rs.pulley.aot";

#[derive(Copy, Clone)]
pub struct SandboxMemory {
    pub heap: u64,
    pub scratch: PerStrategy<usize>,
}

pub const JCO_MEMORY: SandboxMemory = SandboxMemory {
    heap: 1280 * 1024,
    scratch: PerStrategy {
        new: 1280 * 1024,
        reload: 1280 * 1024,
        reuse: 1024 * 1024 * 1024,
    },
};

pub const JCO_PULLEY_MEMORY: SandboxMemory = SandboxMemory {
    heap: 1792 * 1024,
    scratch: PerStrategy {
        new: 1792 * 1024,
        reload: 1792 * 1024,
        reuse: 48 * 1024 * 1024,
    },
};

pub const QJS_MEMORY: SandboxMemory = SandboxMemory {
    heap: 128 * 1024,
    scratch: PerStrategy::uniform(512 * 1024),
};

pub const RUST_MEMORY: SandboxMemory = SandboxMemory {
    heap: 128 * 1024,
    scratch: PerStrategy::uniform(512 * 1024),
};