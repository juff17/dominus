import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { type Logger, errCode, errorMessage } from './log.ts'

export type JsonRecord = Record<string, unknown>

export const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null && !Array.isArray(v)

// Coercing fields of parsed JSON whose shape isn't checked whole: a field of
// the wrong type reads as empty.
export const str = (v: unknown): string => (typeof v === 'string' ? v : '')
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
export const rec = (v: unknown): JsonRecord => (isRecord(v) ? v : {})
export const records = (v: unknown): JsonRecord[] => (Array.isArray(v) ? v.filter(isRecord) : [])

// Written whole, through a rename, so a reader never sees half a file. The
// temp file is named for the pid, so two writers never share one.
export function writeAtomic(file: string, body: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, body)
  renameSync(tmp, file)
}

// The parsed file, or undefined when it's missing (none yet), unreadable or
// broken. The last two are told to `log` as `message`, so each caller keeps
// its own fixed message.
export function readJsonFile(file: string, log?: Pick<Logger, 'warn'>, message = 'file unreadable'): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    if (errCode(err) !== 'ENOENT') log?.warn(message, { path: file, err: errorMessage(err) })
    return undefined
  }
}
