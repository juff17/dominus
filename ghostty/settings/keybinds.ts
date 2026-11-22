// Settings › Keybinds made real. layout.conf stays the one place each alt
// key's command is written: a rebind takes that `bind -n M-…` statement as it
// stands and binds it to the new key, in a file sourced into the layout's
// tmux (bin/ghostty-keys, also run as layout.conf loads). Ghostty's keys go
// in keys.local.ghostty beside config.ghostty, which includes it, and
// Ghostty reloads its config on SIGUSR2.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { errCode, errorMessage, logger } from '../core/log.ts'
import { t, text } from '../core/text.ts'
import { type KeyRow, ROWS, type SettingRow, load, settingsFile } from './settings.ts'

const log = logger('settings')

export type KeybindRow = Extract<SettingRow, { type: 'key' }>
export type KeyName = KeybindRow['key']
// A missing row is its default.
export type KeyValues = Partial<Record<KeyName, string>>

export const KEY_ROWS: KeybindRow[] = ROWS.filter((r): r is KeybindRow => r.type === 'key')

// Keys a rebind may not take, and what has them already. Claude Code's own
// alt keys pass through when the layout doesn't bind them.
const R = text<Record<string, string>>('settings.keybinds.reserved')
export const RESERVED: Record<string, string> = {
  'alt+b': R.shellWordBack,
  'alt+f': R.shellWordForward,
  'alt+p': R.modelPicker,
  'ctrl+shift+c': R.copy,
  'ctrl+shift+v': R.paste,
  'ctrl+shift+q': R.quit,
  'ctrl+shift+o': R.splitRight,
  'ctrl+shift+e': R.splitDown,
  'ctrl+shift+i': R.inspector,
  'ctrl+shift+j': R.scrollback,
  'ctrl+shift+p': R.palette,
}

// Alt rows take the letter with or without alt held; Ghostty rows take it
// with or without ctrl, since ctrl+shift+letter reaches a terminal program
// as ctrl+letter.
export function captured(r: KeyRow, key: string): string | null {
  let c: string | undefined
  if (key.length === 2 && key[0] === '\x1b') c = key[1]
  else if (key.length === 1) {
    const code = key.charCodeAt(0)
    c = r.kind === 'ghostty' && code >= 1 && code <= 26 && !'\t\r'.includes(key) ? String.fromCharCode(code + 96) : key
  }
  c = c?.toLowerCase()
  if (!c || !/^[a-z0-9]$/.test(c)) return null
  return `${r.kind === 'alt' ? 'alt' : 'ctrl+shift'}+${c}`
}

// Why row r can't take spec, or null when it can.
export function clash(r: KeyRow, spec: string, values: KeyValues = load()): string | null {
  if (!spec) return null
  if (RESERVED[spec]) return t('settings.keybinds.takenBy', { key: spec, what: RESERVED[spec] })
  // An alt key and a ctrl+shift one never meet: tmux has the one, Ghostty the other.
  const other = KEY_ROWS.find(o => o.key !== r.key && o.kind === r.kind && values[o.key] === spec)
  return other ? t('settings.keybinds.takenBy', { key: spec, what: other.label }) : null
}

export const tmuxKey = (spec: string): string => `M-${spec.slice('alt+'.length)}`
// What an alt key sends a terminal program: Esc, then the letter.
export const altSeq = (spec: string): string => `\x1b${spec.slice('alt+'.length)}`

export const layoutConf = (): string => join(dirname(fileURLToPath(import.meta.url)), '..', 'layout.conf')

// Key → its whole statement, which runs over lines while its braces are open.
export function statements(layout: string): Map<string, string> {
  const out = new Map<string, string>()
  let cur: { key: string; lines: string[] } | null = null
  let depth = 0
  for (const line of layout.split('\n')) {
    if (!cur) {
      const m = /^bind -n (M-\S+) /.exec(line)
      if (!m) continue
      cur = { key: m[1], lines: [] }
      depth = 0
    }
    cur.lines.push(line)
    for (const ch of line) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0
    if (depth <= 0) {
      out.set(cur.key, cur.lines.join('\n'))
      cur = null
    }
  }
  return out
}

const HEADER = '# Written by Settings › Keybinds (settings/keybinds.ts); changes here are overwritten.'

// Every alt letter and digit layout.conf doesn't bind for something else is
// unbound first, so a key moved off again is free.
export function tmuxConf(values: KeyValues, layout: string): string {
  const all = statements(layout)
  const rows = KEY_ROWS.filter(r => r.kind === 'alt')
  const mine = new Set(rows.map(r => tmuxKey(r.default)))
  const others = new Set([...all.keys()].filter(k => !mine.has(k)))
  const lines = [HEADER]
  for (const c of 'abcdefghijklmnopqrstuvwxyz0123456789') if (!others.has(`M-${c}`)) lines.push(`unbind -q -n M-${c}`)
  for (const r of rows) {
    const v = values[r.key] ?? r.default
    const body = all.get(tmuxKey(r.default))
    if (!v || !body) continue
    // A statement that passes its key through elsewhere (`send-keys M-v` off
    // the work window) passes the new key, not the one it was written for.
    const passThrough = new RegExp(`(\\bsend-keys )${tmuxKey(r.default)}(?![\\w-])`, 'g')
    lines.push(body.replace(/^bind -n M-\S+/, `bind -n ${tmuxKey(v)}`).replace(passThrough, `$1${tmuxKey(v)}`))
  }
  return `${lines.join('\n')}\n`
}

// Every unbind comes first: a later line for the same key wins in Ghostty, so
// a row moved onto a default another row gave up would be unbound again by
// that row's line.
export function ghosttyConf(values: KeyValues): string {
  const unbinds: string[] = []
  const binds: string[] = []
  for (const r of KEY_ROWS.filter(r => r.kind === 'ghostty')) {
    // Missing is the default; only '' takes a key off.
    const v = values[r.key] ?? r.default
    if (v === r.default) continue
    unbinds.push(`keybind = ${r.default}=unbind`)
    if (v) binds.push(`keybind = ${v}=${r.run}`)
  }
  return `${[HEADER, ...unbinds, ...binds].join('\n')}\n`
}

export const tmuxFile = (): string => join(dirname(settingsFile()), 'keys.tmux.conf')
// Beside the config.ghostty link, not the file it leads to: Ghostty reads
// an included path from the folder of the link it opened.
export const ghosttyFile = (): string => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ghostty', 'keys.local.ghostty')

// Through a rename, so tmux or Ghostty never reads half a file: the layout's
// start-up and a panel save can both be writing one.
const write = (file: string, body: string): void => {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, body)
  renameSync(tmp, file)
}

const readOrNull = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    // Not written yet.
    return null
  }
}

// Your Ghostty processes that catch SIGUSR2, so the signal reloads their
// config and never kills one built without that. Another user's would only
// refuse the signal.
function reloadableGhosttys(): number[] {
  let pids: number[] = []
  const uid = process.getuid?.()
  try {
    pids = execFileSync('pgrep', [...(uid === undefined ? [] : ['-u', String(uid)]), '-x', 'ghostty'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    // pgrep exits 1 when no Ghostty is running.
  }
  return pids.filter(pid => {
    const status = readOrNull(`/proc/${pid}/status`)
    const caught = status === null ? null : /^SigCgt:\s*([0-9a-f]+)/m.exec(status)
    return caught !== null && ((BigInt(`0x${caught[1]}`) >> 11n) & 1n) === 1n
  })
}

type ApplyOptions = { ghostty?: boolean }

// Ghosttys a reload signal didn't reach. An unchanged keys.local.ghostty
// sends no signal, so without this a second try (the Settings panel saving
// again) would leave them on the old keys.
const unreloaded = new Set<number>()

// `ghostty: false` is for when only tmux has to catch up. Returns why one of
// them didn't take the keys up, or ''; a file that can't be written throws.
export function apply(values: KeyValues = load(), { ghostty = true }: ApplyOptions = {}): string {
  write(tmuxFile(), tmuxConf(values, readFileSync(layoutConf(), 'utf8')))
  const tmux = sourceInTmux()
  if (!ghostty) return tmux
  const file = ghosttyFile()
  const next = ghosttyConf(values)
  const changed = next !== readOrNull(file)
  if (changed) write(file, next)
  const pids = changed ? reloadableGhosttys() : [...unreloaded]
  unreloaded.clear()
  const failed = pids.map(reload).filter(Boolean)
  return tmux || failed[0] || ''
}

// tmux's words for a socket no server listens on.
const NO_SERVER = /no server running|error connecting to/

// Why tmux refused the file, or ''.
function sourceInTmux(): string {
  const cmd = ['tmux', '-L', process.env.GHOSTTY_LAYOUT_SOCKET || 'ghostty-layout', 'source-file', tmuxFile()]
  try {
    execFileSync(cmd[0], cmd.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] })
    return ''
  } catch (e) {
    // stderr is null when tmux never started (ENOENT, EACCES).
    const stderr = e instanceof Error && 'stderr' in e && e.stderr ? String(e.stderr) : ''
    // No layout running yet (or no tmux at all): layout.conf applies the
    // file when one starts.
    if (NO_SERVER.test(stderr) || errCode(e) === 'ENOENT') return ''
    const exit = e instanceof Error && 'status' in e ? e.status : undefined
    const err = stderr.trim() || errorMessage(e)
    log.error('keys not sourced', { cmd, exit, err })
    return err
  }
}

// One Ghostty that can't be signalled doesn't stop the others reloading, and
// is tried again by the next apply (unreloaded). One that's gone since pgrep
// listed it has nothing to reload. Returns why it wasn't reloaded, or ''.
function reload(pid: number): string {
  try {
    process.kill(pid, 'SIGUSR2')
    return ''
  } catch (e) {
    if (errCode(e) === 'ESRCH') return ''
    log.warn('ghostty not reloaded', { pid, err: errorMessage(e) })
    unreloaded.add(pid)
    return String(errCode(e) ?? errorMessage(e))
  }
}
