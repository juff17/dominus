#!/usr/bin/env node
// The hub's New agent form, for a task: run as an overlay (tui/overlay.ts) over the whole
// window so it has room whether the hub shows the board or the narrow list
// beside an open session. Monitors start from Alt+M (viewer/monitors), not
// here. It only asks: what you chose goes to the result file as JSON and
// the hub starts the agent once the popup closes; Esc leaves no file.
//   newagent.ts <result file> <{"folder": "...", "recents": [...]}>

import { statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { TaskSpec } from '../../agents/model.ts'
import { logCrashes } from '../../core/crash.ts'
import { type Image, type Pasted, attachFiles, imageFiles, imagesDir, keptImages, nextNumber, pasteImage, placeholder, sweepImages } from '../../core/images.ts'
import { expandHome as expand, tilde } from '../../core/paths.ts'
import { type Menu, complete, matchesOf, suggestion as pathSuggestion } from '../../tui/complete.ts'
import { leftPress } from '../../tui/input.ts'
import { type LineState, editLine, insertAt, length, rowOf, rowStep, wrapRows } from '../../tui/line.ts'
import { button, chips, field, fieldLabel, radio, select } from '../../tui/controls.ts'
import { t } from '../../core/text.ts'
import { MODEL_IDS } from '../../settings/models.ts'
import { defaultFolder, load as settings } from '../../settings/settings.ts'
import { type Overlay, openOverlay, overlayBox } from '../../tui/overlay.ts'
import { BOLD, P, type Span, bg, clean, fg, render, tokens, width } from '../../tui/term.ts'
import { logger } from '../../core/log.ts'

const HOME = homedir()
const log = logger('newagent')

// Each option's label and note are newAgent.branch.<id> in core/text.json.
type Option<I extends string> = { id: I; label: string; sub: string }
const options = <I extends string>(group: string, list: { id: I }[]): Option<I>[] =>
  list.map(o => ({ ...o, label: t(`newAgent.${group}.${o.id}.label`), sub: t(`newAgent.${group}.${o.id}.sub`) }))
const BRANCH = options<'current' | 'worktree'>('branch', [{ id: 'current' }, { id: 'worktree' }])
// Default is for an agent that isn't about one repo: it runs in Settings ›
// General › Default folder, with no folder to pick, and on its current
// branch unless you choose a worktree.
const WHERE = options<'folder' | 'default'>('where', [{ id: 'folder' }, { id: 'default' }])
// What a task starts with comes from Settings (newAgent.task.*); 'default'
// is still a choice, for Claude's own.
const STARTS_WITH = ['model', 'mode', 'effort', 'chrome'] as const
type StartsWith = (typeof STARTS_WITH)[number]
const CHOICES: Record<StartsWith, readonly string[]> = {
  model: ['default', ...MODEL_IDS],
  mode: ['default', 'auto', 'acceptEdits', 'plan'],
  effort: ['default', 'low', 'medium', 'high', 'xhigh'],
  chrome: ['off', 'on'],
}
const BOX = bg(P.base)
// Space between the overlay's frame and the form.
const MARGIN_X = 3
const MARGIN_Y = 1
const HINTS = [
  ['↑/↓', t('newAgent.keys.field')],
  ['←/→', t('newAgent.keys.choose')],
  ['tab', t('newAgent.keys.completeFolder')],
  ['ctrl+s', t('hints.start')],
  ['esc', t('hints.cancel')],
]
  .map(([k, what]) => `${k} ${what}`)
  .join('   ')
// The form: the prompt and its note, a gap, where, folder, recent, a gap,
// branch and its note, a gap, model, mode, effort, chrome, a gap, Start.
// Below it a gap, then the keys. The prompt counts one row here; it wraps
// to as many as PROMPT_ROWS, the frame growing with it, and past that it
// scrolls to keep the caret's row in view.
const BODY_ROWS = 16
const LABEL_COLS = 10
const PROMPT_ROWS = 5

// The overlay frame's size, edges included, with a one-row prompt: just room
// for the form, with the folder and prompt as wide as the keys line. A
// window smaller than that gets all of it.
export const POPUP = {
  w: width(HINTS) + 2 * MARGIN_X + 2,
  h: BODY_ROWS + 2 + 2 * MARGIN_Y + 2,
}

const ESC = '\x1b'
const CTRL_C = '\x03'
const CTRL_S = '\x13'
const CTRL_E = '\x05'
const CTRL_V = '\x16'
const ENTER = '\r'
const TAB = '\t'
const SHIFT_TAB = '\x1b[Z'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const END = '\x1b[F'

type TextField = 'prompt' | 'folder'
// A choice is an index into its options; Recent is -1 while Folder isn't
// one of them.
type ChoiceField = 'where' | 'branch' | 'recent' | StartsWith
export type Field = TextField | ChoiceField | 'start'

// `images` are those pasted into the prompt, each shown there as its
// [Image #n].
export type Form = Record<ChoiceField, number> &
  Record<TextField, LineState> & {
    field: Field
    error: string | null
    images: Image[]
  }
// null for cancel.
export type Done = { done: TaskSpec | null }

// The overlay, once main() has opened it; the hub only imports POPUP.
let ov: Overlay | null = null
const cols = () => ov?.size().cols ?? (process.stdout.columns || 80)
const rows = () => ov?.size().rows ?? (process.stdout.rows || 24)

let RESULT = ''
let recents: string[] = []
let d: Form
// The last frame's clickable rows, counted from 1.
let hits: { y: number; f: Field }[] = []
// While Tab cycles through the folders that match: where they are, their
// names and which one is in the field.
let menu: Menu | null = null
// The first body row drawn, when the popup is too short for them all.
let top = 0
// The prompt's first row drawn, once it wraps past PROMPT_ROWS.
let promptTop = 0
// Branch under the Runs in choice not shown, swapped in when you switch, so
// Default starts on Current branch and each keeps what you chose in it.
let otherBranch = 0

const isText = (f: Field): f is TextField => f === 'folder' || f === 'prompt'

// The prompt's width in a frame `inner` cells wide, and the rows it wraps to.
const promptWidth = (inner = cols()) => inner - 2 * MARGIN_X - LABEL_COLS
const promptRows = (w = promptWidth()) => wrapRows(d.prompt.text, w)

// The frame as tall as the prompt's rows need, up to PROMPT_ROWS. Read from
// the window, not the overlay, whose size comes from this.
export function popupBox(screen = { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }) {
  const inner = overlayBox(screen, POPUP).w - 2
  return { w: POPUP.w, h: POPUP.h + Math.min(PROMPT_ROWS, promptRows(promptWidth(inner)).length) - 1 }
}

// Up and Down move the caret a row while the prompt has one that way.
function promptRow(dir: number): boolean {
  const at = rowStep(d.prompt.text, d.prompt.at, promptWidth(), dir)
  if (at === null) return false
  d.prompt.at = at
  return true
}

const inDefault = () => WHERE[d.where].id === 'default'

export const fields = (): Field[] => ['prompt', 'where', ...(inDefault() ? [] : (['folder', 'recent'] as const)), 'branch', ...STARTS_WITH, 'start']

// ------------------------------------------------------------ folders

export { matchesOf }

// The cursor is in code points, as tui/line.ts keeps it.
const setFolder = (text: string) => (d.folder = { text, at: length(text) })

// The folder Folder names, absolute: empty is home, and a relative path is
// from the popup's folder, the one completion listed and isFolder checks.
// The hub saves it to the recents and tmux and the spawn each read it from
// their own folder, so it never leaves the form relative. resolve() also
// drops trailing slashes but keeps / itself.
function folderPath(): string {
  const typed = expand(d.folder.text.trim())
  return typed ? resolve(typed) : HOME
}

// Recent marks Folder's entry, or none once Folder is edited to another.
const syncRecent = () => (d.recent = recents.indexOf(folderPath()))

// What's left of the first match, while the cursor is at the end of a part
// it extends.
export function suggestion(): string {
  if (d.field !== 'folder' || menu || d.folder.at !== length(d.folder.text)) return ''
  return pathSuggestion(d.folder.text)
}

// Tab and Shift+Tab as in zsh (complete in tui/complete.ts).
function tab(back: boolean) {
  const r = complete(d.folder.text, menu, back)
  menu = r.menu
  setFolder(r.text)
}

// Keys only Folder takes: Tab completes, and Shift+Tab once Tab has
// started; → or End at the end of the folder takes the suggestion.
function folderKey(k: string): boolean {
  if (k === TAB || (k === SHIFT_TAB && menu)) {
    tab(k === SHIFT_TAB)
    return true
  }
  if (k !== RIGHT && k !== END && k !== CTRL_E) return false
  const rest = suggestion()
  if (rest) setFolder(d.folder.text + rest)
  return Boolean(rest)
}

// Under Folder while you type in it: the folders that match, the one Tab is
// on highlighted, in place of Recent.
function matchesRow(w: number): Span[] | null {
  const { part, names } = menu ?? matchesOf(d.folder.text)
  if (!menu && !part && !d.folder.text.endsWith('/')) return null
  return chips(names, menu ? menu.i : -1, w, { lead: fieldLabel(t('newAgent.fields.matches'), true, LABEL_COLS), empty: t('newAgent.noMatches') })
}

// ------------------------------------------------------------ keys

const MOVES = new Map([
  [UP, -1],
  [SHIFT_TAB, -1],
  [DOWN, 1],
  [TAB, 1],
  [ENTER, 1],
])
const STEPS = new Map([
  [RIGHT, 1],
  [' ', 1],
  [LEFT, -1],
])
const OPTION_COUNT: Record<ChoiceField, () => number> = {
  where: () => WHERE.length,
  branch: () => BRANCH.length,
  recent: () => recents.length,
  model: () => CHOICES.model.length,
  mode: () => CHOICES.mode.length,
  effort: () => CHOICES.effort.length,
  chrome: () => CHOICES.chrome.length,
}

function move(n: number) {
  const fs = fields()
  d.field = fs[Math.min(fs.length - 1, Math.max(0, fs.indexOf(d.field) + n))]
}

// A step of a choice, wrapping. With none chosen (Recent at -1), → takes
// the first and ← the last.
function choose(f: ChoiceField, dir: number) {
  const n = OPTION_COUNT[f]()
  if (!n) return
  d[f] = d[f] < 0 ? (dir < 0 ? n - 1 : 0) : (d[f] + dir + n) % n
  if (f === 'recent') setFolder(tilde(recents[d.recent] ?? ''))
  if (f === 'where') [d.branch, otherBranch] = [otherBranch, d.branch]
}

export function key(k: string, paste?: string): Done | undefined {
  // Typing, pasting or Tab on Folder can make it another folder than the
  // recent marked; choose('recent') sets both itself.
  const onFolder = d.field === 'folder'
  const r = handle(k, paste)
  if (onFolder) syncRecent()
  return r
}

function handle(k: string, paste?: string): Done | undefined {
  d.error = null
  if (k !== TAB && k !== SHIFT_TAB) menu = null
  if (paste !== undefined) {
    const files = d.field === 'prompt' ? imageFiles(paste) : []
    if (files.length) for (const r of attachFiles(files, imagesDir('agent'))) attach(r)
    else if (isText(d.field)) insert(d[d.field], paste.replace(/\s*\n\s*/g, ' '))
    return
  }
  if (k === ESC || k === CTRL_C) return { done: null }
  // As in Claude Code: the clipboard's image, which a terminal's paste can't
  // carry.
  if (k === CTRL_V && d.field === 'prompt') return void attach(pasteImage(imagesDir('agent')))
  if (k === CTRL_S || (k === ENTER && d.field === 'start')) return submit()
  if (d.field === 'folder' && folderKey(k)) return
  if (d.field === 'prompt' && (k === UP || k === DOWN) && promptRow(k === UP ? -1 : 1)) return
  const moveBy = MOVES.get(k)
  const stepBy = STEPS.get(k)
  const f = d.field
  if (moveBy) move(moveBy)
  else if (isText(f)) Object.assign(d[f], editLine(d[f].text, d[f].at, k))
  else if (stepBy && f !== 'start') choose(f, stepBy)
}

function insert(text: LineState, s: string) {
  Object.assign(text, insertAt(text.text, text.at, clean(s)))
}

// A pasted image goes in at the caret as its placeholder, which Backspace
// deletes whole (tui/line.ts), so no space follows it; one that couldn't
// be read says why beside Start, leaving you in the prompt.
export function attach(r: Pasted) {
  if ('error' in r) {
    d.error = r.error
    return
  }
  const n = nextNumber(d.images)
  d.images.push({ n, path: r.image })
  insert(d.prompt, placeholder(n))
}

// ------------------------------------------------------------ the spec

function refuse(f: Field, error: string): undefined {
  d.field = f
  d.error = error
  return undefined
}

function submit(): Done | undefined {
  const general = inDefault()
  // defaultFolder() is home when the setting's folder is gone, so it's always one.
  const cwd = general ? defaultFolder(settings()) : folderPath()
  if (!general && !isFolder(cwd)) return refuse('folder', t('newAgent.noFolder', { path: tilde(cwd) }))
  if (!d.prompt.text.trim()) return refuse('prompt', t('newAgent.noPrompt'))
  const images = keptImages(d.images, d.prompt.text)
  const spec: TaskSpec = {
    kind: 'task',
    cwd,
    prompt: d.prompt.text,
    ...(images.length ? { images } : {}),
    worktree: BRANCH[d.branch].id === 'worktree',
    model: CHOICES.model[d.model],
    mode: CHOICES.mode[d.mode],
    effort: CHOICES.effort[d.effort],
    chrome: CHOICES.chrome[d.chrome] === 'on',
  }
  return { done: spec }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch (err) {
    // Shown beside Start; the reason is only for the log.
    log.debug('folder unreadable', { path, err })
    return false
  }
}

function startWith() {
  const s = settings()
  for (const f of STARTS_WITH) d[f] = Math.max(0, CHOICES[f].indexOf(s[`newAgent.task.${f}`]))
}

// ------------------------------------------------------------ drawing

// `f` is null for a note or a gap; `input` is the text field that fills the
// rest of the row, `part` the code points of it this row shows, all of them
// when left off.
type Row = { f: Field | null; spans: Span[]; input?: TextField; ghost?: string; part?: [number, number] }

function body(w: number): Row[] {
  const rows: Row[] = []
  const label = (f: Field) => fieldLabel(t(`newAgent.fields.${f}`), d.field === f, LABEL_COLS)
  const row = (f: Field | null, spans: Span[], input?: TextField, ghost?: string) => rows.push({ f, spans, input, ghost })
  const note = (text: string) => row(null, [[`${' '.repeat(LABEL_COLS)}${text}`, fg(P.overlay1)]])
  const gap = () => row(null, [])
  promptBody(w).forEach(r => rows.push(r))
  const images = keptImages(d.images, d.prompt.text).length
  note(images ? t('newAgent.imagesNote', { n: images }) : t('newAgent.taskNote'))
  gap()
  row('where', [...label('where'), ...radio(WHERE, d.where)])
  if (inDefault()) {
    // Shown, not a field: Settings › General is where it changes.
    row(null, [...label('folder'), [tilde(defaultFolder(settings())), fg(P.text)]])
    note(WHERE[d.where].sub)
  } else {
    row('folder', label('folder'), 'folder', suggestion())
    const recent = chips(
      recents.map(p => p.split('/').pop() ?? ''),
      d.field === 'recent' ? d.recent : -1,
      w,
      { lead: label('recent') },
    )
    row('recent', (d.field === 'folder' && matchesRow(w)) || recent)
  }
  gap()
  row('branch', [...label('branch'), ...radio(BRANCH, d.branch)])
  note(BRANCH[d.branch].sub)
  gap()
  for (const f of STARTS_WITH) row(f, [...label(f), ...select(CHOICES[f][d[f]], d.field === f)])
  gap()
  const lands = t('newAgent.lands')
  // An error stands in for where the agent lands, beside the Start it stopped.
  row('start', [
    ...button(t('newAgent.start'), { focused: d.field === 'start' }),
    ['  ctrl+s', fg(P.sub)],
    d.error ? [`   ${d.error}`, BOLD + fg(P.peach)] : [`   ${lands}`, fg(P.overlay1)],
  ])
  return rows
}

// The prompt's rows in view, ↑ and ↓ beside its label while it has rows
// above or below them.
function promptBody(w: number): Row[] {
  const { text, at } = d.prompt
  const starts = promptRows(w - LABEL_COLS)
  const n = starts.length
  const room = Math.min(PROMPT_ROWS, n)
  promptTop = scrollTo(promptTop, d.field === 'prompt' ? rowOf(starts, at) : -1, room, n)
  return Array.from({ length: room }, (_, i): Row => {
    const r = promptTop + i
    const mark = i === 0 && r > 0 ? '↑' : i === room - 1 && r < n - 1 ? '↓' : ''
    const name = i === 0 ? t('newAgent.fields.prompt') : ''
    const spans: Span[] = [...fieldLabel(name, d.field === 'prompt', LABEL_COLS - 2), [mark.padEnd(2), fg(P.overlay1)]]
    return { f: 'prompt', spans, input: 'prompt', part: [starts[r], starts[r + 1] ?? length(text)] }
  })
}

function drawRow(r: Row, w: number): string {
  if (!r.input) return render(r.spans, w, BOX)
  const lw = r.spans.reduce((n, [s]) => n + width(s), 0)
  const { text, at } = d[r.input]
  const chars = [...text]
  const [from, to] = r.part ?? [0, chars.length]
  // A caret on the next row's start is that row's, but for the end.
  const here = d.field === r.f && at >= from && (at < to || to === chars.length)
  const input = field({ text: chars.slice(from, to).join(''), at: at - from, w: w - lw, focused: here, ghost: here ? (r.ghost ?? '') : '' })
  return render(r.spans, lw, BOX) + render(input, w - lw, BOX)
}

// The first of n rows to draw in `room`, from `was`, with row `focus` among
// them: it moves only as far as it must, as a list scrolls, and never past
// the last row.
export function scrollTo(was: number, focus: number, room: number, n: number): number {
  if (n <= room) return 0
  let first = was
  if (focus >= 0 && focus < first) first = focus
  else if (focus >= first + room) first = focus - room + 1
  return Math.max(0, Math.min(first, n - room))
}

function draw() {
  const W = cols()
  const H = rows()
  const w = W - 2 * MARGIN_X
  // The keys keep the bottom row, so they stay put as the form changes length.
  hits = []
  const blank = render([], W, BOX)
  const lines = Array.from({ length: MARGIN_Y }, () => blank)
  const pad = render([], MARGIN_X, BOX)
  // A window under the popup's height shrinks it (the hub's popupSize), so
  // the body scrolls to keep the field you're on, which keys still reach,
  // drawn.
  const all = body(w)
  const room = Math.max(0, H - 2 * MARGIN_Y - 2)
  top = scrollTo(top, all.findIndex(r => r.f === d.field), room, all.length)
  const shown = all.slice(top, top + room)
  for (const r of shown) {
    if (r.f) hits.push({ y: lines.length + 1, f: r.f })
    lines.push(pad + drawRow(r, w) + pad)
  }
  while (lines.length < H - MARGIN_Y - 1) lines.push(blank)
  // A refusal moves you to the field to fix; with Start scrolled off, its
  // error takes the keys' row instead.
  const error = d.error && !shown.some(r => r.f === 'start') ? d.error : null
  lines.push(pad + render([error ? [error, BOLD + fg(P.peach)] : [HINTS, fg(P.overlay1)]], w, BOX) + pad)
  while (lines.length < H) lines.push(blank)
  ov?.paint(lines.slice(0, H), t('hub.newAgent'))
}

// ------------------------------------------------------------ main

const IMAGES_KEPT_MS = 30 * 24 * 60 * 60 * 1000

// Closes the form, the spec saved for the hub first. A spec that can't be
// saved keeps the form open with the reason beside Start: closed, the hub
// would find no file and read it as a cancel, and what you filled in would
// be lost.
function finish(spec: TaskSpec | null) {
  if (spec && !save(spec)) return
  log.info('form closed', { ok: Boolean(spec), ...(spec ? { kind: spec.kind, where: WHERE[d.where].id, worktree: spec.worktree } : {}) })
  ov?.quit()
  process.exit(0)
}

export function save(spec: TaskSpec, file = RESULT): boolean {
  try {
    writeFileSync(file, JSON.stringify(spec))
    return true
  } catch (err) {
    log.error('result not saved', { path: file, err })
    refuse('start', t('newAgent.notSaved', { err: err instanceof Error ? err.message : String(err) }))
    return false
  }
}

export type FormOptions = { folder?: string; recents?: string[] }

// A fresh form, in the folder given (a worktree's repo, so the
// new agent doesn't nest in another's worktree), else the newest recent,
// else Settings' Default folder.
export function form({ folder = '', recents: given = [] }: FormOptions = {}): Form {
  recents = given
  menu = null
  top = 0
  promptTop = 0
  otherBranch = BRANCH.findIndex(b => b.id === 'current')
  const s = settings()
  const start = s['newAgent.defaultFolder'] === 'projects' ? '' : folder || recents[0]
  const root = (start || defaultFolder(s)).replace(/\/\.claude\/worktrees\/.*$/, '')
  d = {
    where: 0,
    branch: Math.max(0, BRANCH.findIndex(b => b.id === s['newAgent.task.branch'])),
    model: 0,
    mode: 0,
    effort: 0,
    chrome: 0,
    // Which recent Folder is, -1 for none, so none shows as chosen.
    recent: recents.indexOf(root),
    field: 'prompt',
    folder: { text: tilde(root), at: length(tilde(root)) },
    prompt: { text: '', at: 0 },
    error: null,
    images: [],
  }
  startWith()
  return d
}

// The hub passes the folder and recents as JSON; anything else in it is
// left out.
function formOptions(json: string): FormOptions {
  const v: unknown = JSON.parse(json)
  if (typeof v !== 'object' || v === null) return {}
  const folder = 'folder' in v && typeof v.folder === 'string' ? v.folder : undefined
  const list = 'recents' in v && Array.isArray(v.recents) ? v.recents.filter((p): p is string => typeof p === 'string') : undefined
  return { folder, recents: list }
}

function onClick(y: number): Done | undefined {
  const h = hits.find(r => r.y === y)
  return h ? pick(h.f) : undefined
}

// The wheel over the prompt moves its caret a row, scrolling it as Up and
// Down do.
export function onWheel(y: number, dir: number) {
  if (hits.find(r => r.y === y)?.f !== 'prompt') return
  menu = null
  d.field = 'prompt'
  promptRow(dir)
}

// Picks a field, and on Start, starts. A Tab menu ends here as it does on
// any other key, or Shift+Tab back on Folder would step its old matches.
export function pick(f: Field): Done | undefined {
  menu = null
  d.error = null
  d.field = f
  return f === 'start' ? submit() : undefined
}

function main() {
  const [result, opts] = process.argv.slice(2)
  if (!result || !process.stdin.isTTY) {
    console.error('newagent.ts <result file> <options json>, in a terminal; the hub runs it.')
    process.exit(1)
  }
  logCrashes(log)
  // The agents given them read them as they start; a month leaves room to
  // resume one.
  sweepImages(imagesDir('agent'), new Set(), IMAGES_KEPT_MS)
  RESULT = result
  form(formOptions(opts || '{}'))
  ov = openOverlay({ name: 'newagent', key: 'keys.newAgent', box: () => popupBox() })
  const overlay = ov
  overlay.start(data => {
    // The read as it came: tokens decodes it, keeping a character a long
    // paste cut in two for the next read, and takes an emoji as one key.
    for (const tok of tokens(data)) {
      // Its own key, Ctrl+C or a click outside the frame cancel it, as Esc does.
      if (tok.key && overlay.closes(tok.key)) return finish(null)
      const m = tok.mouse && overlay.mouse(tok.mouse)
      if (m === 'close') return finish(null)
      if (m && m.button & 64) onWheel(m.y, m.button & 1 ? 1 : -1)
      if (tok.mouse && !(m && leftPress(m))) continue
      const r = m ? onClick(m.y) : key(tok.key ?? '', tok.paste)
      // finish() exits, unless the spec couldn't be saved: then the form
      // stays, drawn with why before any later key clears it.
      if (r) {
        finish(r.done)
        break
      }
    }
    draw()
  }, draw)
}

// The hub imports POPUP; run as a program, this is the form.
if (import.meta.main) main()
