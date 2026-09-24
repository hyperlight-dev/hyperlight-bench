import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { publicationPolicy, strategies } from '../shared/catalog.ts'
import { groupHistories, historyRunPath, parseHistoryRun, runKey, validateCompleteRun, validateHistory, validatePublishableRun } from '../shared/results.ts'
import { createMockBundles } from '../src/mock-data.ts'
import { readJson, writeJson, withStoreLock } from './result-store.ts'
import { assembleSite } from './assemble-site.ts'
import { loadHistory } from '../src/data.ts'
import { promoteRun, storeRun } from './publish-results.ts'
import { mergeBundles } from './merge-results.ts'

const repository = 'example/benchmarks'
const root = resolve(import.meta.dirname, '..')

test('main pushes configure cache warming without a measurement identity', async context => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'benchmark-cache-config-'))
  context.after(() => rmSync(temporary, { recursive: true, force: true }))
  const eventPath = resolve(temporary, 'event.json')
  const outputPath = resolve(temporary, 'output')
  const configure = () => spawnSync(process.execPath, [resolve(root, 'scripts/configure-ci.ts')], {
    cwd: temporary, encoding: 'utf8',
    env: {
      ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath, GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1',
    },
  })
  writeJson(eventPath, { ref: 'refs/heads/main', deleted: false }, false)
  const result = configure()
  assert.equal(result.status, 0, result.stderr)
  const outputs = Object.fromEntries([...readFileSync(outputPath, 'utf8').matchAll(/^(\w+)=(.+)$/gm)]
    .map(match => [match[1], JSON.parse(match[2]!)]))
  assert.deepEqual(outputs.platforms.include.map((entry: { platform: string }) => entry.platform), ['kvm', 'mshv3'])
  assert.equal(outputs.configurations.include.length, 36)
  const configurations = outputs.configurations.include.flatMap((entry: { platform: string, runtime: string }) =>
    strategies.map(strategy => `${entry.platform}-${entry.runtime}-${strategy}`))
  assert.equal(new Set(configurations).size, 108)
  assert.deepEqual(configurations.sort(), publicationPolicy.benchmark.expectedConfigurations
    .map(entry => `${entry.platformId}-${entry.runtimeId}-${entry.strategy}`).sort())
  assert.equal(existsSync(resolve(temporary, 'artifacts')), false)
  for (const event of [{ ref: 'refs/heads/feature' }, { ref: 'refs/heads/main', deleted: true }]) {
    writeJson(eventPath, event, false)
    assert.notEqual(configure().status, 0)
  }
})

test('benchmark status requires smoke only for skipped measurements', () => {
  const check = (mode: 'required' | 'skip', results: Record<string, { result: string }>) => spawnSync(process.execPath, [resolve(root, 'scripts/check-ci-status.ts')], {
    encoding: 'utf8', env: { ...process.env, BENCHMARK_MODE: mode, BENCHMARK_JOB_RESULTS: JSON.stringify(results) },
  })
  const shared = {
    eligibility: { result: 'success' }, configure: { result: 'success' }, producer: { result: 'success' },
  }
  assert.equal(check('skip', { ...shared, smoke: { result: 'success' } }).status, 0)
  assert.notEqual(check('skip', { ...shared, smoke: { result: 'failure' } }).status, 0)
  assert.equal(check('required', {
    ...shared, smoke: { result: 'skipped' }, prepare: { result: 'success' }, measure: { result: 'success' }, collect: { result: 'success' },
  }).status, 0)
  assert.equal(check('skip', { workload: { result: 'success' } }).status, 0)
  assert.notEqual(check('skip', { workload: { result: 'cancelled' } }).status, 0)
})

test('partial retries retain successful measurements from the same source revision', () => {
  const bundle = fixture()
  const shards = bundle.measurements.map(measurement => {
    const runner = structuredClone(bundle.runners.find(entry => entry.id === measurement.runnerId)!)
    runner.id = measurement.id
    return { ...structuredClone(bundle), runners: [runner], measurements: [{ ...structuredClone(measurement), runnerId: runner.id }] }
  })
  const retry = structuredClone(shards[0]!)
  retry.run.attempt = 2
  retry.run.workflow.url = `https://github.com/${repository}/actions/runs/${retry.run.id}/attempts/2`
  retry.runners[0]!.name = 'retry-runner'
  const measurement = shards[0]!.measurements[0]!
  shards[0]!.measurements = [{ id: measurement.id, runnerId: measurement.runnerId, runtimeId: measurement.runtimeId, strategy: measurement.strategy, status: 'failed', reason: 'Transient failure', rawOutputs: [] }]
  const retained = shards.slice(1)
  const merged = mergeBundles([retry, ...retained], 2, bundle.run.id)
  assert.equal(merged.run.attempt, 2)
  assert.equal(merged.run.workflow.url, retry.run.workflow.url)
  assert.equal(merged.measurements.length, 108)
  assert.deepEqual(merged.measurements[0], retry.measurements[0])
  assert.deepEqual(merged.measurements[1], shards[1]!.measurements[0])
  assert.equal(merged.runners.find(runner => runner.id === retry.runners[0]!.id)!.name, 'retry-runner')
  assert.throws(() => mergeBundles([retry, ...retained, structuredClone(retry)], 2), /Duplicate/)
  assert.equal(mergeBundles([retry, ...retained], 3).run.attempt, 3)

  const failedRetry = structuredClone(retry)
  failedRetry.measurements = structuredClone(shards[0]!.measurements)
  assert.throws(() => mergeBundles([failedRetry, ...retained], 2), /Missing successful configurations|Only successful/)
  assert.throws(() => mergeBundles(shards, 2), /Missing successful configurations|Only successful/)
  assert.throws(() => mergeBundles([...shards.slice(1, -1), retry], 2), /Missing successful configurations/)
  assert.throws(() => mergeBundles([...shards, retry], 2), /Duplicate/)
  assert.throws(() => mergeBundles([retry, ...retained], 1), /exceeds collection attempt/)
  assert.throws(() => mergeBundles([retry, ...retained], 2, 'another-run'), /Run identity differs/)
  for (const mutate of [
    (input: typeof retry) => { input.run.id = 'another-run' },
    (input: typeof retry) => { input.run.commit.sha = 'f'.repeat(40) },
    (input: typeof retry) => { input.run.commit.tree = 'f'.repeat(40) },
    (input: typeof retry) => { input.run.pullRequest!.base = 'f'.repeat(40) },
    (input: typeof retry) => { input.benchmark.settings.concurrency = 1 },
  ]) {
    const invalid = structuredClone(retry)
    mutate(invalid)
    assert.throws(() => mergeBundles([...retained, invalid], 2), /Shard definitions differ/)
  }
  const invalidUrl = structuredClone(retry)
  invalidUrl.run.workflow.url = bundle.run.workflow.url
  assert.throws(() => mergeBundles([...retained, invalidUrl], 2), /Shard workflow URL differs/)
})

test('local history loads measured results but cannot be published', async context => {
  const bundle = fixture()
  bundle.source = 'local'
  bundle.run.workflow.url = null
  bundle.run.commit.url = null
  delete bundle.run.pullRequest
  bundle.catalog.platforms = bundle.catalog.platforms.filter(platform => platform.id === 'kvm')
  bundle.benchmark.expectedConfigurations = bundle.benchmark.expectedConfigurations.filter(configuration => configuration.platformId === 'kvm')
  bundle.runners = bundle.runners.filter(runner => runner.platformId === 'kvm')
  bundle.measurements = bundle.measurements.filter(measurement => bundle.runners.some(runner => runner.id === measurement.runnerId))
  assert.equal(validateCompleteRun(bundle).measurements.length, 54)
  assert.throws(() => parseHistoryRun(bundle, bundle.run), /History requires measured results/)
  assert.throws(() => validatePublishableRun(bundle, publicationPolicy), /Publication requires measured results/)
  context.mock.method(globalThis, 'fetch', async (url: URL) => Response.json(url.pathname.endsWith('index.json')
    ? { schemaVersion: 1, runs: [{ id: bundle.run.id, attempt: bundle.run.attempt }] }
    : bundle))
  const dataset = await loadHistory(new URL('http://localhost/local-data/index.json'))
  assert.equal(dataset!.source, 'local')
  assert.equal(dataset!.measurements.length, 54)
  bundle.measurements.pop()
  await assert.rejects(loadHistory(new URL('http://localhost/local-data/index.json')), /Missing successful configurations/)
})

test('Pages assembly keeps pending data inside its preview', async context => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'benchmark-pages-'))
  context.after(() => rmSync(temporary, { recursive: true, force: true }))
  const production = resolve(temporary, 'production')
  const previewDirectory = resolve(temporary, 'preview')
  const store = resolve(temporary, 'store')
  for (const directory of [production, previewDirectory]) {
    mkdirSync(directory)
    writeFileSync(resolve(directory, 'index.html'), '<!doctype html><title>Fixture</title>')
  }
  const bundle = fixture()
  writeJson(resolve(store, historyRunPath(bundle.run)), bundle, true)
  writeJson(resolve(store, 'index.json'), { schemaVersion: 1, runs: [] }, true)
  writeJson(resolve(store, 'pending/pr-7.json'), { id: bundle.run.id, attempt: 1 }, true)
  const preview = {
    number: 7, head: bundle.run.pullRequest!.head, base: bundle.run.pullRequest!.base,
    runId: 99, attempt: 1, artifactId: 100, directory: previewDirectory, includePending: true,
  }
  const output = resolve(temporary, 'site')
  assembleSite({ production, store, output, repository, previews: [preview] })
  assert.deepEqual(readJson(resolve(output, 'data/index.json')), { schemaVersion: 1, runs: [] })
  assert.equal(existsSync(resolve(output, 'data', historyRunPath(bundle.run))), false)
  const previewIndex = readJson(resolve(output, 'previews/pr-7/data/index.json')) as any
  assert.equal(previewIndex.preview.head, preview.head)
  assert.deepEqual(previewIndex.preview.pending, { id: bundle.run.id, attempt: 1 })
  context.mock.method(globalThis, 'fetch', async (input: URL) => {
    const path = resolve(output, `.${input.pathname}`)
    return existsSync(path) ? Response.json(readJson(path)) : new Response(null, { status: 404 })
  })
  assert.equal(await loadHistory(new URL('https://fixture.test/data/index.json')), null)
  const dataset = await loadHistory(new URL('https://fixture.test/previews/pr-7/data/index.json'))
  assert.equal(dataset!.runs.length, 1)
  assert.equal(dataset!.preview!.number, 7)
  const staleOutput = resolve(temporary, 'stale')
  assembleSite({ production, store, output: staleOutput, repository, previews: [{ ...preview, head: 'f'.repeat(40) }] })
  assert.equal((readJson(resolve(staleOutput, 'previews/pr-7/data/index.json')) as any).preview.pending, null)
  const skippedOutput = resolve(temporary, 'skipped')
  assembleSite({ production, store, output: skippedOutput, repository, previews: [{ ...preview, includePending: false }] })
  assert.equal((readJson(resolve(skippedOutput, 'previews/pr-7/data/index.json')) as any).runs.length, 0)
  const closedOutput = resolve(temporary, 'closed')
  assembleSite({ production, store, output: closedOutput, repository, previews: [] })
  assert.equal(existsSync(resolve(closedOutput, 'previews/pr-7')), false)
  symlinkSync(resolve(production, 'index.html'), resolve(previewDirectory, 'linked.html'))
  const unsafeOutput = resolve(temporary, 'unsafe')
  assert.throws(() => assembleSite({ production, store, output: unsafeOutput, repository, previews: [preview] }), /symbolic link/)
  assert.equal(existsSync(unsafeOutput), false)
})

function fixture() {
  const bundle = structuredClone(createMockBundles()[0]!)
  bundle.source = 'published'
  bundle.run.id = '12345'
  bundle.run.pullRequest = { repository, number: 7, head: 'a'.repeat(40), base: 'b'.repeat(40) }
  bundle.run.workflow.url = `https://github.com/${repository}/actions/runs/12345/attempts/1`
  bundle.run.commit.url = `https://github.com/${repository}/commit/${bundle.run.commit.sha}`
  for (const runner of bundle.runners) {
    runner.region = 'fixture-region'
    runner.os.version = 'fixture-version'
    runner.cpu = { model: 'fixture-cpu', logicalProcessors: 8, cores: 4, threadsPerCore: 2 }
    runner.tools = { node: 'fixture' }
    runner.dependencies = { wasmtime: 'fixture' }
  }
  return validatePublishableRun(bundle, publicationPolicy)
}

function publication(bundle = fixture()) {
  return {
    schemaVersion: 1, run: { id: bundle.run.id, attempt: bundle.run.attempt },
    pullRequest: bundle.run.pullRequest,
    merge: { sha: 'c'.repeat(40), tree: bundle.run.commit.tree, mergedAt: '2026-09-15T00:00:00Z', message: 'Benchmark results (#7)' },
  }
}

test('benchmark definition changes retain selectable histories and pending previews', async context => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'benchmark-histories-'))
  context.after(() => rmSync(temporary, { recursive: true, force: true }))
  const store = resolve(temporary, 'store')
  const first = fixture()
  first.run.createdAt = '2026-09-01T00:00:00Z'
  storeRun(store, first)
  promoteRun(store, publication(first))
  const original = readFileSync(resolve(store, historyRunPath(first.run)), 'utf8')
  const bundles = [first]
  for (const change of ['version', 'settings', 'metric'] as const) {
    const next = structuredClone(bundles.at(-1)!)
    const number = bundles.length
    next.run.id = String(12345 + number)
    next.run.createdAt = `2026-09-0${number + 1}T00:00:00Z`
    next.run.pullRequest!.number = 7 + number
    next.run.workflow.url = `https://github.com/${repository}/actions/runs/${next.run.id}/attempts/1`
    if (change === 'settings') next.benchmark.settings.durationSeconds = 120
    if (change === 'metric') next.catalog.metrics[0]!.methodVersion++
    if (change !== 'version') assert.throws(() => groupHistories([...bundles, next]), /Bump the benchmark version/)
    next.benchmark.version++
    const policy = { ...publicationPolicy, catalog: next.catalog, benchmark: next.benchmark }
    assert.throws(() => validateHistory([first, next]))
    storeRun(store, next, policy)
    const record = publication(next)
    const titled = { ...record, merge: { ...record.merge, message: 'Improve benchmarks (#10)\n\nCommit details' } }
    promoteRun(store, titled, policy)
    promoteRun(store, titled, policy)
    bundles.push(next)
  }
  assert.equal(readFileSync(resolve(store, historyRunPath(first.run)), 'utf8'), original)
  assert.equal(groupHistories(bundles).length, 4)
  const reordered = structuredClone(first)
  reordered.run.id = 'reordered'
  reordered.catalog.metrics.reverse()
  reordered.catalog.runtimes.reverse()
  assert.deepEqual(groupHistories([first, reordered]), [[first, reordered]])
  assert.throws(() => groupHistories([first, first]), /Duplicate run/)
  assert.throws(() => groupHistories([first, { ...reordered, source: 'local' }]), /sources differ/)

  const production = resolve(temporary, 'build')
  mkdirSync(production)
  writeFileSync(resolve(production, 'index.html'), '<!doctype html><title>Fixture</title>')
  const pending = fixture()
  pending.run.id = 'pending'
  pending.run.createdAt = '2026-09-05T00:00:00Z'
  pending.benchmark.version = 99
  writeJson(resolve(store, historyRunPath(pending.run)), pending, true)
  writeJson(resolve(store, 'pending/pr-7.json'), { id: pending.run.id, attempt: 1 }, true)
  const site = resolve(temporary, 'site')
  assembleSite({ production, store, output: site, repository, previews: [{
    number: 7, head: pending.run.pullRequest!.head, base: pending.run.pullRequest!.base,
    runId: 99, attempt: 1, artifactId: 100, directory: production, includePending: true,
  }] })
  context.mock.method(globalThis, 'fetch', async (url: URL) => Response.json(readJson(resolve(site, `.${url.pathname}`))))
  const url = new URL('https://fixture.test/data/index.json')
  const latest = await loadHistory(url)
  assert.equal(latest!.histories!.length, 4)
  assert.equal(latest!.historyId, String(bundles.at(-1)!.benchmark.version))
  assert.deepEqual(latest!.runs.map(run => run.id), [runKey(bundles.at(-1)!)])
  assert.equal(latest!.runs[0]!.message, 'Improve benchmarks (#10)')
  assert.equal(latest!.runs[0]!.commit, 'ccccccc')
  assert.equal(latest!.runs[0]!.commitUrl, `https://github.com/${repository}/commit/${'c'.repeat(40)}`)
  assert.deepEqual(latest!.runs[0]!.bundle, bundles.at(-1))
  const older = await loadHistory(url, String(first.benchmark.version))
  assert.equal(older!.historyId, String(first.benchmark.version))
  assert.deepEqual(older!.runs.map(run => run.id), [runKey(first)])
  assert.equal(older!.runs[0]!.message, 'Benchmark results (#7)')
  const compared = await loadHistory(url, `${first.benchmark.version},${bundles.at(-1)!.benchmark.version}`)
  assert.equal(compared!.historyId, `${first.benchmark.version},${bundles.at(-1)!.benchmark.version}`)
  assert.deepEqual(compared!.runs.map(run => run.id), [runKey(first), runKey(bundles.at(-1)!)])
  await assert.rejects(loadHistory(url, 'missing'), /Benchmark version not found/)
  await assert.rejects(loadHistory(url, `${first.benchmark.version},missing`), /Benchmark version not found/)
  await assert.rejects(loadHistory(url, `${first.benchmark.version},${first.benchmark.version}`), /Invalid benchmark version selection/)
  assert.deepEqual((await loadHistory(url, undefined, runKey(first)))!.runs.map(run => run.id), [runKey(first)])
  assert.equal((await loadHistory(url, String(first.benchmark.version), runKey(bundles.at(-1)!)))!.historyId, String(first.benchmark.version))
  const previewUrl = new URL('https://fixture.test/previews/pr-7/data/index.json')
  const preview = await loadHistory(previewUrl)
  assert.equal(preview!.histories!.length, 5)
  assert.equal(preview!.historyId, '99')
  assert.deepEqual(preview!.runs.map(run => run.id), [runKey(pending)])
  assert.equal(preview!.runs[0]!.commit, pending.run.commit.sha.slice(0, 7))
  assert.deepEqual((await loadHistory(previewUrl, String(first.benchmark.version)))!.runs.map(run => run.id), [runKey(first)])
})

test('local result storage and promotion', async context => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'benchmark-publication-'))
  context.after(() => rmSync(temporary, { recursive: true, force: true }))
  const store = resolve(temporary, 'data')
  const input = resolve(temporary, 'input.json')
  const invoke = (command: string, value: unknown, expected = 0) => {
    writeJson(input, value, false)
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/publish-results.ts'), command, '--directory', store, input], { encoding: 'utf8' })
    assert.equal(result.status, expected, result.stderr)
    return result.stderr
  }
  const bundle = fixture()
  const bundlePath = resolve(store, historyRunPath(bundle.run))
  await context.test('archive is immutable and does not enter history', () => {
    invoke('store', bundle)
    const original = readFileSync(bundlePath, 'utf8')
    invoke('store', bundle)
    assert.equal(readFileSync(bundlePath, 'utf8'), original)
    assert.equal(existsSync(resolve(store, 'index.json')), false)
    const conflict = structuredClone(bundle)
    conflict.run.commit.message = 'conflicting fixture'
    assert.match(invoke('store', conflict, 1), /Conflicting immutable/)
    assert.equal(readFileSync(bundlePath, 'utf8'), original)
  })
  await context.test('incomplete and synthetic runs fail', () => {
    const incomplete = structuredClone(bundle)
    incomplete.measurements.pop()
    assert.match(invoke('store', incomplete, 1), /Missing successful/)
    assert.match(invoke('store', createMockBundles()[0], 1), /measured results/)
  })
  await context.test('stale provenance fails before index writes', () => {
    const stale = publication()
    stale.pullRequest!.head = 'd'.repeat(40)
    assert.match(invoke('promote', stale, 1), /PR revisions/)
    const mismatch = publication()
    mismatch.merge.tree = 'e'.repeat(40)
    assert.match(invoke('promote', mismatch, 1), /source tree/)
    assert.equal(existsSync(resolve(store, 'index.json')), false)
  })
  await context.test('promotion and retry preserve measurements and one index entry', () => {
    const original = readFileSync(bundlePath, 'utf8')
    invoke('promote', publication())
    invoke('promote', publication())
    assert.deepEqual(readJson(resolve(store, 'index.json')), { schemaVersion: 1, runs: [{ id: '12345', attempt: 1 }] })
    assert.equal(readFileSync(bundlePath, 'utf8'), original)
  })
  await context.test('retry repairs an interrupted index update', () => {
    rmSync(resolve(store, 'index.json'))
    invoke('promote', publication())
    assert.deepEqual(readJson(resolve(store, 'index.json')), { schemaVersion: 1, runs: [{ id: '12345', attempt: 1 }] })
  })
  await context.test('another attempt cannot replace a published PR', () => {
    const retry = structuredClone(bundle)
    retry.run.attempt = 2
    retry.run.workflow.url = `https://github.com/${repository}/actions/runs/12345/attempts/2`
    invoke('store', retry)
    assert.match(invoke('promote', publication(retry), 1), /different publication/)
  })
  await context.test('exclusive lock blocks concurrent writers and releases on failure', () => {
    withStoreLock(store, () => assert.match(invoke('store', bundle, 1), /locked/))
    assert.throws(() => withStoreLock(store, () => { throw new Error('fixture failure') }), /fixture failure/)
    assert.equal(existsSync(resolve(store, '.publication-lock')), false)
    invoke('store', bundle)
  })
})

test('label-only eligibility with simulated GitHub responses', async context => {
  process.env.GITHUB_REPOSITORY = repository
  process.env.GH_TOKEN = 'fixture-token'
  const { eligibility } = await import('./github-pr.ts')
  const pr = {
    number: 7, base: { ref: 'main', repo: { full_name: repository }, sha: 'b'.repeat(40) },
    head: { sha: 'a'.repeat(40) }, labels: [] as { name: string }[], changed_files: 1,
  }
  const requests: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    const path = new URL(url).pathname.replace(`/repos/${repository}/`, '')
    requests.push(path)
    const responses: Record<string, unknown> = {
      'pulls/7': pr,
    }
    assert.ok(path in responses, `Unexpected GitHub request: ${path}`)
    return Response.json(responses[path])
  })
  await context.test('adding and removing the label updates the decision without comments', async () => {
    assert.equal((await eligibility(7)).decision.mode, 'required')
    pr.labels = [{ name: 'benchmarks: skip' }]
    const skipped = (await eligibility(7)).decision
    assert.equal(skipped.mode, 'skip')
    assert.equal(skipped.approver, null)
    pr.labels = []
    assert.equal((await eligibility(7)).decision.mode, 'required')
    assert.deepEqual(requests, ['pulls/7', 'pulls/7', 'pulls/7'])
  })
  await context.test('skipping does not inspect files or the label actor', async () => {
    pr.labels = [{ name: 'benchmarks: skip' }]
    pr.changed_files = 2
    assert.equal((await eligibility(7)).decision.mode, 'skip')
    assert.ok(requests.every(path => path === 'pulls/7'))
  })
})

test('workflows must match trusted main', async context => {
  process.env.GITHUB_REPOSITORY = repository
  process.env.GH_TOKEN = 'fixture-token'
  const { workflowTrusted } = await import('./github-pr.ts')
  const temporary = mkdtempSync(resolve(tmpdir(), 'benchmark-workflow-trust-'))
  const previousDirectory = process.cwd()
  context.after(() => {
    process.chdir(previousDirectory)
    rmSync(temporary, { recursive: true, force: true })
  })
  process.chdir(temporary)
  mkdirSync('.github/workflows', { recursive: true })
  const head = 'a'.repeat(40)
  let content = 'trusted workflow'
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    const path = new URL(url).pathname.replace(`/repos/${repository}/`, '')
    assert.ok(path.startsWith('contents/'), `Unexpected GitHub request: ${path}`)
    return Response.json({ encoding: 'base64', content: Buffer.from(content).toString('base64') })
  })
  for (const workflow of ['benchmark', 'benchmark-trigger', 'preview']) {
    const path = `.github/workflows/${workflow}.yml`
    writeFileSync(path, 'trusted workflow')
    content = 'trusted workflow'
    assert.equal(await workflowTrusted(path, head), true)
    content = 'changed workflow'
    assert.equal(await workflowTrusted(path, head), false)
  }
})

test('Pages verifies previews with revision and build jobs and excludes draft PRs', async context => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'benchmark-preview-policy-'))
  const previousDirectory = process.cwd()
  const previousArguments = process.argv
  const previousEnvironment = { GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY, GH_TOKEN: process.env.GH_TOKEN }
  context.after(() => {
    process.chdir(previousDirectory)
    process.argv = previousArguments
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(temporary, { recursive: true, force: true })
  })
  process.chdir(temporary)
  process.argv = [process.execPath, resolve(root, 'scripts/site-ci.ts'), 'verify']
  process.env.GITHUB_REPOSITORY = repository
  process.env.GH_TOKEN = 'fixture-token'
  const pr = {
    number: 7, draft: false, user: { login: 'dependabot[bot]' }, labels: [],
    head: { sha: 'a'.repeat(40), repo: { full_name: repository } },
    base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: repository } },
  }
  const workflow = readFileSync(resolve(root, '.github/workflows/preview.yml'), 'utf8')
  mkdirSync('.github/workflows', { recursive: true })
  writeFileSync('.github/workflows/preview.yml', workflow)
  const run = {
    id: 123, run_attempt: 1, event: 'pull_request', path: '.github/workflows/preview.yml',
    conclusion: 'success', head_sha: pr.head.sha, head_repository: pr.head.repo,
    pull_requests: [{ number: pr.number }],
  }
  const artifact = {
    id: 456, name: `preview-${pr.number}-${pr.head.sha}-1`, expired: false,
    size_in_bytes: 1024, workflow_run: { id: run.id },
  }
  writeJson(resolve(temporary, 'site-state.json'), {
    main: pr.base.sha, data: null,
    open: [{ number: pr.number, head: pr.head.sha, base: pr.base.sha }],
    previews: [{ number: pr.number, head: pr.head.sha, base: pr.base.sha,
      runId: run.id, attempt: run.run_attempt, artifactId: artifact.id, includePending: true }],
  }, false)
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    const path = new URL(url).pathname.replace(`/repos/${repository}/`, '')
    const responses: Record<string, unknown> = {
      'git/ref/heads/main': { object: { sha: pr.base.sha } },
      'git/matching-refs/heads/data': [],
      pulls: [pr, { ...pr, number: 9, draft: true }],
      'pulls/7': pr,
      'actions/runs/123': run,
      'actions/artifacts/456': artifact,
      'actions/runs/123/attempts/1/jobs': { jobs: [
        { name: 'revision', conclusion: 'success' }, { name: 'build', conclusion: 'success' },
      ] },
      'contents/.github/workflows/preview.yml': { encoding: 'base64', content: Buffer.from(workflow).toString('base64') },
    }
    assert.ok(path in responses, `Unexpected GitHub request: ${path}`)
    return Response.json(responses[path])
  })
  await import('./site-ci.ts')
})

test('CI archival and promotion with simulated GitHub and Git', async context => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'benchmark-ci-publication-'))
  const previousDirectory = process.cwd()
  const previousOutput = process.env.GITHUB_OUTPUT
  const outputPath = resolve(temporary, 'output')
  process.env.GITHUB_OUTPUT = outputPath
  process.chdir(temporary)
  context.after(() => {
    context.mock.restoreAll()
    syncBuiltinESMExports()
    process.chdir(previousDirectory)
    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT
    else process.env.GITHUB_OUTPUT = previousOutput
    rmSync(temporary, { recursive: true, force: true })
  })
  process.env.GITHUB_REPOSITORY = repository
  process.env.GH_TOKEN = 'fixture-token'
  process.env.GITHUB_EVENT_NAME = 'workflow_run'
  process.env.GITHUB_RUN_ID = '999'
  process.env.GITHUB_RUN_ATTEMPT = '2'
  const eventPath = resolve(temporary, 'event.json')
  process.env.GITHUB_EVENT_PATH = eventPath
  const notification = { workflow_run: {
    id: 12345, run_attempt: 1, event: 'pull_request', conclusion: 'success', head_sha: 'a'.repeat(40), pull_requests: [{ number: 7 }],
  } }
  writeJson(eventPath, notification, false)
  const triggerWorkflow = readFileSync(resolve(root, '.github/workflows/benchmark-trigger.yml'), 'utf8')
  let triggerWorkflowContent = triggerWorkflow
  const workloadWorkflow = readFileSync(resolve(root, '.github/workflows/benchmark.yml'), 'utf8')
  const bundle = fixture()
  const pr = {
    number: 7, base: { ref: 'main', repo: { full_name: repository }, sha: bundle.run.pullRequest!.base },
    head: { sha: bundle.run.pullRequest!.head }, labels: [] as { name: string }[], changed_files: 1,
    state: 'open', merged: false, merge_commit_sha: 'c'.repeat(40), merged_at: '2026-09-15T00:00:00Z',
  }
  let mergedTree = bundle.run.commit.tree
  let workflowHead = pr.head.sha
  let failedJob = false
  let pushes = 0
  let downloads = 0
  const jobs = ['workload / eligibility', 'workload / configure', 'workload / producer',
    'workload / collect', 'workload / Workload Status', 'Benchmark Status',
    ...Array.from({ length: 2 }, (_, index) => `workload / prepare (${index})`),
    ...Array.from({ length: 36 }, (_, index) => `workload / measure (${index})`),
  ].map(name => ({ name, conclusion: 'success' }))
  let retryJobs: typeof jobs = []
  const statuses: any[] = []
  context.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(`/repos/${repository}/`, '')
    if (path.startsWith('statuses/')) {
      assert.equal(path, `statuses/${pr.head.sha}`)
      assert.equal(options?.method, 'POST')
      const status = JSON.parse(String(options?.body))
      assert.equal(status.context, 'Benchmark Publication')
      assert.equal(status.target_url, `https://github.com/${repository}/actions/runs/999/attempts/2`)
      statuses.push(status)
      return Response.json(status)
    }
    if (path.endsWith('/jobs')) {
      const page = Number(parsed.searchParams.get('page'))
      const response = structuredClone(path.includes('/attempts/2/') ? retryJobs : jobs)
      if (failedJob && !path.includes('/attempts/2/')) response[0]!.conclusion = 'failure'
      return Response.json({ jobs: response.slice((page - 1) * 100, page * 100), total_count: response.length })
    }
    const responses: Record<string, unknown> = {
      'pulls/7': pr,
      [`commits/${pr.merge_commit_sha}/pulls`]: [pr],
      [`commits/${'d'.repeat(40)}/pulls`]: [pr],
      'actions/runs/12345/attempts/1': { id: 12345, event: 'pull_request', conclusion: 'success', path: '.github/workflows/benchmark-trigger.yml', head_sha: workflowHead, created_at: bundle.run.createdAt },
      'actions/runs/12345/attempts/2': { id: 12345, event: 'pull_request', conclusion: 'success', path: '.github/workflows/benchmark-trigger.yml', head_sha: workflowHead, created_at: bundle.run.createdAt },
      'contents/.github/workflows/benchmark-trigger.yml': { encoding: 'base64', content: Buffer.from(triggerWorkflowContent).toString('base64') },
      'contents/.github/workflows/benchmark.yml': { encoding: 'base64', content: Buffer.from(workloadWorkflow).toString('base64') },
      [`git/commits/${bundle.run.commit.sha}`]: { tree: { sha: bundle.run.commit.tree }, parents: [{ sha: bundle.run.pullRequest!.base }, { sha: bundle.run.pullRequest!.head }] },
      [`git/commits/${pr.merge_commit_sha}`]: { tree: { sha: mergedTree }, message: 'Benchmark results (#7)' },
    }
    assert.ok(path in responses, `Unexpected GitHub request: ${path}`)
    return Response.json(responses[path])
  })
  context.mock.method(childProcess, 'spawnSync', (command: string, args: string[]) => {
    if (command === 'gh') {
      assert.deepEqual(args.slice(0, 2), ['run', 'download'])
      downloads++
      writeJson(resolve(temporary, 'incoming-results/run.json'), bundle, false)
    } else {
      assert.equal(command, 'git')
      assert.ok(['init', 'remote', 'ls-remote', 'config', 'add', 'diff', 'commit', 'push'].includes(args[0]!))
      if (args[0] === 'push') pushes++
    }
    return { status: 0, stdout: command === 'git' && args[0] === 'diff' ? 'fixture changes' : '', stderr: '' }
  })
  syncBuiltinESMExports()
  mkdirSync(resolve(temporary, '.github/workflows'), { recursive: true })
  writeFileSync(resolve(temporary, '.github/workflows/benchmark-trigger.yml'), triggerWorkflow)
  writeFileSync(resolve(temporary, '.github/workflows/benchmark.yml'), workloadWorkflow)
  const { main } = await import('./publish-ci.ts')
  const clearStore = () => {
    rmSync(resolve(temporary, 'data-store'), { recursive: true, force: true })
    rmSync(outputPath, { force: true })
    pushes = 0
    downloads = 0
  }
  await context.test('archive retains pending data without indexing it', async () => {
    await main()
    assert.equal(pushes, 1)
    assert.equal(readFileSync(outputPath, 'utf8'), 'changed=true\n')
    assert.equal(downloads, 1)
    assert.deepEqual(readJson(resolve(temporary, 'data-store/index.json')), { schemaVersion: 1, runs: [] })
    assert.ok(existsSync(resolve(temporary, 'data-store/policies/12345/1.json')))
    assert.deepEqual(statuses.map(status => status.state), ['pending', 'success'])
  })
  await context.test('main push promotes the archived candidate through commit association', async () => {
    pr.merged = true
    pr.state = 'closed'
    process.env.GITHUB_EVENT_NAME = 'push'
    writeJson(eventPath, {
      ref: 'refs/heads/main', after: pr.merge_commit_sha, commits: [{ id: pr.merge_commit_sha }],
    }, false)
    try {
      await main()
      assert.equal(downloads, 1)
      assert.equal(pushes, 2)
      assert.deepEqual(readJson(resolve(temporary, 'data-store/index.json')), { schemaVersion: 1, runs: [{ id: '12345', attempt: 1 }] })
    } finally {
      process.env.GITHUB_EVENT_NAME = 'workflow_run'
      writeJson(eventPath, notification, false)
    }
  })
  await context.test('push ignores associated PRs whose merge commit is outside the push', async () => {
    const previousPushes = pushes
    process.env.GITHUB_EVENT_NAME = 'push'
    writeJson(eventPath, {
      ref: 'refs/heads/main', after: 'd'.repeat(40), commits: [{ id: 'd'.repeat(40) }],
    }, false)
    try {
      await main()
      assert.equal(pushes, previousPushes)
      assert.equal(downloads, 1)
      writeJson(eventPath, { ref: 'refs/heads/main' }, false)
      await assert.rejects(main(), /commit list is unavailable or truncated/)
    } finally {
      process.env.GITHUB_EVENT_NAME = 'workflow_run'
      writeJson(eventPath, notification, false)
    }
  })
  await context.test('stale workflow and failed jobs cannot download artifacts', async () => {
    clearStore()
    workflowHead = 'e'.repeat(40)
    await assert.rejects(main(), /stale/)
    workflowHead = pr.head.sha
    failedJob = true
    await assert.rejects(main(), /successful eligibility/)
    assert.equal(statuses.at(-1).state, 'failure')
    failedJob = false
    assert.equal(downloads, 0)
    assert.equal(pushes, 0)
  })
  await context.test('partial retry archives and promotes retained successful jobs', async () => {
    clearStore()
    const originalUrl = bundle.run.workflow.url
    bundle.run.attempt = 2
    bundle.run.workflow.url = `https://github.com/${repository}/actions/runs/12345/attempts/2`
    retryJobs = jobs.filter(job => ['eligibility', 'measure (0)', 'collect', 'Workload Status', 'Benchmark Status']
      .includes(job.name.split(' / ').at(-1)!))
    failedJob = true
    writeJson(eventPath, { workflow_run: { ...notification.workflow_run, run_attempt: 2 } }, false)
    try {
      await main()
      assert.equal(downloads, 1)
      assert.equal(pushes, 2)
      assert.deepEqual(readJson(resolve(temporary, 'data-store/index.json')), { schemaVersion: 1, runs: [{ id: '12345', attempt: 2 }] })
      const stored = validateCompleteRun(readJson(resolve(temporary, 'data-store/runs/12345/2.json')))
      assert.deepEqual(stored.measurements, bundle.measurements)
      retryJobs = retryJobs.map(job => ({ ...job, conclusion: job.name.endsWith('measure (0)') ? 'failure' : 'success' }))
      await assert.rejects(main(), /successful measure/)
      assert.equal(downloads, 1, 'A failed retry must not use an earlier successful job')
      retryJobs = retryJobs.filter(job => !job.name.endsWith('eligibility'))
      await assert.rejects(main(), /successful eligibility/)
      assert.equal(downloads, 1)
    } finally {
      bundle.run.attempt = 1
      bundle.run.workflow.url = originalUrl
      retryJobs = []
      failedJob = false
      writeJson(eventPath, notification, false)
      clearStore()
    }
  })
  await context.test('label changes prevent archival and promotion', async () => {
    pr.labels = [{ name: 'benchmarks: skip' }]
    await main()
    assert.equal(downloads, 0)
    assert.equal(pushes, 0)
    assert.equal(existsSync(outputPath), false)
    pr.labels = []
  })
  await context.test('cache-warming completions do not archive results', async () => {
    clearStore()
    writeJson(eventPath, { workflow_run: { ...notification.workflow_run, event: 'push' } }, false)
    try {
      await main()
      assert.equal(downloads, 0)
      assert.equal(pushes, 0)
      assert.equal(existsSync(resolve(temporary, 'data-store')), false)
    } finally {
      writeJson(eventPath, notification, false)
    }
  })
  await context.test('stale notifications cannot update the current PR status', async () => {
    const count = statuses.length
    writeJson(eventPath, { workflow_run: { ...notification.workflow_run, head_sha: 'e'.repeat(40) } }, false)
    try {
      await assert.rejects(main(), /stale/)
      assert.equal(statuses.length, count)
    } finally {
      writeJson(eventPath, notification, false)
    }
  })
  await context.test('changed workflows cannot archive before matching main', async () => {
    clearStore()
    triggerWorkflowContent = `${triggerWorkflow}\n`
    pr.merged = false
    pr.state = 'open'
    try {
      await assert.rejects(main(), /workflow files must match current main/)
      assert.equal(downloads, 0)
      assert.equal(pushes, 0)
      assert.equal(statuses.at(-1).state, 'failure')
    } finally {
      triggerWorkflowContent = triggerWorkflow
      pr.merged = true
      pr.state = 'closed'
      clearStore()
    }
  })
  await context.test('merge with no archive reports failure and requires manual archival', async () => {
    clearStore()
    process.env.GITHUB_EVENT_NAME = 'push'
    writeJson(eventPath, { ref: 'refs/heads/main', after: pr.merge_commit_sha, commits: [{ id: pr.merge_commit_sha }] }, false)
    try {
      await assert.rejects(main(), /pending results are missing/)
      assert.equal(downloads, 0)
      assert.equal(pushes, 0)
      assert.equal(statuses.at(-1).state, 'failure')
    } finally {
      process.env.GITHUB_EVENT_NAME = 'workflow_run'
      writeJson(eventPath, notification, false)
    }
  })
  await context.test('promotion failure after merge still retains the valid archive remotely', async () => {
    clearStore()
    mergedTree = 'f'.repeat(40)
    await assert.rejects(main(), /source tree/)
    assert.equal(pushes, 1, 'Archival must finish before promotion can fail')
    assert.deepEqual(readJson(resolve(temporary, 'data-store/index.json')), { schemaVersion: 1, runs: [] })
  })
})