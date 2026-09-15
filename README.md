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