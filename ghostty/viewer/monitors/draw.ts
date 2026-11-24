// Draws the Monitors popup. It reads Settings' hub.endedFor and nothing
// else, so a test can draw any state. Pipelines' body is in draw-pipes.ts,
// Logs' in draw-logs.ts.

import { pipelineResult } from '../../agents/transcript.ts'
import { tilde } from '../../core/paths.ts'
import { t } from '../../core/text.ts'
import { load as settings } from '../../settings/settings.ts'
import { type Hint, hintSpansAfter } from '../../tui/chrome.ts'
import { button, confirm, field, frameBottom, frameTop, pressAgain, select, spanWidth } from '../../tui/controls.ts'
import { clampScroll, keepInView } from '../../tui/list.ts'
import type { Size } from '../../tui/overlay.ts'
import { MONITOR, TINT } from '../../tui/palette.ts'
import { ACCENT, BOLD, ITALIC, type Line, P, type Span, ago, bg, clean, fg, render, split } from '../../tui/term.ts'
import { glyphOf } from '../../tray/approvals.ts'
import { current } from '../approvals/approvals.ts'
import { type Drawn, dots, panel as drawPanel, keysFor } from '../approvals/draw.ts'
import { WATCH_KEYS } from './attach.ts'
import { babysitBranch, repoKey } from './checkout.ts'
import type { Branch, HostResult, Pipeline, Pr, Reviews } from './forge.ts'
import { logsBody } from './draw-logs.ts'
import { CTRL_S } from './logs-state.ts'
import { heading, rule } from './heading.ts'
import { pipesBody } from './draw-pipes.ts'
import { lit } from './lit.ts'
import { hiddenCount, pipeGroups, waitingCount } from './pipe-rows.ts'
import { pipeView } from './pipe-state.ts'
import { type PrRow, RUN_GROUPS, type RunGroup, type RunRow, groupCounts, refLabel, sameUrl } from './rows.ts'
import {
  type Drawer,
  type Filter,
  type MonitorsState,
  type Note,
  type Panel,
  STOP_KEY,
  VIEWS,
  type View,
  allRunning,
  panelRow,
  pipeItemsOf,
  prList,
  runningRows,
  selectedPr,
  selectedRun,
  targets,
} from './state.ts'

export type { Size }
// scroll and approvals are what drawing decided, which the entry keeps.
export type Frame = { lines: string[]; title: string[]; scroll: number; approvals: Drawn | null }

const BASE = bg(P.base)
const SEL = bg(P.surface0)
const BOX = bg(P.mantle)
const DIM = fg(P.overlay1)
const SUB = fg(P.sub)
const blank = (w: number, fill = BASE): string => render([], w, fill)

const TONE = { green: P.green, red: P.red, peach: P.peach, sub: P.sub }

const cell = (spans: Line, w: number, fill: string): string => render(spans, w, fill)

// ------------------------------------------------------------ the view row

// A terminal can't draw one row's text larger, so the tabs get height
// instead: each is a three-row box, the lit one filled so it reads as one
// solid button.
function viewTab(view: View, count: string, on: boolean): { top: Span[]; mid: Span[]; bottom: Span[] } {
  const name = `  ${t(`monitors.views.${view}`)}  `
  const num = `${count}  `
  const inner = spanWidth([[name + num]])
  const fill = on ? bg(P.surface1) : BASE
  const edge = fg(on ? P.rose : P.surface1) + fill
  const gap: Span = ['  ', BASE]
  return {
    top: [[`╭${'─'.repeat(inner)}╮`, edge], gap],
    mid: [
      ['│', edge],
      [name, BOLD + (on ? fg(P.text) : SUB) + fill],
      [num, BOLD + fg(on ? P.rose : P.overlay2) + fill],
      ['│', edge],
      gap,
    ],
    bottom: [[`╰${'─'.repeat(inner)}╯`, edge], gap],
  }
}

function runningCounts(s: MonitorsState): Span[] {
  const c = groupCounts(allRunning(s))
  const parts: [keyof typeof c, string][] = [
    ['approve', `▲ ${t('monitors.counts.approve', { n: c.approve })}`],
    ['action', `▲ ${t('monitors.counts.action', { n: c.action })}`],
    ['watching', `◉ ${t('monitors.counts.watching', { n: c.watching })}`],
    ['stale', `◌ ${t('monitors.counts.stale', { n: c.stale })}`],
    ['ended', `✓ ${t('monitors.counts.ended', { n: c.ended })}`],
  ]
  return parts.filter(([k]) => c[k] > 0).flatMap(([k, text]): Span[] => [[text, fg(k === 'ended' ? P.green : k === 'approve' ? P.peach : MONITOR[k].color)], ['  ']])
}

function fetchedAt(hosts: readonly { at: number }[], refreshing: boolean, now: number): Span {
  const at = Math.max(0, ...hosts.map(h => h.at))
  if (refreshing && !at) return [t('monitors.refreshing'), fg(P.blue)]
  if (!at) return [t('monitors.never'), DIM]
  return [t('monitors.refreshed', { ago: ago(at, now) || '0s' }), fg(refreshing ? P.blue : P.overlay2)]
}
const fetched = (s: MonitorsState, now: number): Span => fetchedAt(s.hosts, s.refreshing, now)

const pipeCount = (s: MonitorsState): number => {
  const g = pipeGroups(s.pipes.hosts, pipeView(s.pipes))
  return g.own.length + g.prs.length
}
const logWatchers = (s: MonitorsState): number => allRunning(s).filter(r => r.kind === 'logs' && r.group !== 'ended').length
const runningCount = (s: MonitorsState): number => allRunning(s).filter(r => r.group !== 'ended' && !r.standIn).length

const pipesRight = (s: MonitorsState, now: number): Span[] => {
  const hidden = hiddenCount(s.pipes.hosts, pipeView(s.pipes, now))
  return [[`${t('monitors.pipes.scope')} · `, fg(P.overlay2)], ...(hidden ? [[`${t('monitors.pipes.hidden', { n: hidden })} · `, fg(P.overlay1)] as Span] : []), fetchedAt(s.pipes.hosts, s.pipes.refreshing, now), [' ']]
}
const logsRight = (s: MonitorsState): Span[] => [[t('monitors.logs.running', { n: logWatchers(s) }), fg(P.overlay2)], [' ']]

function roleToggle(s: MonitorsState, now: number): Span[] {
  const n = { mine: 0, reviewer: 0 }
  for (const h of s.hosts)
    for (const pr of h.prs)
      if (s.drafts || !pr.draft) {
        if (pr.mine) n.mine++
        if (pr.review) n.reviewer++
      }
  const role = (r: 'mine' | 'reviewer'): Span => [` ${t(`monitors.roles.${r}`)} ${n[r]} `, s.role === r ? BOLD + fg(P.text) + bg(P.surface1) : SUB + BOX]
  return [role('mine'), ['│', fg(P.surface1) + BOX], role('reviewer'), ['  '], fetched(s, now), [' ']]
}

function viewRows(s: MonitorsState, w: number, now: number): string[] {
  const counts: Record<View, string> = {
    running: String(runningCount(s)),
    // Before the first fetch lands, 0 would be a wrong count.
    prs: s.refreshing && !s.hosts.some(h => h.ok) ? '…' : String(prList({ ...s, filters: { ...s.filters, prs: { open: false, typing: false, query: '' } } }).rows.length),
    pipes: String(pipeCount(s)),
    logs: '+',
  }
  const tabs = VIEWS.map(v => viewTab(v, counts[v], v === s.view))
  const right = s.view === 'running' ? runningCounts(s) : s.view === 'prs' ? roleToggle(s, now) : s.view === 'pipes' ? pipesRight(s, now) : logsRight(s)
  return [
    render([[' '], ...tabs.flatMap(x => x.top)], w, BASE),
    split([[' '], ...tabs.flatMap(x => x.mid)], right, w, BASE),
    render([[' '], ...tabs.flatMap(x => x.bottom)], w, BASE),
  ]
}

// ------------------------------------------------------------ filter

function filterRow(f: Filter, kept: number, total: number, w: number, placeholder: string): string {
  const count: Span[] = [[t('monitors.filter.count', { n: kept, total }), SUB], [' ']]
  const lead: Span = [' / ', BOLD + fg(ACCENT) + BOX]
  const room = Math.max(1, w - spanWidth([lead, ...count]) - 2)
  return split([lead, ...field({ text: f.query, at: f.at, w: room, focused: f.typing, placeholder })], count, w, BOX)
}

const hiddenLine = (n: number, w: number): string => render([['   '], [t('monitors.filter.hidden', { n }), DIM]], w, BASE)

// ------------------------------------------------------------ footer

const H = (k: string): string => t(`monitors.hints.${k}`)

function hints(s: MonitorsState): Hint[] {
  const f = s.filters[s.view]
  if (s.view === 'logs') return [['↑/↓', H('field')], ['←/→', H('choose')], ['ctrl+s', H('start')], ['tab', H('view')]]
  if (s.view === 'pipes') {
    if (s.pipes.watch.typing) return [['↵', H('startWatching')], ['esc', H('back')]]
    if (f.typing) return [['↑/↓', H('move')], ['↵', H('keep')], ['esc', H('clear')]]
    return [['j/k', H('move')], ['y/n', H('runSkip')], ['m', H('watchPipe')], ['+', H('pasteUrl')], ['↵', H('prompts')], ['x', H('dismiss')], ['o', H('browser')], ['r', H('refresh')], ['/', H('filter')], ['tab', H('view')]]
  }
  if (s.view === 'prs' && s.drawer) {
    const d = s.drawer
    if (d.focus === 'brief') return [['↵', H('back')], ['tab', H('next')], ['ctrl+s', H('start')], ['esc', H('back')]]
    const choice: Hint[] = d.focus === 'list' ? [] : [['←/→', H('change')]]
    return [...choice, ['j/k', H('move')], ['space', H('mark')], ['1–4', H('toggle')], ['/', H('brief')], ['m', d.more ? H('less') : H('more')], ['ctrl+s', H('start')], ['esc', d.focus === 'list' ? H('closeDrawer') : H('back')]]
  }
  if (f.typing) return [['↑/↓', H('move')], ['↵', H('keep')], ['esc', H('clear')]]
  const views: Hint = ['tab', H('view')]
  if (s.view === 'running') return [['j/k', H('move')], ['↵', H('open')], ['a', H('approvals')], ['x', H('stop')], ['o', H('browser')], ['/', H('filter')], views]
  return [['j/k', H('move')], ['space', H('mark')], ['*', H('markAll')], ['↵', H('attach')], ['g', H('goMonitor')], ['o', H('browser')], ['w', H('role')], ['r', H('refresh')], ['/', H('filter')], views]
}

// Monitors' j/k and esc go after the panel's first key, and not at all
// while a diff or the editor has the keys.
function panelHints(panel: Panel): Hint[] {
  const ap = panel.ap
  const own = keysFor(ap, current(ap))
  if (ap.diff || ap.editing) return own
  const ours: Hint[] = [['j/k', H('monitor')], ['esc', H('closePanel')]]
  return [...own.slice(0, 1), ...ours, ...own.slice(1)]
}

// The panel's busy line or note wins over the popup's own.
function noteOf(s: MonitorsState, drawn: Drawn | null): Note | null {
  const ap = s.panel?.ap
  if (ap?.busy) return { text: ap.busy, tone: 'sub' }
  const said = ap ? (drawn?.seen ? drawn.seen.note : ap.note) : null
  return said ?? s.note
}

function footer(s: MonitorsState, w: number, drawn: Drawn | null): string {
  if (s.view === 'logs' && s.logs.confirm) {
    const q = confirm(t('monitors.logs.confirm', { env: s.logs.env }), pressAgain(CTRL_S, t('monitors.logs.startAnyway')))
    return render([[' '], ...q], w, BASE)
  }
  if (s.ask) {
    const q = confirm(t('hub.notes.stopMonitorAsk', { name: clean(s.ask.name), title: clean(s.ask.title) }), [
      ...pressAgain(STOP_KEY),
      ['a', t('hub.dontAskAgain')],
    ])
    return render([[' '], ...q], w, BASE)
  }
  const said = noteOf(s, drawn)
  const note: Span[] = said ? [[`${said.text} `, fg(TONE[said.tone])]] : []
  let keys = s.view === 'running' && s.panel ? panelHints(s.panel) : hints(s)
  const room = w - spanWidth(note) - 2
  while (keys.length > 1 && spanWidth(hintSpansAfter(keys)) > room) keys = keys.slice(0, -1)
  return split([[' '], ...hintSpansAfter(keys)], note, w, BASE)
}

// ------------------------------------------------------------ Running

const STATE_W = 16
const KIND_W = 6
const TARGET_W = 26
const AGE_W = 7

const KIND_LOOK: Record<RunRow['kind'], [label: string, color: string]> = {
  pr: [t('monitors.kinds.pr'), P.mauve],
  pipe: [t('monitors.kinds.pipe'), P.sapphire],
  logs: [t('monitors.kinds.logs'), P.green],
  other: ['', P.sub],
}

const GROUP_COLOR: Record<RunGroup, string> = { needs: P.peach, watching: P.rose, ended: P.green }

// A [pipeline] line is coloured by how it ended, not by its tag.
function tagColor({ tag, line }: { tag: string; line: string }): string {
  if (/^(failed|error|crash|conflicts?|stuck)$/.test(tag)) return P.red
  if (/^(manual|auth|setup|blocked)$/.test(tag)) return P.peach
  if (/comment|review/.test(tag)) return P.mauve
  if (tag === 'pipeline') return { failed: P.red, canceled: P.sub, skipped: P.sub }[pipelineResult(line)] ?? P.green
  if (tag === 'merged') return P.green
  return P.sub
}

// Proposals waiting on you outrank the monitor's own state.
function stateLook(r: RunRow): [text: string, color: string] {
  const n = r.waits.length
  if (n) return [`▲ ${t(r.group === 'ended' ? 'monitors.approvals.left' : 'monitors.approvals.toApprove', { n })}`, P.peach]
  const look = MONITOR[r.m.state]
  return [`${look.glyph} ${look.name}`, look.color]
}

// A stand-in has no events, so it shows its first proposal.
function latestSpans(r: RunRow): Line {
  const ev = r.m.event
  if (r.standIn) return [[clean(r.waits[0]?.title ?? ''), fg(P.peach)]]
  return ev ? [[clean(ev.line), fg(tagColor(ev))]] : [[t('hub.firstEvent'), DIM]]
}

// narrow is beside the approvals panel.
function runLine(r: RunRow, on: boolean, w: number, now: number, narrow = false): string {
  const fill = on ? SEL : BASE
  const [state, sc] = stateLook(r)
  const [kind, kc] = KIND_LOOK[r.kind]
  const ev = r.m.event
  const lead =
    cell([[on ? ' ▌' : '  ', fg(P.rose)]], 2, fill) +
    cell([[state, fg(sc)]], STATE_W, fill) +
    cell([[kind || r.m.kind.slice(0, 5), BOLD + fg(kc)]], KIND_W, fill)
  const target: Line = [...(r.forge ? ([[`${r.forge} `, DIM]] as Span[]) : []), ...lit(clean(r.target), r.hit, fg(P.text))]
  if (narrow) return lead + cell(target, Math.max(1, w - 2 - STATE_W - KIND_W), fill)
  const latestW = Math.max(4, w - 2 - STATE_W - KIND_W - TARGET_W - AGE_W)
  const age = r.m.ended ? ago(r.m.ended.at, now) : ago(ev?.at ?? r.m.startedAt, now)
  return lead + cell(target, TARGET_W - 1, fill) + cell([], 1, fill) + cell(latestSpans(r), latestW, fill) + cell([[age.padStart(AGE_W - 1), SUB]], AGE_W, fill)
}

function groupLine(g: RunGroup, n: number, w: number): string {
  const note: Span[] = g === 'ended' ? [[` · ${t('monitors.groups.endedNote', { n: settings()['hub.endedFor'] })}`, DIM]] : []
  return heading([[`${t(`monitors.groups.${g}`)} `, BOLD + fg(GROUP_COLOR[g])], [String(n), fg(P.overlay2)], ...note], w)
}

function runHeader(w: number, narrow = false): string {
  const lead: Span[] = [['  '], [t('monitors.cols.state').padEnd(STATE_W), DIM], [t('monitors.cols.kind').padEnd(KIND_W), DIM], [t('monitors.cols.target'), DIM]]
  if (narrow) return render(lead, w, BASE)
  lead[3] = [t('monitors.cols.target').padEnd(TARGET_W), DIM]
  const rest: Span[] = [
    [t('monitors.cols.latest').padEnd(Math.max(4, w - 2 - STATE_W - KIND_W - TARGET_W - AGE_W)), DIM],
    [t('monitors.cols.age').padStart(AGE_W - 1), DIM],
  ]
  return render([...lead, ...rest], w, BASE)
}

type RunItem = { group?: RunGroup; n?: number; row?: number }

function runItems(rows: readonly RunRow[]): RunItem[] {
  const items: RunItem[] = []
  for (const g of RUN_GROUPS) {
    const idx = rows.flatMap((r, i) => (r.group === g ? [i] : []))
    if (!idx.length) continue
    // A blank line between groups; an item with neither group nor row draws blank.
    if (items.length) items.push({})
    items.push({ group: g, n: idx.length })
    for (const i of idx) items.push({ row: i })
  }
  return items
}

function sessionLine(r: RunRow, now: number): string {
  const a = r.m.agent
  const where = a.pane ? t('monitors.side.tab', { n: a.pane.tab }) : t(a.kind === 'bg' ? 'monitors.side.bg' : 'monitors.side.term')
  const model = a.model.replace(/^claude-/, '').replace(/-\d[\d-]*$/, '')
  return [where, r.m.kind, model, ago(r.m.startedAt, now)].filter(Boolean).join(' · ')
}

const WAITING_MOST = 5

function waitingBox(r: RunRow, w: number, now: number): string[] {
  const edge = fg(P.peach)
  // One cell in from the panel's edge, as its text is.
  const bw = w - 2
  const inner = bw - 4
  const head = ` ${t('monitors.approvals.waiting', { n: r.waits.length })} `
  const row = (content: string): string => render([[' │ ', edge]], 3, BASE) + content + render([[' │ ', edge]], 3, BASE)
  const lines = [render([[' ╭─', edge], [head, BOLD + edge], ['─'.repeat(Math.max(0, bw - 4 - spanWidth([[head]]))), edge], ['─╮', edge]], w, BASE)]
  for (const p of r.waits.slice(0, WAITING_MOST)) {
    const glyph: Span = [`${glyphOf(p.kind)} `, fg(p.status === 'failed' ? P.red : P.peach)]
    lines.push(row(split([glyph, [clean(p.title ?? p.kind), fg(P.text)]], [[` ${ago(p.at ?? 0, now)}`, DIM]], inner, BASE)))
  }
  if (r.waits.length > WAITING_MOST) lines.push(row(render([[t('monitors.approvals.more', { n: r.waits.length - WAITING_MOST }), DIM]], inner, BASE)))
  lines.push(row(render([['a', BOLD + fg(P.text)], [` ${t('monitors.approvals.reviewHere')}`, SUB]], inner, BASE)))
  lines.push(render([[` ╰${'─'.repeat(Math.max(0, bw - 2))}╯`, edge]], w, BASE))
  return lines
}

function sidePanel(s: MonitorsState, r: RunRow | null, w: number, h: number, now: number): string[] {
  const lines: string[] = []
  const add = (spans: Line, fill = BASE) => lines.push(render([[' '], ...spans], w, fill))
  if (!r) return Array.from({ length: h }, () => blank(w))
  const [state, sc] = stateLook(r)
  const [kind, kc] = KIND_LOOK[r.kind]
  lines.push(split([[' '], [kind ? `${kind}  ` : '', BOLD + fg(kc)], [r.forge ? `${r.forge} ` : '', DIM], [clean(r.target), BOLD + fg(P.text)]], [[`${state} `, fg(sc)]], w, BASE))
  add([[clean(r.pr?.title ?? r.m.description), BOLD + fg(P.text)]])
  if (r.pr) add([[`⎇ ${clean(r.pr.head)} → ${clean(r.pr.base)}`, SUB]])
  if (r.standIn) add([[t(`monitors.approvals.standIn.${r.standIn}`), DIM]])
  else add([[sessionLine(r, now), DIM]])
  const record = r.url ? (s.attached[r.url] ?? Object.entries(s.attached).find(([u]) => sameUrl(u) === sameUrl(r.url))?.[1]) : undefined
  if (record && !r.standIn) {
    lines.push(blank(w))
    add([[t('monitors.side.watchingUntil', { until: t(`monitors.until.${record.until}`) }), DIM]])
    for (const k of WATCH_KEYS) if (record.watch[k]) add([['✓ ', fg(P.green)], [t(`monitors.side.watch.${k}`), fg(P.text)]])
    if (record.brief) add([[t('monitors.side.brief', { text: clean(record.brief) }), SUB]])
  }
  if (r.waits.length) lines.push(blank(w), ...waitingBox(r, w, now))
  if (!r.standIn) {
    lines.push(blank(w))
    add([[t('monitors.side.latest'), DIM]])
    const ev = r.m.event
    if (r.m.ended) add([[t('monitors.side.ended', { why: clean(r.m.ended.reason) }), SUB]])
    if (ev) add([[`${ago(ev.at, now).padEnd(4)} `, DIM], [clean(ev.line), fg(tagColor(ev))]], BOX)
    else add([[t('monitors.side.noEvents'), DIM]], BOX)
  }
  while (lines.length < h) lines.push(blank(w))
  return lines.slice(0, h)
}

// Below PANEL_FROM columns the panel takes all of Running's width.
const PANEL_SHARE = 0.6
const PANEL_FROM = 90

function approvalsPanel(s: MonitorsState, panel: Panel, w: number, h: number): { lines: string[]; drawn: Drawn } {
  const ap = panel.ap
  const r = panelRow(s)
  const target = r?.target ?? panel.target
  const inner = Math.max(1, w - 2)
  const at = ap.list.length ? [` · ${t('approvals.position', { at: Math.min(ap.i, ap.list.length - 1) + 1, n: ap.list.length })}`] : []
  const head = split(
    [
      [t('approvals.title'), BOLD + fg(P.peach)],
      [` · ${clean(target)}${at.join('')}`, SUB],
    ],
    [[`${dots(ap)} `, fg(P.peach)]],
    inner,
    BASE,
  )
  const drawn = drawPanel(ap, inner, Math.max(1, h - 1), { empty: t('monitors.approvals.nothingWaits', { target }) })
  const edge = render([['┃', fg(P.peach)]], 1, BASE) + render([], 1, BASE)
  return { lines: [head, ...drawn.lines].map(l => `${edge}${l}`), drawn }
}

function running(s: MonitorsState, w: number, height: number, now: number): { lines: string[]; scroll: number; approvals: Drawn | null } {
  const f = s.filters.running
  const panel = s.panel
  // A push's diff takes the whole body.
  if (panel?.ap.diff) {
    const drawn = drawPanel(panel.ap, w, height)
    return { lines: drawn.lines, scroll: s.run.scroll, approvals: drawn }
  }
  const rows = runningRows(s)
  const sel = selectedRun(s)
  const side = panel ? (w >= PANEL_FROM ? Math.round(w * PANEL_SHARE) : w) : w >= 100 ? Math.min(48, Math.floor(w * 0.36)) : 0
  const lw = panel ? w - side : side ? w - side - 1 : w
  if (panel && !lw) {
    const shown = approvalsPanel(s, panel, w, height)
    return { lines: shown.lines, scroll: s.run.scroll, approvals: shown.drawn }
  }
  const total = allRunning(s).length
  const hidden = f.query.trim() ? total - rows.length : 0
  const listH = Math.max(1, height - 1 - (hidden ? 1 : 0))
  const items = runItems(rows)
  const at = items.findIndex(it => it.row !== undefined && rows[it.row].key === sel?.key)
  const top = at > 0 && items[at - 1].group ? at - 1 : at
  const scroll = clampScroll(at < 0 ? 0 : keepInView(s.run.scroll, top, at, listH), items.length, listH)
  const narrow = Boolean(panel)
  const list: string[] = [runHeader(lw, narrow)]
  for (let y = 0; y < listH; y++) {
    const it = items[scroll + y]
    if (!it) list.push(y === 0 && !rows.length ? render([['   '], [f.query.trim() ? t('monitors.empty.noMatch', { query: f.query.trim() }) : t('monitors.empty.running'), ITALIC + SUB]], lw, BASE) : blank(lw))
    else if (it.group) list.push(groupLine(it.group, it.n ?? 0, lw))
    else if (it.row !== undefined) list.push(runLine(rows[it.row], rows[it.row].key === sel?.key, lw, now, narrow))
    else list.push(blank(lw))
  }
  if (hidden) list.push(hiddenLine(hidden, lw))
  if (panel) {
    const shown = approvalsPanel(s, panel, side, list.length)
    return { lines: list.map((l, i) => `${l}${shown.lines[i]}`), scroll, approvals: shown.drawn }
  }
  if (!side) return { lines: list, scroll, approvals: null }
  const info = sidePanel(s, sel, side, list.length, now)
  const rule = render([['│', fg(P.surface0)]], 1, BASE)
  return { lines: list.map((l, i) => `${l}${rule}${info[i]}`), scroll, approvals: null }
}

// ------------------------------------------------------------ PRs & MRs

type Col = 'ref' | 'title' | 'pipe' | 'rev' | 'branch' | 'mon'
const FIXED: Record<Exclude<Col, 'title'>, number> = { ref: 24, pipe: 24, rev: 29, branch: 13, mon: 13 }
// Dropped in this order when the title would get too narrow.
const DROP: readonly Col[] = ['rev', 'branch', 'pipe', 'mon']
const LEAD = 2 + 4 + 3

export function prColumns(w: number): { cols: Col[]; title: number } {
  let cols: Col[] = ['ref', 'title', 'pipe', 'rev', 'branch', 'mon']
  const titleW = (cs: Col[]) => w - LEAD - cs.reduce((n, c) => n + (c === 'title' ? 0 : FIXED[c] + 1), 0) - 1
  for (const c of DROP) if (titleW(cols) < 18) cols = cols.filter(x => x !== c)
  return { cols, title: Math.max(6, titleW(cols)) }
}

const PIPE_LOOK: Record<Pipeline['state'], string> = {
  passed: P.green,
  failed: P.red,
  running: P.blue,
  pending: P.sub,
  manual: P.peach,
  canceled: P.overlay1,
  none: P.overlay1,
}

export function pipelineText(p: Pipeline): string {
  if (p.state === 'failed') return p.job ? t('monitors.pipeline.failed', { job: p.job }) : t('monitors.pipeline.failedNoJob')
  if (p.state === 'manual') return t('monitors.pipeline.manual', { job: p.job })
  if (p.state === 'running') return t('monitors.pipeline.running', { done: p.done, total: p.total })
  return t(`monitors.pipeline.${p.state}`)
}

export function reviewsText(r: Reviews, draft: boolean): [text: string, color: string] {
  const threads = r.threads ? ` · ${t('monitors.reviews.threads', { n: r.threads })}` : ''
  if (r.changes) return [`${t('monitors.reviews.changes')}${threads}`, P.peach]
  if (r.required) return [`${t('monitors.reviews.of', { n: r.approvedBy.length, required: r.required })}${threads}`, P.sub]
  if (r.approvedBy.length && !r.waiting) return [`${t('monitors.reviews.approved')}${threads}`, P.green]
  if (r.waiting) return [`${t('monitors.reviews.required')}${threads}`, P.sub]
  if (draft) return [t('monitors.reviews.draft'), P.overlay1]
  if (r.reviewers.length) return [`${t('monitors.reviews.waiting', { n: r.reviewers.length })}${threads}`, P.sub]
  return [r.threads ? threads.slice(3) : t('monitors.reviews.none'), P.overlay1]
}

export function branchText(b: Branch): [text: string, color: string] {
  if (b.state === 'conflict') return [t('monitors.branch.conflict'), P.peach]
  if (b.state === 'behind') return [b.behind ? t('monitors.branch.behind', { n: b.behind }) : t('monitors.branch.behindSome'), P.sub]
  if (b.state === 'ok') return [t('monitors.branch.ok'), P.overlay1]
  return [t('monitors.branch.unknown'), P.overlay1]
}

const MON_LOOK: Record<string, [string, string]> = {
  action: [t('monitors.monitor.action'), P.peach],
  watching: [t('monitors.monitor.watching'), P.rose],
  stale: [t('monitors.monitor.stale'), P.sub],
  none: [t('monitors.monitor.attach'), P.rose],
}

function prLine(row: PrRow, on: boolean, marked: boolean, layout: ReturnType<typeof prColumns>): string {
  const fill = on ? SEL : BASE
  const { pr } = row
  const dim = pr.draft
  const text = (color: string) => fg(dim ? P.overlay1 : color)
  const out = [cell([[on ? ' ▌' : '  ', fg(P.rose)]], 2, fill), cell([[marked ? '[x]' : '[ ]', fg(marked ? P.rose : P.overlay1)]], 4, fill), cell([[pr.forge, DIM]], 3, fill)]
  for (const c of layout.cols) {
    const spans: Span[] =
      c === 'ref'
        ? lit(clean(row.ref), row.hit.ref, text(P.text))
        : c === 'title'
          ? lit(clean(pr.title), row.hit.title, (on ? BOLD : '') + text(P.text))
          : c === 'pipe'
            ? [[pipelineText(pr.pipeline), text(PIPE_LOOK[pr.pipeline.state])]]
            : c === 'rev'
              ? (([s, color]) => [[s, text(color)] as Span])(reviewsText(pr.reviews, pr.draft))
              : c === 'branch'
                ? (([s, color]) => [[s, text(color)] as Span])(branchText(pr.branch))
                : (([s, color]) => [[s, text(color)] as Span])(MON_LOOK[row.monitor ?? 'none'])
    out.push(cell(spans, c === 'title' ? layout.title : FIXED[c], fill), cell([], 1, fill))
  }
  return out.join('')
}

function prHeader(s: MonitorsState, rows: readonly PrRow[], layout: ReturnType<typeof prColumns>, w: number): string {
  const marked = rows.filter(r => s.prs.marked.has(sameUrl(r.pr.url))).length
  const box = s.prs.marked.size === 0 ? '[ ]' : marked === rows.length && rows.length ? '[x]' : '[-]'
  const names: Record<Col, string> = {
    ref: t('monitors.cols.pr'),
    title: t('monitors.cols.title'),
    pipe: t('monitors.cols.pipeline'),
    rev: t('monitors.cols.reviews'),
    branch: t('monitors.cols.branch'),
    mon: t('monitors.cols.monitor'),
  }
  const spans: Span[] = [['  '], [box.padEnd(4), fg(s.prs.marked.size ? P.rose : P.overlay1)], ['   ']]
  for (const c of layout.cols) spans.push([names[c].padEnd((c === 'title' ? layout.title : FIXED[c]) + 1), DIM])
  return render(spans, w, BASE)
}

// A host that failed this time keeps the rows it had, this line under them.
function hostLine(h: Extract<HostResult, { ok: false }>, w: number): string {
  const cli = h.forge === 'gh' ? 'gh' : 'glab'
  const why = h.why === 'failed' ? t(h.prs.length ? 'monitors.hosts.stale' : 'monitors.hosts.failed', { err: clean(h.err).slice(0, 120) }) : t(`monitors.hosts.${h.why}`, { cli })
  return render([['   '], [`${h.forge} ${h.host} · ${why}`, DIM]], w, BASE)
}

function infoBox(s: MonitorsState, row: PrRow, w: number, now: number): string[] {
  const { pr } = row
  const label = (k: string): Span => [` ${t(`monitors.info.${k}`).padEnd(11)}`, DIM + BOX]
  const conflicts: Span[] = pr.branch.state === 'conflict' ? [[` · ${t('monitors.branch.conflict')}`, fg(P.peach) + BOX]] : []
  const opened = pr.createdAt ? ` · ${t('monitors.info.opened', { ago: ago(pr.createdAt, now) })}` : ''
  const approved = pr.reviews.approvedBy.length ? ` · ${t('monitors.info.approvedBy', { who: pr.reviews.approvedBy.map(a => `@${a}`).join(', ') })}` : ''
  const reviewers = pr.reviews.reviewers.length ? pr.reviews.reviewers.map(r => `@${r}`).join(', ') : t('monitors.info.noReviewers')
  const dir = s.checkouts.get(repoKey(pr.host, pr.repo))
  const checkout: Span[] = dir
    ? [[tilde(dir), fg(P.text) + BOX], [' · ', DIM + BOX], ['⑂ ', DIM + BOX], [babysitBranch(pr.number), fg(P.text) + BOX]]
    : [[t('monitors.info.noCheckout', { repo: pr.repo }), fg(P.peach) + BOX]]
  return [
    render([label('selected'), [`${pr.forge} `, DIM + BOX], [clean(row.ref), BOLD + fg(P.text) + BOX], [` · ⎇ ${clean(pr.head)} → ${clean(pr.base)}${opened}`, SUB + BOX], ...conflicts], w, BOX),
    render([label('reviewers'), [`${reviewers}${approved}`, SUB + BOX]], w, BOX),
    render([label('checkout'), ...checkout], w, BOX),
  ]
}

// ------------------------------------------------------------ the drawer

export const DRAWER_ROWS = 5

// !512, #44
const shortRefs = (prs: readonly Pr[]): string => prs.map(p => `${p.forge === 'gh' ? '#' : '!'}${p.number}`).join(', ')

function toggleChip(i: number, label: string, on: boolean): Span[] {
  const fill = on ? bg(TINT.ok) : BOX
  return [[` ${i + 1}`, BOLD + fg(on ? P.rose : P.overlay1) + fill], [` ${label} `, fg(on ? P.text : P.overlay1) + fill], [' ', BOX]]
}

function drawerLines(s: MonitorsState, d: Drawer, prs: readonly Pr[], offScreen: number, w: number): string[] {
  const inner = w - 4
  const marked = s.prs.marked.size
  const head: Span[] = marked
    ? [[t('monitors.drawer.attachTo', { n: prs.length }), BOLD + fg(P.rose) + BOX], ...(offScreen ? ([[` ${t('monitors.drawer.offScreen', { n: offScreen })}`, fg(P.peach) + BOX]] as Span[]) : [])]
    : [[t('monitors.drawer.attachOne', { ref: prs[0] ? refLabel(prs[0].forge, prs[0].repo.split('/').at(-1) ?? '', prs[0].number) : '' }), BOLD + fg(P.rose) + BOX]]
  const refs: Span = [`  ${shortRefs(prs)}`, SUB + BOX]
  const summary: Span[] = d.more
    ? [
        [`${t('monitors.drawer.until')} `, DIM + BOX],
        ...select(t(`monitors.untilShort.${d.until}`), d.focus === 'until').map(([x, st]): Span => [x, `${st ?? ''}${BOX}`]),
        [`  ${t('monitors.drawer.model')} `, DIM + BOX],
        ...select(d.model, d.focus === 'model').map(([x, st]): Span => [x, `${st ?? ''}${BOX}`]),
        [`  ${t('monitors.drawer.effort')} `, DIM + BOX],
        ...select(d.effort, d.focus === 'effort').map(([x, st]): Span => [x, `${st ?? ''}${BOX}`]),
        [' ', BOX],
      ]
    : [
        [`${t('monitors.drawer.summary', { until: t(`monitors.untilShort.${d.until}`), model: d.model, effort: d.effort })} · `, DIM + BOX],
        ['m', fg(P.text) + BOX],
        [` ${t('monitors.drawer.more')} `, DIM + BOX],
      ]
  const toggles: Span[] = [[`${t('monitors.drawer.watch')}`.padEnd(7), DIM + BOX], ...WATCH_KEYS.flatMap((k, i) => toggleChip(i, t(`monitors.drawer.toggles.${k}`), d.watch[k]))]
  const start = button(t('monitors.drawer.start'), { key: ' ctrl+s', main: true, color: P.rose })
  const fieldW = Math.max(4, inner - 7 - spanWidth(start) - 2)
  const brief: Span[] = [
    [`${t('monitors.drawer.brief')}`.padEnd(7), (d.focus === 'brief' ? fg(P.rose) : DIM) + BOX],
    ...field({ text: d.brief, at: d.at, w: fieldW, focused: d.focus === 'brief', placeholder: t('monitors.drawer.briefPlaceholder') }),
  ]
  return [
    frameTop(w, { fill: BASE }),
    boxed(split([...head, refs], summary, inner, BOX)),
    boxed(render(toggles, inner, BOX)),
    boxed(split(brief, start, inner, BOX)),
    frameBottom(w, { fill: BASE }),
  ]
}

// Content is `w - 4` cells wide.
const EDGE = render([['│', fg(P.rose)]], 1, BASE)
const PAD = render([[' ']], 1, BOX)
const boxed = (content: string): string => `${EDGE}${PAD}${content}${PAD}${EDGE}`

function prs(s: MonitorsState, w: number, height: number, now: number): { lines: string[]; scroll: number } {
  const f = s.filters.prs
  const { rows, hidden } = prList(s)
  const sel = selectedPr(s)
  const layout = prColumns(w)
  const down = s.hosts.filter((h): h is Extract<HostResult, { ok: false }> => !h.ok)
  const noHosts = !s.hosts.length && !s.refreshing
  const below = (hidden && f.query.trim() ? 1 : 0) + Math.min(3, down.length) + (noHosts ? 1 : 0)
  const box = s.drawer ? DRAWER_ROWS : sel ? 4 : 0
  const listH = Math.max(1, height - 2 - below - box)
  const selUrl = sel ? sameUrl(sel.pr.url) : ''
  const at = rows.findIndex(r => sameUrl(r.pr.url) === selUrl)
  const scroll = clampScroll(at < 0 ? 0 : keepInView(s.prs.scroll, at, at, listH), rows.length, listH)
  const lines = [prHeader(s, rows, layout, w), rule(w)]
  for (let y = 0; y < listH; y++) {
    const r = rows[scroll + y]
    if (r) lines.push(prLine(r, sameUrl(r.pr.url) === selUrl, s.prs.marked.has(sameUrl(r.pr.url)), layout))
    else if (y === 0) {
      const say = f.query.trim() ? t('monitors.empty.noMatch', { query: f.query.trim() }) : s.refreshing && !s.hosts.some(h => h.at) ? t('monitors.refreshing') : t('monitors.empty.prs')
      lines.push(render([['   '], [say, ITALIC + SUB]], w, BASE))
    } else lines.push(blank(w))
  }
  if (hidden && f.query.trim()) lines.push(hiddenLine(hidden, w))
  for (const h of down.slice(0, 3)) lines.push(hostLine(h, w))
  if (noHosts) lines.push(render([['   '], [t('monitors.empty.noHosts'), DIM]], w, BASE))
  if (s.drawer) {
    const visible = new Set(rows.slice(scroll, scroll + listH).map(r => sameUrl(r.pr.url)))
    const offScreen = [...s.prs.marked].filter(u => !visible.has(u)).length
    lines.push(...drawerLines(s, s.drawer, targets(s), offScreen, w))
  } else if (sel) lines.push(blank(w), ...infoBox(s, sel, w, now))
  return { lines, scroll }
}

// ------------------------------------------------------------ the frame

export function frame(s: MonitorsState, { cols: w, rows }: Size, now = Date.now()): Frame {
  const f = s.filters[s.view]
  const lines = viewRows(s, w, now)
  if (f.open) {
    const pipes = (query: string): number => pipeItemsOf({ ...s, filters: { ...s.filters, pipes: { ...f, query } } }).filter(i => i.kind === 'pipe').length
    const kept = s.view === 'running' ? runningRows(s).length : s.view === 'pipes' ? pipes(f.query) : prList(s).rows.length
    const total = s.view === 'running' ? allRunning(s).length : s.view === 'pipes' ? pipes('') : kept + prList(s).hidden
    const placeholder = t(s.view === 'running' ? 'monitors.filter.placeholderRunning' : s.view === 'pipes' ? 'monitors.filter.placeholderPipes' : 'monitors.filter.placeholder')
    lines.push(filterRow(f, kept, total, w, placeholder))
  }
  const height = Math.max(2, rows - lines.length - 1)
  const body =
    s.view === 'running'
      ? running(s, w, height, now)
      : { approvals: null, ...(s.view === 'prs' ? prs(s, w, height, now) : s.view === 'pipes' ? pipesBody(s, w, height, now) : { lines: logsBody(s, w, height), scroll: 0 }) }
  lines.push(...body.lines.slice(0, height))
  while (lines.length < rows - 1) lines.push(blank(w))
  lines.push(footer(s, w, body.approvals))
  return { lines: lines.slice(0, rows), title: titleOf(s), scroll: body.scroll, approvals: body.approvals }
}

function titleOf(s: MonitorsState): string[] {
  const n = runningCount(s)
  const approve = groupCounts(allRunning(s)).approve
  if (s.view === 'running') return [t('monitors.title'), t('monitors.running', { n }), ...(approve ? [`▲ ${t('monitors.counts.approve', { n: approve })}`] : [])]
  if (s.view === 'logs') return [t('monitors.title'), t('monitors.logs.title')]
  if (s.view === 'prs') return [t('monitors.title'), t('monitors.views.prs')]
  const waiting = waitingCount(s.pipes.hosts, pipeView(s.pipes))
  return [t('monitors.title'), t('monitors.views.pipes'), ...(waiting ? [t('monitors.pipes.waiting', { n: waiting })] : [])]
}
