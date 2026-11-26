// frame() reads nothing but the state, the size and Settings, so a test can
// draw any state.

import { basename } from 'node:path'

import { t } from '../../core/text.ts'
import { LONGEST_MODEL_ID, modelLabel, modelName } from '../../settings/models.ts'
import { load as loadSettings } from '../../settings/settings.ts'
import type { Settings } from '../../settings/catalog.ts'
import { type Hint, keyHints, keyHintsWidth, modeHeader, switchCol } from '../../tui/chrome.ts'
import { ansi, chips, confirm, field, fieldLabel, radio, select, spanWidth } from '../../tui/controls.ts'
import { ACCENT, BG, BOLD, FG, ITALIC, P, RESET, STRIKE, fg } from '../../tui/palette.ts'
import { frame as screenFrame } from '../../tui/screen.ts'
import { type Span, render } from '../../tui/term.ts'
import { fit, visible, wrapText as wrap } from '../../tui/text.ts'
import { type Arranged, CATEGORIES, type Filing, type Item, TYPES, age, categoryName, categoryShort, colorOf, filingState, imagesOf, typeColorOf, typeName } from './todo.ts'
import * as tabs from './tabs.ts'
import * as ui from './todo-ui.ts'
import { type AddStep, type ConfirmPrompt, EDIT_FIELDS, type EditField, type EditPrompt, FIELDS, type HandoffPrompt, type Prompt, fieldName } from './todo-ui.ts'
import { type State, cursorItem, selectable, shown } from './state.ts'

// Counted from 1. The popup has no mode header: its title is in the overlay
// frame's edge.
export const listTop = (popup: boolean): number => (popup ? 2 : 3)
export const bodyHeight = (rows: number, popup: boolean): number => Math.max(1, rows - listTop(popup))
export const sayMs = (values: Pick<Settings, 'todo.noteSecs'> = loadSettings()): number => values['todo.noteSecs'] * 1000

const C = {
  text: FG.text,
  sub: FG.sub,
  overlay: FG.overlay0,
  // Placeholder text in an empty prompt.
  hint: FG.surface2,
  blue: FG.blue,
  green: FG.green,
  peach: FG.peach,
  red: FG.red,
  accent: FG.accent,
  ink: FG.accentInk,
  cursorBg: BG.surface0,
  cardBg: BG.mantle,
  pillBg: BG.accent,
  bold: BOLD,
  italic: ITALIC,
  strike: STRIKE,
  reset: RESET,
}
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// How often the spinner turns, and so how often todo-view.ts repaints while
// Claude is filing.
export const SPIN_MS = 120

const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5)

// `item` lets clicks and scrolling find the row. `done` marks the done-today
// header, which a click opens or closes.
export type BodyRow = { text: string; item?: Item; header?: boolean; done?: boolean }

// `settings` loads only if a row needs them.
type Frame = { s: State; cols: number; now: number; settings: () => Settings }

const tabOf = (f: Frame, pane: string | undefined, server: string | undefined): string => tabs.tabOf(pane, f.s.panes, f.s.config.win, server)

function header({ s, cols }: Frame): string[] {
  const { popup, pane, modes } = s.config
  return popup ? [] : [modeHeader(modes, pane.at, pane.next, switchCol(cols))]
}

export const TITLE = t('settings.modes.todo.name')

function summary({ s, cols }: Frame, view: Arranged): string {
  const scope = s.only ? ui.scopeName(s.here.repo) : t('todo.allRepos')
  const left = `${C.accent}${C.bold}${t('todo.summary', { n: view.open, scope })}${C.reset}`
  const right = t('todo.byCategory')
  return `${left}\x1b[${cols - ui.cells(right)}G${C.sub}${right}${C.reset}`
}

const repoName = (repo: string): string => (repo === 'none' ? t('todo.none') : repo)

function itemRow({ s, cols, now }: Frame, item: Item, selected: boolean): string {
  const back = selected ? C.cursorBg : ''
  // ☑ has an emoji form that some fonts draw two cells wide; ✓ stays one.
  const box = item.done ? `${C.green}✓${C.reset}${back}` : '☐'
  const mark = s.marked.has(item.id) ? `${C.accent}▌${C.reset}${back}` : ' '
  // ✻, as the hub marks a Claude at work: it's been handed to an agent.
  const agent = item.handoff ? `${C.blue}✻ ${C.reset}${back}` : ''
  const right = `${repoName(item.repo)} · ${age(now - (item.done || item.created))}`
  const type = item.type ? `${typeName(item.type)} · ` : ''
  const room = Math.max(4, cols - 4 - ui.cells(type) - ui.cells(right) - (agent ? 2 : 0) - 3)
  const fitted = fit(item.title, room)
  const words = fitted.trimEnd()
  const title = item.done
    ? `${C.sub}${C.strike}${words}${C.reset}${back}${fitted.slice(words.length)}`
    : `${selected ? C.bold : ''}${fitted}`
  const typed = item.type ? `${fg(typeColorOf(item.type))}${typeName(item.type)}${C.sub} · ` : ''
  return `${back}${mark} ${box} ${title}${C.reset}${back} ${agent}${C.sub}${typed}${right} ${C.reset}`
}

const cardWidth = (cols: number): number => Math.max(10, cols - 7)
const cardLine = (f: Frame, text: string): string => {
  const inner = text.replaceAll(C.reset, `${C.reset}${C.cardBg}`)
  return `    ${C.cardBg} ${inner}${' '.repeat(Math.max(0, cardWidth(f.cols) - visible(text)))} ${C.reset}`
}

function cardRows(f: Frame, item: Item): string[] {
  if (item.filing) return filingCard(f, item, item.filing)
  const { s } = f
  const w = cardWidth(f.cols)
  const pad = (text: string): string => cardLine(f, text)
  // The repo is on the item's row already; the branch goes last, where a
  // long one can be cut.
  const by = t(item.by === 'claude' ? 'todo.card.byClaude' : 'todo.card.byYou')
  const where = [
    tabOf(f, item.pane, item.paneServer) && t('todo.card.inTab', { tab: tabOf(f, item.pane, item.paneServer) }),
    t('todo.card.at', { time: clock(item.created) }),
    item.branch && t('todo.card.onBranch', { branch: item.branch }),
  ]
    .filter(Boolean)
    .join(' ')
  const rows = [pad(`${C.sub}${fit(t('todo.card.added', { by, where }), w).trimEnd()}${C.reset}`)]
  if (s.prompt?.kind === 'edit' && s.prompt.id === item.id) return [...rows, ...editRows(f, s.prompt, w)]
  if (item.handoff) {
    const { name, where: ran, pane, at, server } = item.handoff
    const place = ran === 'bg' ? t('todo.card.inBackground') : t('todo.card.inTab', { tab: tabOf(f, pane, server) || t('todo.card.aTab') })
    rows.push(pad(`${C.blue}✻ ${C.sub}${fit(t('todo.card.handed', { name, place, time: clock(at) }), w - 2).trimEnd()}${C.reset}`))
  }
  if (item.note) for (const line of wrap(item.note, w)) rows.push(pad(`${C.text}${line}${C.reset}`))
  const images = imagesOf(item).length
  if (images) rows.push(pad(`${C.sub}${fit(t('images.attached', { n: images }), w).trimEnd()}${C.reset}`))
  const go = tabs.goLabel(item, s.panes, s.agents)
  const keys: Hint[] = [
    ...(go ? [['↵', go] as const] : []),
    ['e', t('hints.edit')],
    ['c', t('todo.keys.category')],
    ['t', t('todo.keys.type')],
    ['space', t(item.done ? 'todo.keys.reopen' : 'todo.keys.done')],
  ]
  rows.push(pad(keyHints(ui.cardKeys(keys, w))))
  return rows
}

const LABEL_W = 10

const noneText = (): string => `${C.hint}${t('todo.none')}${C.reset}`

const categoryPicks = (picked: string): Span[] =>
  radio(
    CATEGORIES.map((c, i) => ({ key: i + 1, label: categoryShort(c.name), color: c.color })),
    CATEGORIES.findIndex(c => c.name === picked),
  )

const typePicks = (picked: string | null): Span[] =>
  radio(
    [...TYPES.map((x, i) => ({ key: i + 1, label: typeName(x.name), color: x.color })), { key: 0, label: typeName(null), color: P.sub }],
    picked ? TYPES.findIndex(x => x.name === picked) : TYPES.length,
  )

const fitSpans = (spans: Span[], w: number): string => (spanWidth(spans) <= w ? ansi(spans) : render(spans, w))

function repoPicks(prompt: EditPrompt, room: number): string {
  const matches = ui.repoMatches(prompt)
  const lead: Span[] = prompt.find ? [...field({ text: prompt.find, w: ui.cells(prompt.find) + 1 }), [' ', '']] : []
  const names = matches.map(r => (r === ui.NO_REPO ? t('todo.none') : r.repo))
  return ansi(chips(names, matches.indexOf(prompt.repo), room, { lead, empty: t('todo.card.noDirMatches') }))
}

// The caret's mark goes in before wrapping, so the caret lands where the wrap
// puts it.
function textLines(prompt: EditPrompt, name: 'title' | 'note', on: boolean, room: number): string[] {
  const value = prompt[name]
  if (!value) {
    if (!on) return [noneText()]
    return [ansi(field({ w: room, placeholder: t(name === 'note' ? 'todo.placeholders.editNote' : 'todo.placeholders.title') }))]
  }
  const text = on ? ui.withCaret(value, prompt.at) : value
  return wrap(text, room).map(line => `${C.text}${ui.caretShown(line)}${C.reset}`)
}

const EDIT_LINES: Record<EditField, (prompt: EditPrompt, on: boolean, room: number) => string[]> = {
  title: (prompt, on, room) => textLines(prompt, 'title', on, room),
  note: (prompt, on, room) => textLines(prompt, 'note', on, room),
  cat: (prompt, on, room) => [on ? fitSpans(categoryPicks(prompt.cat), room) : `${fg(colorOf(prompt.cat))}${categoryName(prompt.cat)}${C.reset}`],
  type(prompt, on, room) {
    if (on) return [fitSpans(typePicks(prompt.type), room)]
    return [prompt.type ? `${fg(typeColorOf(prompt.type))}${typeName(prompt.type)}${C.reset}` : noneText()]
  },
  repo(prompt, on, room) {
    if (on) return [repoPicks(prompt, room)]
    return [prompt.repo === ui.NO_REPO ? noneText() : `${C.text}${prompt.repo.repo}${C.reset}`]
  },
}

function editRows(f: Frame, prompt: EditPrompt, w: number): string[] {
  const room = Math.max(4, w - LABEL_W)
  return EDIT_FIELDS.flatMap(name => {
    const on = prompt.field === name
    const label = ansi(fieldLabel(fieldName(name), on, LABEL_W))
    return EDIT_LINES[name](prompt, on, room).map((line, i) => cardLine(f, `${i ? ' '.repeat(LABEL_W) : label}${line}`))
  })
}

function filingRow({ cols, now }: Frame, item: Item, selected: boolean): string {
  const back = selected ? C.cursorBg : ''
  const failed = filingState(item, now) === 'failed'
  const mark = failed ? `${C.red}✕` : `${C.peach}${SPINNER[Math.floor(now / SPIN_MS) % SPINNER.length]}`
  const right = `${repoName(item.repo)} · ${age(now - item.created)}`
  const room = Math.max(4, cols - 4 - ui.cells(right) - 3)
  const text = fit(item.title, room)
  const title = failed ? `${selected ? C.bold : ''}${text}` : `${C.sub}${C.italic}${text}`
  return `${back}  ${mark}${C.reset}${back} ${title}${C.reset}${back} ${C.sub}${right} ${C.reset}`
}

function filingCard(f: Frame, item: Item, filing: Filing): string[] {
  const w = cardWidth(f.cols)
  if (filingState(item, f.now) === 'filing')
    return [
      cardLine(f, `${C.sub}${t('todo.filing.busy', { model: modelName(f.settings()['todo.filing.model']), time: clock(filing.started) })}${C.reset}`),
      cardLine(f, keyHints([['x', t('hints.drop')]])),
    ]
  const why = filing.error || t('todo.filing.tooLong')
  return [
    ...wrap(t('todo.filing.failed', { why }), w).map(line => cardLine(f, `${C.red}${line}${C.reset}`)),
    cardLine(
      f,
      keyHints([
        ['r', t('todo.keys.retry')],
        ['shift+a', t('todo.keys.addByHand')],
        ['x', t('hints.drop')],
      ]),
    ),
  ]
}

function itemRows(
  f: Frame,
  items: readonly Item[],
  current: Item | undefined,
  row: (f: Frame, item: Item, selected: boolean) => string,
  card: (f: Frame, item: Item) => string[],
): BodyRow[] {
  return items.flatMap(item => {
    const selected = item === current
    return [{ text: row(f, item, selected), item }, ...(selected ? card(f, item).map(text => ({ text, item })) : [])]
  })
}

const groupHeader = (color: string, name: string, n: number): BodyRow => ({
  text: `${C.sub}▾${C.reset} ${color}${C.bold}${name}${C.reset} ${C.sub}${n}${C.reset}`,
  header: true,
})

const filingCardOf = (f: Frame, item: Item): string[] => (item.filing ? filingCard(f, item, item.filing) : [])

function bodyRows(f: Frame, view: Arranged, current: Item | undefined): BodyRow[] {
  const { showDone } = f.s
  const rows: BodyRow[] = []
  if (view.filing.length)
    rows.push(groupHeader(C.peach, t('todo.groups.filing'), view.filing.length), ...itemRows(f, view.filing, current, filingRow, filingCardOf), { text: '' })
  for (const g of view.groups)
    rows.push(groupHeader(fg(g.color), categoryName(g.name), g.items.length), ...itemRows(f, g.items, current, itemRow, cardRows), { text: '' })
  if (view.doneToday.length) {
    rows.push({ text: `${C.sub}${showDone ? '▾' : '▸'} ${t('todo.groups.doneToday', { n: view.doneToday.length })}${C.reset}`, done: true, header: true })
    if (showDone) rows.push(...itemRows(f, view.doneToday, current, itemRow, cardRows))
  }
  return rows
}

function emptyRows({ s, cols }: Frame, height: number): BodyRow[] {
  const lines = ui.emptyLines({ loadError: s.loadError, only: s.only, repo: s.here.repo })
  const rows: BodyRow[] = Array.from({ length: height }, () => ({ text: '' }))
  const top = Math.max(0, Math.floor(height / 2) - 1)
  lines.forEach((line, i) => {
    const padding = Math.max(0, Math.floor((cols - ui.cells(line)) / 2))
    if (rows[top + i]) rows[top + i] = { text: `${' '.repeat(padding)}${C.sub}${line}${C.reset}` }
  })
  return rows
}

const pill = (label: string, back: string): string => `${back}${C.ink}${C.bold} ${label} ${C.reset}`
const pillWidth = (label: string): number => ui.cells(label) + 2

// width is text's width in cells, without its escape codes.
type Side = { text: string; width: number }

function trail(at: AddStep): Side {
  const parts = FIELDS.map((step, i) => {
    const name = fieldName(step)
    if (i < FIELDS.indexOf(at)) return { text: `✓ ${name}`, color: C.sub }
    return step === at ? { text: name, color: `${C.accent}${C.bold}` } : { text: name, color: C.hint }
  })
  return {
    text: parts.map(p => `${p.color}${p.text}${C.reset}`).join(`${C.hint} › ${C.reset}`),
    width: parts.reduce((n, p) => n + ui.cells(p.text), 0) + 3 * (parts.length - 1),
  }
}

// The placeholder says what to do, so it keeps its room over `right`.
function inputRow(cols: number, label: string, pillBg: string, text: string, placeholder: string, right: Side, at: number | undefined): string {
  const lead = pillWidth(label) + 1
  const need = text ? 30 : ui.cells(placeholder) + 3
  const side = cols - lead - right.width >= need ? right : null
  const room = cols - lead - 1 - (side ? side.width + 2 : 0)
  const body = ansi(field({ text, at, w: room + 1, placeholder }))
  return side ? `${pill(label, pillBg)} ${body}\x1b[${cols - side.width + 1}G${side.text}` : `${pill(label, pillBg)} ${body}`
}

const noteLine = (said: { text: string; color: string }, cols: number): string => `${fg(said.color)}${fit(said.text, cols - 1)}${C.reset}`

const choice = (key: string, value: string): Span[] => [[`${key} `, fg(ACCENT)], ...select(value)]
const joinChoices = (list: readonly Span[][]): Span[] => list.flatMap((c, i): Span[] => [...(i ? [['  ', ''] as const] : []), ...c])
const longest = (...words: string[]): string => words.reduce((a, b) => (ui.cells(b) > ui.cells(a) ? b : a))

function handoffRow(f: Frame, prompt: HandoffPrompt): string {
  const n = prompt.ids.length
  // Outside git there's no worktree or branch to choose, only the folder.
  const outside = n - prompt.inGit
  const folders = [...new Set(prompt.places.filter(p => !p.git).map(p => p.cwd))]
  const away = prompt.places.filter(p => p.moved).length
  const flash = f.now - (prompt.flash ?? 0) < sayMs(f.settings())
  const folder = folders.length === 1 ? basename(folders[0] ?? '') : t('todo.handOff.theirFolders')
  const why = outside ? t('todo.handOff.notInGit', { n: outside }) : away ? t('todo.handOff.withoutRepo', { n: away, repo: prompt.here.repo }) : ''
  const branch: Span[] = !prompt.inGit
    ? [[t('todo.handOff.notGit', { folder }), fg(flash ? P.peach : P.sub)]]
    : [...choice('b', t(prompt.worktree ? 'todo.handOff.worktree' : 'todo.handOff.thisBranch')), ...(why ? [[` · ${why}`, fg(P.sub)] as const] : [])]
  const choices = joinChoices([branch, choice('m', prompt.model)])
  const label = t('todo.pills.handOff')
  const lead = `${pill(label, C.pillBg)} ${C.sub}${t('todo.handOff.count', { n })}${C.reset} ${ansi(choices)}`
  // The keys show only where the widest row leaves room, so they don't come
  // and go as the choices change.
  const widest = joinChoices([
    [...choice('b', longest(t('todo.handOff.worktree'), t('todo.handOff.thisBranch'))), [` · ${t('todo.handOff.withoutRepo', { n: 9, repo: 'dotfiles' })}`]],
    choice('m', LONGEST_MODEL_ID),
  ])
  const used = pillWidth(label) + 1 + ui.cells(t('todo.handOff.count', { n: 2 })) + 1 + spanWidth(widest)
  return f.cols - used > 20
    ? `${lead}  ${keyHints([
        ['↵', t('hints.start')],
        ['esc', t('hints.cancel')],
      ])}`
    : lead
}

// Cut so its answers still show.
function confirmRow(prompt: ConfirmPrompt, cols: number): string {
  const room = Math.max(1, cols - 1 - spanWidth(confirm('', prompt.answers)))
  return ansi(confirm(fit(prompt.text, room).trimEnd(), prompt.answers))
}

function editStatus(cols: number, prompt: EditPrompt): string {
  const pick = t('hints.pick')
  const picks: Partial<Record<EditField, Hint[]>> = {
    cat: [['1–6', pick]],
    type: [['0–5', pick]],
    repo: [
      ['←/→', pick],
      ['type', t('hints.filter')],
    ],
  }
  const pairs: Hint[] = [['tab', t('todo.keys.nextField')], ...(picks[prompt.field] ?? []), ['↵', t('hints.save')], ['esc', t('hints.cancel')]]
  const label = t('todo.pills.edit')
  return `${pill(label, C.pillBg)}  ${keyHints(pillWidth(label) + 2 + keyHintsWidth(pairs) < cols ? pairs : pairs.slice(-2))}`
}

function categoryStatus(cols: number, picked: string): string {
  const label = t('todo.pills.category')
  const lead = pillWidth(label) + 1
  const picks = categoryPicks(picked)
  const side = trail('cat')
  if (cols - lead - spanWidth(picks) - side.width > 2) return `${pill(label, C.pillBg)} ${ansi(picks)}\x1b[${cols - side.width + 1}G${side.text}`
  return `${pill(label, C.pillBg)} ${fitSpans(picks, Math.max(0, cols - lead - 1))}`
}

function promptStatus(f: Frame, prompt: Prompt): string {
  const { cols } = f
  switch (prompt.kind) {
    case 'claude': {
      const values = f.settings()
      const model = `${modelLabel(values['todo.filing.model'])} · ${values['todo.filing.effort']}`
      const side = { text: `${C.hint}${model}${C.reset}`, width: ui.cells(model) }
      return inputRow(cols, t('todo.pills.claude'), C.pillBg, prompt.text, t('todo.placeholders.claude'), side, prompt.at)
    }
    case 'title':
    case 'note':
      return inputRow(cols, t(`todo.pills.${prompt.kind}`), C.pillBg, prompt.text, t(`todo.placeholders.${prompt.kind}`), trail(prompt.kind), prompt.at)
    case 'edit':
      return editStatus(cols, prompt)
    case 'cat':
      return categoryStatus(cols, prompt.cat)
    case 'handoff':
      return handoffRow(f, prompt)
    case 'confirm':
      return confirmRow(prompt, cols)
  }
}

function idleStatus(f: Frame, list: readonly Item[], current: Item | undefined): string {
  const { s, cols, now } = f
  if (s.said && now < s.said.until) return noteLine(s.said, cols)
  // Marks on items f hides don't count: w wouldn't hand them off.
  const marks = ui.markedIds(list, s.marked).length
  const pairs = ui.statusPairs(marks, s.only)
  const position = ui.position(list, current, marks)
  const label = t('todo.pills.todo')
  const fits = pillWidth(label) + 2 + keyHintsWidth(pairs) + position.length < cols
  const left = `${pill(label, C.pillBg)}  ${fits ? keyHints(pairs) : keyHints(pairs.slice(0, 2))}`
  return position ? `${left}\x1b[${cols - position.length + 1}G${C.text}${position}${C.reset}` : left
}

export type FrameOptions = { now?: number; settings?: Settings }
export type Drawn = { lines: string[]; body: BodyRow[]; scroll: number; cursorId: string | undefined }

// `marked` should already be pruned (ui.pruneMarks). Changes nothing in `s`.
export function frame(s: State, cols: number, rows: number, { now = Date.now(), settings }: FrameOptions = {}): Drawn {
  let values = settings
  const f: Frame = { s, cols, now, settings: () => (values ??= loadSettings()) }
  const view = shown(s, now)
  const list = selectable(s, view)
  const current = cursorItem(s, list)
  const height = bodyHeight(rows, s.config.popup)
  let body: BodyRow[]
  let scroll: number
  if (!view.groups.length && !view.filing.length && !(s.showDone && view.doneToday.length)) {
    body = emptyRows(f, height)
    if (view.doneToday.length) body[height - 1] = { text: `${C.sub}▸ ${t('todo.groups.doneToday', { n: view.doneToday.length })}${C.reset}`, done: true }
    scroll = 0
  } else {
    body = bodyRows(f, view, current)
    scroll = ui.scrollTo(body, current, s.scroll, height)
  }
  const lines = [...header(f), summary(f, view)]
  for (let row = 0; row < height; row++) lines.push(body[scroll + row]?.text ?? '')
  // A prompt covers the status row, so a note said while it's open (the edit
  // form's "A todo needs a title") goes on the row above it.
  if (s.prompt && s.said && now < s.said.until) lines[lines.length - 1] = noteLine(s.said, cols)
  lines.push(s.prompt ? promptStatus(f, s.prompt) : idleStatus(f, list, current))
  return { lines, body, scroll, cursorId: current?.id }
}

export const paint = (lines: readonly string[]): string => screenFrame(lines, { clear: true })
