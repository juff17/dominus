// dv's screen. It reads nothing but the state, Settings and whether the
// diagram's PNG is there, which the caller says. The picture's kitty ids in
// s.pic move on as it sends commands, since what it sends depends on what
// the terminal has already.

import { t } from '../../core/text.ts'
import type { Box } from '../../tui/backdrop.ts'
import type { Hint } from '../../tui/chrome.ts'
import { closeLabel, compose } from '../../tui/overlay.ts'
import { ACCENT, BOLD, CAP_L, CAP_R, ITALIC, P, type Span, bg, clean, fg, pill, render, spanWidth, split, width } from '../../tui/term.ts'
import { type View, clampView, fitChips, home, placement } from '../view.ts'
import { type Diagram, dropPicture, fitHints, hints, placeIn, showFile, truncate } from './diagram.ts'
import { gridRow } from './kitty.ts'
import { type ChipHit, type DiagramState, type Size, box, diagram, inner, region } from './state.ts'

const PANEL = bg(P.mantle)

export type Frame = { lines: string[]; setup: string; chips: ChipHit[]; view: View | undefined }

function header(s: DiagramState, cols: number): string {
  const { pane, modes } = s.config
  const line = modes.map((m, i) => (i === pane.at ? `\x1b[7;1m${m.label}\x1b[0m` : `\x1b[2m${m.label}\x1b[0m`)).join(' ')
  if (!pane.next) return line
  const what = ` ${t('hints.switch')}`
  return `${line}\x1b[${cols - width(`tab${what}`) + 1}G\x1b[34mtab\x1b[0;2m${what}\x1b[0m`
}

function chip(d: Diagram, i: number, index: number): { spans: Span[]; cells: number } {
  const on = i === index
  const color = on ? ACCENT : P.surface0
  const dim = fg(on ? P.surface0 : P.overlay1) + bg(color)
  const spans: Span[] = [
    [CAP_L, fg(color)],
    [i < 9 ? `${i + 1} ` : '', dim],
    [`${truncate(clean(d.title))} `, (on ? BOLD + fg(P.crust) : fg(P.text)) + bg(color)],
    ['×', dim],
    [CAP_R, fg(color)],
    [' ', ''],
  ]
  return { spans, cells: spanWidth(spans) }
}

function chipRow(s: DiagramState, b: Box, w: number): { line: string; chips: ChipHit[] } {
  const { diagrams } = s.list
  const n = diagrams.length
  if (!n) return { line: render([], w), chips: [] }
  const position = `${s.index + 1}/${n}`
  const all = diagrams.map((d, i) => chip(d, i, s.index))
  // Room for the position and a "+N" either side.
  const room = w - width(position) - 2 * 4
  const { start, end } = fitChips(
    all.map(c => c.cells),
    s.index,
    room,
  )
  const left: Span[] = []
  const chips: ChipHit[] = []
  const hidden = `‹${start} `
  if (start) left.push([hidden, fg(P.overlay1)])
  let col = b.left + s.config.edge + 1 + (start ? width(hidden) : 0)
  for (let i = start; i < end; i++) {
    const c = all[i]
    chips.push({ i, from: col, close: col + c.cells - 3, to: col + c.cells - 2 })
    left.push(...c.spans)
    col += c.cells
  }
  if (end < n) left.push([`+${n - end}`, fg(P.overlay1)])
  return { line: split(left, [[position, fg(P.sub)]], w), chips }
}

function footer(s: DiagramState, view: View | undefined, w: number): string {
  const K = (k: string) => t(`diagrams.keys.${k}`)
  const keys: Hint[] = s.config.frame
    ? [['[ ]', K('prevNext')], ['1–9', K('jump')], ['scroll', K('zoom')], ['drag', K('pan')], ['0', K('fit')], ['x', K('closeDiagram')], ['esc', t('hints.close')]]
    : [['[ ]', K('diagrams')], ['scroll', K('zoom')], ['drag', K('pan')], ['x', K('closeDiagram')], ['q', t('hints.quit')]]
  const d = diagram(s)
  const right: Span[] = d
    ? [[`${d.width}×${d.height} `, fg(P.overlay1)], ...pill(view && view.zoom > 1 ? ` ${view.zoom.toFixed(1)}× ` : ` ${t('diagrams.fit')} `, P.surface0, P.base, fg(P.text))]
    : []
  if (s.note) return split([[` ${s.note}`, fg(P.red)]], right, w)
  return split(hints(fitHints(keys, w - spanWidth(right) - 2)), right, w)
}

function panelMessage(lines: readonly Span[], rows: number, w: number): string[] {
  const out: string[] = Array(rows).fill(render([], w, PANEL))
  const from = Math.max(0, Math.floor((rows - lines.length) / 2))
  lines.forEach(([text, style], k) => {
    if (from + k >= rows) return
    const pad = Math.max(0, Math.floor((w - width(text)) / 2))
    out[from + k] = render([[' '.repeat(pad)], [text, style]], w, PANEL)
  })
  return out
}

function noPicture(s: DiagramState): Span[] {
  if (diagram(s)) return [[t('diagrams.pngGone'), ITALIC + fg(P.sub)]]
  if (s.gone) return [[t('diagrams.tabGone'), ITALIC + fg(P.sub)]]
  return [
    [s.tabTitle ? t('diagrams.noneYetIn', { tab: s.tabTitle }) : t('diagrams.noneYet'), ITALIC + fg(P.sub)],
    [t('diagrams.askClaude'), fg(P.overlay1)],
  ]
}

type PictureRows = { rows: string[]; setup: string; view: View | undefined }

function pictureRows(s: DiagramState, size: Size, pngThere: boolean): PictureRows {
  const r = region(s, size)
  const d = diagram(s)
  if (!d || !pngThere) return { rows: panelMessage(noPicture(s), r.rows, r.cols), setup: dropPicture(s.pic), view: s.view }
  let setup = showFile(s.pic, d.file)
  const view = clampView(d, r, s.view ?? home(d))
  const at = placement(d, r, view)
  setup += placeIn(s.pic, at.gridCols, at.gridRows)
  // The panel's color stays on under the placeholders, so it shows through
  // the PNG's transparent background.
  const rows: string[] = Array(r.rows).fill(render([], r.cols, PANEL))
  // Columns count from the frame's inside (tui/overlay.ts compose), as they
  // do from the pane's left in the viewer pane.
  for (let k = 0; k < at.rows; k++) {
    const cells = gridRow(s.pic.shownId, s.pic.placedId, at.gridRow + k, at.gridCol, at.cols)
    rows[at.row + k] = `${PANEL}${' '.repeat(r.cols)}\x1b[${at.col + 1}G${PANEL}${cells}\x1b[0m`
  }
  return { rows, setup, view }
}

// Every row overwrites itself instead of the screen being cleared first, so
// the terminal never shows a half-drawn frame while zooming or panning.
export function frame(s: DiagramState, size: Size, pngThere: boolean): Frame {
  const w = inner(s, size)
  const b = box(s, size)
  const picture = pictureRows(s, size, pngThere)
  const chips = chipRow(s, b, w)
  const body = [...(s.config.header ? [header(s, size.cols)] : []), chips.line, ...picture.rows, footer(s, picture.view, w)]
  const title = [t('diagrams.title'), s.tabTitle]
  const lines = s.config.frame ? compose(s.backdrop, size, b, { title, close: closeLabel('keys.diagrams') }, body) : body
  return { lines, setup: picture.setup, chips: chips.chips, view: picture.view }
}
