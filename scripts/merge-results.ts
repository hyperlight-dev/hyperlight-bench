import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { canonicalJson, parseRunBundle, validatePublishableRun, type RunBundle } from '../shared/results.ts'
import { publicationPolicy } from '../shared/catalog.ts'

export function mergeBundles(inputs: unknown[], attempt?: number, runId?: string): RunBundle {
  if (!inputs.length) throw new Error('Provide bundle files to merge')
  const bundles = inputs.map(parseRunBundle)
  const merged = structuredClone(bundles[0]!)
  const collectionAttempt = attempt ?? Math.max(...bundles.map(bundle => bundle.run.attempt))
  if (!Number.isSafeInteger(collectionAttempt) || collectionAttempt < 1) throw new Error('Invalid collection attempt')
  if (runId !== undefined && merged.run.id !== runId) throw new Error('Run identity differs from the current workflow')
  const definition = (bundle: RunBundle) => {
    const { attempt, createdAt, workflow, ...run } = bundle.run
    const { url, ...workflowDefinition } = workflow
    return canonicalJson({ run, workflow: workflowDefinition, catalog: bundle.catalog, benchmark: bundle.benchmark, source: bundle.source })
  }
  const expected = definition(merged)
  merged.runners = []
  merged.measurements = []
  for (const bundle of bundles) {
    if (definition(bundle) !== expected) throw new Error('Shard definitions differ')
    if (bundle.run.attempt > collectionAttempt) throw new Error('Shard attempt exceeds collection attempt')
    if (bundle.source === 'published' && bundle.run.workflow.url !== `https://github.com/${bundle.run.pullRequest?.repository}/actions/runs/${bundle.run.id}/attempts/${bundle.run.attempt}`) throw new Error('Shard workflow URL differs')
    if (bundle.run.createdAt < merged.run.createdAt) merged.run.createdAt = bundle.run.createdAt
    merged.runners.push(...bundle.runners)
    merged.measurements.push(...bundle.measurements)
  }
  merged.run.attempt = collectionAttempt
  if (merged.source === 'published') merged.run.workflow.url = `https://github.com/${merged.run.pullRequest!.repository}/actions/runs/${merged.run.id}/attempts/${collectionAttempt}`
  return validatePublishableRun(merged, publicationPolicy)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string', default: 'run.json' } } })
  const attempt = process.env.GITHUB_ACTIONS ? Number(process.env.GITHUB_RUN_ATTEMPT) : undefined
  const merged = mergeBundles(positionals.map(path => JSON.parse(readFileSync(path, 'utf8'))), attempt, process.env.GITHUB_ACTIONS ? process.env.GITHUB_RUN_ID : undefined)
  writeFileSync(values.output, `${JSON.stringify(merged, null, 2)}\n`, { flag: 'wx' })
  console.log(`Merged ${merged.measurements.length} successful measurements`)
}