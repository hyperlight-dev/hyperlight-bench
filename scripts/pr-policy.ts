import { appendFileSync, readFileSync } from 'node:fs'
import { eligibility } from './github-pr.ts'

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8'))
const number = event.pull_request?.number
try {
  const { pr, decision } = await eligibility(number)
  if (pr.state !== 'open') throw new Error('PR is not open')
  if (decision.head !== event.pull_request.head.sha || decision.base !== event.pull_request.base.sha) throw new Error('PR revisions changed. Start a fresh run.')
  appendFileSync(process.env.GITHUB_OUTPUT!, `mode=${decision.mode}\n`)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY!, `\`\`\`json\n${JSON.stringify(decision, null, 2)}\n\`\`\`\n`)
} catch (error) {
  console.error(String(error))
  process.exitCode = 1
}