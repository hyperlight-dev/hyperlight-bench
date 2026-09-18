# Hyperlight HTTP Benchmarks

[View the dashboard](https://hyperlight-dev.github.io/hyperlight-bench/).

HTTP benchmarks and a results dashboard for Hyperlight.
Compare throughput, latency, and memory use across JavaScript and WebAssembly
runtimes on Linux KVM and MSHV.

Benchmarks cover three sandbox lifecycle strategies: Renew, Restore, and Reuse.

## Run The Dashboard

Requires Node.js 24 or later.

```sh
npm ci
npm run dev
```

Open the URL printed by the dev server. The dashboard loads published results.
Add `?demo=1` to explore it with synthetic data.

## Measure Locally

After installing the tools in the [development guide](docs/README.md#local-end-to-end):

```sh
just build-benchmark-artifacts
npm run benchmark:local -- --platform kvm
npm run dev:local
```

This measures all 54 KVM configurations and serves their results locally.
Add `--smoke` to verify every configuration with one measured request each.

## Documentation

* [Development guide](docs/README.md): setup, benchmark commands, CI, and deployment.
* [Result format](docs/results.md): measurements, history, and validation.

## Limitations and future work

This benchmark is intended to model a service that selects and executes customer code at request time to handle each incoming request.

The current implementation has some limitations:

* Each runtime configuration uses one fixed guest. A representative workload would provide multiple guests and select one based on the incoming request.
* Guest selection is not dynamic. Hyperlight JS uses one fixed source string. Hyperlight Wasm restores a snapshot prepared for one fixed module. Wasmtime compiles or deserializes one fixed component when each worker context is created. Each Restore then creates a fresh store and instance from that resident component, which explains the similar Wasmtime JIT and AOT performance.

Real services may have more customer code than fits in memory. They load artifacts from disk and evict inactive code from memory.

Future work should select guest code from each request and allow every worker to execute any selected guest. It should not require every artifact to remain resident. This would let the benchmark model caching strategies, such as keeping the top N customer artifacts in memory while loading others on demand, and produce more representative results.