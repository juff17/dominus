// Alt+M's Running view: a row per monitor, grouped by what it watches, with
// its session's waiting proposals beside it.

import { pipelineResult } from '../../agents/transcript.ts'
import { t } from '../../core/text.ts'
import { load as settings } from '../../settings/settings.ts'
import { spanWidth } from '../../tui/controls.ts'
import { clampScroll, keepInView } from '../../tui/list.ts'
import { MONITOR } from '../../tui/palette.ts'
import { BOLD, ITALIC, type Line, P, type Span, ago, clean, fg, render, split } from '../../tui/term.ts'
import { glyphOf } from '../../tray/approvals.ts'
import { type Drawn, dots, panel as drawPanel } from '../approvals/draw.ts'
import { WATCH_KEYS } from './attach.ts'
import { heading } from './heading.ts'
import { lit } from './lit.ts'
import { RUN_GROUPS, type RunGroup, type RunRow, sameUrl } from './rows.ts'
import {
  type MonitorsState,
  type Panel,
  allRunning,
  panelRow,
  runningRows,
  selectedRun,
} from './state.ts'
import { BASE, BOX, DIM, SEL, SUB, blank, cell, hiddenLine } from './look.ts'

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

export function running(s: MonitorsState, w: number, height: number, now: number): { lines: string[]; scroll: number; approvals: Drawn | null } {
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
