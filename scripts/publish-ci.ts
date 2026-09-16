import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { publicationPolicy } from '../shared/catalog.ts'
import { historyRunPath, validatePublication, validatePublishableRun } from '../shared/results.ts'
import { eligibility, github, pages, workflowTrusted } from './github-pr.ts'
import { readJson, readOptionalJson, writeJson } from './result-store.ts'
import { promoteRun, storeRun } from './publish-results.ts'

const repository = process.env.GITHUB_REPOSITORY!
const directory = resolve('data-store')
const incoming = resolve('incoming-results')

function execute(command: string, args: string[], cwd = process.cwd()): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`)
  return result.stdout.trim()
}

function openStore() {
  execute('git', ['init', '--initial-branch=data', directory])
  execute('git', ['remote', 'add', 'origin', `https://github.com/${repository}.git`], directory)
  const refs = execute('git', ['ls-remote', '--heads', 'origin', 'refs/heads/data'], directory)
  if (refs) {
    execute('git', ['fetch', '--depth=1', 'origin', 'data'], directory)
    execute('git', ['checkout', '-B', 'data', 'FETCH_HEAD'], directory)
  }
  execute('git', ['config', 'user.name', 'github-actions[bot]'], directory)
  execute('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], directory)
}

function pushStore() {
  const paths = ['runs', 'policies', 'pending', 'publications', 'index.json'].filter(path => existsSync(resolve(directory, path)))
  if (!paths.length) return
  execute('git', ['add', '--', ...paths], directory)
  if (!execute('git', ['diff', '--cached', '--name-only'], directory)) return
  execute('git', ['commit', '-m', 'Record validated benchmark results'], directory)
  execute('git', ['push', 'origin', 'HEAD:refs/heads/data'], directory)
}

async function verifiedRun(runId: number, attempt: number) {
  const run = await github(`actions/runs/${runId}/attempts/${attempt}`)
  if (run.event !== 'pull_request' || run.conclusion !== 'success' || run.path !== '.github/workflows/benchmark.yml') {
    throw new Error('Expected a successful PR Benchmark workflow attempt')
  }
  if (!await workflowTrusted('.github/workflows/benchmark.yml', run.head_sha)) {
    throw new Error('Benchmark workflow must match current main. After merge, rerun this publication workflow.')
  }
  const latestJobs = new Map<string, any>()
  for (let currentAttempt = attempt; currentAttempt >= 1; currentAttempt--) {
    let fetched = 0
    for (let page = 1; ; page++) {
      const response = await github(`actions/runs/${runId}/attempts/${currentAttempt}/jobs?per_page=100&page=${page}`)
      for (const job of response.jobs) {
        if (!latestJobs.has(job.name)) latestJobs.set(job.name, job)
      }
      fetched += response.jobs.length
      if (fetched >= response.total_count) break
      if (!response.jobs.length) throw new Error('Incomplete workflow job list')
    }
  }
  const jobs = [...latestJobs.values()]
  const expected = new Map([
    ['eligibility', 1], ['configure', 1], ['producer', 1], ['prepare', 2],
    ['measure', publicationPolicy.benchmark.expectedConfigurations.length], ['collect', 1], ['Benchmark Status', 1],
  ])
  for (const [name, count] of expected) {
    const matching = jobs.filter(job => job.name === name || job.name.startsWith(`${name} (`))
    if (matching.length !== count || matching.some(job => job.conclusion !== 'success')) {
      throw new Error(`Run ${runId} through attempt ${attempt} requires ${count} successful ${name} jobs. Rerun the failed jobs.`)
    }
  }
  return run
}

async function verifyCandidate(bundle: ReturnType<typeof validatePublishableRun>, pr: any) {
  const recorded = bundle.run.pullRequest
  if (!recorded || recorded.repository !== repository || recorded.number !== pr.number || recorded.head !== pr.head.sha) {
    throw new Error('Measured PR head differs from the current PR')
  }
  const candidate = await github(`git/commits/${bundle.run.commit.sha}`)
  if (candidate.tree.sha !== bundle.run.commit.tree || candidate.parents.length !== 2
    || candidate.parents[0].sha !== recorded.base || candidate.parents[1].sha !== recorded.head) {
    throw new Error('Measured commit is not the recorded PR merge candidate')
  }
  if (!pr.merged && recorded.base !== pr.base.sha) throw new Error('PR base changed. A fresh benchmark run is required.')
}

async function promote(number: number) {
  const { pr, decision } = await eligibility(number)
  if (!pr.merged) throw new Error('PR has not merged')
  if (decision.mode === 'skip') {
    console.log(`PR ${number}: approved skip. No results published.`)
    return
  }
  const pending = readOptionalJson(resolve(directory, 'pending', `pr-${number}.json`)) as any
  if (!pending) throw new Error(`PR ${number}: pending results are missing. Retry archival before promotion.`)
  const policyPath = resolve(directory, 'policies', pending.id, `${pending.attempt}.json`)
  const bundle = validatePublishableRun(readJson(resolve(directory, historyRunPath(pending))), readJson(policyPath))
  const run = await verifiedRun(Number(bundle.run.id), bundle.run.attempt)
  if (run.head_sha !== pr.head.sha) throw new Error('Workflow head differs from merged PR head')
  await verifyCandidate(bundle, pr)
  const merged = await github(`git/commits/${pr.merge_commit_sha}`)
  const publication = validatePublication(bundle, {
    schemaVersion: 1,
    run: { id: bundle.run.id, attempt: bundle.run.attempt },
    pullRequest: bundle.run.pullRequest,
    merge: { sha: pr.merge_commit_sha, tree: merged.tree.sha, mergedAt: pr.merged_at, message: merged.message },
  })
  promoteRun(directory, publication, readJson(policyPath))
}

export async function withPublicationStatus(head: string, operation: () => Promise<void>) {
  const report = (state: string, description: string) => github(`statuses/${head}`, {
    state, context: 'Benchmark Publication', description,
    target_url: `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`,
  })
  await report('pending', 'Validating benchmark publication')
  try {
    await operation()
    await report('success', 'Benchmark publication completed')
  } catch (error) {
    try {
      await report('failure', 'Benchmark publication failed. See workflow logs.')
    } catch (statusError) {
      console.error('Could not report publication failure:', statusError)
    }
    throw error
  }
}

export async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8'))
  if (process.env.GITHUB_EVENT_NAME === 'push') {
    if (event.ref !== 'refs/heads/main' || event.deleted) return
    if (!Array.isArray(event.commits) || event.commits.length >= 2048) {
      throw new Error('Push commit list is unavailable or truncated. Rerun archival for the merged PRs to retry promotion.')
    }
    const commits = new Set<string>([event.after, ...event.commits.map((commit: { id: string }) => commit.id)])
    const numbers = new Set<number>()
    for (const commit of commits) {
      for (const pr of await pages(`commits/${commit}/pulls`)) {
        if (pr.merged_at && pr.base.ref === 'main' && pr.base.repo.full_name === repository
          && commits.has(pr.merge_commit_sha)) numbers.add(pr.number)
      }
    }
    if (!numbers.size) return
    openStore()
    for (const number of numbers) {
      const pr = await github(`pulls/${number}`)
      await withPublicationStatus(pr.head.sha, async () => {
        await promote(number)
        pushStore()
      })
    }
    return
  }
  const notification = event.workflow_run
  if (notification.event !== 'pull_request' || notification.conclusion !== 'success') return
  if (notification.pull_requests.length !== 1) throw new Error('Workflow must identify one PR')
  const number = notification.pull_requests[0].number
  const current = await github(`pulls/${number}`)
  if (current.head.sha !== notification.head_sha) throw new Error('Workflow is stale. A fresh benchmark run is required.')
  await withPublicationStatus(notification.head_sha, () => archive(notification, number))
}

async function archive(notification: any, number: number) {
  const { pr, decision } = await eligibility(number)
  if (decision.mode === 'skip') {
    console.log(`PR ${number}: approved skip. No results archived.`)
    return
  }
  if (pr.state !== 'open' && !pr.merged) throw new Error('PR was closed without merging')
  const run = await verifiedRun(notification.id, notification.run_attempt)
  if (run.head_sha !== pr.head.sha) throw new Error('Workflow is stale. A fresh benchmark run is required.')
  mkdirSync(incoming, { recursive: true })
  execute('gh', ['run', 'download', String(run.id), '--repo', repository, '--name', `run-${run.id}-${notification.run_attempt}`, '--dir', incoming])
  const input = resolve(incoming, 'run.json')
  const bundle = validatePublishableRun(readJson(input), publicationPolicy)
  if (bundle.run.id !== String(run.id) || bundle.run.attempt !== notification.run_attempt) throw new Error('Artifact workflow identity differs')
  await verifyCandidate(bundle, pr)
  validatePublication(bundle, {
    schemaVersion: 1, run: { id: bundle.run.id, attempt: bundle.run.attempt }, pullRequest: bundle.run.pullRequest,
    merge: { sha: bundle.run.commit.sha, tree: bundle.run.commit.tree, mergedAt: bundle.run.createdAt, message: bundle.run.commit.message },
  })
  openStore()
  storeRun(directory, bundle)
  writeJson(resolve(directory, 'policies', bundle.run.id, `${bundle.run.attempt}.json`), publicationPolicy, true)
  const pointerPath = resolve(directory, 'pending', `pr-${number}.json`)
  const previous = readOptionalJson(pointerPath) as any
  const pointer = { id: bundle.run.id, attempt: bundle.run.attempt, createdAt: run.created_at }
  if (!previous || previous.createdAt < pointer.createdAt || (previous.id === pointer.id && previous.attempt <= pointer.attempt)) {
    writeJson(pointerPath, pointer, false)
  }
  if (!readOptionalJson(resolve(directory, 'index.json'))) writeJson(resolve(directory, 'index.json'), { schemaVersion: 1, runs: [] }, true)
  pushStore()
  if (pr.merged) {
    await promote(number)
    pushStore()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(String(error))
    process.exitCode = 1
  })
}