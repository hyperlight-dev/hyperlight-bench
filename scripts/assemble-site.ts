import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { historyIndexSchema, historyRunPath, parseHistoryRun, runKey, groupHistories, validatePublication } from '../shared/results.ts'
import type { RunBundle } from '../shared/results.ts'
import { readJson, readOptionalJson, writeJson } from './result-store.ts'

export const previewBuildSchema = z.object({
  number: z.number().int().positive(),
  head: z.string().regex(/^[a-f0-9]{40}$/),
  base: z.string().regex(/^[a-f0-9]{40}$/),
  runId: z.number().int().positive(),
  attempt: z.number().int().positive(),
  artifactId: z.number().int().positive(),
})

function copyBuild(source: string, destination: string) {
  let bytes = 0
  let files = 0
  function inspect(path: string) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`Build contains a symbolic link: ${path}`)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry.startsWith('.')) throw new Error(`Build contains a hidden entry: ${entry}`)
        inspect(resolve(path, entry))
      }
    } else if (stat.isFile()) {
      bytes += stat.size
      files++
      if (bytes > 100 * 1024 ** 2 || files > 10000) throw new Error('Build exceeds the site artifact limit')
    } else {
      throw new Error(`Build contains a special file: ${path}`)
    }
  }
  inspect(source)
  if (!lstatSync(resolve(source, 'index.html')).isFile()) throw new Error('Build requires index.html')
  for (const entry of ['previews', 'data']) {
    if (existsSync(resolve(source, entry))) throw new Error(`Build uses reserved directory: ${entry}`)
  }
  cpSync(source, destination, { recursive: true, errorOnExist: true, force: false })
}

export function assembleSite(options: {
  production: string,
  store: string,
  output: string,
  repository: string,
  previews: (z.infer<typeof previewBuildSchema> & { directory: string, includePending: boolean })[],
}) {
  if (existsSync(options.output)) throw new Error('Site output must be a new directory')
  const index = historyIndexSchema.parse(readOptionalJson(resolve(options.store, 'index.json')) ?? { schemaVersion: 1, runs: [] })
  if (index.preview) throw new Error('Production history must not contain preview metadata')
  const published = index.runs.map(entry => parseHistoryRun(readJson(resolve(options.store, historyRunPath(entry))), entry))
  const seen = new Set<number>()
  function serveData(destination: string, bundles: RunBundle[], preview?: { number: number, head: string, pending: { id: string, attempt: number } | null }) {
    groupHistories(bundles)
    const runs = bundles.map(bundle => {
      const entry = { id: bundle.run.id, attempt: bundle.run.attempt }
      if (!index.runs.some(run => run.id === entry.id && run.attempt === entry.attempt)) return entry
      const pr = bundle.run.pullRequest
      const input = pr ? readOptionalJson(resolve(options.store, 'publications', `pr-${pr.number}.json`)) : undefined
      if (input === undefined) return entry
      const publication = validatePublication(bundle, input)
      return { ...entry, displayCommit: {
        sha: publication.merge.sha,
        message: publication.merge.message.split('\n')[0],
        url: `https://github.com/${publication.pullRequest.repository}/commit/${publication.merge.sha}`,
      } }
    })
    const history = historyIndexSchema.parse({ schemaVersion: 1, runs, ...(preview ? { preview } : {}) })
    for (const bundle of bundles) writeJson(resolve(destination, 'data', historyRunPath(bundle.run)), bundle, true)
    writeJson(resolve(destination, 'data/index.json'), history, true)
  }
  try {
    copyBuild(options.production, options.output)
    serveData(options.output, published)
    for (const preview of options.previews) {
      previewBuildSchema.parse(preview)
      if (seen.has(preview.number)) throw new Error('Duplicate PR preview')
      seen.add(preview.number)
      const bundles = [...published]
      let pending: { id: string, attempt: number } | null = null
      const pointerInput = preview.includePending ? readOptionalJson(resolve(options.store, 'pending', `pr-${preview.number}.json`)) : undefined
      if (pointerInput !== undefined) {
        const pointer = historyIndexSchema.shape.runs.element.parse(pointerInput)
        const bundle = parseHistoryRun(readJson(resolve(options.store, historyRunPath(pointer))), pointer)
        const pr = bundle.run.pullRequest
        if (pr?.repository === options.repository && pr.number === preview.number && pr.head === preview.head && pr.base === preview.base) {
          if (!bundles.some(entry => runKey(entry) === runKey(bundle))) {
            bundles.push(bundle)
            pending = pointer
          }
        }
      }
      const destination = resolve(options.output, 'previews', `pr-${preview.number}`)
      mkdirSync(resolve(options.output, 'previews'), { recursive: true })
      copyBuild(preview.directory, destination)
      serveData(destination, bundles, { number: preview.number, head: preview.head, pending })
    }
  } catch (error) {
    rmSync(options.output, { recursive: true, force: true })
    throw error
  }
}