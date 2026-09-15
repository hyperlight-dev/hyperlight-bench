import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { canonicalJson, parseRunBundle, validatePublishableRun } from '../shared/results.ts'
import { publicationPolicy } from '../shared/catalog.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string', default: 'run.json' } } })
if (!positionals.length) throw new Error('Provide bundle files to merge')
const bundles = positionals.map(path => parseRunBundle(JSON.parse(readFileSync(path, 'utf8'))))
const merged = structuredClone(bundles[0]!)
for (const bundle of bundles.slice(1)) {
  if (canonicalJson({ run: bundle.run, catalog: bundle.catalog, benchmark: bundle.benchmark, source: bundle.source }) !== canonicalJson({ run: merged.run, catalog: merged.catalog, benchmark: merged.benchmark, source: merged.source })) throw new Error('Shard definitions differ')
  merged.runners.push(...bundle.runners)
  merged.measurements.push(...bundle.measurements)
}
writeFileSync(values.output, `${JSON.stringify(validatePublishableRun(merged, publicationPolicy), null, 2)}\n`, { flag: 'wx' })
console.log(`Merged ${merged.measurements.length} successful measurements`)