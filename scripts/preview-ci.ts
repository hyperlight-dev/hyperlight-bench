import { appendFileSync, readFileSync } from 'node:fs'
import { github } from './github-pr.ts'

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8'))
const number = event.pull_request.number
const head = event.pull_request.head.sha
const pr = await github(`pulls/${number}`)
if (pr.state !== 'open' || pr.draft || pr.base.ref !== 'main' || pr.head.sha !== head) {
  throw new Error('Preview request is closed, draft, or stale')
}
if (!/^[a-f0-9]{40}$/.test(head) || !/^[\w.-]+\/[\w.-]+$/.test(pr.head.repo.full_name)) throw new Error('Invalid preview source')
appendFileSync(process.env.GITHUB_OUTPUT!, `number=${number}\nhead=${head}\nrepository=${pr.head.repo.full_name}\n`)