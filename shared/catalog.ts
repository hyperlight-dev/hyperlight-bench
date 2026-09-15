import type { Metric, Platform, Runtime, Strategy } from './results.ts'

const definitions = [
  { id: 'dummy', engine: 'Native', description: 'Host-only baseline.' },
  { id: 'hyperlight-dummy', engine: 'Native', description: 'Minimal native Hyperlight guest.' },
  { id: 'hyperlight-js', engine: 'QuickJS', description: 'Native QuickJS inside Hyperlight.' },
  { id: 'hyperlight-wasm-jco', engine: 'StarlingMonkey', description: 'jco component, native AOT, inside Hyperlight.' },
  { id: 'hyperlight-wasm-pulley', engine: 'StarlingMonkey', description: 'jco component, Pulley interpreter, inside Hyperlight.' },
  { id: 'hyperlight-wasm-qjs', engine: 'QuickJS', description: 'QuickJS component, native AOT, inside Hyperlight.' },
  { id: 'hyperlight-wasm-dummy', engine: 'Rust', description: 'Rust Wasm component, native AOT, inside Hyperlight.' },
  { id: 'wasmtime-jco', engine: 'StarlingMonkey', description: 'jco component compiled at context creation.' },
  { id: 'wasmtime-qjs', engine: 'QuickJS', description: 'QuickJS component compiled at context creation.' },
  { id: 'wasmtime-aot-jco', engine: 'StarlingMonkey', description: 'Precompiled jco component in Wasmtime.' },
  { id: 'wasmtime-aot-qjs', engine: 'QuickJS', description: 'Precompiled QuickJS component in Wasmtime.' },
  { id: 'wasmtime-aot-dummy', engine: 'Rust', description: 'Precompiled Rust Wasm component in Wasmtime.' },
  { id: 'wasmtime-pulley-jco', engine: 'StarlingMonkey', description: 'jco component interpreted by Wasmtime Pulley.' },
  { id: 'wasmtime-dummy', engine: 'Rust', description: 'Rust Wasm component compiled at context creation.' },
  { id: 'hyperlight-wasm-pulley-qjs', engine: 'QuickJS', description: 'QuickJS component, Pulley interpreter, inside Hyperlight.' },
  { id: 'wasmtime-pulley-qjs', engine: 'QuickJS', description: 'QuickJS component interpreted by Wasmtime Pulley.' },
  { id: 'hyperlight-wasm-pulley-dummy', engine: 'Rust', description: 'Rust Wasm component, Pulley interpreter, inside Hyperlight.' },
  { id: 'wasmtime-pulley-dummy', engine: 'Rust', description: 'Rust Wasm component interpreted by Wasmtime Pulley.' },
]

export const runtimes: Runtime[] = definitions.map(runtime => ({
  ...runtime,
  execution: runtime.id === 'dummy' ? 'host' : ['hyperlight-dummy', 'hyperlight-js'].includes(runtime.id) ? 'native' : runtime.id.includes('pulley') ? 'wasm-pulley' : runtime.id.startsWith('hyperlight-wasm-') || runtime.id.startsWith('wasmtime-aot-') ? 'wasm-aot' : 'wasm-jit',
}))

export const platforms: Platform[] = [
  { id: 'kvm', label: 'KVM' },
  { id: 'mshv3', label: 'MSHV' },
]

export const runnerPools = {
  kvm: { pool: 'hld-kvm-amd', sku: 'Standard_D8ads_v6', os: 'linux' },
  mshv3: { pool: 'hld-azlinux3-mshv-amd', sku: 'Standard_D8as_v5', os: 'linux' },
} as const

export const metrics: Metric[] = [
  { id: 'rps', label: 'Throughput', title: 'HTTP requests per second', unit: 'req/s', direction: 'higher', methodVersion: 1 },
  { id: 'memory', label: 'Peak memory', title: 'Peak resident memory', unit: 'MiB', direction: 'lower', methodVersion: 2 },
  { id: 'p50', label: 'P50 latency', title: 'P50 request latency', unit: 'ms', direction: 'lower', methodVersion: 1 },
  { id: 'p95', label: 'P95 latency', title: 'P95 request latency', unit: 'ms', direction: 'lower', methodVersion: 1 },
  { id: 'p9999', label: 'P99.99 latency', title: 'P99.99 request latency', unit: 'ms', direction: 'lower', methodVersion: 1 },
]

export const strategies: Strategy[] = ['reload', 'reuse', 'new']
export const catalog = { runtimes, platforms, metrics }
export const benchmark = {
  id: 'http-redirect', version: 2,
  settings: {
    durationSeconds: 60, concurrency: 50, poolSize: 4, workerThreads: 'available-parallelism', workerReadiness: 'all-workers',
    sandboxTimeoutMs: 1000, timeoutCheckIntervalMs: 10, clientTimeoutSeconds: 30,
    memorySampleIntervalMs: 500, memorySampleAtShutdown: true, readinessRequests: 1, warmupRequests: 0,
    waitOngoingRequests: false, repetitions: 1, hyperlightAotMapping: 'linux-file-mapping-per-worker',
  },
  metricIds: metrics.map(metric => metric.id),
  expectedConfigurations: runtimes.flatMap(runtime => platforms.flatMap(platform => strategies.map(strategy => ({ runtimeId: runtime.id, platformId: platform.id, strategy })))),
}

export const publicationPolicy = {
  catalog, benchmark,
  expectedSkus: Object.fromEntries(Object.entries(runnerPools).map(([id, runner]) => [id, runner.sku])),
}

export const serverFlavor = (runtime: string) => runtime.startsWith('hyperlight-wasm-pulley') ? 'pulley' : 'native'