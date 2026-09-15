import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { publicationPolicy } from '../shared/catalog.ts'
import { groupHistories, historyRunPath, parseHistoryRun, runKey, validateCompleteRun, validateHistory, validatePublishableRun } from '../shared/results.ts'
import { createMockBundles } from '../src/mock-data.ts'
import { readJson, writeJson, withStoreLock } from './result-store.ts'
import { assembleSite } from './assemble-site.ts'
import { loadHistory } from '../src/data.ts'
import { promoteRun, storeRun } from './publish-results.ts'

const repository = 'example/benchmarks'
const root = resolve(import.meta.dirname, '..')

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
    merge: { sha: 'c'.repeat(40), tree: bundle.run.commit.tree, mergedAt: '2026-09-15T00:00:00Z' },
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
    if (change === 'version') next.benchmark.version++
    if (change === 'settings') next.benchmark.settings.durationSeconds = 120
    if (change === 'metric') next.catalog.metrics[0]!.methodVersion++
    const policy = { ...publicationPolicy, catalog: next.catalog, benchmark: next.benchmark }
    assert.throws(() => validateHistory([first, next]))
    storeRun(store, next, policy)
    promoteRun(store, publication(next), policy)
    promoteRun(store, publication(next), policy)
    bundles.push(next)
  }
  assert.equal(readFileSync(resolve(store, historyRunPath(first.run)), 'utf8'), original)
  assert.equal(groupHistories(bundles).length, 4)
  const reordered = structuredClone(first)
  reordered.run.id = 'reordered'
  reordered.catalog.metrics.reverse()
  reordered.catalog.runtimes.reverse()
  assert.equal(groupHistories([first, reordered]).length, 1)
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
  assert.deepEqual(latest!.runs.map(run => run.id), [runKey(bundles.at(-1)!)])
  const older = await loadHistory(url, runKey(first))
  assert.deepEqual(older!.runs.map(run => run.id), [runKey(first)])
  assert.equal((await loadHistory(url, 'missing'))!.historyId, latest!.historyId)
  const previewUrl = new URL('https://fixture.test/previews/pr-7/data/index.json')
  const preview = await loadHistory(previewUrl)
  assert.equal(preview!.histories!.length, 5)
  assert.deepEqual(preview!.runs.map(run => run.id), [runKey(pending)])
  assert.deepEqual((await loadHistory(previewUrl, runKey(first)))!.runs.map(run => run.id), [runKey(first)])
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
  let files: { filename: string, previous_filename?: string }[] = [{ filename: 'README.md' }]
  let permission = 'write'
  const requests: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    const path = new URL(url).pathname.replace(`/repos/${repository}/`, '')
    requests.push(path)
    const responses: Record<string, unknown> = {
      'pulls/7': pr, 'pulls/7/files': files,
      'issues/7/events': [{ event: 'labeled', label: { name: 'benchmarks: skip' }, actor: { login: 'maintainer' } }],
      'collaborators/maintainer/permission': { permission },
    }
    assert.ok(path in responses, `Unexpected GitHub request: ${path}`)
    return Response.json(responses[path])
  })
  await context.test('adding and removing the label updates the decision without comments', async () => {
    assert.equal((await eligibility(7)).decision.mode, 'required')
    pr.labels = [{ name: 'benchmarks: skip' }]
    const skipped = (await eligibility(7)).decision
    assert.equal(skipped.mode, 'skip')
    assert.equal(skipped.approver, 'maintainer')
    pr.labels = []
    assert.equal((await eligibility(7)).decision.mode, 'required')
    assert.equal(requests.some(path => path.includes('comments')), false)
  })
  await context.test('unauthorized labels and sensitive renames fail', async () => {
    pr.labels = [{ name: 'benchmarks: skip' }]
    permission = 'read'
    await assert.rejects(eligibility(7), /maintainer/)
    permission = 'write'
    files = [{ filename: 'README.md', previous_filename: 'Cargo.toml' }]
    await assert.rejects(eligibility(7), /benchmark-sensitive/)
  })
  await context.test('truncated changed-file lists fail', async () => {
    files = [{ filename: 'README.md' }]
    pr.changed_files = 2
    await assert.rejects(eligibility(7), /complete changed-file/)
  })
})

test('CI archival and promotion with simulated GitHub and Git', async context => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'benchmark-ci-publication-'))
  const previousDirectory = process.cwd()
  process.chdir(temporary)
  context.after(() => {
    context.mock.restoreAll()
    syncBuiltinESMExports()
    process.chdir(previousDirectory)
    rmSync(temporary, { recursive: true, force: true })
  })
  process.env.GITHUB_REPOSITORY = repository
  process.env.GH_TOKEN = 'fixture-token'
  process.env.GITHUB_EVENT_NAME = 'workflow_run'
  const eventPath = resolve(temporary, 'event.json')
  process.env.GITHUB_EVENT_PATH = eventPath
  const notification = { workflow_run: {
    id: 12345, run_attempt: 1, event: 'pull_request', conclusion: 'success', pull_requests: [{ number: 7 }],
  } }
  writeJson(eventPath, notification, false)
  const workflow = readFileSync(resolve(root, '.github/workflows/benchmark.yml'), 'utf8')
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
  const jobs = ['eligibility', 'configure', 'producer', 'collect', 'Benchmark Status',
    ...Array.from({ length: 2 }, (_, index) => `prepare (${index})`),
    ...Array.from({ length: 108 }, (_, index) => `measure (${index})`),
  ].map(name => ({ name, conclusion: 'success' }))
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    const parsed = new URL(url)
    const path = parsed.pathname.replace(`/repos/${repository}/`, '')
    if (path.endsWith('/jobs')) {
      const page = Number(parsed.searchParams.get('page'))
      const response = structuredClone(jobs)
      if (failedJob) response[0]!.conclusion = 'failure'
      return Response.json({ jobs: response.slice((page - 1) * 100, page * 100), total_count: response.length })
    }
    const responses: Record<string, unknown> = {
      'pulls/7': pr,
      [`commits/${pr.merge_commit_sha}/pulls`]: [pr],
      [`commits/${'d'.repeat(40)}/pulls`]: [pr],
      'pulls/7/files': [{ filename: 'README.md' }],
      'issues/7/events': [{ event: 'labeled', label: { name: 'benchmarks: skip' }, actor: { login: 'maintainer' } }],
      'collaborators/maintainer/permission': { permission: 'write' },
      'actions/runs/12345/attempts/1': { id: 12345, event: 'pull_request', conclusion: 'success', path: '.github/workflows/benchmark.yml', head_sha: workflowHead, created_at: bundle.run.createdAt },
      'contents/.github/workflows/benchmark.yml': { encoding: 'base64', content: Buffer.from(workflow).toString('base64') },
      [`git/commits/${bundle.run.commit.sha}`]: { tree: { sha: bundle.run.commit.tree }, parents: [{ sha: bundle.run.pullRequest!.base }, { sha: bundle.run.pullRequest!.head }] },
      [`git/commits/${pr.merge_commit_sha}`]: { tree: { sha: mergedTree } },
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
  writeFileSync(resolve(temporary, '.github/workflows/benchmark.yml'), workflow)
  const { main } = await import('./publish-ci.ts')
  const clearStore = () => {
    rmSync(resolve(temporary, 'data-store'), { recursive: true, force: true })
    pushes = 0
    downloads = 0
  }
  await context.test('archive retains pending data without indexing it', async () => {
    await main()
    assert.equal(pushes, 1)
    assert.equal(downloads, 1)
    assert.deepEqual(readJson(resolve(temporary, 'data-store/index.json')), { schemaVersion: 1, runs: [] })
    assert.ok(existsSync(resolve(temporary, 'data-store/policies/12345/1.json')))
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
    failedJob = false
    assert.equal(downloads, 0)
    assert.equal(pushes, 0)
  })
  await context.test('label changes prevent archival and promotion', async () => {
    pr.labels = [{ name: 'benchmarks: skip' }]
    await main()
    assert.equal(downloads, 0)
    assert.equal(pushes, 0)
    pr.labels = []
  })
  await context.test('promotion failure after merge still retains the valid archive remotely', async () => {
    clearStore()
    mergedTree = 'f'.repeat(40)
    await assert.rejects(main(), /source tree/)
    assert.equal(pushes, 1, 'Archival must finish before promotion can fail')
    assert.deepEqual(readJson(resolve(temporary, 'data-store/index.json')), { schemaVersion: 1, runs: [] })
  })
})