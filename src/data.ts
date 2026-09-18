import { groupHistories, historyIndexSchema, historyRunPath, parseHistoryRun, parseRunBundle, runKey, validateHistory } from '../shared/results.ts'
import type { HistoryIndex, Metric, Platform, Runner, Runtime, RunBundle, Strategy } from '../shared/results.ts'

export type { Metric, Platform, Runtime, Strategy } from '../shared/results.ts'
export type PlatformId = string
export type MetricId = string

export interface Run {
  id: string
  commit: string
  message: string
  date: string
  commitUrl?: string
  runners: Runner[]
  bundle: RunBundle
}

export interface Measurement {
  runId: string
  runtimeId: string
  platformId: PlatformId
  runnerId: string
  strategy: Strategy
  values: Record<MetricId, number>
}

export interface Dataset {
  schemaVersion: 1
  source: RunBundle['source']
  runtimes: Runtime[]
  platforms: Platform[]
  metrics: Metric[]
  runs: Run[]
  measurements: Measurement[]
  preview?: HistoryIndex['preview']
  histories?: { id: string, label: string }[]
  historyId?: string
}

function datasetFromHistories(histories: RunBundle[][]): Dataset {
  const datasets = histories.map(datasetFromBundles)
  if (datasets.length === 1) return datasets[0]!

  const bundles = histories.flat().sort((first, second) => first.run.createdAt.localeCompare(second.run.createdAt) || runKey(first).localeCompare(runKey(second)))
  const runtimes = new Map<string, Runtime>()
  const platforms = new Map<string, Platform>()
  const metrics = new Map<string, Metric>()
  for (const bundle of bundles) {
    for (const runtime of bundle.catalog.runtimes) runtimes.set(runtime.id, runtime)
    for (const platform of bundle.catalog.platforms) platforms.set(platform.id, platform)
    for (const metric of bundle.catalog.metrics) {
      const previous = metrics.get(metric.id)
      if (previous && (previous.unit !== metric.unit || previous.direction !== metric.direction)) {
        throw new Error(`Benchmark versions use incompatible definitions for metric ${metric.id}`)
      }
      metrics.set(metric.id, metric)
    }
  }
  return {
    schemaVersion: 1,
    source: datasets[0]!.source,
    runtimes: [...runtimes.values()],
    platforms: [...platforms.values()],
    metrics: [...metrics.values()],
    runs: datasets.flatMap(dataset => dataset.runs).sort((first, second) => first.date.localeCompare(second.date) || first.id.localeCompare(second.id)),
    measurements: datasets.flatMap(dataset => dataset.measurements),
  }
}

export async function loadDataset(): Promise<Dataset | null> {
  if (new URLSearchParams(location.search).get('demo') === '1') {
    const { createMockBundles } = await import('./mock-data')
    return datasetFromBundles(createMockBundles())
  }
  const indexUrl = new URL(import.meta.env.VITE_HISTORY_URL || 'https://raw.githubusercontent.com/hyperlight-dev/hyperlight-bench/data/index.json', location.href)
  const params = new URLSearchParams(location.search)
  return loadHistory(indexUrl, params.get('history') ?? undefined, params.get('run') ?? undefined)
}

export async function loadHistory(indexUrl: URL, selectedHistory?: string, selectedRun?: string): Promise<Dataset | null> {
  async function readJson(url: URL): Promise<unknown> {
    const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`Unable to load ${url}: HTTP ${response.status}`)
    return response.json()
  }
  const index = historyIndexSchema.parse(await readJson(indexUrl))
  if (!index.runs.length) {
    return index.preview ? { schemaVersion: 1, source: 'published', runtimes: [], platforms: [], metrics: [], runs: [], measurements: [], preview: index.preview } : null
  }
  const bundles: RunBundle[] = []
  for (let offset = 0; offset < index.runs.length; offset += 8) {
    const batch = await Promise.all(index.runs.slice(offset, offset + 8).map(async entry => {
      const input = await readJson(new URL(historyRunPath(entry), indexUrl))
      return parseHistoryRun(input, entry, true)
    }))
    bundles.push(...batch)
  }
  if (index.preview?.pending) {
    const pending = bundles.find(bundle => bundle.run.id === index.preview!.pending!.id && bundle.run.attempt === index.preview!.pending!.attempt)!
    if (pending.run.pullRequest?.number !== index.preview.number || pending.run.pullRequest.head !== index.preview.head) {
      throw new Error('Pending results differ from the preview revision')
    }
  }
  const groups = groupHistories(bundles)
  const containing = (key: string | undefined) => groups.find(group => group.some(bundle => runKey(bundle) === key))
  const pending = index.preview?.pending
  const requestedVersions = selectedHistory?.split(',')
  if (requestedVersions?.some(version => !version) || requestedVersions && new Set(requestedVersions).size !== requestedVersions.length) {
    throw new Error(`Invalid benchmark version selection: ${selectedHistory}`)
  }
  const requested = requestedVersions?.map(version => {
    const group = groups.find(candidate => String(candidate[0]!.benchmark.version) === version)
    if (!group) throw new Error(`Benchmark version not found: ${version}`)
    return group
  })
  const selected = requested ?? [containing(selectedRun) ?? containing(pending ? `${pending.id}.${pending.attempt}` : undefined) ?? groups[0]!]
  const dataset = datasetFromHistories(selected)
  for (const run of dataset.runs) {
    const display = index.runs.find(entry => `${entry.id}.${entry.attempt}` === run.id)?.displayCommit
    if (display) {
      run.commit = display.sha.slice(0, 7)
      run.message = display.message
      run.commitUrl = display.url
    }
  }
  return {
    ...dataset,
    preview: index.preview,
    historyId: selected.map(group => group[0]!.benchmark.version).join(','),
    histories: groups.map((group, index) => {
      const latest = group.at(-1)!
      const settings = latest.benchmark.settings
      const load = settings.requestCount ? `${settings.requestCount} request` : `${settings.durationSeconds}s`
      return {
        id: String(group[0]!.benchmark.version),
        label: `${latest.benchmark.id} v${latest.benchmark.version} / ${load} / ${settings.concurrency} connections / ${latest.run.createdAt.slice(0, 10)} / ${index + 1}`,
      }
    }),
  }
}

export function datasetFromBundles(inputs: unknown[]): Dataset {
  const bundles = inputs.map(parseRunBundle).sort((first, second) => first.run.createdAt.localeCompare(second.run.createdAt) || runKey(first).localeCompare(runKey(second)))
  return {
    schemaVersion: 1,
    ...validateHistory(bundles),
    runs: bundles.map(bundle => ({
      id: runKey(bundle),
      commit: bundle.run.commit.sha.slice(0, 7),
      message: bundle.run.commit.message,
      date: bundle.run.createdAt,
      commitUrl: bundle.run.commit.url ?? undefined,
      runners: bundle.runners,
      bundle,
    })),
    measurements: bundles.flatMap(bundle => bundle.measurements.flatMap(measurement => {
      if (measurement.status !== 'success') return []
      const runner = bundle.runners.find(entry => entry.id === measurement.runnerId)!
      return [{ runId: runKey(bundle), runtimeId: measurement.runtimeId, platformId: runner.platformId, runnerId: runner.id, strategy: measurement.strategy, values: measurement.values }]
    })),
  }
}