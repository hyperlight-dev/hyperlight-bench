import { appendFileSync } from 'node:fs'

const results = JSON.parse(process.env.BENCHMARK_JOB_RESULTS ?? '{}') as Record<string, { result?: string }>
const required = process.env.BENCHMARK_MODE === 'skip'
  ? ['eligibility']
  : ['eligibility', 'configure', 'producer', 'prepare', 'measure', 'collect']
const failed = required.filter(job => results[job]?.result !== 'success')
const summary = required.map(job => `* ${job}: ${results[job]?.result ?? 'missing'}`).join('\n')
console.log(summary)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Benchmark Status\n\n${summary}\n`)
if (failed.length) {
  console.error(`::error::Benchmark pipeline incomplete: ${failed.join(', ')}. Every stage must succeed.`)
  process.exitCode = 1
}