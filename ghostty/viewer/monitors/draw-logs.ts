// The Logs view's form, for draw.ts.

import { tilde } from '../../core/paths.ts'
import { t } from '../../core/text.ts'
import { button, radio, select } from '../../tui/controls.ts'
import { CARET_MARK, caretShown, withCaret } from '../../tui/line.ts'
import { BOLD, P, type Span, bg, fg, render, wrap } from '../../tui/term.ts'
import { type LogsField, type LogsState, envOpen, envsOf, isProtected, sourcesFor } from './logs-state.ts'
import { REMOTES, type Source } from './sources.ts'

const BASE = bg(P.base)
const BOX = bg(P.mantle)
const DIM = fg(P.overlay1)
const blank = (w: number): string => render([], w, BASE)
const L = (k: string, vars?: Record<string, string | number>): string => t(`monitors.logs.${k}`, vars)

const MARGIN = 4
const LABEL = 16
export const TASK_ROWS = 3

function label(l: LogsState, f: LogsField): Span[] {
  const on = l.field === f
  return [[' '.repeat(MARGIN)], [`${on ? '▸ ' : '  '}${L(`fields.${f}`)}`.padEnd(LABEL), on ? BOLD + fg(P.teal) : fg(P.overlay2)]]
}

function chip(name: string, picked: boolean, focused: boolean, red: boolean, open: boolean): Span {
  if (picked) return [` ${name} `, BOLD + (focused ? fg(P.crust) + bg(P.teal) : fg(P.text) + bg(P.surface1))]
  if (!open) return [` ${name} `, fg(P.surface2) + bg(P.mantle)]
  return [` ${name} `, fg(red ? P.red : P.sub) + bg(P.surface0)]
}

const envChips = (l: LogsState): Span[] =>
  envsOf(l).flatMap((e, i): Span[] => [...(i ? [[' '] as Span] : []), chip(e, e === l.env, l.field === 'env', isProtected(l, e), envOpen(l, e))])

const SOURCES: readonly Source[] = ['docker', ...REMOTES]

// Why the grayed-out sources are, one dim line; '' when nothing is.
function sourceNote(l: LogsState): string {
  const b = l.blocked
  if (!b) return L('sources.checking')
  if (b.kubernetes && b.elastic) return L('sources.onlyLocal', { kube: L(`sources.why.${b.kubernetes}`), elastic: L(`sources.why.${b.elastic}`) })
  return REMOTES.flatMap(r => (b[r] ? [L(`sources.why.${b[r]}`)] : [])).join(' · ')
}

// Scrolls to keep the caret's line in the box.
function taskBox(l: LogsState, w: number): string[] {
  const focused = l.field === 'task'
  const text = focused ? withCaret(l.task, l.at) : l.task
  const shown = text || !focused ? text : CARET_MARK
  const wrapped = shown ? shown.split('\n').flatMap(line => (line ? wrap([[line, fg(P.text)]], w - 2).map(x => x.map(([s]) => s).join('')) : [''])) : []
  const caretRow = wrapped.findIndex(x => x.includes(CARET_MARK))
  const from = Math.max(0, Math.min(Math.max(0, wrapped.length - TASK_ROWS), caretRow < 0 ? 0 : caretRow - TASK_ROWS + 1))
  const rows = wrapped.slice(from, from + TASK_ROWS)
  const out: string[] = []
  for (let i = 0; i < TASK_ROWS; i++) {
    const line = rows[i]
    if (line === undefined) {
      out.push(render(i === 0 && !l.task && !focused ? [[` ${L('placeholder')}`, DIM]] : [], w, BOX))
      continue
    }
    const drawn = render([[` ${line}`, fg(P.text)]], w, BOX)
    out.push(focused ? caretShown(drawn) : drawn)
  }
  return out
}

export function logsBody(s: { logs: LogsState }, w: number, height: number): string[] {
  const l = s.logs
  const lines: string[] = [blank(w)]
  const pad = (spans: Span[]): string => render(spans, w, BASE)
  const right = w - MARGIN - LABEL - MARGIN
  lines.push(pad([...label(l, 'env'), ...envChips(l)]))
  lines.push(blank(w))
  const can = sourcesFor(l, l.env)
  const options = SOURCES.map(src => ({ label: L(`sources.${src}`), off: !can.includes(src) }))
  lines.push(pad([...label(l, 'source'), ...radio(options, SOURCES.indexOf(l.source), { color: l.field === 'source' ? P.teal : P.overlay2 })]))
  const note = sourceNote(l)
  if (note) lines.push(pad([[' '.repeat(MARGIN + LABEL)], [note, DIM]]))
  lines.push(blank(w))
  const box = taskBox(l, right)
  box.forEach((b, i) => lines.push(render(i === 0 ? label(l, 'task') : [[' '.repeat(MARGIN + LABEL)]], MARGIN + LABEL, BASE) + b + blank(MARGIN)))
  lines.push(blank(w))
  const levels: Record<string, string> = { warn: L('levels.warn'), error: L('levels.error'), info: L('levels.info') }
  const value: Record<'level' | 'for' | 'model' | 'effort', string> = { level: levels[l.level] ?? l.level, for: l.for, model: l.model, effort: l.effort }
  for (const f of ['level', 'for', 'model', 'effort'] as const) lines.push(pad([...label(l, f), ...select(value[f], l.field === f)]))
  lines.push(blank(w))
  const info = L('info', { env: l.env, source: L(`sources.${l.source}`), folder: tilde(l.folder || '~') })
  lines.push(pad([[' '.repeat(MARGIN + LABEL)], ...button(L('start'), { key: ' ctrl+s', main: true, color: P.teal }), ['   '], [info, fg(P.overlay2)]]))
  while (lines.length < height) lines.push(blank(w))
  return lines.slice(0, height)
}
