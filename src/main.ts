import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import './style.css'
import { Chart, registerables } from 'chart.js'
import { createIcons, Download, Link, ArrowUpRight, AlertTriangle, RotateCcw, ChevronRight, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide'
import { loadDataset } from './data'
import { catalog } from '../shared/catalog.ts'
import { runSelectionSchema } from '../shared/results.ts'
import type { Dataset, MetricId, PlatformId, Strategy } from './data'

Chart.register(...registerables)
Chart.defaults.font.family = 'IBM Plex Sans'
Chart.defaults.color = '#626b66'

const palette = ['#65736a', '#93663c', '#2f66cb', '#e06b2f', '#968526', '#148c87', '#a34764', '#7159b5', '#438333', '#bf4961', '#427992']
const icons = { Download, Link, ArrowUpRight, AlertTriangle, RotateCcw, ChevronRight, ArrowUp, ArrowDown, ArrowUpDown }
const strategyDescriptions: Record<Strategy, string> = {
  reload: 'Restore the sandbox for each request.',
  reuse: 'Keep the sandbox as-is across requests.',
  new: 'Create a new sandbox for each request.',
}
const app = document.querySelector<HTMLDivElement>('#app')!
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)

app.innerHTML = '<div class="initial-state" role="status">Loading benchmark data...</div>'

async function start() {
  const data = await loadDataset()
  renderDashboard(data?.runs.length ? data : {
    ...data, schemaVersion: 1, source: data?.source ?? 'published',
    ...catalog, runs: [], measurements: [],
  })
}

function previewLabel(data: Dataset): string {
  const preview = data.preview!
  const included = preview.pending && data.runs.some(run => run.id === `${preview.pending!.id}.${preview.pending!.attempt}`)
  return `PR #${preview.number} / ${preview.head.slice(0, 7)} / ${included ? 'Pending results included' : preview.pending ? 'Pending results in another history' : 'No pending results for this revision'}`
}

function renderDashboard(data: Dataset) {
  data = {
    ...data,
    platforms: data.platforms.toSorted((first, second) => Number(second.id === 'mshv3') - Number(first.id === 'mshv3')),
  }
  const params = new URLSearchParams(location.search)
  const preferredRuntimes = ['hyperlight-js', 'hyperlight-wasm-jco', 'hyperlight-wasm-qjs', 'wasmtime-aot-jco', 'wasmtime-aot-qjs']
  const availablePreferred = preferredRuntimes.filter(id => data.runtimes.some(runtime => runtime.id === id))
  const defaultRuntimes = availablePreferred.length ? availablePreferred : data.runtimes.map(runtime => runtime.id)
  const defaultPlatform = data.platforms[0]!.id
  const defaultMetric = data.metrics.find(metric => metric.id === 'rps')?.id ?? data.metrics[0]!.id
  let strategy: Strategy = ['reload', 'reuse', 'new'].includes(params.get('strategy') ?? '') ? params.get('strategy') as Strategy : 'reload'
  let metricId: MetricId = data.metrics.some(metric => metric.id === params.get('metric')) ? params.get('metric') as MetricId : defaultMetric
  let range = params.get('range') === '7' ? 7 : 14
  const selectedRuntimes = new Set((params.has('runtimes') ? params.get('runtimes')!.split(',') : defaultRuntimes).filter(id => data.runtimes.some(runtime => runtime.id === id)))
  const selectedPlatforms = new Set<PlatformId>((params.has('platforms') ? params.get('platforms')!.split(',') : [defaultPlatform]).filter(id => data.platforms.some(platform => platform.id === id)) as PlatformId[])
  const hardwareColors = (values: (string | null | undefined)[], tints: string[]) => new Map(
    [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))].sort()
      .map((value, index) => [value, tints[index % tints.length]!]),
  )
  const cpuColors = hardwareColors(data.runs.flatMap(run => run.runners.map(runner => runner.cpu.model)), ['#e3edf9', '#e6f1e7', '#dcf0ef'])
  const skuColors = hardwareColors(data.runs.flatMap(run => run.runners.map(runner => runner.sku)), ['#f8ead5', '#f2e5ef', '#f8e3df'])
  let selectedRunId = data.runs.find(run => run.id === params.get('run'))?.id ?? data.runs.at(-1)?.id ?? ''
  let chart: Chart<'line'> | undefined
  let tooltipMode = 'ranked'
  let snapshotMode = 'ranked'
  let snapshotSort: { platformId: string, bestFirst: boolean } | undefined
  let comparisonSort: { platformId: string, bestFirst: boolean } | undefined
  try {
    if (localStorage.getItem('benchmark-tooltip-mode') === 'grouped') tooltipMode = 'grouped'
  } catch {}
  let renderTooltipContents = () => {}
  let tooltipHideTimer: ReturnType<typeof setTimeout> | undefined
  const runtimeGroups = [
    { label: 'Hyperlight JS', shape: 'circle', runtimes: data.runtimes.filter(runtime => runtime.id === 'hyperlight-js') },
    { label: 'Hyperlight Wasm', shape: 'square', runtimes: data.runtimes.filter(runtime => runtime.id.startsWith('hyperlight-wasm-') && !runtime.id.endsWith('-dummy')) },
    { label: 'Wasmtime', shape: 'diamond', runtimes: data.runtimes.filter(runtime => runtime.id.startsWith('wasmtime-') && !runtime.id.endsWith('-dummy')) },
    { label: 'Dummy', shape: 'triangle', runtimes: data.runtimes.filter(runtime => runtime.id === 'dummy' || runtime.id.endsWith('-dummy')) },
  ]
  const runtimeMarker = (runtimeId: string, markerColor: string) => {
    const shape = runtimeGroups.find(group => group.runtimes.some(runtime => runtime.id === runtimeId))?.shape ?? 'square'
    return `<span class="runtime-swatch" data-shape="${shape}" style="background:${markerColor}" aria-hidden="true"></span>`
  }
  const shortRuntimeName = (runtimeId: string) => {
    if (runtimeId === 'hyperlight-js') return 'QuickJS'
    const name = runtimeId === 'dummy' ? 'native' : runtimeId.endsWith('-dummy')
      ? runtimeId.slice(0, -6) : runtimeId.replace(/^(hyperlight-wasm|wasmtime)-/, '')
    const words: Record<string, string> = { native: 'Native', hyperlight: 'Hyperlight', wasm: 'Wasm', wasmtime: 'Wasmtime', aot: 'AOT', jco: 'JCO', qjs: 'QuickJS', pulley: 'Pulley' }
    return name.split('-').map(word => words[word] ?? word).join(' ')
  }

  app.innerHTML = `
    <header class="site-header">
      <h1 class="site-heading"><a class="site-title" href="${escapeHtml(location.pathname)}${data.source === 'synthetic' ? '?demo=1' : ''}">Hyperlight Benchmarks${data.source === 'synthetic' ? ' (Demo)' : data.source === 'local' ? ' (Local)' : ''}</a></h1>
      <nav class="repository-links" aria-label="GitHub repositories"><a href="https://github.com/hyperlight-dev/hyperlight" target="_blank" rel="noopener noreferrer">Hyperlight GitHub</a><a href="https://github.com/hyperlight-dev/hyperlight-bench" target="_blank" rel="noopener noreferrer">Benchmarks GitHub</a></nav>
    </header>
    <main class="dashboard-main">
      ${data.preview ? `<p class="preview-status" role="status">${escapeHtml(previewLabel(data))}</p>` : ''}
      <div class="workspace">
        <aside class="runtime-panel" aria-label="Runtime filters">
          ${data.histories && data.histories.length > 1 ? `<label class="search-label" for="history">Benchmark history</label><select id="history" style="width:100%;min-width:0" title="Benchmark history">${data.histories.map(group => `<option value="${group.id}" ${group.id === data.historyId ? 'selected' : ''}>${escapeHtml(group.label)}</option>`).join('')}</select>` : ''}
          <div class="panel-heading"><h2>Runtimes <span class="count" id="runtime-count"></span></h2><button class="icon-button" id="reset" title="Reset filters" aria-label="Reset filters"><i data-lucide="rotate-ccw"></i></button></div>
          <label class="search-label" for="runtime-search">Find runtime</label><input id="runtime-search" type="search" placeholder="Filter runtimes..." autocomplete="off" />
          <div class="selection-actions"><button id="select-all">Select all</button><button id="select-none">Clear</button></div>
          <div id="runtime-list">${runtimeGroups.map(group => `<div class="runtime-group" role="group" aria-label="${group.label}"><h3 class="runtime-group-heading">${group.label}</h3>${group.runtimes.map(runtime => {
            const index = data.runtimes.indexOf(runtime)
            return `
            <label class="runtime-option" data-runtime="${runtime.id}" title="${escapeHtml(runtime.description)}">
              <input type="checkbox" value="${runtime.id}" ${selectedRuntimes.has(runtime.id) ? 'checked' : ''} style="accent-color:${palette[index % palette.length]}" />
              ${runtimeMarker(runtime.id, palette[index % palette.length]!)}<span class="runtime-text"><span>${runtime.id}</span><small>${escapeHtml(runtime.engine)}</small></span>
            </label>`
          }).join('')}</div>`).join('')}</div>
          <p id="search-empty" hidden>No matching runtimes.</p>
        </aside>
        <div class="results">
          <section class="controls" aria-label="Benchmark configuration">
            <div class="lifecycle-control"><span class="control-label">Per-request lifecycle</span><div class="segments" role="group" aria-label="Sandbox lifecycle">
              <button data-strategy="reload">Restore</button><button data-strategy="reuse">Reuse</button><button data-strategy="new">Renew</button>
            </div><p id="strategy-description"></p></div>
            <fieldset class="platform-control"><legend>Platform</legend><div class="platform-options">${data.platforms.map(platform => `<label><input type="checkbox" value="${platform.id}" ${selectedPlatforms.has(platform.id) ? 'checked' : ''} /><span>${escapeHtml(platform.label)}</span><small>Linux</small></label>`).join('')}</div></fieldset>
          </section>
          <div id="hardware-warning" class="hardware-warning" hidden><i data-lucide="alert-triangle"></i><div>Different Azure VM sizes and generations. Results reflect both hardware and software differences.</div></div>
          <div class="metrics" role="tablist" aria-label="Metric">${data.metrics.map(metric => `<button role="tab" data-metric="${metric.id}">${escapeHtml(metric.label)}</button>`).join('')}</div>
          <section class="chart-section" aria-labelledby="chart-title">
            <div class="chart-heading"><div><h2 id="chart-title"></h2><p><span id="metric-direction"></span><span class="separator">·</span><span id="series-count"></span></p><p>Hover for values. Click to select a commit.</p></div><div class="chart-actions"><label for="range" class="sr-only">History range</label><select id="range"><option value="14">All 14 commits</option><option value="7">Last 7 commits</option></select><button id="download" class="icon-button" aria-label="Download selected results" title="Download selected results"><i data-lucide="download"></i></button><button id="share" class="icon-button" aria-label="Copy view link" title="Copy view link"><i data-lucide="link"></i></button></div></div>
            <div class="chart-wrap"><canvas id="chart" role="img" aria-label="Benchmark history. Values are available in the results table below."></canvas><div id="chart-tooltip" class="chart-tooltip" hidden aria-hidden="true"></div><div id="empty-chart" hidden>Select at least one runtime and platform.</div></div>
            <div class="chart-caption"><span id="chart-period"></span></div>
            <div id="chart-legend" class="chart-legend"></div>
          </section>
          <section class="snapshot-section" aria-labelledby="snapshot-title"><div class="snapshot-heading"><div><span class="eyebrow">COMMIT SNAPSHOT</span><h2 id="snapshot-title"></h2><p id="commit-message"></p></div><div><label for="run" class="sr-only">Selected commit</label><select id="run"></select><a id="commit-link" target="_blank" rel="noopener noreferrer" hidden>View commit <i data-lucide="arrow-up-right"></i></a><a id="pr-link" target="_blank" rel="noopener noreferrer" hidden><span id="pr-link-label">View PR</span> <i data-lucide="arrow-up-right"></i></a></div></div>
            <div class="snapshot-controls" role="group" aria-label="Snapshot ordering"><button type="button" data-snapshot-mode="ranked" aria-pressed="true">Ranked</button><button type="button" data-snapshot-mode="grouped" aria-pressed="false">Grouped</button></div>
            <div class="table-scroll" id="snapshot-ranked"><table><thead><tr><th scope="col">Rank</th><th scope="col">Runtime</th><th scope="col" id="snapshot-platform-heading" ${selectedPlatforms.size > 1 ? '' : 'hidden'}>Platform</th><th scope="col" id="value-heading"></th><th scope="col">% of largest selected value<div class="relative-scale" aria-hidden="true"><span>0</span><span>50</span><span>100%</span></div></th></tr></thead><tbody id="results-body"></tbody></table></div>
            <div class="table-scroll" id="snapshot-grouped" hidden></div>
          </section>
          <details class="methodology"><summary>Runner specifications</summary><div class="table-scroll"><table class="runner-table"><thead><tr><th scope="col" id="runner-runtime-heading">Runtime</th><th scope="col" id="runner-platform-heading" ${selectedPlatforms.size > 1 ? '' : 'hidden'}>Platform</th><th scope="col">CPU</th><th scope="col">Azure VM SKU</th></tr></thead><tbody id="runner-details"></tbody></table></div><div id="runner-configurations"></div></details>
        </div>
      </div>
      <footer><span>${data.source === 'synthetic' ? 'Demo data. Synthetic measurements.' : 'Hyperlight HTTP Benchmarks'}</span></footer>
    </main><div class="toast" id="toast" role="status" hidden></div>`

  const element = <T extends HTMLElement = HTMLElement>(selector: string) => app.querySelector<T>(selector)!
  if (!data.runs.length) {
    app.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button').forEach(control => control.disabled = true)
    app.querySelectorAll<HTMLButtonElement>('[data-strategy]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.strategy === strategy)))
    app.querySelectorAll<HTMLButtonElement>('[data-metric]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.metric === metricId)))
    element('#runtime-count').textContent = `${selectedRuntimes.size}/${data.runtimes.length}`
    element('#strategy-description').textContent = strategyDescriptions[strategy]
    element('#chart-title').textContent = data.metrics.find(metric => metric.id === metricId)!.title
    element('#series-count').textContent = '0 runs'
    element('#empty-chart').textContent = 'No published runs yet.'
    element('#empty-chart').setAttribute('role', 'status')
    element('#empty-chart').hidden = false
    element('#chart').hidden = true
    element('#range').innerHTML = '<option>No runs</option>'
    element('#run').innerHTML = '<option>No runs</option>'
    element('#snapshot-title').textContent = 'No run selected'
    element('#value-heading').textContent = data.metrics.find(metric => metric.id === metricId)!.label
    element('#results-body').innerHTML = `<tr><td colspan="${selectedPlatforms.size > 1 ? 5 : 4}" class="empty-table">No measurements available.</td></tr>`
    element('#runner-details').innerHTML = `<tr><td colspan="${selectedPlatforms.size > 1 ? 4 : 3}" class="empty-table">No runner data available.</td></tr>`
    element('.chart-heading p:last-child').hidden = true
    element('.separator').hidden = true
    createIcons({ icons, attrs: { 'stroke-width': 1.7, 'aria-hidden': 'true' } })
    return
  }
  const color = (runtimeId: string) => palette[data.runtimes.findIndex(runtime => runtime.id === runtimeId) % palette.length]!
  const metric = () => data.metrics.find(entry => entry.id === metricId)!
  const visibleRuns = () => data.runs.slice(-range)
  const rowsFor = (runId: string) => data.measurements.filter(entry => entry.runId === runId && entry.strategy === strategy && selectedRuntimes.has(entry.runtimeId) && selectedPlatforms.has(entry.platformId) && entry.values[metricId] !== undefined)
    .sort((first, second) => metric().direction === 'higher' ? second.values[metricId] - first.values[metricId] : first.values[metricId] - second.values[metricId])
  const format = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: metricId === 'rps' ? 0 : metricId === 'memory' ? 1 : 3 }).format(value)

  function saveView() {
    const query = new URLSearchParams({ strategy, metric: metricId, platforms: [...selectedPlatforms].join(','), runtimes: [...selectedRuntimes].join(','), range: String(range), run: selectedRunId })
    if (data.source === 'synthetic') query.set('demo', '1')
    if (data.historyId) query.set('history', data.historyId)
    history.replaceState(null, '', `${location.pathname}?${query}`)
  }

  function updateSnapshot() {
    const run = data.runs.find(entry => entry.id === selectedRunId)!
    element('#snapshot-title').textContent = `${run.commit} / ${new Date(run.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`
    const pending = data.preview?.pending
    element('#commit-message').textContent = `${pending && run.id === `${pending.id}.${pending.attempt}` ? 'Pending PR result: ' : ''}${run.message}`
    element<HTMLSelectElement>('#run').value = selectedRunId
    const commitLink = element<HTMLAnchorElement>('#commit-link')
    commitLink.hidden = !run.commitUrl
    if (run.commitUrl) commitLink.href = run.commitUrl
    const prLink = element<HTMLAnchorElement>('#pr-link')
    const pr = run.bundle.run.pullRequest
    prLink.hidden = !pr
    if (pr) {
      prLink.href = `https://github.com/${pr.repository}/pull/${pr.number}`
    }
    const rows = rowsFor(selectedRunId)
    const platformRunners = data.platforms.map(platform => ({
      platform,
      runners: run.runners.filter(runner => runner.platformId === platform.id && rows.some(row => row.runnerId === runner.id)),
    })).filter(entry => entry.runners.length)
    const configurationKey = (runner: typeof run.runners[number]) =>
      JSON.stringify([runner.cpu, (runner.memoryBytes / 1024 ** 3).toFixed(1), runner.os, runner.sku, runner.pool, runner.region])
    const showRuntimeAssignments = platformRunners.some(({ runners }) => new Set(runners.map(configurationKey)).size > 1)
    element('.methodology .table-scroll').hidden = !showRuntimeAssignments && platformRunners.length > 0
    element('#runner-runtime-heading').hidden = !showRuntimeAssignments
    const showRunnerPlatform = selectedPlatforms.size > 1
    element('#runner-platform-heading').hidden = !showRunnerPlatform
    const columnCount = 2 + Number(showRuntimeAssignments) + Number(showRunnerPlatform)
    const renderRunner = (platform: Dataset['platforms'][number], runners: typeof run.runners, runtimeId?: string) => {
      const runner = runners[0]!
      return `<tr class="runner-runtime-row" data-runner-runtime="${escapeHtml(runtimeId ?? '')}" data-runner-platform="${escapeHtml(platform.id)}">${runtimeId ? `<td title="${escapeHtml(runtimeId)}"><span class="table-runtime">${runtimeMarker(runtimeId, color(runtimeId))}${escapeHtml(shortRuntimeName(runtimeId))}</span></td>` : ''}${showRunnerPlatform ? `<td>${escapeHtml(platform.label)}</td>` : ''}<td style="background:${cpuColors.get(runner.cpu.model ?? '') ?? 'transparent'}">${escapeHtml(runner.cpu.model || 'Unknown CPU')}</td><td style="background:${skuColors.get(runner.sku ?? '') ?? 'transparent'}">${escapeHtml(runner.sku ?? '-')}</td></tr>`
    }
    element('#runner-details').innerHTML = (showRuntimeAssignments ? runtimeGroups.map(family => {
      const assignments = family.runtimes.map(runtime => platformRunners.map(({ platform, runners }) => {
        const runnerIds = new Set(rows.filter(row => row.runtimeId === runtime.id && row.platformId === platform.id).map(row => row.runnerId))
        return runners.filter(runner => runnerIds.has(runner.id)).map(runner => renderRunner(platform, [runner], runtime.id)).join('')
      }).join('')).join('')
      return assignments ? `<tr class="runner-family-row"><th colspan="${columnCount}">${escapeHtml(family.label)}</th></tr>${assignments}` : ''
    }).join('') : platformRunners.map(({ platform, runners }) => renderRunner(platform, runners)).join(''))
      || `<tr><td colspan="${columnCount}" class="empty-table">No measurements selected.</td></tr>`
    const configurations = new Map<string, { runner: typeof run.runners[number], platforms: Set<string> }>()
    for (const { platform, runners } of platformRunners) {
      for (const runner of runners) {
        const key = configurationKey(runner)
        const configuration = configurations.get(key)
        if (configuration) configuration.platforms.add(platform.label)
        else configurations.set(key, { runner, platforms: new Set([platform.label]) })
      }
    }
    element('#runner-configurations').innerHTML = [...configurations.values()].map(({ runner, platforms }, index) => {
      const specs = [
        ...(showRunnerPlatform ? [['Platform', [...platforms].join(', ')]] : []),
        ['vCPUs', runner.cpu.logicalProcessors], ['Cores', runner.cpu.cores],
        ['Memory (GiB)', (runner.memoryBytes / 1024 ** 3).toFixed(1)],
        ['Operating system', [runner.os.name, runner.os.version, runner.os.architecture].filter(Boolean).join(' ')],
        ['Runner pool', runner.pool], ['Region', runner.region],
      ]
      return `<section class="runner-configuration" aria-labelledby="runner-configuration-${index}"><h3 id="runner-configuration-${index}"><span style="background:${cpuColors.get(runner.cpu.model ?? '') ?? 'transparent'}">${escapeHtml(runner.cpu.model || 'Unknown CPU')}</span><span style="background:${skuColors.get(runner.sku ?? '') ?? 'transparent'}">${escapeHtml(runner.sku ?? '-')}</span></h3><dl>${specs.map(([name, value]) => `<div><dt>${name}</dt><dd>${escapeHtml(String(value ?? '-'))}</dd></div>`).join('')}</dl></section>`
    }).join('')
    const currentMetric = metric()
    const snapshotPlatforms = data.platforms.filter(platform => selectedPlatforms.has(platform.id))
    const sort = snapshotSort && (snapshotSort.platformId === '*' || selectedPlatforms.has(snapshotSort.platformId as PlatformId)) ? snapshotSort : undefined
    const ascending = sort ? (currentMetric.direction === 'lower') === sort.bestFirst : currentMetric.direction === 'lower'
    const sortHeader = (platformId: string, label: string) => {
      const active = sort?.platformId === platformId
      const direction = active ? ascending ? 'ascending' : 'descending' : 'none'
      return `<th scope="col" aria-sort="${direction}"><button type="button" class="snapshot-sort" data-snapshot-sort="${escapeHtml(platformId)}" aria-label="Sort by ${escapeHtml(label)}" title="Sort by ${escapeHtml(label)}">${escapeHtml(label)}<i data-lucide="${active ? ascending ? 'arrow-up' : 'arrow-down' : 'arrow-up-down'}"></i></button></th>`
    }
    const valueHeading = element('#value-heading')
    valueHeading.innerHTML = `<button type="button" class="snapshot-sort" data-snapshot-sort="*" aria-label="Sort by ${escapeHtml(currentMetric.label)}">${escapeHtml(currentMetric.label)} (${escapeHtml(currentMetric.unit)})<i data-lucide="${ascending ? 'arrow-up' : 'arrow-down'}"></i></button>`
    valueHeading.setAttribute('aria-sort', ascending ? 'ascending' : 'descending')
    element('#snapshot-ranked').hidden = snapshotMode !== 'ranked'
    element('#snapshot-grouped').hidden = snapshotMode !== 'grouped'
    element('.snapshot-controls').querySelectorAll<HTMLButtonElement>('[data-snapshot-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.snapshotMode === snapshotMode)))
    const showSnapshotPlatform = selectedPlatforms.size > 1
    element('#snapshot-platform-heading').hidden = !showSnapshotPlatform
    const maximum = Math.max(...rows.map(entry => entry.values[metricId]), 0)
    const rankedRows = sort?.platformId === '*' && !sort.bestFirst ? [...rows].reverse() : rows
    element('#results-body').innerHTML = rows.length ? rankedRows.map(entry => {
      const percentage = maximum > 0 ? entry.values[metricId] / maximum * 100 : 0
      const family = runtimeGroups.find(group => group.runtimes.some(runtime => runtime.id === entry.runtimeId))!.label
      return `<tr><td class="rank">${String(rows.indexOf(entry) + 1).padStart(2, '0')}</td><td title="${escapeHtml(entry.runtimeId)}"><span class="table-runtime">${runtimeMarker(entry.runtimeId, color(entry.runtimeId))}<span class="snapshot-runtime"><strong>${escapeHtml(family)}</strong><span>${escapeHtml(shortRuntimeName(entry.runtimeId))}</span></span></span></td>${showSnapshotPlatform ? `<td><span class="platform-badge">${escapeHtml(data.platforms.find(platform => platform.id === entry.platformId)!.label)}</span></td>` : ''}<td class="number">${format(entry.values[metricId])}</td><td class="bar-cell"><div class="relative-bar"><span class="bar-track" aria-hidden="true"><span class="value-bar" style="width:${percentage}%;background:${color(entry.runtimeId)}"></span></span><span class="bar-percentage">${percentage.toFixed(1)}%</span></div></td></tr>`
    }).join('') : `<tr><td colspan="${showSnapshotPlatform ? 5 : 4}" class="empty-table">No measurements selected.</td></tr>`
    const snapshotValue = (runtimeId: string, platformId: string) => rows.find(row => row.runtimeId === runtimeId && row.platformId === platformId)?.values[metricId]
    element('#snapshot-grouped').innerHTML = `<table><thead><tr><th scope="col">Variant</th>${snapshotPlatforms.map(platform => sortHeader(platform.id, `${showSnapshotPlatform ? platform.label : currentMetric.label} (${currentMetric.unit})`)).join('')}</tr></thead><tbody>${runtimeGroups.map(group => {
      const runtimes = group.runtimes.filter(runtime => rows.some(row => row.runtimeId === runtime.id))
      const sortPlatform = sort?.platformId ?? (snapshotPlatforms.length === 1 ? snapshotPlatforms[0]!.id : undefined)
      if (sortPlatform) runtimes.sort((first, second) => {
        const firstValue = snapshotValue(first.id, sortPlatform)
        const secondValue = snapshotValue(second.id, sortPlatform)
        if (firstValue == null) return secondValue == null ? 0 : 1
        if (secondValue == null) return -1
        return ascending ? firstValue - secondValue : secondValue - firstValue
      })
      if (!runtimes.length) return ''
      return `<tr class="snapshot-family"><th scope="rowgroup" colspan="${1 + snapshotPlatforms.length}">${escapeHtml(group.label)}</th></tr>${runtimes.map(runtime => `<tr data-snapshot-runtime="${escapeHtml(runtime.id)}"><td title="${escapeHtml(runtime.id)}"><span class="table-runtime">${runtimeMarker(runtime.id, color(runtime.id))}${escapeHtml(shortRuntimeName(runtime.id))}</span></td>${snapshotPlatforms.map(platform => {
        const value = snapshotValue(runtime.id, platform.id)
        return `<td class="number" data-snapshot-platform="${escapeHtml(platform.id)}">${value == null ? '<span aria-label="No measurement">-</span>' : format(value)}</td>`
      }).join('')}</tr>`).join('')}`
    }).join('') || `<tr><td colspan="${1 + snapshotPlatforms.length}" class="empty-table">No measurements selected.</td></tr>`}</tbody></table>`
    createIcons({ icons, attrs: { 'stroke-width': 1.7, 'aria-hidden': 'true' } })
    saveView()
  }

  function update() {
    const currentMetric = metric()
    const runs = visibleRuns()
    if (!runs.some(run => run.id === selectedRunId)) selectedRunId = runs.at(-1)!.id
    element('#runtime-count').textContent = `${selectedRuntimes.size}/${data.runtimes.length}`
    app.querySelectorAll<HTMLButtonElement>('[data-strategy]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.strategy === strategy)))
    app.querySelectorAll<HTMLButtonElement>('[data-metric]').forEach(button => {
      button.setAttribute('aria-selected', String(button.dataset.metric === metricId))
      button.tabIndex = button.dataset.metric === metricId ? 0 : -1
    })
    element('#strategy-description').textContent = strategyDescriptions[strategy]
    element('#hardware-warning').hidden = selectedPlatforms.size < 2
    element('#chart-title').textContent = currentMetric.title
    element('#metric-direction').textContent = `${currentMetric.direction === 'higher' ? 'Higher' : 'Lower'} is better · ${currentMetric.unit}`
    element<HTMLOptionElement>('#range option[value="14"]').textContent = `Last ${Math.min(14, data.runs.length)} runs`
    element<HTMLOptionElement>('#range option[value="7"]').textContent = `Last ${Math.min(7, data.runs.length)} runs`
    element<HTMLSelectElement>('#range').value = String(range)
    element<HTMLSelectElement>('#run').innerHTML = runs.map(run => `<option value="${run.id}">${run.commit}${data.preview?.pending && run.id === `${data.preview.pending.id}.${data.preview.pending.attempt}` ? ' · Pending PR' : ''}${run.id === data.runs.at(-1)!.id ? ' · Latest' : ''}</option>`).join('')
    element('#chart-period').textContent = `${runs[0]!.date.slice(0, 10)} / ${runs.at(-1)!.date.slice(0, 10)}`
    const series = data.runtimes.filter(runtime => selectedRuntimes.has(runtime.id)).flatMap(runtime => data.platforms.filter(platform => selectedPlatforms.has(platform.id)).map(platform => ({
      runtimeId: runtime.id,
      platformId: platform.id,
      label: `${runtime.id}${selectedPlatforms.size > 1 ? ` / ${platform.label}` : ''}`,
      shortLabel: `${shortRuntimeName(runtime.id)}${selectedPlatforms.size > 1 ? ` / ${platform.label}` : ''}`,
      data: runs.map(run => data.measurements.find(entry => entry.runId === run.id && entry.runtimeId === runtime.id && entry.platformId === platform.id && entry.strategy === strategy)?.values[metricId] ?? null),
      borderColor: color(runtime.id), backgroundColor: color(runtime.id), borderWidth: 2,
      borderDash: platform.id === 'kvm' ? [6, 4] : [],
      tension: 0, pointRadius: 2.5, pointHoverRadius: 5, pointBorderWidth: 1, pointBackgroundColor: '#fff',
    })))
    element('#series-count').textContent = `${series.length} series`
    element('#empty-chart').hidden = series.length > 0
    const groupedSeries = runtimeGroups.map(group => ({
      ...group,
      entries: series.filter(entry => group.runtimes.some(runtime => runtime.id === entry.runtimeId)),
    })).filter(group => group.entries.length)
    element('#chart-legend').innerHTML = groupedSeries.map(group => `<section class="legend-group"><h3>${escapeHtml(group.label)}</h3><div>${group.entries.map(entry => `<span title="${escapeHtml(entry.label)}">${runtimeMarker(entry.runtimeId, entry.borderColor)}<span class="legend-line" style="border-color:${entry.borderColor};border-style:${entry.borderDash.length ? 'dashed' : 'solid'}"></span>${escapeHtml(entry.shortLabel)}</span>`).join('')}</div></section>`).join('')
    element('#chart-tooltip').hidden = true
    chart?.destroy()
    chart = new Chart(element<HTMLCanvasElement>('#chart'), {
      type: 'line', data: { labels: runs.map(run => run.commit), datasets: series },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 16, right: 12 } },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { font: { family: 'IBM Plex Mono', size: 10 }, maxTicksLimit: 7, maxRotation: 0 } },
          y: { beginAtZero: true, border: { display: false }, grid: { color: '#e9eee9' }, ticks: { maxTicksLimit: 6, callback: value => Number(value) >= 1000 ? `${Number(value) / 1000}k` : value } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: false,
            external: ({ chart: currentChart, tooltip }) => {
              const popup = element('#chart-tooltip')
              clearTimeout(tooltipHideTimer)
              if (!tooltip.opacity) {
                tooltipHideTimer = setTimeout(() => {
                  if (!popup.matches(':hover, :has(:focus-visible)')) popup.hidden = true
                }, 200)
                return
              }
              if (!popup.hidden && popup.matches(':hover, :has(:focus-visible)')) return
              const dataPoints = [...tooltip.dataPoints]
              renderTooltipContents = () => {
                const renderPoint = (point: typeof dataPoints[number], ranked: boolean) => {
                  const entry = series[point.datasetIndex]!
                  const family = groupedSeries.find(group => group.entries.includes(entry))!.label
                  return `<div title="${escapeHtml(entry.label)}">${runtimeMarker(entry.runtimeId, entry.borderColor)}${ranked ? `<span class="tooltip-family">${escapeHtml(family)}</span>` : ''}<span class="tooltip-variant">${escapeHtml(entry.shortLabel)}</span><b>${format(point.parsed.y!)} ${escapeHtml(currentMetric.unit)}</b></div>`
                }
                popup.querySelector<HTMLElement>('.tooltip-values')!.dataset.mode = tooltipMode
                const comparisonPlatforms = data.platforms.filter(platform => selectedPlatforms.has(platform.id))
                const sort = comparisonPlatforms.some(platform => platform.id === comparisonSort?.platformId) ? comparisonSort : undefined
                const ascending = sort ? (currentMetric.direction === 'lower') === sort.bestFirst : false
                const comparisonValue = (runtimeId: string, platformId: string) => dataPoints.find(point => {
                  const entry = series[point.datasetIndex]!
                  return entry.runtimeId === runtimeId && entry.platformId === platformId
                })?.parsed.y
                const renderComparison = () => `<section class="tooltip-comparison" role="table" aria-label="Platform comparison (${escapeHtml(currentMetric.unit)})" style="--platform-count:${comparisonPlatforms.length}"><div class="tooltip-comparison-header" role="row"><span role="columnheader">Variant (${escapeHtml(currentMetric.unit)})</span>${comparisonPlatforms.map(platform => {
                  const active = sort?.platformId === platform.id
                  const direction = active ? ascending ? 'ascending' : 'descending' : 'none'
                  return `<span role="columnheader" aria-sort="${direction}"><button type="button" data-tooltip-sort="${escapeHtml(platform.id)}" title="Sort by ${escapeHtml(platform.label)}" aria-label="Sort by ${escapeHtml(platform.label)}">${escapeHtml(platform.label)}<i data-lucide="${active ? ascending ? 'arrow-up' : 'arrow-down' : 'arrow-up-down'}"></i></button></span>`
                }).join('')}</div>${groupedSeries.map(group => {
                  const runtimes = group.runtimes.filter(runtime => dataPoints.some(point => series[point.datasetIndex]!.runtimeId === runtime.id))
                  if (sort) runtimes.sort((first, second) => {
                    const firstValue = comparisonValue(first.id, sort.platformId)
                    const secondValue = comparisonValue(second.id, sort.platformId)
                    if (firstValue == null) return secondValue == null ? 0 : 1
                    if (secondValue == null) return -1
                    return ascending ? firstValue - secondValue : secondValue - firstValue
                  })
                  if (!runtimes.length) return ''
                  return `<div class="tooltip-comparison-group" role="rowgroup" aria-label="${escapeHtml(group.label)}"><h4>${escapeHtml(group.label)}</h4>${runtimes.map(runtime => `<div class="tooltip-comparison-row" role="row"><span role="cell" class="tooltip-comparison-variant" title="${escapeHtml(runtime.id)}">${runtimeMarker(runtime.id, color(runtime.id))}<span>${escapeHtml(shortRuntimeName(runtime.id))}</span></span>${comparisonPlatforms.map(platform => {
                    const point = dataPoints.find(point => {
                      const entry = series[point.datasetIndex]!
                      return entry.runtimeId === runtime.id && entry.platformId === platform.id
                    })
                    return `<b role="cell">${point ? format(point.parsed.y!) : '<span aria-label="No measurement">-</span>'}</b>`
                  }).join('')}</div>`).join('')}</div>`
                }).join('')}</section>`
                popup.querySelector('.tooltip-values')!.innerHTML = tooltipMode === 'ranked'
                  ? dataPoints.map(point => renderPoint(point, true)).join('')
                  : comparisonPlatforms.length > 1 ? renderComparison()
                  : groupedSeries.map(group => {
                    const points = dataPoints.filter(point => group.entries.includes(series[point.datasetIndex]!))
                    return points.length ? `<h4>${escapeHtml(group.label)}</h4>${points.map(point => renderPoint(point, false)).join('')}` : ''
                  }).join('')
                popup.querySelectorAll<HTMLButtonElement>('[data-tooltip-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tooltipMode === tooltipMode)))
                createIcons({ icons, attrs: { 'stroke-width': 1.7, 'aria-hidden': 'true' } })
              }
              popup.innerHTML = `<strong>${escapeHtml(tooltip.title.join(' '))}</strong><div class="tooltip-modes" role="group" aria-label="Tooltip ordering"><button type="button" data-tooltip-mode="ranked">Ranked</button><button type="button" data-tooltip-mode="grouped">Grouped</button></div><div class="tooltip-values"></div><p>${escapeHtml(tooltip.footer.join(' '))}</p>`
              renderTooltipContents()
              popup.hidden = false
              popup.style.left = `${Math.max(0, Math.min(tooltip.caretX + 12, currentChart.width - popup.offsetWidth))}px`
              popup.style.top = `${Math.max(0, Math.min(tooltip.caretY, currentChart.height - popup.offsetHeight))}px`
            },
            itemSort: (first, second) => currentMetric.direction === 'higher' ? second.parsed.y! - first.parsed.y! : first.parsed.y! - second.parsed.y!,
            callbacks: {
              title: items => `Commit ${runs[items[0]!.dataIndex]!.commit}`,
              label: context => ` ${context.dataset.label}: ${format(context.parsed.y!)} ${currentMetric.unit}`,
              footer: items => runs[items[0]!.dataIndex]!.message,
            },
          },
        },
        onClick: (_event, points) => {
          if (!points.length) return
          const run = runs[points[0]!.index]!
          selectedRunId = run.id
          updateSnapshot()
        },
      },
    })
    updateSnapshot()
  }

  element('.snapshot-section').addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-snapshot-mode], [data-snapshot-sort]')
    if (!button) return
    const platformId = button.dataset.snapshotSort
    const keyboardFocus = button.matches(':focus-visible')
    if (platformId) {
      snapshotSort = snapshotSort?.platformId !== platformId
        ? { platformId, bestFirst: true }
        : snapshotSort.bestFirst ? { platformId, bestFirst: false } : undefined
    } else {
      snapshotMode = button.dataset.snapshotMode!
      snapshotSort = undefined
    }
    updateSnapshot()
    if (keyboardFocus && platformId) {
      element('.snapshot-section').querySelectorAll<HTMLButtonElement>('[data-snapshot-sort]').forEach(control => {
        if (control.dataset.snapshotSort === platformId) control.focus({ preventScroll: true })
      })
    }
  })
  element('#runtime-list').addEventListener('change', event => {
    const input = event.target as HTMLInputElement
    input.checked ? selectedRuntimes.add(input.value) : selectedRuntimes.delete(input.value)
    update()
  })
  element('.chart-wrap').addEventListener('pointerleave', () => {
    if (!element('#chart-tooltip').matches(':has(:focus-visible)')) element('#chart-tooltip').hidden = true
  })
  element('#chart-tooltip').addEventListener('click', event => {
    const sortButton = (event.target as Element).closest<HTMLButtonElement>('[data-tooltip-sort]')
    if (sortButton) {
      const platformId = sortButton.dataset.tooltipSort!
      const keyboardFocus = sortButton.matches(':focus-visible')
      const values = element('.tooltip-values')
      const scrollTop = values.scrollTop
      comparisonSort = comparisonSort?.platformId !== platformId
        ? { platformId, bestFirst: true }
        : comparisonSort.bestFirst ? { platformId, bestFirst: false } : undefined
      renderTooltipContents()
      if (keyboardFocus) {
        element('#chart-tooltip').querySelectorAll<HTMLButtonElement>('[data-tooltip-sort]').forEach(button => {
          if (button.dataset.tooltipSort === platformId) button.focus({ preventScroll: true })
        })
      }
      values.scrollTop = scrollTop
      return
    }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tooltip-mode]')
    if (!button) return
    tooltipMode = button.dataset.tooltipMode!
    try {
      localStorage.setItem('benchmark-tooltip-mode', tooltipMode)
    } catch {}
    renderTooltipContents()
  })
  element('#chart-tooltip').addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      element('#chart-tooltip').querySelector<HTMLElement>(':focus')?.blur()
      element('#chart-tooltip').hidden = true
    }
  })
  element<HTMLInputElement>('#runtime-search').addEventListener('input', event => {
    const query = (event.target as HTMLInputElement).value.toLowerCase()
    let visible = 0
    app.querySelectorAll<HTMLElement>('[data-runtime]').forEach(row => {
      row.hidden = !`${row.textContent} ${row.title}`.toLowerCase().includes(query)
      if (!row.hidden) visible++
    })
    element('#search-empty').hidden = visible !== 0
    element('#select-all').textContent = query ? 'Select matches' : 'Select all'
    element('#select-none').textContent = query ? 'Clear matches' : 'Clear'
  })
  function syncRuntimeInputs() {
    app.querySelectorAll<HTMLInputElement>('#runtime-list input').forEach(input => input.checked = selectedRuntimes.has(input.value))
  }
  element('#select-all').onclick = () => {
    app.querySelectorAll<HTMLInputElement>('[data-runtime]:not([hidden]) input').forEach(input => selectedRuntimes.add(input.value))
    syncRuntimeInputs(); update()
  }
  element('#select-none').onclick = () => {
    app.querySelectorAll<HTMLInputElement>('[data-runtime]:not([hidden]) input').forEach(input => selectedRuntimes.delete(input.value))
    syncRuntimeInputs(); update()
  }
  element('#reset').onclick = () => {
    selectedRuntimes.clear(); defaultRuntimes.forEach(id => selectedRuntimes.add(id))
    selectedPlatforms.clear(); selectedPlatforms.add(defaultPlatform)
    strategy = 'reload'; metricId = defaultMetric; range = 14; selectedRunId = data.runs.at(-1)!.id
    syncRuntimeInputs()
    app.querySelectorAll<HTMLInputElement>('.platform-options input').forEach(input => input.checked = selectedPlatforms.has(input.value))
    element<HTMLInputElement>('#runtime-search').value = ''
    app.querySelectorAll<HTMLElement>('[data-runtime]').forEach(row => row.hidden = false)
    element('#search-empty').hidden = true
    element('#select-all').textContent = 'Select all'
    element('#select-none').textContent = 'Clear'
    update()
  }
  app.querySelectorAll<HTMLButtonElement>('[data-strategy]').forEach(button => button.onclick = () => { strategy = button.dataset.strategy as Strategy; update() })
  app.querySelectorAll<HTMLButtonElement>('[data-metric]').forEach(button => {
    button.onclick = () => { metricId = button.dataset.metric as MetricId; update() }
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = data.metrics.findIndex(entry => entry.id === metricId)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? data.metrics.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + data.metrics.length) % data.metrics.length
      metricId = data.metrics[next]!.id
      update(); element<HTMLButtonElement>(`[data-metric="${metricId}"]`).focus()
    }
  })
  app.querySelectorAll<HTMLInputElement>('.platform-options input').forEach(input => input.onchange = () => {
    input.checked ? selectedPlatforms.add(input.value as PlatformId) : selectedPlatforms.delete(input.value as PlatformId)
    update()
  })
  const historySelect = app.querySelector<HTMLSelectElement>('#history')
  if (historySelect) historySelect.onchange = () => {
    const query = new URLSearchParams(location.search)
    query.set('history', historySelect.value)
    for (const key of ['run', 'runtimes', 'platforms', 'metric']) query.delete(key)
    location.search = query.toString()
  }
  element<HTMLSelectElement>('#range').onchange = event => { range = Number((event.target as HTMLSelectElement).value); update() }
  element<HTMLSelectElement>('#run').onchange = event => { selectedRunId = (event.target as HTMLSelectElement).value; updateSnapshot() }
  let toastTimer: ReturnType<typeof setTimeout>
  function toast(message: string) {
    element('#toast').textContent = message; element('#toast').hidden = false
    clearTimeout(toastTimer); toastTimer = setTimeout(() => element('#toast').hidden = true, 3000)
  }
  element('#share').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast('View link copied') }
    catch { toast('Clipboard unavailable. The current view is saved in the address bar.') }
  }
  element('#download').onclick = () => {
    const runs = visibleRuns()
    const payload = runSelectionSchema.parse({ schemaVersion: 1, kind: 'selection', selection: { metricId, strategy, runtimeIds: [...selectedRuntimes], platformIds: [...selectedPlatforms], runId: selectedRunId }, bundles: runs.map(run => run.bundle) })
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'hyperlight-results.json'; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast('Selected results downloaded')
  }
  createIcons({ icons, attrs: { 'stroke-width': 1.7, 'aria-hidden': 'true' } })
  update()
  import.meta.hot?.dispose(() => chart?.destroy())
}

start().catch(error => {
  console.error('Unable to load benchmark history', error)
  app.innerHTML = '<div class="initial-state" role="alert"><h1>Data unavailable</h1><p>The benchmark dataset could not be loaded.</p><button id="retry">Retry</button></div>'
  document.querySelector<HTMLButtonElement>('#retry')!.onclick = () => location.reload()
})