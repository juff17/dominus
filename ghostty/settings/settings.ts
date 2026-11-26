// One flat JSON file of key → value, holding only the ones changed from their
// default, so the watcher (Python) and the tray widget (QML, through tray.ts)
// can read it too. A value that's missing, of the wrong type or out of range
// reads as its default, so a hand-edited file can't break anything that
// reads it.

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { isRecord, writeAtomic } from '../core/json.ts'
import { errCode, errorMessage, logger } from '../core/log.ts'
import { expandHome } from '../core/paths.ts'
import { t } from '../core/text.ts'
import type { FlagsRow, KeyKind, ListRow, Mode, Setting, SettingValue } from './rows.ts'
import { BUILTIN, BUILTIN_MODES, BY_KEY, ROWS, type RowOf, type SettingKey, type SettingRow, type Settings, isAdded, modeName, row } from './catalog.ts'

const log = logger('settings')

// AGENT_HUB_SETTINGS points everything at another file. It's read on each
// call, so a test can set it after importing a module that reads settings.
export const settingsFile = (): string =>
  process.env.AGENT_HUB_SETTINGS || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agent-hub', 'settings.json')

export const KEY_PATTERN: Record<KeyKind, RegExp> = { alt: /^alt\+[a-z0-9]$/, ghostty: /^ctrl\+shift\+[a-z0-9]$/ }
// A host as gh and glab take it: a name, and a port when it has one.
export const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/
export const MAX_HOSTS = 8

export function valid<R extends Setting>(r: R, v: unknown): v is R['default'] {
  switch (r.type) {
    case 'choice':
      return r.choices.some(c => c.value === v)
    case 'bool':
      return typeof v === 'boolean'
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) && v >= r.min && v <= r.max
    case 'flags':
      return Array.isArray(v) && v.every((x: unknown) => r.choices.some(c => c.value === x))
    case 'key':
      return v === '' || (typeof v === 'string' && KEY_PATTERN[r.kind].test(v))
    case 'modes':
      return validModes(v)
    case 'file':
      return v === '' || (isText(v, 500) && /^(\/|~\/)/.test(v))
    case 'hosts':
      return validHosts(v)
    case 'list':
      return validList(r, v)
    case 'text':
      return v === '' || (isText(v, r.max) && r.item.test(v))
  }
}

function validList(r: ListRow, v: unknown): v is string[] {
  if (!Array.isArray(v) || v.length > r.max) return false
  return v.every((w: unknown) => typeof w === 'string' && w.length <= 200 && r.item.test(w)) && new Set(v).size === v.length && r.keep.every(k => v.includes(k))
}

export function parseList(r: ListRow, text: string): string[] | null {
  const typed = text.split(',').map(w => w.trim().replace(/\s+/g, ' ')).filter(Boolean)
  const words = [...new Set([...r.keep.filter(k => !typed.includes(k)), ...typed])]
  return validList(r, words) ? words : null
}

function validHosts(v: unknown): v is string[] {
  if (!Array.isArray(v) || v.length > MAX_HOSTS) return false
  return v.every((h: unknown) => typeof h === 'string' && h.length <= 253 && HOST_PATTERN.test(h)) && new Set(v).size === v.length
}

// A pasted address keeps only its host.
const hostOf = (h: string): string => (/^\w+:\/\//.test(h) ? h.replace(/^\w+:\/\//, '').replace(/\/.*$/, '') : h).toLowerCase()
export function parseHosts(text: string): string[] | null {
  const list = [...new Set(text.split(/[\s,]+/).filter(Boolean).map(hostOf))]
  return validHosts(list) ? list : null
}

const isText = (v: unknown, most: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= most && !/[\t\n\r]/.test(v)

const isMode = (m: unknown): m is Mode =>
  isRecord(m) && typeof m.on === 'boolean' && typeof m.id === 'string' && (BUILTIN.has(m.id) || (isAdded(m.id) && isText(m.name, 24) && isText(m.cmd, 500)))

function validModes(v: unknown): v is Mode[] {
  return Array.isArray(v) && v.every(isMode) && new Set(v.map(m => m.id)).size === v.length && v.some(m => m.on)
}

// The saved list's good entries, the first of each id. A bad one (a hand
// edit, or a built-in a later version drops) costs only itself: were the
// whole list to read as the default, the panel's next edit of it would save
// that default over every mode you added.
function savedModes(v: unknown, fallback: Mode[]): Mode[] {
  const kept: Mode[] = []
  const entries = Array.isArray(v) ? v : []
  for (const m of entries) if (isMode(m) && !kept.some(k => k.id === m.id)) kept.push(m)
  // Said, as the panel's next mode edit saves the list without them.
  if (kept.length < entries.length) log.warn('modes dropped', { kept: kept.length, saved: entries.length })
  const list = withBuiltins(kept)
  return list.some(m => m.on) ? list : withBuiltins(fallback)
}

// A built-in mode the list doesn't have (one a later version adds) goes on at
// its end.
const withBuiltins = (list: Mode[]): Mode[] => [
  ...list,
  ...BUILTIN_MODES.filter(b => !list.some(m => m.id === b.id)).map(b => ({ id: b.id, on: true })),
]

export function addedId(name: string, list: readonly { id: string }[]): string {
  const base = `x-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'mode'}`
  let id = base
  for (let n = 2; list.some(m => m.id === id); n++) id = `${base}-${n}`
  return id
}

const isMissing = (e: unknown): boolean => errCode(e) === 'ENOENT'

// {} when it's missing; throws when it's there but unreadable, broken or not
// an object.
function readObjectStrict(file: string): Record<string, unknown> {
  let v: unknown
  try {
    v = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    if (isMissing(e)) return {}
    throw e
  }
  if (!isRecord(v)) throw new Error(`${basename(file)} holds no JSON object`)
  return v
}

// {} for a broken file too, so a hand edit can't break what reads it.
export function readObject(file: string): Record<string, unknown> {
  try {
    return readObjectStrict(file)
  } catch (e) {
    log.warn('file unreadable', { path: file, err: errorMessage(e) })
    return {}
  }
}

// Values carried over from prefs.json, beside the file, which is where the
// hub kept "don't ask again" before there were settings.
function legacy(file: string): Record<string, unknown> {
  const skip = readObject(join(dirname(file), 'prefs.json')).skip
  return isRecord(skip) && skip['stop-monitor'] ? { 'hub.askStopMonitor': false } : {}
}

// A setting that moved to another key reads the old one's value until the
// new one is saved.
const RENAMED: Record<string, string> = { 'todo.handoff.defaultRepo': 'general.folder' }
const renamed = (saved: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(RENAMED).flatMap(([from, to]) => (from in saved && !(to in saved) ? [[to, saved[from]]] : [])))

const raw = (file: string): Record<string, unknown> => {
  const saved = readObject(file)
  return { ...legacy(file), ...renamed(saved), ...saved }
}

function savedOrDefault(r: SettingRow, saved: Record<string, unknown>): SettingValue {
  const v = saved[r.key]
  if (r.type === 'modes') return savedModes(v, r.default)
  return valid(r, v) ? v : r.default
}

// Not the mtime alone: two writes in one clock tick share it, and a reader that read between them would keep the first.
// Every write here renames a new inode into place, and an editor writing in
// place changes the size or the ctime.
function versionOf(file: string): string {
  try {
    const s = statSync(file)
    return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
  } catch {
    // No file yet: every value is its default.
    return ''
  }
}

// The hub and agentd read it often, so it's read again only when the file
// changes.
let cache: { file: string; version: string; values: Settings } | undefined
export function load(file = settingsFile()): Settings {
  const version = versionOf(file)
  if (cache?.file === file && cache.version === version) return cache.values
  const saved = raw(file)
  // Built from ROWS, which has every key, each value checked against its row.
  const values = Object.freeze(Object.fromEntries(ROWS.map(r => [r.key, savedOrDefault(r, saved)]))) as Settings
  cache = { file, version, values }
  return values
}

// At run time a key there isn't reads as undefined,
// which the shell's `setting` (bin/lib/core.sh) takes as its cue to fall back.
export const get = <K extends SettingKey>(key: K, file = settingsFile()): Settings[K] => load(file)[key]

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const writeJson = (file: string, value: unknown): void => writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`)

// A value back at its default is left out, so a default changed here later
// reaches everyone who never changed it. Keys this version doesn't know are
// kept. A file that's there but won't read as an object throws: it reads as
// every default, so writing it back with one value would lose all the others
// for good.
export function set<K extends SettingKey>(key: K, value: RowOf<K>['default'], file = settingsFile()): Settings {
  const r = BY_KEY.get(key)
  if (!r || !valid(r, value)) throw new Error(`Not a value for ${key}: ${JSON.stringify(value)}`)
  let saved: Record<string, unknown>
  try {
    const strict = readObjectStrict(file)
    saved = { ...legacy(file), ...renamed(strict), ...strict }
    for (const from of Object.keys(RENAMED)) delete saved[from]
  } catch (e) {
    throw new Error(`${basename(file)} is broken, fix it by hand first: ${errorMessage(e)}`, { cause: e })
  }
  // Unless a carried-over value would come back in its place.
  if (same(value, r.default) && !(key in legacy(file))) delete saved[key]
  else saved[key] = value
  writeJson(file, saved)
  // The new file can take the old one's freed inode, at the same size in the
  // same tick, which versionOf can't tell apart.
  cache = undefined
  return load(file)
}

// Where an agent starts when nothing names a folder: General's Default
// folder, else ~/projects.
export const defaultFolderSetting = (v: Settings = load()): string => v['general.folder'] || '~/projects'

// Home when that folder isn't on disk, so a start never fails over it.
export function defaultFolder(v: Settings = load(), isDir = (d: string): boolean => !!statSync(d, { throwIfNoEntry: false })?.isDirectory()): string {
  const folder = expandHome(defaultFolderSetting(v))
  return isDir(folder) ? folder : homedir()
}

export const reset = (key: SettingKey, file = settingsFile()): Settings => set(key, row(key).default, file)

export function step(r: Setting, value: SettingValue, dir: -1 | 1): SettingValue {
  switch (r.type) {
    case 'choice': {
      const i = r.choices.findIndex(c => c.value === value)
      return r.choices[(i + dir + r.choices.length) % r.choices.length].value
    }
    case 'number':
      return Math.min(r.max, Math.max(r.min, Number(value) + dir * r.step))
    case 'bool':
      return !value
    default:
      return value
  }
}

export const toggleFlag = (r: FlagsRow, value: readonly string[], flag: string): string[] =>
  r.choices.map(c => c.value).filter(v => (v === flag ? !value.includes(v) : value.includes(v)))

export { expandHome } from '../core/paths.ts'

// v is r's own value, so the row's type says what it is.
export function show(r: Setting, v: SettingValue): string {
  switch (r.type) {
    case 'key':
      return String(v) || t('settings.ui.unbound')
    case 'file':
      return String(v) || r.empty || t('settings.ui.none')
    case 'modes':
      return (v as Mode[])
        .filter(m => m.on)
        .map(modeName)
        .join(', ')
    case 'number':
      return `${v}${r.unit}`
    case 'bool':
      return t(v ? 'settings.ui.on' : 'settings.ui.off')
    case 'choice':
      return r.choices.find(c => c.value === v)?.label ?? String(v)
    case 'flags':
      return (v as string[]).join(', ')
    case 'hosts':
      return (v as string[]).join(', ') || t('settings.ui.none')
    case 'list':
      return (v as string[]).join(', ') || r.empty || t('settings.ui.none')
    case 'text':
      return String(v) || r.empty || t('settings.ui.none')
  }
}
