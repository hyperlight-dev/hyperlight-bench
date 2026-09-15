import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { groupHistories, parseResultFile, validateCompleteRun, validatePublishableRun } from '../shared/results.ts'
import { datasetFromBundles } from '../src/data.ts'
import { createMockBundles } from '../src/mock-data.ts'

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      fixtures: { type: 'boolean', default: false },
      complete: { type: 'boolean', default: false },
      policy: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  })
  if (values.help) {
    console.log('Usage: npm run validate -- [--complete] [--policy policy.json] file.json ...\n       npm run validate -- --fixtures')
    return
  }
  if (values.fixtures ? positionals.length > 0 : positionals.length === 0) {
    throw new Error('Choose --fixtures or one or more JSON files')
  }
  const policy = values.policy ? JSON.parse(await readFile(values.policy, 'utf8')) as unknown : undefined
  const bundles = values.fixtures ? createMockBundles() : (await Promise.all(positionals.map(async path => {
    try {
      return parseResultFile(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }))).flat()
  for (const bundle of bundles) {
    if (policy !== undefined) validatePublishableRun(bundle, policy)
    else if (values.complete || values.fixtures) validateCompleteRun(bundle)
  }
  const datasets = groupHistories(bundles).map(datasetFromBundles)
  const measurements = bundles.reduce((count, bundle) => count + bundle.measurements.length, 0)
  const successful = datasets.reduce((count, dataset) => count + dataset.measurements.length, 0)
  console.log(`Validated ${bundles.length} runs in ${datasets.length} histories, ${measurements} results, ${successful} successful measurements.`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})