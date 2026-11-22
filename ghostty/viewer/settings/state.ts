// Keys only: the panel takes no clicks.

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { errorMessage, logger } from '../../core/log.ts'
import { t } from '../../core/text.ts'
import { type Menu, complete, suggestion } from '../../tui/complete.ts'
import { editField, insertAt, length } from '../../tui/line.ts'
import { P } from '../../tui/term.ts'
import {
  BUILTIN_MODES,
  type Mode,
  SECTIONS,
  type RowOf,
  type SettingKey,
  type SettingRow,
  type Settings,
  addedId,
  expandHome,
  isAdded,
  isSetting,
  load,
  modeName,
  parseHosts,
  parseList,
  reset,
  row,
  set,
  step,
  toggleFlag,
} from '../../settings/settings.ts'
import { type KeybindRow, apply, captured, clash } from '../../settings/keybinds.ts'

const log = logger('settings-panel')

function onPath(cmd: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some(dir => {
    try {
      accessSync(join(dir || '.', cmd), constants.X_OK)
      return true
    } catch {
      // Not in this folder; the next one may have it.
      return false
    }
  })
}

// Tests put stand-ins here.
export const effects: { applyKeys: () => string; hasYazi: () => boolean } = { applyKeys: () => apply(), hasYazi: () => onPath('yazi') }

type ModesKey = Extract<SettingRow, { type: 'modes' }>['key']
type FileRow = Extract<SettingRow, { type: 'file' }>
type HostsRow = Extract<SettingRow, { type: 'hosts' }>
type ListRow = Extract<SettingRow, { type: 'list' }>
type SteppedRow = Extract<SettingRow, { type: 'choice' | 'number' | 'bool' }>

// Each mode row carries the list's key, so a row knows which setting it's in.
export type ModeItem = { key: ModesKey; type: 'mode'; index: number; mode: Mode; label: string }
export type AddModeItem = { key: ModesKey; type: 'addMode'; label: string }
export type SettingItem = Exclude<SettingRow, { type: 'modes' }>
export type Item = SettingItem | ModeItem | AddModeItem

// `at` undefined is the caret at the end. `files` is whether completion
// offers files, or only folders. Hosts and lists are typed as one line,
// comma apart.
export type ModeInput = { field: 'name' | 'cmd'; key: ModesKey; name: string; text: string }
export type FileInput = { field: 'file'; key: FileRow['key']; label: string; text: string; files: boolean; menu: Menu | null; at?: number }
export type HostsInput = { field: 'hosts'; key: HostsRow['key']; label: string; text: string; at?: number }
export type ListInput = { field: 'list'; key: ListRow['key']; label: string; text: string; at?: number }
export type Input = ModeInput | FileInput | HostsInput | ListInput
// The longest command or path set() takes.
const LONGEST = 500

export type Note = { text: string; color: string }

// The row the last key or frame left selected. The file can change under an
// open panel (another client's panel, a hand edit), and a list of modes with
// one gone or moved would leave sel on another row, or past the end.
export type Seen = { sec: number; sel: number; id: string }

// `flag` is which flag ←/→ is on in a row of flags. `capture` is a Keybinds
// row waiting for its new key.
export type SettingsState = { sec: number; sel: number; flag: number; scroll: number; note: Note | null; capture: boolean; input: Input | null; seen?: Seen }

export const start = (id?: string): SettingsState => ({
  sec: Math.max(0, SECTIONS.findIndex(s => s.id === id)),
  sel: 0,
  flag: 0,
  scroll: 0,
  note: null,
  capture: false,
  input: null,
})

export const modeRows = (r: { key: ModesKey }, values: Settings = load()): (ModeItem | AddModeItem)[] => [
  ...values[r.key].map((m, index): ModeItem => ({ key: r.key, type: 'mode', index, mode: m, label: modeName(m) })),
  { key: r.key, type: 'addMode', label: t('settings.ui.addMode') },
]

// Not the lines that only say where an agent's instructions are; a list of
// modes is a row each.
export const items = (s: Pick<SettingsState, 'sec'>): Item[] =>
  SECTIONS[s.sec].rows.filter(isSetting).flatMap((r): Item[] => (r.type === 'modes' ? modeRows(r) : [r]))
export const current = (s: Pick<SettingsState, 'sec' | 'sel'>): Item => items(s)[s.sel]

// Which row an item is, apart from where the list puts it.
const itemId = (i: Item | undefined): string => (!i ? '' : i.type === 'mode' ? `${i.key}:${i.mode.id}` : i.type === 'addMode' ? `${i.key}:+` : i.key)

const mark = (s: SettingsState, list: Item[] = items(s)): void => {
  s.seen = { sec: s.sec, sel: s.sel, id: itemId(list[s.sel]) }
}

// Before each key and each frame: when the file has moved the row last seen
// selected, sel follows it, or stays put when it's gone, kept on a row that's
// there. Only when nothing here moved sel since, so code that set it on
// purpose isn't undone.
export function follow(s: SettingsState): void {
  const list = items(s)
  const was = s.seen
  if (was && was.sec === s.sec && was.sel === s.sel && itemId(list[s.sel]) !== was.id) {
    const at = list.findIndex(i => itemId(i) === was.id)
    if (at >= 0) s.sel = at
    s.flag = 0
  }
  s.sel = Math.max(0, Math.min(list.length - 1, s.sel))
  mark(s, list)
}

// Node's errors carry a code (ENOTDIR, EACCES) that says it in a word.
const errorCode = (e: unknown): string => (e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : errorMessage(e))

function saving(s: SettingsState, message: string, fields: { key: SettingKey; value?: unknown }, write: () => void): boolean {
  try {
    write()
  } catch (err) {
    log.warn('setting change failed', { ...fields, err: errorMessage(err) })
    s.note = { text: t('settings.ui.cantSave', { err: errorCode(err) }), color: P.red }
    return false
  }
  log.info(message, fields)
  s.note = null
  if (row(fields.key).type === 'key') applyKeys(s, fields.key)
  return true
}

// A keybind is saved by now; tmux and Ghostty taking it up is a step of its
// own, so its failure doesn't read as the save failing.
function applyKeys(s: SettingsState, key: SettingKey): void {
  let why: string
  try {
    why = effects.applyKeys()
  } catch (err) {
    log.error('keys not applied', { key, err: errorMessage(err) })
    why = errorCode(err)
  }
  // apply() has logged why tmux or a Ghostty refused them.
  if (why) s.note = { text: t('settings.ui.notApplied', { err: why.slice(0, 120) }), color: P.red }
}

const save = <K extends SettingKey>(s: SettingsState, key: K, value: RowOf<K>['default']): boolean =>
  saving(s, 'setting changed', { key, value }, () => set(key, value))
const restore = (s: SettingsState, key: SettingKey) => saving(s, 'setting reset', { key }, () => reset(key))

// The cast is safe: step() gives back a value of the row's own type, and
// set() checks it again.
const stepped = <R extends SteppedRow>(r: R, dir: -1 | 1): RowOf<R['key']>['default'] => step(r, load()[r.key], dir) as RowOf<R['key']>['default']

function bindKey(s: SettingsState, r: KeybindRow, spec: string): void {
  const why = clash(r, spec)
  if (why) s.note = { text: t('settings.ui.notSaved', { why }), color: P.red }
  else save(s, r.key, spec)
}

function onCapture(s: SettingsState, key: string) {
  s.capture = false
  const r = current(s)
  if (key === '\x1b' || key === '\x03' || r.type !== 'key') return
  if (key === '\x7f') return bindKey(s, r, '')
  const spec = captured(r, key)
  if (spec) bindKey(s, r, spec)
  else s.note = { text: t('settings.ui.notAKey', { mods: r.kind === 'alt' ? 'alt' : 'ctrl+shift' }), color: P.red }
}

const say = (s: SettingsState, text: string): void => {
  s.note = { text, color: P.peach }
}

// A string from fn is a note to show instead of saving.
function editModes(s: SettingsState, key: ModesKey, fn: (list: Mode[]) => Mode[] | string): boolean {
  const out = fn(load()[key].map(m => ({ ...m })))
  if (typeof out === 'string') {
    say(s, out)
    return false
  }
  return save(s, key, out)
}

// Why the viewer pane would have nothing to run with this list, or null.
// bin/ghostty-viewer skips Files without yazi, so Files alone on is as bad
// as none on.
function noneRuns(list: Mode[]): string | null {
  if (list.some(m => m.on && (m.id !== 'files' || effects.hasYazi()))) return null
  return list.some(m => m.on) ? t('settings.ui.filesNeedsYazi') : t('settings.ui.oneModeOn')
}

function flipMode(s: SettingsState, { key, index }: ModeItem): void {
  editModes(s, key, list => {
    list[index].on = !list[index].on
    return noneRuns(list) ?? list
  })
}

function moveMode(s: SettingsState, { key, index }: ModeItem, dir: -1 | 1): void {
  const to = index + dir
  if (to < 0 || to >= load()[key].length) return
  const moved = editModes(s, key, list => {
    ;[list[index], list[to]] = [list[to], list[index]]
    return list
  })
  if (moved) pickRow(s, s.sel + dir)
}

function removeMode(s: SettingsState, { key, index, mode }: ModeItem) {
  if (!isAdded(mode.id)) return say(s, t('settings.ui.builtIn', { name: modeName(mode) }))
  editModes(s, key, list => {
    list.splice(index, 1)
    return noneRuns(list) ?? list
  })
  pickRow(s, s.sel)
}

// Ones you added stay, after the built-ins. Like J and K, the mode stays
// selected wherever the new order puts it.
function resetModes(s: SettingsState, r: ModeItem | AddModeItem): void {
  const saved = editModes(s, r.key, list => [...BUILTIN_MODES.map(b => ({ id: b.id, on: true })), ...list.filter(m => isAdded(m.id))])
  if (!saved || r.type !== 'mode') return
  const at = items(s).findIndex(i => i.type === 'mode' && i.mode.id === r.mode.id)
  if (at >= 0) pickRow(s, at)
}

export function startAdd(s: SettingsState): void {
  const list = items(s)
  const at = list.findIndex(i => i.type === 'addMode')
  const add = list[at]
  if (add?.type !== 'addMode') return
  s.sel = at
  s.input = { field: 'name', key: add.key, name: '', text: '' }
  s.note = null
}

function inputKey(s: SettingsState, input: Input, key: string) {
  if (key === '\x1b' || key === '\x03') {
    s.input = null
    s.note = null
    return
  }
  if (key === '\r') return submit(s, input)
  if (input.field === 'file') return pathKey(input, key)
  if (input.field === 'hosts' || input.field === 'list') return void editField(input, 'text', key)
  if (key === '\x7f' || key === '\b') {
    input.text = [...input.text].slice(0, -1).join('')
    return
  }
  // Counted in code points: the tokenizer hands an emoji over as one key of
  // two UTF-16 units.
  if ([...key].length === 1 && key >= ' ') typeText(s, key)
}

function submit(s: SettingsState, input: Input) {
  const text = input.text.trim()
  if (input.field === 'file') return saveFile(s, input.key, text)
  if (input.field === 'hosts') return saveHosts(s, input.key, text)
  if (input.field === 'list') return saveList(s, input.key, text)
  if (!text) return say(s, t(input.field === 'name' ? 'settings.ui.nameFirst' : 'settings.ui.commandFirst'))
  if (input.field === 'name') {
    s.input = { field: 'cmd', key: input.key, name: text.slice(0, 24), text: '' }
    s.note = null
    return
  }
  // The footer stays open on a failed save, so the name and command typed
  // aren't lost.
  if (!editModes(s, input.key, list => [...list, { id: addedId(input.name, list), name: input.name, cmd: text.slice(0, LONGEST), on: true }])) return
  s.input = null
  pickRow(s, items(s).findIndex(i => i.type === 'addMode') - 1)
}

// A path that's wrong keeps the footer open to fix it.
function saveFile(s: SettingsState, key: FileRow['key'], path: string) {
  if (path && !/^(\/|~\/)/.test(path)) return say(s, t('settings.ui.wholePath'))
  const { dir } = row(key)
  let there = !path
  try {
    const st = statSync(expandHome(path))
    there ||= dir ? st.isDirectory() : st.isFile()
  } catch (err) {
    log.warn('setting file unreadable', { key, path, err: errorMessage(err) })
  }
  if (!there) return say(s, t(dir ? 'settings.ui.noFolder' : 'settings.ui.noFile', { path }))
  // A completed folder ends in a slash; the setting is the folder itself.
  // The home folder keeps its: ~ alone isn't a whole path, which set() refuses.
  const value = dir ? path.replace(/(.)\/+$/, '$1').replace(/^~$/, '~/') : path
  // The footer stays open on a failed save, so the path typed isn't lost.
  if (save(s, key, value)) s.input = null
}

function saveHosts(s: SettingsState, key: HostsRow['key'], text: string) {
  const list = parseHosts(text)
  if (!list) return say(s, t('settings.ui.notHosts'))
  if (save(s, key, list)) s.input = null
}

function saveList(s: SettingsState, key: ListRow['key'], text: string) {
  const list = parseList(row(key), text)
  if (!list) return say(s, t('settings.ui.notList'))
  if (save(s, key, list)) s.input = null
}

function startList(s: SettingsState, r: ListRow): void {
  s.input = { field: 'list', key: r.key, label: r.label, text: load()[r.key].join(', ') }
  s.note = null
}

function startHosts(s: SettingsState, r: HostsRow): void {
  s.input = { field: 'hosts', key: r.key, label: r.label, text: load()[r.key].join(', ') }
  s.note = null
}

function startFile(s: SettingsState, r: FileRow): void {
  s.input = { field: 'file', key: r.key, label: r.label, text: load()[r.key], files: !r.dir, menu: null }
  s.note = null
}

// As in a shell: Tab completes and steps through the matches (Shift+Tab
// back), and → or End at the end takes the dim suggestion.
function pathKey(input: FileInput, key: string): void {
  if (key === '\t' || (key === '\x1b[Z' && input.menu)) {
    const r = complete(input.text, input.menu, key === '\x1b[Z', { files: input.files })
    input.text = r.text
    input.menu = r.menu
    delete input.at
    return
  }
  input.menu = null
  const was = { text: input.text, at: input.at }
  editPath(input, key)
  // Capped as a paste is (typeText): set() takes no longer a path, counted
  // as it counts, and ↵ would be the first to say so.
  if (input.text.length <= LONGEST || input.text.length <= was.text.length) return
  input.text = was.text
  if (was.at === undefined) delete input.at
  else input.at = was.at
}

function editPath(input: FileInput, key: string): void {
  const rest = pathGhost(input)
  if (rest && ['\x1b[C', '\x1b[F', '\x1b[4~', '\x05'].includes(key)) {
    input.text += rest
    return
  }
  // Ctrl+W takes back one part of the path, as zsh does, not the whole word.
  if (key === '\x17') {
    const chars = [...input.text]
    const at = input.at ?? chars.length
    const before = chars.slice(0, at).join('')
    const kept = before.replace(/[^/]*\/?$/, '')
    input.text = kept + chars.slice(at).join('')
    if (input.at !== undefined) input.at = length(kept)
    return
  }
  editField(input, 'text', key)
}

// The dim rest of the first match.
export const pathGhost = (input: Input): string =>
  input.field === 'file' && !input.menu && (input.at ?? length(input.text)) === length(input.text) ? suggestion(input.text, { files: input.files }) : ''

export function typeText(s: SettingsState, text: string): void {
  if (!s.input) return
  const most = s.input.field === 'name' ? 24 : LONGEST
  const clean = text.replace(/[\t\r\n]/g, ' ')
  if (s.input.field === 'file' || s.input.field === 'hosts' || s.input.field === 'list') {
    if (s.input.field === 'file') s.input.menu = null
    const r = insertAt(s.input.text, s.input.at, clean)
    s.input.text = r.text.slice(0, most)
    if (r.at < length(s.input.text)) s.input.at = r.at
    else delete s.input.at
    return
  }
  s.input.text = (s.input.text + clean).slice(0, most)
}

// The footer's note is about the row it was set on, so moving off drops it.
export function pickSection(s: SettingsState, i: number): void {
  s.sec = (i + SECTIONS.length) % SECTIONS.length
  s.sel = 0
  s.flag = 0
  s.scroll = 0
  s.note = null
}

export function pickRow(s: SettingsState, i: number): void {
  const sel = Math.max(0, Math.min(items(s).length - 1, i))
  if (sel !== s.sel) s.note = null
  s.sel = sel
  s.flag = 0
}

export function change(s: SettingsState, dir: -1 | 1): void {
  const r = current(s)
  if (r.type === 'key' || r.type === 'file' || r.type === 'hosts' || r.type === 'list' || r.type === 'addMode') return
  if (r.type === 'mode') flipMode(s, r)
  else if (r.type === 'flags') s.flag = (s.flag + dir + r.choices.length) % r.choices.length
  else save(s, r.key, stepped(r, dir))
}

export function toggle(s: SettingsState) {
  const r = current(s)
  if (r.type === 'key') {
    s.capture = true
    s.note = null
    return
  }
  if (r.type === 'mode') return flipMode(s, r)
  if (r.type === 'addMode') return startAdd(s)
  if (r.type === 'file') return startFile(s, r)
  if (r.type === 'hosts') return startHosts(s, r)
  if (r.type === 'list') return startList(s, r)
  if (r.type === 'flags') save(s, r.key, toggleFlag(r, load()[r.key], r.choices[s.flag].value))
  else save(s, r.key, stepped(r, 1))
}

function shift(s: SettingsState, dir: -1 | 1): void {
  const r = current(s)
  if (r?.type === 'mode') moveMode(s, r, dir)
  else pickSection(s, s.sec + dir)
}

function resetRow(s: SettingsState): void {
  const r = current(s)
  if (r.type === 'key') bindKey(s, r, r.default)
  else if (r.type === 'mode' || r.type === 'addMode') resetModes(s, r)
  else restore(s, r.key)
}

function clearRow(s: SettingsState): void {
  const r = current(s)
  if (r.type === 'key') bindKey(s, r, '')
  else if (r.type === 'file') save(s, r.key, '')
  else if (r.type === 'hosts') save(s, r.key, [])
  else if (r.type === 'list') save(s, r.key, [...r.keep])
}

// Typing a path or mode, or capturing a keybind, takes every key, so the
// overlay's own closing keys (Ctrl+C and the Settings key) mustn't close it.
export const mayClose = (s: SettingsState): boolean => !s.input && !s.capture

// It acts on the row the panel shows selected, wherever the file has moved
// it since.
export function onKey(s: SettingsState, key: string): 'quit' | undefined {
  follow(s)
  const out = keyed(s, key)
  mark(s)
  return out
}

function keyed(s: SettingsState, key: string): 'quit' | undefined {
  if (s.input) return void inputKey(s, s.input, key)
  if (s.capture) return void onCapture(s, key)
  const modes = items(s).some(i => i.type === 'addMode')
  const quit = () => 'quit' as const
  const actions: Record<string, () => unknown> = {
    q: quit,
    '\x1b': quit,
    j: () => pickRow(s, s.sel + 1),
    k: () => pickRow(s, s.sel - 1),
    '\x1b[B': () => pickRow(s, s.sel + 1),
    '\x1b[A': () => pickRow(s, s.sel - 1),
    g: () => pickRow(s, 0),
    G: () => pickRow(s, Infinity),
    '\t': () => pickSection(s, s.sec + 1),
    '\x1b[Z': () => pickSection(s, s.sec - 1),
    J: () => shift(s, 1),
    K: () => shift(s, -1),
    h: () => change(s, -1),
    l: () => change(s, 1),
    '\x1b[D': () => change(s, -1),
    '\x1b[C': () => change(s, 1),
    ' ': () => toggle(s),
    '\r': () => toggle(s),
    r: () => resetRow(s),
    '\x7f': () => clearRow(s),
    ...(modes && {
      a: () => startAdd(s),
      x: () => {
        const r = current(s)
        if (r.type === 'mode') removeMode(s, r)
      },
    }),
  }
  return Object.hasOwn(actions, key) && actions[key]() === 'quit' ? 'quit' : undefined
}
