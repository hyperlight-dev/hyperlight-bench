import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { publicationPolicy } from '../shared/catalog.ts'
import {
  canonicalJson, historyIndexSchema, historyRunPath, parseHistoryRun, publicationSchema,
  validatePublication, validatePublishableRun, groupHistories,
} from '../shared/results.ts'
import { readJson, readOptionalJson, withStoreLock, writeJson } from './result-store.ts'

export function storeRun(directory: string, input: unknown, policy: unknown = publicationPolicy) {
  const bundle = validatePublishableRun(input, policy)
  const path = resolve(directory, historyRunPath(bundle.run))
  withStoreLock(directory, () => writeJson(path, bundle, true))
  console.log(`Stored ${path}`)
}

export function promoteRun(directory: string, input: unknown, policy: unknown = publicationPolicy) {
  const requested = publicationSchema.parse(input)
  withStoreLock(directory, () => {
    const bundle = validatePublishableRun(readJson(resolve(directory, historyRunPath(requested.run))), policy)
    const publication = validatePublication(bundle, requested)
    const publicationPath = resolve(directory, 'publications', `pr-${publication.pullRequest.number}.json`)
    const previous = readOptionalJson(publicationPath)
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(publication)) {
      throw new Error(`PR already has a different publication: ${publicationPath}`)
    }
    const indexPath = resolve(directory, 'index.json')
    const index = historyIndexSchema.parse(readOptionalJson(indexPath) ?? { schemaVersion: 1, runs: [] })
    const history = index.runs.map(entry => parseHistoryRun(readJson(resolve(directory, historyRunPath(entry))), entry))
    const included = index.runs.some(entry => entry.id === publication.run.id && entry.attempt === publication.run.attempt)
    if (included && previous === undefined) throw new Error('Run is already indexed without its PR publication record')
    if (!included) {
      history.push(bundle)
      index.runs.push(publication.run)
    }
    groupHistories(history)
    index.runs.sort((first, second) => first.id.localeCompare(second.id) || first.attempt - second.attempt)
    writeJson(publicationPath, publication, true)
    writeJson(indexPath, index, false)
  })
  console.log(`Published PR ${requested.pullRequest.number}: ${requested.run.id}.${requested.run.attempt}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        directory: { type: 'string' },
        policy: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
    if (values.help) {
      console.log('Usage: node scripts/publish-results.ts store|promote --directory data [--policy policy.json] input.json')
    } else {
      const [command, inputPath] = positionals
      if (!values.directory || positionals.length !== 2 || !['store', 'promote'].includes(command)) {
        throw new Error('Provide store|promote, --directory, and one input JSON file')
      }
      const policy = values.policy ? readJson(values.policy) : publicationPolicy
      const operation = command === 'store' ? storeRun : promoteRun
      operation(resolve(values.directory), readJson(inputPath), policy)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}