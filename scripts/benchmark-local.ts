import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { benchmark, catalog, runnerPools, runtimes, strategies } from '../shared/catalog.ts'
import { historyRunPath, parseRunBundle, validateCompleteRun } from '../shared/results.ts'
import { runnerMetadata } from './runner-metadata.ts'

process.chdir(resolve(import.meta.dirname, '..'))
const { values } = parseArgs({ options: {
  platform: { type: 'string', default: 'kvm' },
  runtime: { type: 'string' },
  duration: { type: 'string' },
  concurrency: { type: 'string' },
  'client-timeout': { type: 'string' },
  smoke: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} })

async function main() {
  if (values.help) {
    console.log('Usage: npm run benchmark:local -- [--platform kvm|mshv3] [--runtime ID] [--smoke | --duration SECONDS --concurrency N --client-timeout SECONDS]')
    return
  }
  const platform = values.platform as keyof typeof runnerPools
  if (!Object.hasOwn(runnerPools, platform)) throw new Error(`Unknown platform: ${platform}`)
  const selected = values.runtime ? runtimes.filter(runtime => runtime.id === values.runtime) : runtimes
  if (!selected.length) throw new Error(`Unknown runtime: ${values.runtime}`)
  const positive = (input: string | undefined, fallback: number, name: string) => {
    const value = input === undefined ? fallback : Number(input)
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
    return value
  }
  if (values.smoke && (values.duration || values.concurrency || values['client-timeout'])) throw new Error('Smoke mode cannot be combined with load settings')
  const settings = {
    ...benchmark.settings,
    durationSeconds: values.smoke ? 0 : positive(values.duration, benchmark.settings.durationSeconds, 'Duration'),
    concurrency: values.smoke ? 1 : positive(values.concurrency, benchmark.settings.concurrency, 'Concurrency'),
    clientTimeoutSeconds: values.smoke ? 120 : positive(values['client-timeout'], benchmark.settings.clientTimeoutSeconds, 'Client timeout'),
    ...(values.smoke ? { requestCount: 1 } : {}),
  }
  if (selected.some(runtime => runtime.id.startsWith('hyperlight-'))) {
    accessSync(platform === 'kvm' ? '/dev/kvm' : '/dev/mshv', constants.R_OK | constants.W_OK)
  }
  const runner = await runnerMetadata(platform, true)
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { encoding: 'utf8' })
    return result.status === 0 ? result.stdout.trim() : undefined
  }
  const sha = git(['rev-parse', 'HEAD'])
  const tree = git(['rev-parse', 'HEAD^{tree}'])
  const dirty = git(['status', '--porcelain'])
  const id = `local-${randomUUID()}`
  const directory = resolve('results/local', id)
  mkdirSync(directory, { recursive: true })
  const bundle = parseRunBundle({
    schemaVersion: 1, source: 'local',
    run: {
      id, attempt: 1, createdAt: new Date().toISOString(),
      workflow: { name: 'Local benchmark', url: null },
      commit: {
        sha: sha ?? '0'.repeat(40), tree: tree ?? '0'.repeat(40), url: null,
        message: sha ? `Local working tree${dirty ? ' (uncommitted changes)' : ''}` : 'Local unversioned source',
      },
    },
    catalog: { ...catalog, runtimes: selected, platforms: catalog.platforms.filter(entry => entry.id === platform) },
    benchmark: {
      ...benchmark,
      settings,
      expectedConfigurations: selected.flatMap(runtime => strategies.map(strategy => ({ runtimeId: runtime.id, platformId: platform, strategy }))),
    },
    runners: [runner], measurements: [],
  })
  const input = resolve(directory, 'input.json')
  writeFileSync(input, JSON.stringify(bundle, null, 2), { flag: 'wx' })
  const collected = structuredClone(bundle)
  collected.runners = []
  for (const [index, configuration] of bundle.benchmark.expectedConfigurations.entries()) {
    console.log(`[${index + 1}/${bundle.benchmark.expectedConfigurations.length}] ${platform} ${configuration.runtimeId} ${configuration.strategy}`)
    const result = spawnSync(process.execPath, [
      'scripts/benchmark.ts', '--platform', platform, '--runtime', configuration.runtimeId,
      '--strategy', configuration.strategy, '--local-bundle', input, '--output', directory,
    ], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Benchmark failed. Results retained in ${directory}`)
    const shard = parseRunBundle(JSON.parse(readFileSync(resolve(directory, `${platform}-${configuration.runtimeId}-${configuration.strategy}`, 'bundle.json'), 'utf8')))
    collected.runners.push(...shard.runners)
    collected.measurements.push(...shard.measurements)
  }
  const complete = validateCompleteRun(collected)
  const site = resolve('public/local-data')
  const path = resolve(site, historyRunPath(complete.run))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(complete, null, 2), { flag: 'wx' })
  const index = resolve(site, `${id}.json`)
  writeFileSync(index, JSON.stringify({ schemaVersion: 1, runs: [{ id, attempt: 1 }] }), { flag: 'wx' })
  renameSync(index, resolve(site, 'index.json'))
  console.log(`Validated ${complete.measurements.length} configurations. Raw results: ${directory}`)
  console.log('Run npm run dev:local to inspect this run.')
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})