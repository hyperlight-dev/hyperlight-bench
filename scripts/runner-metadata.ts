import { execFileSync } from 'node:child_process'
import { cpus, hostname, release, totalmem } from 'node:os'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { runnerPools } from '../shared/catalog.ts'
import { runnerSchema, type Runner } from '../shared/results.ts'

export const output = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 ** 2 }).trim()

export async function runnerMetadata(platformId: keyof typeof runnerPools, local = false): Promise<Runner> {
  const expected = runnerPools[platformId]
  if (process.platform !== expected.os) throw new Error(`Platform ${platformId} requires ${expected.os}`)
  if (process.arch !== 'x64') throw new Error('The configured runners require x86_64')
  let machine: { vmSize: string, location: string | null } = { vmSize: 'local', location: null }
  if (!local) {
    const response = await fetch('http://169.254.169.254/metadata/instance/compute?api-version=2021-02-01', {
      headers: { Metadata: 'true' }, signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error(`Azure IMDS returned ${response.status}`)
    machine = z.object({ vmSize: z.string().min(1), location: z.string().min(1) }).parse(await response.json())
    if (machine.vmSize !== expected.sku) throw new Error(`Expected ${expected.sku}, found ${machine.vmSize}`)
  }
  const topology = z.object({ cpus: z.array(z.object({ core: z.union([z.number(), z.string()]), socket: z.union([z.number(), z.string()]) })) }).parse(JSON.parse(output('lscpu', ['--json', '--extended=CORE,SOCKET', '--online'])))
  const cores = new Set(topology.cpus.map(cpu => `${cpu.socket}/${cpu.core}`)).size
  const logicalProcessors = topology.cpus.length
  const model = cpus()[0]?.model ?? ''
  const osRelease = readFileSync('/etc/os-release', 'utf8')
  const osName = osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?$/m)?.[1] ?? 'Linux'
  const osVersion = release()
  const memoryBytes = totalmem()
  const build = z.object({ tools: z.record(z.string(), z.string()), dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(readFileSync('artifacts/build-info.json', 'utf8')))
  return runnerSchema.parse({
    id: `${platformId}-${process.env.GITHUB_JOB ?? 'local'}`, platformId,
    name: process.env.RUNNER_NAME ?? hostname(), job: process.env.GITHUB_JOB ?? 'local',
    pool: local ? 'local' : expected.pool, sku: machine.vmSize, expectedSku: local ? 'local' : expected.sku, region: machine.location,
    os: { name: osName, version: osVersion, architecture: 'x86_64' },
    cpu: { model, logicalProcessors, cores, threadsPerCore: logicalProcessors / cores }, memoryBytes,
    tools: { ...build.tools, node: process.version, oha: output('oha', ['--version']) }, dependencies: build.dependencies,
  })
}