import { z } from 'zod'

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)
const text = z.string().trim().min(1)
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const timestamp = z.iso.datetime()
const httpUrl = z.url({ protocol: /^https?$/ })
const jsonRecord = z.record(text, z.json())

export const pullRequestSchema = z.object({
  repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  number: positiveInteger,
  head: sha,
  base: sha,
})

export const strategySchema = z.enum(['reload', 'reuse', 'new'])
export const runtimeSchema = z.looseObject({
  id: identifier,
  engine: text,
  description: text,
  execution: z.enum(['host', 'native', 'wasm-jit', 'wasm-aot', 'wasm-pulley']),
})
export const platformSchema = z.looseObject({ id: identifier, label: text })
export const metricSchema = z.looseObject({
  id: identifier,
  label: text,
  title: text,
  unit: text,
  direction: z.enum(['higher', 'lower']),
  methodVersion: positiveInteger,
})
const configurationSchema = z.looseObject({
  runtimeId: identifier,
  platformId: identifier,
  strategy: strategySchema,
})
export const runnerSchema = z.looseObject({
  id: identifier,
  platformId: identifier,
  name: text,
  job: text,
  pool: text,
  sku: text,
  expectedSku: text,
  region: text.nullable(),
  os: z.looseObject({ name: text, version: text.nullable(), architecture: text }),
  cpu: z.looseObject({
    model: text.nullable(),
    logicalProcessors: positiveInteger,
    cores: positiveInteger.nullable(),
    threadsPerCore: positiveInteger.nullable(),
  }),
  memoryBytes: positiveInteger,
  tools: z.record(text, text),
  dependencies: z.record(text, text),
})
const resultFields = {
  id: identifier,
  runnerId: identifier,
  runtimeId: identifier,
  strategy: strategySchema,
  rawOutputs: z.array(z.looseObject({
    tool: text,
    format: z.enum(['json', 'text']),
    content: z.json(),
  })),
}
export const measurementSchema = z.discriminatedUnion('status', [
  z.looseObject({ ...resultFields, status: z.literal('success'), values: z.record(identifier, z.number().nonnegative()) }),
  z.looseObject({ ...resultFields, status: z.literal('failed'), reason: text }),
  z.looseObject({ ...resultFields, status: z.literal('skipped'), reason: text }),
])

const bundleSchema = z.looseObject({
  schemaVersion: z.literal(1),
  source: z.enum(['synthetic', 'published', 'local']),
  run: z.looseObject({
    id: identifier,
    attempt: positiveInteger,
    createdAt: timestamp,
    workflow: z.looseObject({ name: text, url: httpUrl.nullable() }),
    commit: z.looseObject({ sha, tree: sha, message: text, url: httpUrl.nullable() }),
    pullRequest: pullRequestSchema.optional(),
  }),
  catalog: z.looseObject({
    runtimes: z.array(runtimeSchema).min(1),
    platforms: z.array(platformSchema).min(1),
    metrics: z.array(metricSchema).min(1),
  }),
  benchmark: z.looseObject({
    id: identifier,
    version: positiveInteger,
    settings: jsonRecord,
    metricIds: z.array(identifier).min(1),
    expectedConfigurations: z.array(configurationSchema).min(1),
  }),
  runners: z.array(runnerSchema).min(1),
  measurements: z.array(measurementSchema),
})

export type Runtime = z.infer<typeof runtimeSchema>
export type Platform = z.infer<typeof platformSchema>
export type Metric = z.infer<typeof metricSchema>
export type Runner = z.infer<typeof runnerSchema>
export type Strategy = z.infer<typeof strategySchema>
export type RunBundle = z.infer<typeof bundleSchema>
export type Configuration = z.infer<typeof configurationSchema>

const configurationKey = (entry: Configuration) => `${entry.runtimeId}/${entry.platformId}/${entry.strategy}`

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([first], [second]) => first.localeCompare(second)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const runKey = (bundle: RunBundle) => `${bundle.run.id}.${bundle.run.attempt}`

export const historyIndexSchema = z.object({
  schemaVersion: z.literal(1),
  runs: z.array(z.object({
    id: identifier, attempt: positiveInteger,
    displayCommit: z.object({ sha, message: text, url: httpUrl }).optional(),
  })),
  preview: z.object({
    number: positiveInteger,
    head: sha,
    pending: z.object({ id: identifier, attempt: positiveInteger }).nullable(),
  }).optional(),
}).superRefine((index, context) => {
  const keys = index.runs.map(run => `${run.id}.${run.attempt}`)
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate run and attempt in history' })
  }
  if (index.preview?.pending && !keys.includes(`${index.preview.pending.id}.${index.preview.pending.attempt}`)) {
    context.addIssue({ code: 'custom', message: 'Pending preview run is missing from history' })
  }
})

export type HistoryIndex = z.infer<typeof historyIndexSchema>

export const publicationSchema = z.object({
  schemaVersion: z.literal(1),
  run: historyIndexSchema.shape.runs.element,
  pullRequest: pullRequestSchema,
  merge: z.object({ sha, tree: sha, mergedAt: timestamp, message: text }),
})

export function validatePublication(bundle: RunBundle, input: unknown) {
  const publication = publicationSchema.parse(input)
  if (bundle.source !== 'published') throw new Error('Publication requires measured results')
  if (bundle.run.id !== publication.run.id || bundle.run.attempt !== publication.run.attempt) {
    throw new Error('Publication references a different run or attempt')
  }
  if (!bundle.run.pullRequest || canonicalJson(bundle.run.pullRequest) !== canonicalJson(publication.pullRequest)) {
    throw new Error('Publication PR revisions differ from the measured run')
  }
  if (bundle.run.commit.tree !== publication.merge.tree) {
    throw new Error('Merged source tree differs from the measured source tree')
  }
  const repositoryUrl = `https://github.com/${publication.pullRequest.repository}`
  if (bundle.run.workflow.url !== `${repositoryUrl}/actions/runs/${bundle.run.id}/attempts/${bundle.run.attempt}`
    || bundle.run.commit.url !== `${repositoryUrl}/commit/${bundle.run.commit.sha}`) {
    throw new Error('Measured run URLs differ from the publication repository and execution')
  }
  return publication
}

export function historyRunPath(run: HistoryIndex['runs'][number]): string {
  return `runs/${run.id}/${run.attempt}.json`
}

export function parseHistoryRun(input: unknown, entry: HistoryIndex['runs'][number], allowLocal = false): RunBundle {
  const bundle = validateCompleteRun(input)
  if (bundle.source !== 'published' && !(allowLocal && bundle.source === 'local')) throw new Error('History requires measured results')
  if (bundle.run.id !== entry.id || bundle.run.attempt !== entry.attempt) {
    throw new Error(`History run identity differs from index: ${entry.id}.${entry.attempt}`)
  }
  return bundle
}

export const runBundleSchema = bundleSchema.superRefine((bundle, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message })
  const unique = (values: string[], path: (string | number)[]) => {
    const seen = new Set<string>()
    values.forEach((value, index) => {
      if (seen.has(value)) issue([...path, index], `Duplicate identifier: ${value}`)
      seen.add(value)
    })
    return seen
  }
  const runtimes = unique(bundle.catalog.runtimes.map(entry => entry.id), ['catalog', 'runtimes'])
  const platforms = unique(bundle.catalog.platforms.map(entry => entry.id), ['catalog', 'platforms'])
  const metrics = unique(bundle.catalog.metrics.map(entry => entry.id), ['catalog', 'metrics'])
  unique(bundle.runners.map(entry => entry.id), ['runners'])
  unique(bundle.measurements.map(entry => entry.id), ['measurements'])
  const requiredMetrics = unique(bundle.benchmark.metricIds, ['benchmark', 'metricIds'])
  for (const metricId of requiredMetrics) {
    if (!metrics.has(metricId)) issue(['benchmark', 'metricIds'], `Unknown metric: ${metricId}`)
  }
  const expected = unique(bundle.benchmark.expectedConfigurations.map(configurationKey), ['benchmark', 'expectedConfigurations'])
  bundle.benchmark.expectedConfigurations.forEach((entry, index) => {
    if (!runtimes.has(entry.runtimeId)) issue(['benchmark', 'expectedConfigurations', index], 'Unknown runtime')
    if (!platforms.has(entry.platformId)) issue(['benchmark', 'expectedConfigurations', index], 'Unknown platform')
  })
  bundle.runners.forEach((runner, index) => {
    if (!platforms.has(runner.platformId)) issue(['runners', index, 'platformId'], 'Unknown platform')
    if (runner.sku !== runner.expectedSku) issue(['runners', index, 'sku'], 'Actual SKU differs from expected SKU')
  })
  const configurations = new Set<string>()
  bundle.measurements.forEach((measurement, index) => {
    const path = ['measurements', index]
    const runner = bundle.runners.find(entry => entry.id === measurement.runnerId)
    if (!runner) issue([...path, 'runnerId'], 'Unknown runner')
    if (!runtimes.has(measurement.runtimeId)) issue([...path, 'runtimeId'], 'Unknown runtime')
    if (runner) {
      const key = configurationKey({ ...measurement, platformId: runner.platformId })
      if (!expected.has(key)) issue(path, `Unexpected configuration: ${key}`)
      if (configurations.has(key)) issue(path, `Duplicate configuration: ${key}`)
      configurations.add(key)
    }
    if (measurement.status === 'success') {
      for (const metricId of requiredMetrics) {
        if (!(metricId in measurement.values)) issue([...path, 'values', metricId], 'Missing required metric')
      }
      for (const metricId of Object.keys(measurement.values)) {
        if (!requiredMetrics.has(metricId)) issue([...path, 'values', metricId], 'Unexpected metric')
      }
    } else if ('values' in measurement) {
      issue([...path, 'values'], 'Only successful measurements carry values')
    }
    measurement.rawOutputs.forEach((output, outputIndex) => {
      if (output.format === 'text' && typeof output.content !== 'string') {
        issue([...path, 'rawOutputs', outputIndex, 'content'], 'Text output must be a string')
      }
    })
  })
  if (bundle.source === 'published') {
    if (!bundle.run.workflow.url) issue(['run', 'workflow', 'url'], 'Workflow URL is required')
    if (!bundle.run.commit.url) issue(['run', 'commit', 'url'], 'Commit URL is required')
    bundle.runners.forEach((runner, index) => {
      if (!runner.region || !runner.cpu.model || !runner.cpu.cores || !runner.cpu.threadsPerCore || !runner.os.version) {
        issue(['runners', index], 'Published runs require complete machine metadata')
      }
      if (!Object.keys(runner.tools).length || !Object.keys(runner.dependencies).length) {
        issue(['runners', index], 'Published runs require tool and dependency versions')
      }
    })
  }
})

export function parseRunBundle(input: unknown): RunBundle {
  return runBundleSchema.parse(input)
}

export function groupHistories(bundles: RunBundle[]): RunBundle[][] {
  const groups = new Map<string, RunBundle[]>()
  const keys = new Set<string>()
  const ordered = [...bundles].sort((first, second) => first.run.createdAt.localeCompare(second.run.createdAt) || runKey(first).localeCompare(runKey(second)))
  for (const bundle of ordered) {
    const key = runKey(bundle)
    if (keys.has(key)) throw new Error(`Duplicate run and attempt: ${key}`)
    keys.add(key)
    if (bundle.source !== ordered[0]!.source) throw new Error('History sources differ')
    const definition = canonicalJson({
      id: bundle.benchmark.id, version: bundle.benchmark.version, settings: bundle.benchmark.settings,
      metrics: bundle.catalog.metrics.map(({ id, unit, direction, methodVersion }) => ({ id, unit, direction, methodVersion })).sort((first, second) => first.id.localeCompare(second.id)),
      runtimes: bundle.catalog.runtimes.map(({ id, engine, execution }) => ({ id, engine, execution })).sort((first, second) => first.id.localeCompare(second.id)),
    })
    const group = groups.get(definition) ?? []
    group.push(bundle)
    groups.set(definition, group)
  }
  const histories = [...groups.values()].sort((first, second) => second.at(-1)!.run.createdAt.localeCompare(first.at(-1)!.run.createdAt) || runKey(second.at(-1)!).localeCompare(runKey(first.at(-1)!)))
  for (const history of histories) validateHistory(history)
  return histories
}

export function validateHistory(bundles: RunBundle[]) {
  if (!bundles.length) throw new Error('No run bundles supplied')
  const runtimes = new Map<string, Runtime>()
  const platforms = new Map<string, Platform>()
  const metrics = new Map<string, Metric>()
  const keys = new Set<string>()
  const first = bundles[0]!
  const definition = (bundle: RunBundle) => canonicalJson({ id: bundle.benchmark.id, version: bundle.benchmark.version, settings: bundle.benchmark.settings })
  const expected = definition(first)
  for (const bundle of bundles) {
    const key = runKey(bundle)
    if (keys.has(key)) throw new Error(`Duplicate run and attempt: ${key}`)
    keys.add(key)
    if (bundle.source !== first.source || definition(bundle) !== expected) {
      throw new Error(`Incompatible benchmark history: ${key}`)
    }
    for (const runtime of bundle.catalog.runtimes) {
      const previous = runtimes.get(runtime.id)
      if (previous && (previous.engine !== runtime.engine || previous.execution !== runtime.execution)) {
        throw new Error(`Runtime definition changed: ${runtime.id}`)
      }
      runtimes.set(runtime.id, runtime)
    }
    for (const platform of bundle.catalog.platforms) platforms.set(platform.id, platform)
    for (const metric of bundle.catalog.metrics) {
      const previous = metrics.get(metric.id)
      if (previous && (previous.unit !== metric.unit || previous.direction !== metric.direction || previous.methodVersion !== metric.methodVersion)) {
        throw new Error(`Metric definition changed: ${metric.id}`)
      }
      metrics.set(metric.id, metric)
    }
  }
  return { source: first.source, runtimes: [...runtimes.values()], platforms: [...platforms.values()], metrics: [...metrics.values()] }
}

export function validateCompleteRun(input: unknown): RunBundle {
  const bundle = parseRunBundle(input)
  const successful = new Set(bundle.measurements.filter(entry => entry.status === 'success').map(entry => {
    const runner = bundle.runners.find(runner => runner.id === entry.runnerId)!
    return configurationKey({ ...entry, platformId: runner.platformId })
  }))
  const missing = bundle.benchmark.expectedConfigurations.map(configurationKey).filter(key => !successful.has(key))
  if (missing.length) throw new Error(`Missing successful configurations: ${missing.join(', ')}`)
  return bundle
}

export const publicationPolicySchema = z.looseObject({
  catalog: bundleSchema.shape.catalog,
  benchmark: bundleSchema.shape.benchmark,
  expectedSkus: z.record(identifier, text),
})

export function validatePublishableRun(input: unknown, policyInput: unknown): RunBundle {
  const policy = publicationPolicySchema.parse(policyInput)
  const bundle = validateCompleteRun(input)
  if (bundle.source !== 'published') throw new Error('Publication requires measured results')
  const normalize = (catalog: RunBundle['catalog'], benchmark: RunBundle['benchmark']) => ({
    catalog: {
      runtimes: [...catalog.runtimes].sort((first, second) => first.id.localeCompare(second.id)),
      platforms: [...catalog.platforms].sort((first, second) => first.id.localeCompare(second.id)),
      metrics: [...catalog.metrics].sort((first, second) => first.id.localeCompare(second.id)),
    },
    benchmark: {
      ...benchmark,
      metricIds: [...benchmark.metricIds].sort(),
      expectedConfigurations: [...benchmark.expectedConfigurations].sort((first, second) => configurationKey(first).localeCompare(configurationKey(second))),
    },
  })
  if (canonicalJson(normalize(bundle.catalog, bundle.benchmark)) !== canonicalJson(normalize(policy.catalog, policy.benchmark))) {
    throw new Error('Bundle definitions differ from the publication policy')
  }
  for (const runner of bundle.runners) {
    if (policy.expectedSkus[runner.platformId] !== runner.sku) {
      throw new Error(`Runner SKU differs from publication policy: ${runner.id}`)
    }
  }
  return bundle
}

export const runSelectionSchema = z.looseObject({
  schemaVersion: z.literal(1),
  kind: z.literal('selection'),
  selection: z.looseObject({
    metricId: identifier,
    strategy: strategySchema,
    runtimeIds: z.array(identifier),
    platformIds: z.array(identifier),
    runId: text,
  }),
  bundles: z.array(runBundleSchema).min(1),
}).superRefine((archive, context) => {
  const keys = archive.bundles.map(runKey)
  const issue = (message: string) => context.addIssue({ code: 'custom', message })
  if (new Set(keys).size !== keys.length) issue('Duplicate run and attempt')
  if (!keys.includes(archive.selection.runId)) issue('Selected run is missing')
  const runtimes = new Set(archive.bundles.flatMap(bundle => bundle.catalog.runtimes.map(entry => entry.id)))
  const platforms = new Set(archive.bundles.flatMap(bundle => bundle.catalog.platforms.map(entry => entry.id)))
  const metrics = new Set(archive.bundles.flatMap(bundle => bundle.catalog.metrics.map(entry => entry.id)))
  if (archive.selection.runtimeIds.some(id => !runtimes.has(id))) issue('Unknown selected runtime')
  if (archive.selection.platformIds.some(id => !platforms.has(id))) issue('Unknown selected platform')
  if (!metrics.has(archive.selection.metricId)) issue('Unknown selected metric')
})

export function parseResultFile(input: unknown): RunBundle[] {
  if (typeof input === 'object' && input !== null && 'kind' in input && input.kind === 'selection') {
    return runSelectionSchema.parse(input).bundles
  }
  return [parseRunBundle(input)]
}