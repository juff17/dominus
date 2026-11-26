// The attach drawer's options for a pr-babysit monitor, the prompt line
// pr-babysit's SKILL.md (Attach options) reads, and a record per PR so
// Running can say what a monitor watches.

import { dirname, join } from 'node:path'

import { isRecord, readJsonFile, writeAtomic } from '../../core/json.ts'
import type { Logger } from '../../core/log.ts'
import { settingsFile } from '../../settings/settings.ts'

// ping: every comment pings you.
export type Watch = { pipeline: boolean; comments: boolean; rebase: boolean; ping: boolean }
export type WatchKey = keyof Watch
// In the drawer's order: keys 1 to 4.
export const WATCH_KEYS: readonly WatchKey[] = ['pipeline', 'comments', 'rebase', 'ping']
export const DEFAULT_WATCH: Watch = { pipeline: true, comments: true, rebase: true, ping: false }

// When it stops on its own.
export const UNTILS = ['merged', 'pipeline', '8h', '24h'] as const
export type Until = (typeof UNTILS)[number]

export type AttachOptions = { watch: Watch; until: Until; model: string; effort: string; brief: string }

// From Settings › Monitors' Watch by default and Until.
export const watchOf = (on: readonly string[]): Watch => ({ pipeline: on.includes('pipeline'), comments: on.includes('comments'), rebase: on.includes('rebase'), ping: on.includes('ping') })
export const untilOf = (v: string): Until => UNTILS.find(u => u === v) ?? 'merged'

// What it's told, in its starting prompt after the PR's address:
//   Attach options: watch pipeline, comments; skip rebase; ping on every
//   comment; until merged.
// The brief goes last in the prompt, as typed (BRIEF_LABEL).
export const BRIEF_LABEL = 'Brief:'
const UNTIL_WORDS: Record<Until, string> = { merged: 'until merged or closed', pipeline: 'until the pipeline passes', '8h': 'for 8 hours', '24h': 'for 24 hours' }
const WATCHED: Record<Exclude<WatchKey, 'ping'>, string> = { pipeline: 'pipeline', comments: 'comments', rebase: 'rebase' }

export function attachLine(o: Pick<AttachOptions, 'watch' | 'until'>): string {
  const keys = Object.keys(WATCHED) as (keyof typeof WATCHED)[]
  const on = keys.filter(k => o.watch[k]).map(k => WATCHED[k])
  const off = keys.filter(k => !o.watch[k]).map(k => WATCHED[k])
  const parts = [`watch ${on.join(', ') || 'nothing'}`, ...(off.length ? [`skip ${off.join(', ')}`] : []), ...(o.watch.ping ? ['ping on every comment'] : []), UNTIL_WORDS[o.until]]
  return `Attach options: ${parts.join('; ')}.`
}

export type AttachRecord = AttachOptions & { at: number }
// By PR address.
export type Attached = Record<string, AttachRecord>

export const monitorsDir = (): string => join(dirname(settingsFile()), 'monitors')
export const attachedFile = (): string => join(monitorsDir(), 'attached.json')

const KEEP_MS = 30 * 24 * 3600 * 1000

const isWatch = (v: unknown): v is Watch => isRecord(v) && WATCH_KEYS.every(k => typeof v[k] === 'boolean')
const isRecordOf = (v: unknown): v is AttachRecord =>
  isRecord(v) &&
  isWatch(v.watch) &&
  UNTILS.some(u => u === v.until) &&
  typeof v.model === 'string' &&
  typeof v.effort === 'string' &&
  typeof v.brief === 'string' &&
  typeof v.at === 'number'

export function readAttached(file = attachedFile(), log?: Pick<Logger, 'warn'>): Attached {
  const raw = readJsonFile(file, log, 'attach records unreadable')
  if (!isRecord(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, AttachRecord] => isRecordOf(e[1])))
}

// Written through a rename, so a reader never sees half a file.
export function recordAttached(urls: readonly string[], o: AttachOptions, now: number, file = attachedFile()): Attached {
  const kept = Object.entries(readAttached(file)).filter(([, r]) => now - r.at < KEEP_MS)
  const next: Attached = Object.fromEntries([...kept, ...urls.map(u => [u, { ...o, at: now }] as const)])
  writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  return next
}
