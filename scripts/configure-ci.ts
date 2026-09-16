import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { benchmark, runnerPools, serverFlavor } from '../shared/catalog.ts'
import { output } from './runner-metadata.ts'

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8'))
const pullRequest = process.env.GITHUB_EVENT_NAME === 'pull_request' ? event.pull_request : undefined
const warmCaches = process.env.GITHUB_EVENT_NAME === 'push' && event.ref === 'refs/heads/main' && !event.deleted
if (!warmCaches && (!pullRequest || pullRequest.base.ref !== 'main')) throw new Error('Expected a PR targeting main or a push to main')
const repository = process.env.GITHUB_REPOSITORY
const runId = process.env.GITHUB_RUN_ID
const attempt = Number(process.env.GITHUB_RUN_ATTEMPT)
if (!repository || !runId || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('GitHub workflow identity is required')
if (pullRequest) {
  const sha = output('git', ['rev-parse', 'HEAD'])
  const base = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const run = {
    id: runId, attempt, createdAt: new Date().toISOString(),
    workflow: { name: process.env.GITHUB_WORKFLOW ?? 'Benchmark', url: `${base}/${repository}/actions/runs/${runId}/attempts/${attempt}` },
    commit: { sha, tree: output('git', ['rev-parse', 'HEAD^{tree}']), message: output('git', ['show', '-s', '--format=%s', 'HEAD']), url: `${base}/${repository}/commit/${sha}` },
    pullRequest: { repository, number: pullRequest.number, head: pullRequest.head.sha, base: pullRequest.base.sha },
  }
  mkdirSync('artifacts', { recursive: true })
  writeFileSync('artifacts/run.json', `${JSON.stringify(run, null, 2)}\n`)
}
const platforms = Object.entries(runnerPools).map(([platform, runner]) => ({ platform, labels: ['self-hosted', 'Linux', 'X64', `1ES.Pool=${runner.pool}`] }))
const configurations = benchmark.expectedConfigurations.map(configuration => ({
  platform: configuration.platformId, runtime: configuration.runtimeId, strategy: configuration.strategy,
  flavor: serverFlavor(configuration.runtimeId),
  labels: platforms.find(platform => platform.platform === configuration.platformId)!.labels,
}))
if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
appendFileSync(process.env.GITHUB_OUTPUT, `platforms=${JSON.stringify({ include: platforms })}\nconfigurations=${JSON.stringify({ include: configurations })}\n`)