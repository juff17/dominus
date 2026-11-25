// The hub's frames, apart from the terminal: the board and the list it shows
// beside an open session. Each returns its lines, its clickable regions, and
// the selection and scroll as drawing left them. Nothing here reads the
// clock, the settings or the terminal, so a frame can be tested from a fixed
// state (view.test.ts).

import type { Asked } from './actions.ts'
import {
  type Focus,
  LANE_GAP,
  type ListItem,
  type Monitored,
  type Pickable,
  type Selected,
  boardRows,
  filledOf,
  keptFocus,
  laneColumns,
  listItems,
  listScroll,
  listSelection,
  pickable,
  selector,
  trayWindow,
  where,
} from './board.ts'
import type { Peek } from './peek.ts'
import { type GearCells, centredRow } from '../tui/gear.ts'
import { type Agent, type Lane, type Lanes, type Monitor, cardHeights, counts, lanes, monitorsOf, scrollTo, watches } from '../agents/model.ts'
import type { Counts } from '../agents/model.ts'
import { pipelineResult } from '../agents/transcript.ts'
import { lookup, t } from '../core/text.ts'
import { type Hint, hintSpans } from '../tui/chrome.ts'
import { type BoxLine, button as buttonSpans, card, confirm as question, field, laneHeader, pressAgain, spanWidth } from '../tui/controls.ts'
import type { Look } from '../tui/palette.ts'
import { ACCENT, BOLD, ITALIC, type Line, MONITOR, P, STATE, STOPPED, type Span, ago, bg, clean, fg, render, split, width, wrap } from '../tui/term.ts'

// A clickable region of a frame, its cells counted from 1; `wheel` is the
// lane (4: the monitors strip) the wheel scrolls over it.
export type Hit = { x1: number; x2: number; y1: number; y2: number; act: () => unknown; wheel?: Focus }
export type Scroll = Record<Lane | 'list', number>
export type Note = { text: string; color: string; until: number }

// `agents` is filtered already.
export type HubUi = {
  agents: Agent[]
  filter: string
  filtering: boolean
  filterAt: number | undefined
  focus: Focus
  selected: Selected
  scroll: Scroll
  listSel: string | null
  peek: Peek | null
  confirm: Asked | null
  note: Note | null
  win: number
  now: number
  // The gear the board shows when nothing's running (hub.ts); null until it
  // can be drawn.
  splash?: GearCells | null
}
// From Settings. `broke` and `attention` are the monitor event tags that mean
// broke and need you.
export type HubPrefs = { shown: readonly Lane[]; doneCards: number; monitorRows: number; broke: Set<string>; attention: Set<string> }
export type ClickActs = {
  newAgent: () => unknown
  pick: (lane: Focus, id: string) => void
  pickMonitor: (key: string) => void
  closePeek: () => unknown
  openItem: (it: Pickable) => unknown
}
export type Size = { w: number; h: number }
export type HubFrame = { lines: string[]; hits: Hit[]; focus: Focus; selected: Selected; scroll: Scroll; listSel: string | null }

const LANE_BG = bg(P.mantle)
const CARD_BG = bg(P.base)
const SEL_BG = bg(P.surface0)
const nothing = (name: Lane | 'monitors') => t(`hub.empty.${name}`)
const MONITORS_LOOK: Look = { glyph: '◉', color: P.rose, name: t('hub.monitors') }

const kilo = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
// Why a monitor ended: the hub's own reasons have words in agents.ended;
// any other is the line Claude Code gave, shown as it is.
const endedWhy = (reason: string) => {
  const words = lookup(`agents.ended.${reason}`)
  return typeof words === 'string' ? words : reason
}
const placeOf = (a: Agent) => (a.worktree ? ` ⑂ ${a.worktree}` : a.branch ? ` ⎇ ${a.branch}` : '')

// Key and label pairs; no-break spaces inside a pair, so a wrapped footer
// breaks only between pairs.
export const hint = (pairs: readonly Hint[]): Span[] => hintSpans(pairs, { noBreak: true })

// `cells` is its width with the space after, for its click area.
function newButton(label: string) {
  const spans: Span[] = [...buttonSpans(`+ ${label}`, { key: 'alt+n', main: true, round: true }), [' ', '']]
  return { spans, cells: spanWidth(spans) }
}

const header = laneHeader

function empty(text: string, w: number) {
  const pad = Math.max(0, Math.floor((w - width(text)) / 2))
  return render([[`${' '.repeat(pad)}${text}`, ITALIC + fg(P.overlay1)]], w, LANE_BG)
}

export type CardCtx = { win: number; now: number; broke: Set<string> }

const CMD_COLOR: Record<Lane, string> = { needs: P.peach, working: P.blue, done: P.text, idle: P.sub }

// A card a monitor raised whose last event broke reads red, as the tray
// has it.
function cmdColor(name: Lane, a: Agent, broke: Set<string>) {
  if (name === 'needs' && a.need === 'monitor' && broke.has(a.cmd.match(/^\[([\w-]+)/)?.[1] ?? '')) return P.red
  return CMD_COLOR[name]
}

// The right of a full card's second line: in Needs you what answers it, in
// the other lanes its context size.
function cardNote(name: Lane, a: Agent, raised: Monitor | null): Span[] {
  if (name !== 'needs') return a.ctx ? [[t('hub.card.ctx', { n: kilo(a.ctx) }), fg(P.overlay1)]] : []
  if (a.need === 'monitor') return [[`◉ ${raised?.kind ?? t('hub.card.monitor')}`, fg(P.rose)]]
  if (a.need === 'permission')
    return hint([
      ['a', t('hub.keys.allow')],
      ['d', t('hub.keys.deny')],
      ['↵', t('hints.open')],
    ])
  return hint([['↵', a.need === 'question' ? t('hub.keys.answer') : t('hints.open')]])
}

function lineCard(name: Lane, a: Agent, label: string, age: string, w: number, on: boolean, win: number) {
  const done = name === 'done'
  const mark: Span[] = done ? [['✓ ', fg(P.green)]] : a.stopped ? [[`${STOPPED.glyph} `, fg(STOPPED.color)]] : []
  const left: Span[] = [
    [on ? ' ▌' : '  ', fg(ACCENT)],
    ...mark,
    [clean(a.repo), fg(P.sub)],
    [` ${label}`, done ? fg(P.text) : a.stopped ? fg(P.sub) : BOLD + fg(P.text)],
  ]
  return split(left, [[done ? `  ${age} ` : `  ${where(a, win)} · ${age} `, fg(P.sub)]], w, on ? SEL_BG : LANE_BG)
}

export function agentCard(name: Lane, a: Agent, hgt: number, w: number, on: boolean, ctx: CardCtx): string[] {
  const { now } = ctx
  // A card a monitor raised is named after what it watches.
  const raised = a.need === 'monitor' ? (a.monitors.find(m => m.state === 'action') ?? null) : null
  const label = clean(raised ? raised.description : a.title)
  const age = ago(name === 'working' ? a.stateSince : a.since, now)
  if (hgt === 1) return [lineCard(name, a, label, age, w, on, ctx.win)]
  const title: Span[] = [
    [` ${clean(a.repo)}`, BOLD + fg(on ? ACCENT : P.text)],
    [`${clean(placeOf(a))} `, fg(P.sub)],
  ]
  const right: Span[] = [[` ${where(a, ctx.win)} · ${age} `, fg(P.sub)]]
  const toolAge = name === 'working' && a.cmd !== t('agents.cmd.thinking') ? ` ${ago(a.since, now)}` : ''
  const doing: Span[] = [
    [clean(a.cmd), fg(cmdColor(name, a, ctx.broke))],
    [toolAge, fg(P.sub)],
  ]
  const named: Span = [label, BOLD + fg(P.text)]
  const lines: BoxLine[] =
    hgt >= 4 ? [[named], { left: doing, right: [['  ', ''], ...cardNote(name, a, raised)] }] : [[named, [' · ', fg(P.overlay1)], ...doing]]
  const border = on ? ACCENT : a.need === 'monitor' ? P.rose : P.surface1
  return card(title, right, lines, w, { border, fill: on ? SEL_BG : CARD_BG })
}

// The footer's rows: one, or up to FOOTER_ROWS when its question, note or
// keys need more to be read whole, as they do in the list beside a session.
const FOOTER_ROWS = 4
const wrapped = (spans: Line, w: number) => wrap(spans, w - 1, FOOTER_ROWS).map(l => render([[' '], ...l], w))

export function footer(
  { confirm, note, now }: { confirm: Pick<Asked, 'text' | 'skip' | 'key'> | null; note: Note | null; now: number },
  keys: readonly Hint[],
  w: number,
): string[] {
  // A question comes first: it's what the next key answers. Each answer's
  // key and word are held together with no-break spaces, so a wrapped
  // question breaks only between answers.
  if (confirm) {
    const skip: Hint[] = confirm.skip ? [['a', t('hub.dontAskAgain')]] : []
    const [ask, ...answers] = question(confirm.text, [...pressAgain(confirm.key), ...skip])
    // The gap before an answer stays a break; a key of two words (other keys) holds together.
    const hold = (s: string): string => s.replaceAll(' ', ' ')
    const held = answers.map(([s, style]): Span => [s.startsWith('  ') ? `  ${hold(s.slice(2))}` : hold(s), style])
    return wrapped([ask, ...held], w)
  }
  if (note && note.until > now) return wrapped([[note.text, fg(note.color)]], w)
  return keys.length ? wrapped(hint(keys), w) : []
}

// ------------------------------------------------------------ the board

// What a board frame's parts share, move and add to while it's drawn.
type Board = {
  ui: HubUi
  prefs: HubPrefs
  acts: ClickActs
  l: Lanes<Agent>
  strip: Monitored[]
  focus: Focus
  sel: ReturnType<typeof selector>
  scroll: Scroll
  hits: Hit[]
  ctx: CardCtx
}

// The filter while there is one, for a frame's top line: the board's and the
// list's both narrow to it, so each says so.
function filterSpans(ui: HubUi): Span[] {
  if (!ui.filtering && !ui.filter) return []
  // A cell more than the text, for the caret at its end, kept while the
  // caret is inside it, so the header doesn't shift as it moves.
  const fw = width(clean(ui.filter)) + 1
  const typed = field({ text: ui.filter, at: ui.filterAt, w: fw, focused: ui.filtering })
  return [['/', fg(ACCENT)], ...typed, [' '.repeat(fw - spanWidth(typed) + 2), '']]
}

function summary(b: Pick<Board, 'ui' | 'hits' | 'acts'>, c: Counts, W: number) {
  const { ui } = b
  const tasks = t('hub.summary.tasks', { n: c.needs + c.working + c.done + c.idle })
  const left: Span[] = [
    [` ${tasks} · ${t('hub.summary.monitors', { n: c.monitors })}   `, BOLD + fg(P.text)],
    [`▲ ${t('hub.summary.needs', { n: c.needs })}`, BOLD + fg(P.peach)],
    [`  ✻ ${t('hub.summary.working', { n: c.working })}`, fg(P.blue)],
    [`  ✓ ${t('hub.summary.done', { n: c.done })}`, fg(P.green)],
    [`  ○ ${t('hub.summary.idle', { n: c.idle })}`, fg(P.sub)],
    [`  ◉ ${t('hub.summary.watching', { n: c.watching })}`, fg(P.rose)],
  ]
  const right = filterSpans(ui)
  const button = newButton(t('hub.newAgent'))
  right.push(...button.spans)
  b.hits.push({ x1: W - button.cells + 1, x2: W, y1: 1, y2: 1, act: b.acts.newAgent })
  return split(left, right, W)
}

function lane(b: Board, name: Lane, w: number, h: number, laneIndex: Focus, x: number) {
  const items = b.l[name]
  const { i: sel } = b.sel.lane(name)
  const out = [header(STATE[name], items.length, w), render([], w, LANE_BG)]
  const room = h - 2
  const heights = cardHeights(name, items.length, room, b.prefs.doneCards)
  const top = scrollTo(heights, room, b.focus === laneIndex ? sel : -1, b.scroll[name])
  b.scroll[name] = top
  if (top > 0) out.push(render([[` ▴ ${t('hub.above', { n: top })}`, fg(P.sub)]], w, LANE_BG))
  if (!items.length) out.push(render([], w, LANE_BG), empty(nothing(name), w))
  let i = top
  for (; i < items.length; i++) {
    const hgt = heights[i]
    const reserve = i < items.length - 1 ? 1 : 0
    if (out.length + hgt + reserve > h) break
    const y = out.length + 3
    const { id } = items[i]
    b.hits.push({ x1: x, x2: x + w - 1, y1: y, y2: y + hgt - 1, act: () => b.acts.pick(laneIndex, id), wheel: laneIndex })
    out.push(...agentCard(name, items[i], hgt, w, b.focus === laneIndex && i === sel, b.ctx))
  }
  const more = items.length - i
  while (out.length < h - (more > 0 ? 1 : 0)) out.push(render([], w, LANE_BG))
  // A card that ends on the lane's last row gives that row up to the cue, so
  // hidden cards are never hidden silently.
  if (more > 0) {
    out.length = Math.min(out.length, h - 1)
    out.push(render([[` ▾ ${t('hub.more', { n: more })}`, BOLD + fg(name === 'needs' ? P.peach : P.sub)]], w, LANE_BG))
  }
  return out.slice(0, h)
}

// Red for broke, peach for needing you, as the tray and the lanes have them.
// A [pipeline] line is coloured by how it ended.
function tagColor({ tag, line }: { tag: string; line: string }, prefs: HubPrefs) {
  const result = tag === 'pipeline' ? pipelineResult(line) : ''
  if (result === 'failed') return P.red
  if (result === 'canceled' || result === 'skipped') return P.sub
  if (prefs.broke.has(tag)) return P.red
  if (prefs.attention.has(tag)) return P.peach
  return /comment|review/.test(tag) ? P.mauve : P.rose
}

// Column widths of a monitor's row before its last event, which takes the rest.
const STATE_COLS = 18
const TARGET_COLS = 34
const OWNER_COLS = 24

function monitorRow(m: Monitored, on: boolean, w: number, ui: HubUi, prefs: HubPrefs) {
  const fill = on ? SEL_BG : LANE_BG
  const look = MONITOR[m.state]
  const ev = m.event
  const stateCol = render(
    [
      [on ? ' ▌' : '  ', fg(ACCENT)],
      [`${look.glyph} ${look.name}`, BOLD + fg(look.color)],
    ],
    STATE_COLS,
    fill,
  )
  const target = render([[clean(m.description), BOLD + fg(P.text)]], TARGET_COLS, fill)
  const owner = render([[` ${m.agent.repo} · ${m.kind}`, fg(P.sub)]], OWNER_COLS, fill)
  const when = m.ended ? endedWhy(m.ended.reason) : ago(ev ? ev.at : m.startedAt, ui.now)
  const busy: Span[] = m.busy ? [['✻ ', fg(P.blue)]] : []
  const last: Span = ev ? [clean(ev.line), fg(tagColor(ev, prefs))] : [t('hub.firstEvent'), fg(P.overlay1)]
  const event = split([...busy, last], [[` ${when} `, fg(m.state === 'stale' ? P.peach : P.sub)]], w - STATE_COLS - TARGET_COLS - OWNER_COLS, fill)
  return stateCol + target + owner + event
}

// `y0` is its first row on screen.
function monitorRows(b: Board, w: number, h: number, y0: number) {
  const { strip } = b
  const { i: sel } = b.sel.monitor()
  const out = [header(MONITORS_LOOK, strip.length, w, [[`   ${t('hub.monitorsNote')}`, fg(P.sub)]]), render([], w, LANE_BG)]
  if (!strip.length) out.push(empty(`${nothing('monitors')} · n → ${t('hub.empty.monitorsStart')}`, w))
  // Like the lanes, a full tray says how many it hides.
  const { top, room } = trayWindow(strip.length, h - out.length, sel)
  strip.slice(top, top + room).forEach((m, k) => {
    const { key } = m
    b.hits.push({ x1: 1, x2: w, y1: y0 + out.length, y2: y0 + out.length, act: () => b.acts.pickMonitor(key), wheel: 4 })
    out.push(monitorRow(m, b.focus === 4 && top + k === sel, w, b.ui, b.prefs))
  })
  // The wheel anywhere over a strip with monitors scrolls the strip, not
  // the lane that had focus; a click there off a row does nothing. Pushed
  // after the rows, so a click on one still picks it.
  if (strip.length) b.hits.push({ x1: 1, x2: w, y1: y0, y2: y0 + h - 1, act: () => undefined, wheel: 4 })
  const hidden = strip.length - top - room
  if (top > 0 || hidden > 0) {
    const above = top > 0 ? `▴ ${t('hub.above', { n: top })}  ` : ''
    const below = hidden > 0 ? `▾ ${t('hub.more', { n: hidden })}` : ''
    out.push(render([[`  ${above}${below}  ${t('hub.trayKeys', { tab: 'tab', move: 'j/k' })}`, BOLD + fg(P.sub)]], w, LANE_BG))
  }
  while (out.length < h) out.push(render([], w, LANE_BG))
  return out.slice(0, h)
}

// r and R show only while there's a stopped agent to restart.
const restartKeys = (agents: readonly Agent[]): Hint[] => (agents.some(a => a.stopped && !watches(a)) ? [['r/R', t('hub.keys.restart')]] : [])

const boardKeys = (focus: Focus, agents: readonly Agent[]): Hint[] => [
  ['h/l', t('hub.keys.lane')],
  ['j/k', t('hub.keys.agent')],
  ['tab', t('hub.keys.monitors')],
  ['↵', t('hints.open')],
  ['a/d', t('hub.keys.allowDeny')],
  ['e', t('hub.keys.reviewed')],
  ['o', t('hub.keys.goToTab')],
  ['x', focus === 4 ? t('hub.keys.stopMonitor') : t('hints.close')],
  ...restartKeys(agents),
  ['alt+d', t('hub.keys.diagrams')],
  ['alt+e', t('hub.keys.editor')],
  ['n', t('hub.keys.new')],
  ['/', t('hints.filter')],
]

// ------------------------------------------------------------ nothing running

// No card in any lane the board shows and no monitor, with no filter hiding
// any: the board shows the gear. An agent can be running with nowhere to go
// (Idle turned off, or a watcher whose monitor hasn't started), and the
// board's empty lanes would say less than the gear.
export function quiet(ui: Pick<HubUi, 'agents' | 'filter'>, shown: readonly Lane[]): boolean {
  if (ui.filter) return false
  const l = lanes(ui.agents)
  return shown.every(name => l[name].length === 0) && monitorsOf(ui.agents).length === 0
}

// The whole screen in place of the summary, the lanes and the monitors: the
// gear (left out until hub.ts can draw it, or when it won't fit), the name,
// and a way to start an agent or go back. No key bar: the footer shows only
// a question or a note.
function splashFrame(ui: HubUi, { w: W, h: H }: Size, acts: ClickActs): HubFrame {
  const hits: Hit[] = []
  const foot = footer(ui, [], W)
  const panel = Math.max(0, H - foot.length)
  const blank = render([], W, LANE_BG)
  const centred = (spans: Span[]) => render([[' '.repeat(Math.max(0, Math.floor((W - spanWidth(spans)) / 2)))], ...spans], W, LANE_BG)
  const button = newButton(t('hub.newAgent'))
  const choice: Span[] = [...button.spans, [`  ${t('hub.splash.or')}   `, fg(P.sub)], ['ctrl+shift+w', BOLD + fg(P.text)], [` ${t('hub.splash.back')}`, fg(P.sub)]]
  const words = [
    centred([[[...t('hub.splash.name')].join(' '), BOLD + fg(P.text)]]),
    blank,
    centred([[t('hub.splash.quiet'), ITALIC + fg(P.sub)]]),
    blank,
    centred(choice),
  ]
  const gear = ui.splash && ui.splash.rows.length + 1 + words.length <= panel ? ui.splash : null
  const block = gear ? [...gear.rows.map(cells => centredRow(cells, gear.cols, W, LANE_BG)), blank, ...words] : words
  const top = Math.max(0, Math.floor((panel - block.length) / 2))
  const body = Array.from({ length: panel }, (_, r) => block[r - top] ?? blank)
  // The choice is the block's last row; rows count from 1.
  const x1 = Math.max(0, Math.floor((W - spanWidth(choice)) / 2)) + 1
  if (top + block.length <= panel) hits.push({ x1, x2: x1 + button.cells - 1, y1: top + block.length, y2: top + block.length, act: acts.newAgent })
  return { lines: [...body, ...foot].slice(0, H), hits, focus: ui.focus, selected: { ...ui.selected }, scroll: { ...ui.scroll }, listSel: ui.listSel }
}

// ------------------------------------------------------------ the board

export function boardFrame(ui: HubUi, prefs: HubPrefs, size: Size, acts: ClickActs): HubFrame {
  if (quiet(ui, prefs.shown)) return splashFrame(ui, size, acts)
  const { w: W, h: H } = size
  const l = lanes(ui.agents)
  const strip = monitorsOf(ui.agents)
  const selected = { ...ui.selected }
  const b: Board = {
    ui,
    prefs,
    acts,
    l,
    strip,
    // When the focused lane is empty (at start, or its last card moved on),
    // focus goes to the next lane that has cards.
    focus: keptFocus(ui.focus, filledOf(l, strip, prefs.shown)),
    sel: selector(selected, l, strip),
    scroll: { ...ui.scroll },
    hits: [],
    ctx: { win: ui.win, now: ui.now, broke: prefs.broke },
  }
  const lines = [summary(b, counts(ui.agents), W), render([], W)]
  const { stripH, laneH } = boardRows(H, strip.length, prefs.monitorRows)
  const at = laneColumns(W, prefs.shown.length)
  const cols = prefs.shown.map((name, i) => lane(b, name, at[i].w, laneH, i, at[i].x))
  for (let r = 0; r < laneH; r++) lines.push(cols.map(c => c[r]).join(' '.repeat(LANE_GAP)))
  lines.push(render([], W))
  lines.push(...monitorRows(b, W, stripH, lines.length + 1))
  const foot = footer(ui, boardKeys(b.focus, ui.agents), W)
  return { lines: [...lines.slice(0, H - foot.length), ...foot], hits: b.hits, focus: b.focus, selected, scroll: b.scroll, listSel: ui.listSel }
}

// ------------------------------------------------------------ the list

function listRows(it: ListItem, W: number, ui: HubUi, listSel: string | null): string[] {
  if ('spacer' in it) return [render([], W)]
  if ('group' in it) return [header(it.group === 'monitors' ? MONITORS_LOOK : STATE[it.group], it.count, W)]
  if ('empty' in it) return [render([[`   ${nothing(it.empty)}`, ITALIC + fg(P.overlay1)]], W)]
  const fill = it.id === listSel ? SEL_BG : ''
  if (it.monitor) {
    const look = MONITOR[it.monitor.state]
    const head: Span[] = [
      [` ${look.glyph} `, fg(look.color)],
      [clean(it.monitor.description), BOLD + fg(P.text)],
    ]
    return [split(head, [[` ${ago(it.monitor.event?.at ?? it.monitor.startedAt, ui.now)} `, fg(P.sub)]], W, fill)]
  }
  const a = it.agent
  const open = ui.peek && a.id === ui.peek.id
  return [
    split(
      [
        open ? [' ▶ ', fg(ACCENT)] : a.stopped ? [` ${STOPPED.glyph} `, fg(STOPPED.color)] : ['   ', ''],
        [clean(a.title), BOLD + fg(a.stopped ? P.sub : P.text)],
      ],
      [[` ${ago(a.since, ui.now)} `, fg(P.sub)]],
      W,
      fill,
    ),
    render([['   '], [clean(a.repo), fg(P.sub)], [clean(placeOf(a)), fg(P.overlay1)], [` · ${clean(a.cmd)}`, fg(P.overlay1)]], W, fill),
  ]
}

// The board as one column (board.ts listItems), beside an open session or
// on a screen too narrow for lanes.
export function listFrame(ui: HubUi, prefs: HubPrefs, { w: W, h: H }: Size, acts: ClickActs): HubFrame {
  const hits: Hit[] = []
  const scroll = { ...ui.scroll }
  const { peek } = ui
  const button = newButton(t('hub.new'))
  const back: Span[] = [[' ', ''], ...buttonSpans(`◂ ${t('hub.board')}`, { key: 'ctrl+shift+b', color: P.text, round: true })]
  const title: Span[] = [[` ${t('hub.title')}`, BOLD + fg(ACCENT)]]
  const lines = [split(peek ? back : title, [...filterSpans(ui), ...button.spans], W), render([], W)]
  hits.push({ x1: W - button.cells + 1, x2: W, y1: 1, y2: 1, act: acts.newAgent })
  hits.push({ x1: 1, x2: spanWidth(back), y1: 1, y2: 1, act: acts.closePeek })
  const items = listItems(lanes(ui.agents), monitorsOf(ui.agents), prefs.shown)
  const listSel = listSelection(items, ui.listSel, peek?.id)
  const drawn = items.map(it => listRows(it, W, ui, listSel))
  const monitor = pickable(items).find(x => x.id === listSel)?.monitor ?? null
  const listKeys: Hint[] = [
    ['↵', t('hints.open')],
    peek ? ['alt+→', t('hub.keys.session')] : ['esc', t('hub.keys.workspace')],
    ['ctrl+x', monitor ? t('hub.keys.stopMonitor') : t('hints.close')],
    ...restartKeys(ui.agents),
  ]
  const foot = footer(ui, listKeys, W)
  const room = H - 2 - foot.length
  const sel = items.findIndex(x => x.id === listSel)
  // Scrolling counts rows, not items.
  scroll.list = listScroll(
    items,
    drawn.map(r => r.length),
    sel,
    scroll.list,
    room,
  )
  let row = 0
  items.forEach((it, i) => {
    for (const line of drawn[i]) {
      if (row >= scroll.list && row < scroll.list + room) {
        const y = lines.length + 1
        if (it.id !== undefined) hits.push({ x1: 1, x2: W, y1: y, y2: y, act: () => acts.openItem(it) })
        lines.push(line)
      }
      row++
    }
  })
  while (lines.length < H - foot.length) lines.push(render([], W))
  return { lines: [...lines, ...foot].slice(0, H), hits, focus: ui.focus, selected: { ...ui.selected }, scroll, listSel }
}
