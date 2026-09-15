fn main() {
    // re-run when WIT_WORLD changes, or the file to which it points changes
    println!("cargo:rerun-if-env-changed=WIT_WORLD");
    if let Ok(path) = std::env::var("WIT_WORLD") {
        println!("cargo:rerun-if-changed={}", path);
    } else {
        panic!("WIT_WORLD not set");
    }
}
