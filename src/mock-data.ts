import type { Runner, RunBundle } from '../shared/results.ts'
import { benchmark, catalog, platforms, runtimes, runnerPools, strategies } from '../shared/catalog.ts'

function createRunners(runIndex: number): Runner[] {
  return platforms.map(platform => {
    const { sku, pool } = runnerPools[platform.id as keyof typeof runnerPools]
    return {
      id: `${platform.id}-runner`, platformId: platform.id,
      name: `${platform.id}-${runIndex + 1}`, job: `benchmark-${platform.id}`,
      pool,
      sku, expectedSku: sku, region: null,
      os: { name: 'Linux', version: null, architecture: 'x86_64' },
      cpu: { model: null, logicalProcessors: 8, cores: null, threadsPerCore: null },
      memoryBytes: 32 * 1024 ** 3,
      tools: {}, dependencies: {},
    }
  })
}

export function createMockBundles(): RunBundle[] {
  const messages = [
    'Initial benchmark baseline', 'Adjust request parsing', 'Tune worker allocation',
    'Update guest runtime', 'Reduce response allocations', 'Refresh dependency pins',
    'Tune sandbox restoration', 'Adjust memory reservation', 'Update Wasm compiler',
    'Reuse request buffers', 'Refresh runner image', 'Refine timeout handling',
    'Update sandbox snapshots', 'Update HTTP workload',
  ]
  const throughput = [184000, 138000, 47000, 38000, 5200, 69000, 97000, 74000, 112000, 88000, 123000, 141000, 7100, 135000, 8500, 13000, 46000, 59000]
  const memory = [22, 39, 68, 157, 91, 58, 34, 182, 79, 148, 65, 29, 72, 47, 45, 38, 28, 24]
  return messages.map((message, runIndex) => {
    const runners = createRunners(runIndex)
    const measurements: RunBundle['measurements'] = runtimes.flatMap((runtime, runtimeIndex) =>
    platforms.flatMap((platform, platformIndex) => strategies.map((strategy) => {
      const lifecycle = strategy === 'reload' ? 1 : strategy === 'reuse' ? 1.32 : 0.27
      const platformFactor = [1, 0.87][platformIndex]!
      const variation = 1 + Math.sin(runIndex * 0.91 + runtimeIndex * 1.7) * 0.035
      const progress = 1 + runIndex * (runtimeIndex % 3 === 0 ? 0.013 : 0.005)
      const rps = Math.round(throughput[runtimeIndex]! * lifecycle * platformFactor * variation * progress)
      const p50 = Number((18000 / rps).toFixed(3))
      return {
        id: `${runtime.id}-${platform.id}-${strategy}`, runnerId: `${platform.id}-runner`,
        runtimeId: runtime.id, strategy, status: 'success' as const,
        rawOutputs: [{ tool: 'fixture-generator', format: 'json' as const, content: { requestsPerSecond: rps } }],
        values: {
          rps, p50,
          p95: Number((p50 * 2.6).toFixed(3)),
          p9999: Number((p50 * (7.2 + Math.abs(Math.sin(runIndex)))).toFixed(3)),
          memory: Number((memory[runtimeIndex]! * (strategy === 'reuse' ? 1.2 : 1) * (1 + platformIndex * 0.08) * variation).toFixed(1)),
        },
      }
    })))
    return {
      schemaVersion: 1, source: 'synthetic',
      run: {
        id: `mock-run-${runIndex + 1}`, attempt: 1,
        createdAt: `2026-09-${String(runIndex + 1).padStart(2, '0')}T10:30:00Z`,
        workflow: { name: 'benchmark', url: null },
        commit: { sha: `f${(0x100001 + runIndex * 0x173a9).toString(16)}`.padEnd(40, '0'), tree: (runIndex + 1).toString(16).padStart(40, '0'), message, url: null },
      },
      catalog, benchmark,
      runners, measurements,
    }
  })
}