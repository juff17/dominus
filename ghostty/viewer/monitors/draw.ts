// Draws the Monitors popup. It reads Settings' hub.endedFor and nothing
// else, so a test can draw any state. Pipelines' body is in draw-pipes.ts,
// Logs' in draw-logs.ts.

import { t } from '../../core/text.ts'
import { type Hint, hintSpansAfter } from '../../tui/chrome.ts'
import { confirm, field, pressAgain, spanWidth } from '../../tui/controls.ts'
import type { Size } from '../../tui/overlay.ts'
import { MONITOR } from '../../tui/palette.ts'
import { ACCENT, BOLD, P, type Span, ago, bg, clean, fg, render, split } from '../../tui/term.ts'
import { current } from '../approvals/approvals.ts'
import { type Drawn, keysFor } from '../approvals/draw.ts'
import { logsBody } from './draw-logs.ts'
import { pipesBody } from './draw-pipes.ts'
import { hiddenCount, pipeGroups, waitingCount } from './pipe-rows.ts'
import { pipeView } from './pipe-state.ts'
import { groupCounts } from './rows.ts'
import { CTRL_S } from '../../tui/input.ts'
import {
  type Filter,
  type MonitorsState,
  type Note,
  type Panel,
  STOP_KEY,
  VIEWS,
  type View,
  allRunning,
  pipeItemsOf,
  prList,
  runningRows,
} from './state.ts'
import { BASE, BOX, DIM, SUB, TONE, blank } from './look.ts'
import { running } from './draw-running.ts'
import { prs } from './draw-prs.ts'

export type { Size }
// scroll and approvals are what drawing decided, which the entry keeps.
export type Frame = { lines: string[]; title: string[]; scroll: number; approvals: Drawn | null }

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
