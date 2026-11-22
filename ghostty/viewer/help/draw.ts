// frame() reads nothing but the state and the size, so a test can draw any
// state.

import { t } from '../../core/text.ts'
import { hintSpansAfter } from '../../tui/chrome.ts'
import { field } from '../../tui/controls.ts'
import type { Size } from '../../tui/overlay.ts'
import { BOLD, P, type Span, bg, fg, render, split, width } from '../../tui/term.ts'
import { type HelpSection, SECTIONS } from './help.ts'
import { BOTTOM, type HelpState, NAV, TOP, filtering, fitScroll, footerHints, keyWidth, shown } from './state.ts'

export type { Size }
// scroll and maxScroll are what the lines were drawn at; the entry keeps them.
export type Frame = { lines: string[]; title: string[]; scroll: number; maxScroll: number }

const BASE = bg(P.base)

export const bodyRows = (rows: number): number => Math.max(1, rows - TOP - BOTTOM)

function content(groups: HelpSection[], query: string, w: number): string[] {
  const keyW = keyWidth(groups)
  const lines: Span[][] = []
  for (const g of groups) {
    if (lines.length) lines.push([])
    lines.push([
      [g.name, BOLD + fg(g.color)],
      [`  ${g.where}`, fg(P.overlay1)],
    ])
    for (const k of g.keys) {
      lines.push([
        [k.key.padEnd(keyW - (width(k.key) - k.key.length)), BOLD + fg(k.rare ? P.peach : P.text)],
        [k.what, fg(P.text)],
      ])
    }
  }
  if (!groups.length) lines.push([[t('help.noMatch', { query: query.trim() }), `\x1b[3m${fg(P.sub)}`]])
  return lines.map(spans => render(spans, w, BASE))
}

function navRow(s: HelpState, i: number, counts: Map<string, number>): string {
  const section = SECTIONS[i]
  const filtered = filtering(s)
  const n = filtered ? (counts.get(section.id) ?? 0) : section.keys.length
  const on = !filtered && i === s.sel
  const dim = filtered && !n
  const fill = on ? bg(P.surface0) : BASE
  const label = fg(dim ? P.surface1 : on ? P.text : P.sub) + (on ? BOLD : '')
  return split(
    [
      [' ● ', fg(dim ? P.surface1 : section.color)],
      [section.name, label],
    ],
    [[`${n} `, fg(P.overlay1)]],
    NAV - 1,
    fill,
  )
}

function footer(s: HelpState, groups: HelpSection[], w: number): string {
  const total = groups.reduce((n, g) => n + g.keys.length, 0)
  return split(
    [[' '], ...hintSpansAfter(footerHints(s)), [t('help.rare'), BOLD + fg(P.peach)], [` ${t('help.easyToForget')}`, fg(P.sub)]],
    [[`${filtering(s) ? t('help.keyCount', { n: total }) : `${s.sel + 1} / ${SECTIONS.length}`} `, fg(P.sub)]],
    w,
    BASE,
  )
}

export function frame(s: HelpState, { cols: w, rows }: Size): Frame {
  const groups = shown(s)
  const counts = new Map(groups.map(g => [g.id, g.keys.length]))
  const right = w - NAV - 2
  const height = bodyRows(rows)
  const body = content(groups, s.query, right)
  const at = { scroll: s.scroll, maxScroll: s.maxScroll }
  fitScroll(at, body.length, height)

  const title = filtering(s) ? t('help.matching', { query: s.query.trim() }) : SECTIONS[s.sel].name
  const lines = [
    render([], w, BASE),
    render([[' / ', BOLD + fg(P.blue)], ...field({ text: s.query, at: s.at, w: w - 4, focused: s.typing, placeholder: t('help.filterPlaceholder') })], w, BASE),
    render([], w, BASE),
  ]
  for (let y = 0; y < height; y++) {
    const nav = y < SECTIONS.length ? navRow(s, y, counts) : render([], NAV - 1, BASE)
    const more = y === height - 1 && at.scroll < at.maxScroll
    const line = more ? render([[t('help.more'), fg(P.overlay1)]], right, BASE) : (body[at.scroll + y] ?? render([], right, BASE))
    lines.push(`${nav}${render([['│', fg(P.surface0)]], 1, BASE)}${BASE}  ${line}`)
  }
  lines.push(footer(s, groups, w))
  return { lines: lines.slice(0, rows), title: [t('help.title'), title], ...at }
}
