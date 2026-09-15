import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { inspect, parseArgs } from 'node:util'
import { z } from 'zod'
import { benchmark, catalog, runnerPools, runtimes, serverFlavor } from '../shared/catalog.ts'
import { parseRunBundle, strategySchema, type RunBundle } from '../shared/results.ts'
import { runnerMetadata } from './runner-metadata.ts'

process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const { values } = parseArgs({ options: {
  platform: { type: 'string' }, runtime: { type: 'string' }, strategy: { type: 'string' },
  run: { type: 'string', default: 'artifacts/run.json' }, output: { type: 'string', default: 'results' },
  'local-bundle': { type: 'string' },
} })
const platform = values.platform as keyof typeof runnerPools
if (!Object.hasOwn(runnerPools, platform)) throw new Error(`Unknown platform: ${platform}`)
const runtime = runtimes.find(entry => entry.id === values.runtime)
if (!runtime) throw new Error(`Unknown runtime: ${values.runtime}`)
const strategy = strategySchema.parse(values.strategy)
const configuration = `${platform}-${runtime.id}-${strategy}`
const directory = resolve(values.output, configuration)
mkdirSync(directory, { recursive: true })
const local = values['local-bundle'] ? parseRunBundle(JSON.parse(readFileSync(values['local-bundle'], 'utf8'))) : undefined
if (local && local.source !== 'local') throw new Error('Local collection requires a local bundle')
const run = local?.run ?? JSON.parse(readFileSync(values.run, 'utf8')) as RunBundle['run']
if (!local && process.env.GITHUB_ACTIONS) {
  if (run.id !== process.env.GITHUB_RUN_ID || run.commit.sha !== process.env.GITHUB_SHA) throw new Error('Run identity differs from the current workflow')
  run.attempt = z.coerce.number().int().positive().parse(process.env.GITHUB_RUN_ATTEMPT)
  run.workflow.url = `https://github.com/${run.pullRequest!.repository}/actions/runs/${run.id}/attempts/${run.attempt}`
}
const executable = resolve('artifacts/bin', serverFlavor(runtime.id), 'http-bench')
const oha = 'oha'
const runner = await runnerMetadata(platform, !!local)
runner.id = configuration
const bundle = parseRunBundle({ schemaVersion: 1, source: local ? 'local' : 'published', run, catalog: local?.catalog ?? catalog, benchmark: local?.benchmark ?? benchmark, runners: [runner], measurements: [] })
const rawOutputs: RunBundle['measurements'][number]['rawOutputs'] = []
const memoryPath = resolve(directory, 'memory.json')
const performancePath = resolve(directory, 'oha.json')
for (const path of [memoryPath, performancePath, resolve(directory, 'bundle.json')]) rmSync(path, { force: true })
const log = createWriteStream(resolve(directory, 'server.log'))
const cancellation = new AbortController()
const interrupt = () => cancellation.abort(new Error('Benchmark interrupted'))
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)

async function bounded<Value>(promise: Promise<Value>, milliseconds: number, message: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${message} after ${milliseconds}ms`)), milliseconds)
    })])
  } finally {
    clearTimeout(timer!)
  }
}

function closed(child: ChildProcess) {
  return new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`${child.spawnfile} terminated by ${signal}`))
      else resolve(code)
    })
  })
}

let server: ChildProcess | undefined
let serverClosed: Promise<number | null> | undefined
let load: ChildProcess | undefined
let loadClosed: Promise<number | null> | undefined
try {
  const settings = {
    ...benchmark.settings,
    ...z.object({
      durationSeconds: z.number().int().nonnegative(),
      concurrency: z.number().int().positive(),
      clientTimeoutSeconds: z.number().int().positive().nullable(),
      requestCount: z.literal(1).optional(),
    }).parse(bundle.benchmark.settings),
  }
  server = spawn(executable, [
    '--runtime', runtime.id, '--strategy', strategy, '--port', '0', '--pool-size', String(settings.poolSize),
    '--with-timeout', '--timeout-ms', String(settings.sandboxTimeoutMs),
    '--timeout-check-interval-ms', String(settings.timeoutCheckIntervalMs),
    '--shutdown-stdin', '--memory-output', memoryPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  serverClosed = closed(server)
  serverClosed.catch(() => {})
  server.stdin!.on('error', () => {})
  server.stdout!.pipe(log, { end: false })
  server.stderr!.pipe(log, { end: false })
  server.stderr!.pipe(process.stderr, { end: false })
  const lines = createInterface({ input: server.stdout! })
  const readySchema = z.object({ event: z.literal('ready'), pid: z.number().int(), port: z.number().int().positive().max(65535), workerThreads: z.number().int().positive(), poolSize: z.literal(settings.poolSize) })
  const ready = new Promise<z.infer<typeof readySchema>>(resolve => {
    lines.on('line', line => {
      try {
        const result = readySchema.safeParse(JSON.parse(line))
        if (result.success && result.data.pid === server!.pid) resolve(result.data)
      } catch {}
    })
  })
  const aborted = new Promise<never>((_, reject) => cancellation.signal.addEventListener('abort', () => reject(cancellation.signal.reason), { once: true }))
  aborted.catch(() => {})
  const unexpectedExit = serverClosed.then(code => { throw new Error(`Server exited before measurement completed: ${code}`) })
  unexpectedExit.catch(() => {})
  const readyMessage = await bounded(Promise.race([ready, unexpectedExit, aborted]), 120000, 'Server readiness timed out')
  lines.close()
  runner.allocation = { workerThreads: readyMessage.workerThreads, poolSize: readyMessage.poolSize, affinity: 'os-default' }
  bundle.runners[0] = runner
  const url = `http://127.0.0.1:${readyMessage.port}/`
  const response = await fetch(url, { signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(120000)]) })
  if (response.status !== 200) throw new Error(`Readiness request returned ${response.status}`)
  z.object({ uri: z.literal('/redirected.html') }).parse(await response.json())
  const limit = settings.requestCount ? ['-n', String(settings.requestCount)] : ['-z', `${settings.durationSeconds}s`]
  if (settings.requestCount && settings.clientTimeoutSeconds === null) throw new Error('Request-count runs require a client timeout')
  const clientTimeout = settings.clientTimeoutSeconds === null ? [] : ['-t', `${settings.clientTimeoutSeconds}s`]
  load = spawn(oha, [url, ...limit, '-c', String(settings.concurrency), ...clientTimeout, '--no-tui', '--output-format', 'json', '--output', performancePath], { stdio: ['ignore', 'inherit', 'inherit'] })
  loadClosed = closed(load)
  loadClosed.catch(() => {})
  const exitCode = await bounded(Promise.race([loadClosed, unexpectedExit, aborted]), ((settings.requestCount ? settings.clientTimeoutSeconds! : settings.durationSeconds) + 60) * 1000, 'Load generator timed out')
  if (exitCode !== 0) throw new Error(`oha exited with ${exitCode}`)
  server.stdin!.end('shutdown\n')
  const shutdownCode = await bounded(serverClosed, 10000, 'Server shutdown timed out')
  if (shutdownCode !== 0) throw new Error(`Server shutdown failed with exit code ${shutdownCode}`)
  const performance = JSON.parse(readFileSync(performancePath, 'utf8'))
  rawOutputs.push({ tool: 'oha', format: 'json', content: performance })
  const requestDetails = `HTTP statuses: ${JSON.stringify(performance?.statusCodeDistribution)}. Request errors: ${JSON.stringify(performance?.errorDistribution)}. Client timeout: ${settings.clientTimeoutSeconds === null ? 'unlimited' : `${settings.clientTimeoutSeconds}s`}. Concurrency: ${settings.concurrency}.`
  const nonnegative = z.number().finite().nonnegative()
  const parsedReport = z.object({
    summary: z.object({ requestsPerSec: nonnegative.positive() }),
    latencyPercentiles: z.object({ p50: nonnegative, p95: nonnegative, 'p99.99': nonnegative }),
    statusCodeDistribution: z.record(z.string(), nonnegative.int()), errorDistribution: z.record(z.string(), nonnegative.int()),
  }).safeParse(performance)
  if (!parsedReport.success) throw new Error(`Invalid oha report. ${requestDetails}`, { cause: parsedReport.error })
  const report = parsedReport.data
  if (!report.statusCodeDistribution['200'] || Object.entries(report.statusCodeDistribution).some(([status, count]) => status !== '200' && count > 0)) throw new Error(`Unexpected HTTP status distribution. ${requestDetails}`)
  if (Object.entries(report.errorDistribution).some(([error, count]) => count > 0 && error !== 'aborted due to deadline')) throw new Error(`Request errors occurred. ${requestDetails}`)
  if ((report.errorDistribution['aborted due to deadline'] ?? 0) > settings.concurrency) throw new Error(`Deadline cancellations exceed concurrency. ${requestDetails}`)
  const memory = JSON.parse(readFileSync(memoryPath, 'utf8'))
  rawOutputs.push({ tool: 'sysinfo', format: 'json', content: memory })
  const peak = z.array(z.object({ name: z.literal('Peak Resident Memory Usage'), unit: z.literal('bytes'), value: nonnegative.positive() })).length(1).parse(memory)[0]!
  bundle.measurements.push({
    id: configuration, runnerId: runner.id, runtimeId: runtime.id, strategy, status: 'success', rawOutputs,
    values: { rps: report.summary.requestsPerSec, memory: peak.value / 1024 ** 2, p50: report.latencyPercentiles.p50 * 1000, p95: report.latencyPercentiles.p95 * 1000, p9999: report.latencyPercentiles['p99.99'] * 1000 },
  })
} catch (error) {
  console.error(`Benchmark failed: ${configuration}`, error)
  const reason = error instanceof Error && error.cause === undefined ? String(error) : inspect(error, { depth: 5, colors: false })
  if (process.env.GITHUB_ACTIONS) {
    const message = reason.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
    console.error(`::error::${configuration}: ${message}`)
  }
  bundle.measurements.push({ id: configuration, runnerId: runner.id, runtimeId: runtime.id, strategy, status: 'failed', reason, rawOutputs })
  process.exitCode = 1
} finally {
  if (load && load.exitCode === null && load.signalCode === null) load.kill()
  if (loadClosed) await bounded(loadClosed, 10000, 'Load cleanup timed out').catch(error => {
    console.error('Load cleanup failed', error)
    process.exitCode = 1
    load?.kill('SIGKILL')
  })
  if (server && server.exitCode === null && server.signalCode === null) {
    server.stdin?.end('shutdown\n')
    await bounded(serverClosed!, 10000, 'Server cleanup timed out').catch(async error => {
      console.error('Server cleanup failed', error)
      process.exitCode = 1
      server!.kill('SIGKILL')
      await serverClosed!.catch(() => null)
    })
  }
  log.end()
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  for (const [tool, path] of [['oha', performancePath], ['sysinfo', memoryPath]] as const) {
    if (rawOutputs.some(output => output.tool === tool) || !existsSync(path)) continue
    try {
      const content = readFileSync(path, 'utf8')
      try {
        rawOutputs.push({ tool, format: 'json', content: JSON.parse(content) })
      } catch {
        rawOutputs.push({ tool, format: 'text', content })
      }
    } catch (error) {
      console.error(`Failed to retain ${tool} output at ${path}`, error)
    }
  }
  writeFileSync(resolve(directory, 'bundle.json'), `${JSON.stringify(parseRunBundle(bundle), null, 2)}\n`)
}