import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalJson } from '../shared/results.ts'

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function readOptionalJson(path: string): unknown | undefined {
  try {
    return readJson(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function writeJson(path: string, value: unknown, immutable: boolean): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
    if (immutable) {
      try {
        linkSync(temporary, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (canonicalJson(readJson(path)) !== canonicalJson(value)) {
          throw new Error(`Conflicting immutable record: ${path}`)
        }
      }
    } else {
      renameSync(temporary, path)
    }
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function withStoreLock(directory: string, operation: () => void): void {
  mkdirSync(directory, { recursive: true })
  const lock = join(directory, '.publication-lock')
  try {
    mkdirSync(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Result store is locked: ${lock}`)
    }
    throw error
  }
  try {
    operation()
  } finally {
    rmSync(lock, { recursive: true })
  }
}