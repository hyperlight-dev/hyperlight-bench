import { z } from 'zod'
import { readFileSync } from 'node:fs'

const repository = process.env.GITHUB_REPOSITORY!
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY is required')
const api = 'https://api.github.com'
const token = process.env.GH_TOKEN
if (!token) throw new Error('GH_TOKEN is required')

export async function github(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${api}/repos/${repository}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new Error(`GitHub ${body === undefined ? 'GET' : 'POST'} ${path}: HTTP ${response.status}`)
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

export async function workflowTrusted(path: string, head: string): Promise<boolean> {
  const workflow = await github(`contents/${path}?ref=${head}`)
  if (workflow.encoding !== 'base64') return false
  return Buffer.from(workflow.content, 'base64').toString('utf8') === readFileSync(path, 'utf8')
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

export async function eligibility(number: number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('A PR number is required')
  const pr = await github(`pulls/${number}`)
  if (pr.base.ref !== 'main' || pr.base.repo.full_name !== repository) throw new Error('PR must target this repository main')
  const decision = decisionSchema.parse({
    schemaVersion: 1, repository, number, head: pr.head.sha, base: pr.base.sha,
    mode: 'required', reason: 'Benchmark-affecting changes require a complete run.', approver: null,
  })
  if (pr.labels.some((label: { name: string }) => label.name === 'benchmarks: skip')) {
    decision.mode = 'skip'
    decision.reason = 'PR has the benchmarks: skip label.'
  }
  return { pr, decision }
}