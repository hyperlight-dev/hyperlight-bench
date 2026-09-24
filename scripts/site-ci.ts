import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { assembleSite, previewBuildSchema } from './assemble-site.ts'
import { eligibility, github, pages, workflowTrusted } from './github-pr.ts'
import { canonicalJson } from '../shared/results.ts'
import { readJson, writeJson } from './result-store.ts'

const repository = process.env.GITHUB_REPOSITORY!
const mode = process.argv[2]
if (!['assemble', 'verify'].includes(mode!)) throw new Error('Expected assemble or verify')

function execute(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`)
  return result.stdout.trim()
}

async function inputs() {
  const main = await github('git/ref/heads/main')
  const refs = await github('git/matching-refs/heads/data')
  const data = refs.find((entry: { ref: string }) => entry.ref === 'refs/heads/data')?.object.sha ?? null
  const prs = (await pages('pulls?state=open&base=main')).filter(pr => !pr.draft)
  return {
    prs,
    snapshot: {
      main: main.object.sha, data,
      open: prs.map(pr => ({ number: pr.number, head: pr.head.sha, base: pr.base.sha })).sort((first, second) => first.number - second.number),
    },
  }
}

type Preview = ReturnType<typeof previewBuildSchema.parse> & { includePending: boolean }
type SiteState = Awaited<ReturnType<typeof inputs>>['snapshot'] & { previews: Preview[] }

async function verifiedBuild(run: any, pr: any, artifact: any): Promise<boolean> {
  if (run.event !== 'pull_request' || run.path !== '.github/workflows/preview.yml' || run.conclusion !== 'success'
    || run.head_sha !== pr.head.sha || run.head_repository?.full_name !== pr.head.repo.full_name
    || !run.pull_requests.some((entry: { number: number }) => entry.number === pr.number)) return false
  if (!artifact || artifact.expired || artifact.name !== `preview-${pr.number}-${pr.head.sha}-${run.run_attempt}`) return false
  if (artifact.size_in_bytes > 100 * 1024 ** 2) throw new Error(`Preview artifact is too large: ${artifact.name}`)
  if (!await workflowTrusted('.github/workflows/preview.yml', run.head_sha)) return false
  const jobs = await github(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)
  for (const jobName of ['revision', 'build']) {
    const matches = jobs.jobs.filter((job: { name: string }) => job.name === jobName)
    if (matches.length !== 1 || matches[0].conclusion !== 'success') return false
  }
  return true
}

async function discover(prs: any[]): Promise<Preview[]> {
  const selected = new Map<number, Preview>()
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  for (let page = 1; selected.size < prs.length; page++) {
    const response = await github(`actions/workflows/preview.yml/runs?event=pull_request&status=success&created=%3E%3D${since}&per_page=100&page=${page}`)
    if (!response.workflow_runs.length) break
    for (const run of response.workflow_runs) {
      if (run.event !== 'pull_request' || run.path !== '.github/workflows/preview.yml') continue
      const artifacts = await github(`actions/runs/${run.id}/artifacts?per_page=100`)
      if (artifacts.total_count > 100) throw new Error('Preview run contains too many artifacts')
      for (const pr of prs) {
        if (selected.has(pr.number)) continue
        if (run.head_sha !== pr.head.sha || run.head_repository?.full_name !== pr.head.repo.full_name
          || !run.pull_requests.some((entry: { number: number }) => entry.number === pr.number)) continue
        const name = `preview-${pr.number}-${pr.head.sha}-${run.run_attempt}`
        const artifact = artifacts.artifacts.find((entry: { name: string, expired: boolean }) => entry.name === name && !entry.expired)
        if (!await verifiedBuild(run, pr, artifact)) continue
        const { decision } = await eligibility(pr.number)
        if (decision.head !== pr.head.sha || decision.base !== pr.base.sha) throw new Error('PR changed during site assembly')
        selected.set(pr.number, {
          ...previewBuildSchema.parse({ number: pr.number, head: pr.head.sha, base: pr.base.sha, runId: run.id, attempt: run.run_attempt, artifactId: artifact.id }),
          includePending: decision.mode === 'required',
        })
      }
    }
    if (page * 100 >= response.total_count) break
    if (page >= 10) throw new Error('Preview discovery exceeded the GitHub search window')
  }
  return [...selected.values()].sort((first, second) => first.number - second.number)
}

async function verify(desired: SiteState) {
  const { prs, snapshot } = await inputs()
  const { previews, ...expected } = desired
  if (canonicalJson(snapshot) !== canonicalJson(expected)) throw new Error('Site inputs changed. Rerun Pages.')
  for (const preview of previews) {
    const pr = prs.find(pr => pr.number === preview.number)
    const run = await github(`actions/runs/${preview.runId}`)
    const artifact = await github(`actions/artifacts/${preview.artifactId}`)
    if (run.run_attempt !== preview.attempt || artifact.workflow_run?.id !== preview.runId
      || !await verifiedBuild(run, pr, artifact)) throw new Error(`PR ${preview.number}: preview build changed. Rerun Pages.`)
    const { decision } = await eligibility(preview.number)
    if (decision.head !== preview.head || decision.base !== preview.base
      || (decision.mode === 'required') !== preview.includePending) throw new Error('Preview eligibility changed. Rerun Pages.')
  }
}

if (mode === 'verify') {
  await verify(readJson(process.argv[3] ?? 'site-state.json') as SiteState)
} else {
  const { prs, snapshot } = await inputs()
  const desired = { ...snapshot, previews: await discover(prs) }
  if (execute('git', ['rev-parse', 'HEAD']) !== desired.main) throw new Error('Main changed. Rerun Pages.')
  const store = resolve('site-data')
  if (existsSync(store)) throw new Error('Site data directory must be new')
  mkdirSync(store)
  if (desired.data) {
    execute('git', ['clone', '--depth=1', '--branch', 'data', `https://github.com/${repository}.git`, store])
    if (execute('git', ['-C', store, 'rev-parse', 'HEAD']) !== desired.data) throw new Error('Data changed. Rerun Pages.')
  }
  const previews = []
  for (const preview of desired.previews) {
    const directory = resolve('preview-builds', String(preview.number))
    if (existsSync(directory)) throw new Error('Preview download directory must be new')
    mkdirSync(directory, { recursive: true })
    execute('gh', ['run', 'download', String(preview.runId), '--repo', repository,
      '--name', `preview-${preview.number}-${preview.head}-${preview.attempt}`, '--dir', directory])
    previews.push({ ...preview, directory })
  }
  assembleSite({ production: resolve('dist'), store, output: resolve('site'), repository, previews })
  try {
    await verify(desired)
  } catch (error) {
    rmSync('site', { recursive: true })
    throw error
  }
  writeJson('site-state.json', desired, true)
  console.log(`Assembled production and ${previews.length} current PR previews`)
}