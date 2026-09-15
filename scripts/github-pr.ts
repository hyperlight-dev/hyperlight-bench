import { z } from 'zod'

const repository = process.env.GITHUB_REPOSITORY!
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY is required')
const api = 'https://api.github.com'
const token = process.env.GH_TOKEN
if (!token) throw new Error('GH_TOKEN is required')

export async function github(path: string): Promise<any> {
  const response = await fetch(`${api}/repos/${repository}/${path}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new Error(`GitHub GET ${path}: HTTP ${response.status}`)
  return response.json()
}

export async function pages(path: string): Promise<any[]> {
  const entries = []
  for (let page = 1; ; page++) {
    const batch = await github(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    if (!Array.isArray(batch)) throw new Error(`Expected a list: ${path}`)
    entries.push(...batch)
    if (batch.length < 100) return entries
  }
}

const commit = z.string().regex(/^[a-f0-9]{40}$/)
export const decisionSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.string(),
  number: z.number().int().positive(),
  head: commit,
  base: commit,
  mode: z.enum(['required', 'skip']),
  reason: z.string().min(1),
  approver: z.string().nullable(),
})

async function maintainer(login: string): Promise<boolean> {
  const result = await github(`collaborators/${encodeURIComponent(login)}/permission`)
  return ['admin', 'maintain', 'write'].includes(result.permission)
}

export async function eligibility(number: number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('A PR number is required')
  const pr = await github(`pulls/${number}`)
  if (pr.base.ref !== 'main' || pr.base.repo.full_name !== repository) throw new Error('PR must target this repository main')
  const decision = decisionSchema.parse({
    schemaVersion: 1, repository, number, head: pr.head.sha, base: pr.base.sha,
    mode: 'required', reason: 'Benchmark-affecting changes require a complete run.', approver: null,
  })
  if (pr.labels.some((label: { name: string }) => label.name === 'benchmarks: skip')) {
    const files = await pages(`pulls/${number}/files`)
    if (files.length !== pr.changed_files || !files.length) throw new Error('Cannot verify the complete changed-file list')
    const allowed = (path: string) => /^(docs\/|src\/|public\/)/.test(path)
      || ['README.md', 'LICENSE', 'index.html'].includes(path)
    if (files.some(file => !allowed(file.filename) || (file.previous_filename && !allowed(file.previous_filename)))) {
      throw new Error('Skip label covers benchmark-sensitive files. Remove the label and run benchmarks.')
    }
    const events = await pages(`issues/${number}/events`)
    const label = events.filter(event => event.event === 'labeled' && event.label?.name === 'benchmarks: skip').at(-1)
    if (!label?.actor?.login || !await maintainer(label.actor.login)) throw new Error('Skip label must be applied by a maintainer')
    decision.mode = 'skip'
    decision.reason = 'Maintainer applied benchmarks: skip and all changed files are eligible.'
    decision.approver = label.actor.login
  }
  return { pr, decision }
}