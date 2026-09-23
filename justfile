default:
    @just --list

# Install the pinned benchmark build and load tools.
setup-tools:
    scripts/setup-tools.sh

# Install the pinned load tool.
setup-bench-tools:
    scripts/setup-tools.sh --bench-only

# Generate the binary WIT interface used by Rust bindings.
build-handler-wit:
    node scripts/build-harness.ts wit

# Build the StarlingMonkey Wasm component with jco.
build-jco-wasm:
    node scripts/build-harness.ts jco

# Build the QuickJS Wasm component with componentize-qjs.
build-qjs-wasm:
    node scripts/build-harness.ts qjs

# Install the toolchain for the Rust Wasm component.
setup-rust-wasm-toolchain:
    rustup install nightly-2026-02-16
    rustup component add rust-src --toolchain nightly-2026-02-16
    rustup target add wasm32-wasip2 --toolchain nightly-2026-02-16

# Build the Rust Wasm component with the installed nightly toolchain.
build-rust-wasm:
    node scripts/build-harness.ts rust-wasm

# Compile an existing Wasm component to native AOT at the supplied path.
compile-native-aot wasm-input aot-output:
    node scripts/build-harness.ts compile-native-aot "{{wasm-input}}" "{{aot-output}}"

# Compile an existing Wasm component to Pulley AOT at the supplied path.
compile-pulley-aot wasm-input aot-output:
    node scripts/build-harness.ts compile-pulley-aot "{{wasm-input}}" "{{aot-output}}"

# Build the native Hyperlight baseline guest.
build-hyperlight-dummy-guest:
    node scripts/build-harness.ts dummy

# Build every guest component and its native/Pulley AOT artifacts.
build-benchmark-inputs:
    node scripts/build-harness.ts inputs

# Build and retain both native and Pulley server binaries.
build-server-binaries:
    node scripts/build-harness.ts servers

# Build the native server with optional Cargo features such as time_phases.
build-native-server extra-features="":
    node scripts/build-harness.ts servers native "{{extra-features}}"

# Build the Pulley server with optional Cargo features such as time_phases.
build-pulley-server extra-features="":
    node scripts/build-harness.ts servers pulley "{{extra-features}}"

# Build all benchmark inputs and both server binaries.
build-benchmark-artifacts:
    node scripts/build-harness.ts all

# Start a built server. Hyperlight Pulley runtime IDs select the Pulley binary.
run-server runtime strategy:
    ./artifacts/bin/{{ if runtime =~ '^hyperlight-wasm-pulley' { 'pulley' } else { 'native' } }}/http-bench --runtime "{{runtime}}" --strategy "{{strategy}}"

# Send HTTP load to an existing server and wait for in-flight requests.
run-http-load url="http://127.0.0.1:3000" duration="10s" output="perf.json":
    oha "{{url}}" -z "{{duration}}" --output "{{output}}" --output-format json --wait-ongoing-requests-after-deadline

# Build servers and run a local benchmark. Guest artifacts must already exist.
run-local-benchmark runtime strategy timeout-ms="1000" timeout-check-interval-ms="10" duration="60s":
    #!/usr/bin/env bash
    set -e

    # Validate strategy
    case "{{strategy}}" in
        new|reload|reuse)
            ;;
        *)
            echo "Error: Invalid strategy '{{strategy}}'. Must be one of: new, reload, reuse"
            exit 1
            ;;
    esac

    just build-server-binaries
    # launch server in background and capture PID

    export TIMEOUT='--with-timeout --timeout-ms={{timeout-ms}} --timeout-check-interval-ms={{timeout-check-interval-ms}}'
    ./artifacts/bin/{{ if runtime =~ '^hyperlight-wasm-pulley' { 'pulley' } else { 'native' } }}/http-bench --runtime "{{runtime}}" --strategy "{{strategy}}" $TIMEOUT &

    SERVER_PID=$!

    # wait for server to start on http://127.0.0.1:3000
    timeout=120
    sleep_interval=2
    elapsed=0
    while ! curl -s http://127.0.0.1:3000 > /dev/null; do 
        if ! kill -0 $SERVER_PID 2>/dev/null; then
            set +e
            wait $SERVER_PID
            STATUS=$?
            set -e
            echo "Server exited during startup with status $STATUS" >&2
            if [ $STATUS -eq 0 ]; then
                STATUS=1
            fi
            exit $STATUS
        fi
        sleep $sleep_interval
        elapsed=$((elapsed + sleep_interval))
        if [ $elapsed -ge $timeout ]; then
            echo "Server failed to start within $timeout seconds"
            kill -INT $SERVER_PID
            exit 1
        fi
    done
    # Run the load test while also watching for an unexpected server exit.
    oha http://127.0.0.1:3000 -z {{duration}} --no-tui --output-format json --output perf_{{ runtime }}_{{ strategy }}.json &
    LOAD_PID=$!

    set +e
    wait -n -p FINISHED_PID $SERVER_PID $LOAD_PID
    STATUS=$?
    set -e

    if [ "$FINISHED_PID" = "$SERVER_PID" ]; then
        echo "Server exited during benchmark with status $STATUS" >&2
        kill -INT $LOAD_PID 2>/dev/null || true
        wait $LOAD_PID 2>/dev/null || true
        if [ $STATUS -eq 0 ]; then
            STATUS=1
        fi
        exit $STATUS
    fi

    # The load generator finished first. Stop the server and propagate the
    # load generator's status.
    kill -INT $SERVER_PID
    wait $SERVER_PID || true
    exit $STATUS

# Remove compiled servers, guests, and generated component artifacts.
clean-build-artifacts:
    cargo clean
    cd crates/hyperlight-dummy-guest && cargo clean
    cd crates/handler-rs && cargo clean
    rm -f js/default/handler.aot js/default/handler.wasm js/pulley/handler.aot js/componentize-qjs/handler.aot js/componentize-qjs/handler.pulley.aot js/componentize-qjs/handler.wasm js/src/wit/handler_wit.wasm
    rm -f artifacts/bin/native/http-bench artifacts/bin/pulley/http-bench artifacts/build-info.json

# Remove root-level local benchmark summaries.
clean-local-benchmark-results:
    rm -f mem_*.json merged_*.json perf_*.json perf.json
