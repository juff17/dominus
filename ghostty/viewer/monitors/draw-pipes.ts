// The Pipelines view's body, for draw.ts.

import { t } from '../../core/text.ts'
import { field, frameBottom, frameTop, spanWidth } from '../../tui/controls.ts'
import { clampScroll, keepInView } from '../../tui/list.ts'
import { TINT } from '../../tui/palette.ts'
import { BOLD, ITALIC, P, type Span, ago, bg, clean, fg, render, split } from '../../tui/term.ts'
import { type NowLine, type PipeItem, type PipeMonitor, nowOf, shownGates } from './pipe-rows.ts'
import { selectedItem } from './pipe-state.ts'
import type { Gate, PipeHost, Stage, StageState } from './pipelines.ts'
import { heading } from './heading.ts'
import { lit } from './lit.ts'
import { type MonitorsState, pipeItemsOf } from './state.ts'

const BASE = bg(P.base)
const SEL = bg(P.surface0)
const BOX = bg(P.mantle)
const LITBG = bg(TINT.bad)
const DIM = fg(P.overlay1)
const SUB = fg(P.sub)
const blank = (w: number, fill = BASE): string => render([], w, fill)
const cell = (spans: readonly Span[], w: number, fill: string): string => render(spans, w, fill)
const W = (k: string, vars?: Record<string, string | number>): string => t(`monitors.pipes.${k}`, vars)

// ------------------------------------------------------------ columns

const LEAD = 2
const FORGE = 3
const FIXED = { project: 20, ref: 14, trigger: 9, stages: 12, age: 5, monitor: 12 } as const
type Col = keyof typeof FIXED | 'now'
// Dropped in this order when "now" would get too narrow.
const DROP: readonly Col[] = ['trigger', 'stages', 'monitor']

export function pipeColumns(w: number): { cols: Col[]; now: number } {
  let cols: Col[] = ['project', 'ref', 'trigger', 'stages', 'now', 'age', 'monitor']
  const nowW = (cs: Col[]) => w - LEAD - FORGE - cs.reduce((n, c) => n + (c === 'now' ? 0 : FIXED[c] + 1), 0) - 1
  for (const c of DROP) if (nowW(cols) < 16) cols = cols.filter(x => x !== c)
  return { cols, now: Math.max(8, nowW(cols)) }
}

const STAGE: Record<StageState, [glyph: string, color: string]> = {
  passed: ['✓', P.green],
  failed: ['✗', P.red],
  running: ['◐', P.blue],
  manual: ['⏸', P.peach],
  waiting: ['○', P.overlay1],
  skipped: ['⊘', P.overlay1],
}

// As many glyphs as fit in w, then +N.
export function stageStrip(stages: readonly Stage[], w: number): Span[] {
  const fits = stages.length * 2 - 1 <= w
  const shown = fits ? stages : stages.slice(0, Math.max(0, Math.floor((w - 3) / 2)))
  const out: Span[] = shown.flatMap((st, i): Span[] => [...(i ? [[' '] as Span] : []), [STAGE[st.state][0], fg(STAGE[st.state][1])]])
  if (!fits) out.push([` +${stages.length - shown.length}`, DIM])
  return out
}

const TONE: Record<NowLine['tone'], string> = { peach: P.peach, red: P.red, blue: P.blue, green: P.green, sub: P.sub }

function monitorSpan(m: PipeMonitor): Span {
  if (m.kind === 'watching') return [W('monitor.watching'), fg(P.teal)]
  if (m.kind === 'via') return [W('monitor.via', { ref: m.ref }), fg(P.overlay2)]
  return [W('monitor.none'), fg(P.teal)]
}

function pipeLine(it: Extract<PipeItem, { kind: 'pipe' }>, s: MonitorsState, on: boolean, near: boolean, layout: ReturnType<typeof pipeColumns>, now: number): string {
  const { pipe } = it
  const fill = on || near ? SEL : BASE
  const gates = shownGates(pipe, s.pipes.skipped)
  const nowLine = nowOf(pipe, gates, (k, vars) => W(`now.${k}`, vars))
  const out = [cell([[on || near ? ' ▌' : '  ', fg(on ? P.teal : P.surface2)]], LEAD, fill), cell([[pipe.forge, DIM]], FORGE, fill)]
  for (const c of layout.cols) {
    const spans: Span[] =
      c === 'project'
        ? lit(clean(pipe.project), it.hit.project, (on ? BOLD : '') + fg(P.text))
        : c === 'ref'
          ? lit(clean(pipe.pr ? pipe.prRef : pipe.ref), it.hit.ref, SUB)
          : c === 'trigger'
            ? [[W(`triggers.${pipe.trigger}`), fg(P.overlay2)]]
            : c === 'stages'
              ? stageStrip(pipe.stages, FIXED.stages)
              : c === 'now'
                ? [[clean(nowLine.text), fg(TONE[nowLine.tone])]]
                : c === 'age'
                  ? [[(ago(pipe.at, now) || '0s').padStart(FIXED.age), fg(P.overlay2)]]
                  : [monitorSpan(it.monitor)]
    out.push(cell(spans, c === 'now' ? layout.now : FIXED[c], fill), cell([], 1, fill))
  }
  return out.join('')
}

function header(layout: ReturnType<typeof pipeColumns>, w: number): string {
  const spans: Span[] = [[' '.repeat(LEAD + FORGE)]]
  for (const c of layout.cols) {
    const name = W(`cols.${c}`)
    const width = c === 'now' ? layout.now : FIXED[c]
    spans.push([`${c === 'age' ? name.padStart(width) : name.padEnd(width)} `, DIM])
  }
  return render(spans, w, BASE)
}

// ------------------------------------------------------------ the panel

// Where the panel starts, under the project column.
const INDENT = LEAD + FORGE + 1

export const gateAsk = (g: Gate): string => (g.kind === 'deployment' ? W('approve', { env: g.env }) : W('ask', { job: g.name }))
export const gateDetail = (g: Gate): string =>
  g.kind === 'deployment' ? W('detailEnv', { sha: g.sha.slice(0, 7), env: g.env }) : W('detailJob', { sha: g.sha.slice(0, 7), stage: g.stage })

const ASK_W = 24

function gateContent(g: Gate, lit: boolean, w: number, fill: string): string {
  const yes: Span = [` ${W('run')} `, lit ? BOLD + fg(P.crust) + bg(P.peach) : fg(P.sub) + bg(P.surface0)]
  const no: Span = [` ${W('skip')} `, (lit ? fg(P.text) : fg(P.overlay2)) + bg(P.surface0)]
  const left: Span[] = [
    [' '],
    [clean(gateAsk(g)).padEnd(ASK_W), lit ? BOLD + fg(P.peach) : SUB],
    [' '],
    [clean(gateDetail(g)), lit ? fg(P.text) : fg(P.overlay2)],
  ]
  return split(
    left.map(([x, st]): Span => [x, `${st ?? ''}${fill}`]),
    [yes, [' ', fill], no, [' ', fill]],
    w,
    fill,
  )
}

function gateLines(g: Gate, lit: boolean, w: number): string[] {
  const pad = render([], INDENT, BASE)
  const inner = w - INDENT - 2
  const tail = render([], 2, BASE)
  if (!lit) return [pad + render([[' ', BOX]], 1, BOX) + gateContent(g, false, inner - 2, BOX) + render([[' ', BOX]], 1, BOX) + tail]
  const edge = fg(P.peach) + BOX
  const side = render([['│', fg(P.peach) + LITBG]], 1, LITBG)
  return [
    pad + render([[`╭${'─'.repeat(inner - 2)}╮`, edge]], inner, BOX) + tail,
    pad + side + gateContent(g, true, inner - 2, LITBG) + side + tail,
    pad + render([[`╰${'─'.repeat(inner - 2)}╯`, edge]], inner, BOX) + tail,
  ]
}

// ------------------------------------------------------------ the rest

function hostLine(h: Extract<PipeHost, { ok: false }>, w: number): string {
  const cli = h.forge === 'gh' ? 'gh' : 'glab'
  const why = h.why === 'failed' ? t(h.pipes.length ? 'monitors.hosts.stale' : 'monitors.hosts.failed', { err: clean(h.err).slice(0, 120) }) : t(`monitors.hosts.${h.why}`, { cli })
  return render([['   '], [`${h.forge} ${h.host} · ${why}`, DIM]], w, BASE)
}

export const WATCH_ROWS = 3

function watchBar(s: MonitorsState, w: number): string[] {
  const inner = w - 4
  const edge = (x: string) => render([['│', fg(P.teal)]], 1, BASE) + render([[' ', BOX]], 1, BOX) + x + render([[' ', BOX]], 1, BOX) + render([['│', fg(P.teal)]], 1, BASE)
  const on = s.pipes.fromPrs
  const right: Span[] = [['P', BOLD + fg(P.text) + BOX], [` ${W('fromPrs')} `, SUB + BOX], [t(on ? 'controls.on' : 'controls.off'), fg(on ? P.green : P.overlay1) + BOX]]
  const lead: Span = [`${W('watch')}  `, BOLD + fg(P.teal) + BOX]
  const room = Math.max(4, inner - spanWidth([lead, ...right]) - 3)
  const w8 = s.pipes.watch
  const input = field({ text: w8.text, at: w8.at, w: room, focused: w8.typing, placeholder: W('watchPlaceholder') })
  return [frameTop(w, { color: P.teal, fill: BASE }), edge(split([lead, ...input.map(([x, st]): Span => [x, `${st ?? ''}${BOX}`])], right, inner, BOX)), frameBottom(w, { color: P.teal, fill: BASE })]
}

// item is -1 for a group heading. A lit gate takes three lines.
type Drawn = { line: string; item: number }

export function pipesBody(s: MonitorsState, w: number, height: number, now: number): { lines: string[]; scroll: number } {
  const items = pipeItemsOf(s)
  const query = s.filters.pipes.query.trim()
  const sel = selectedItem(s.pipes, items)
  const layout = pipeColumns(w)
  const down = s.pipes.hosts.filter((h): h is Extract<PipeHost, { ok: false }> => !h.ok)
  const listH = Math.max(1, height - 1 - Math.min(3, down.length) - WATCH_ROWS)
  const near = sel?.kind === 'gate' ? sel.pipeKey : ''
  const drawn: Drawn[] = []
  items.forEach((it, i) => {
    if (it.kind === 'group') {
      // A blank line between groups.
      if (drawn.length) drawn.push({ line: blank(w), item: -1 })
      drawn.push({ line: heading([[`${W(`groups.${it.group}`)} `, BOLD + fg(P.text)], [String(it.n), fg(P.overlay2)]], w), item: -1 })
    } else if (it.kind === 'pipe') {
      drawn.push({ line: pipeLine(it, s, sel?.key === it.key, near === it.key, layout, now), item: i })
    } else for (const line of gateLines(it.gate, sel?.key === it.key, w)) drawn.push({ line, item: i })
  })
  const selAt = sel ? items.indexOf(sel) : -1
  const first = drawn.findIndex(d => d.item === selAt)
  const last = drawn.findLastIndex(d => d.item === selAt)
  // A pipeline's heading stays in view with its first row.
  const top = first > 0 && drawn[first - 1].item === -1 ? first - 1 : first
  const scroll = clampScroll(first < 0 ? 0 : keepInView(s.pipes.scroll, top, last, listH), drawn.length, listH)
  const lines = [header(layout, w)]
  for (let y = 0; y < listH; y++) {
    const d = drawn[scroll + y]
    if (d) lines.push(d.line)
    else if (y === 0 && !drawn.length) {
      const say = query ? t('monitors.empty.noMatch', { query }) : s.pipes.refreshing && !s.pipes.hosts.some(h => h.at) ? t('monitors.refreshing') : W('empty')
      lines.push(render([['   '], [say, ITALIC + SUB]], w, BASE))
    } else lines.push(blank(w))
  }
  for (const h of down.slice(0, 3)) lines.push(hostLine(h, w))
  lines.push(...watchBar(s, w))
  return { lines, scroll }
}
