// The rail's frame and its buttons, apart from the terminal, so where each
// button sits and what a click reaches can be tested (rail.test.ts).

import type { Lane } from '../../agents/model.ts'
import { t } from '../../core/text.ts'
import { type Mouse, leftPress } from '../../tui/input.ts'
import { ACCENT, BOLD, P, type Span, bg, fg, render } from '../../tui/term.ts'

const BG = bg(P.crust)

export type RailView = 'work' | 'hub'
export type RailButton = 'work' | 'hub' | 'newAgent' | 'help' | 'settings'
// Any value, for tests.
export type RailActs<A> = Record<RailButton, A>
// Rows counted from 1.
export type Pressable<A> = { y1: number; y2: number; act: A }

function button(icon: string, label: string, on: boolean, w: number, dot = false) {
  const fill = on ? bg(P.surface0) : BG
  const color = fg(on ? ACCENT : P.sub)
  const mark: Span[] = dot ? [[' ●', fg(P.peach)]] : []
  return [
    render([[` ${icon}`, color], ...mark], w, fill),
    render([[` ${label}`, color]], w, fill),
  ]
}

// Work and hub at the top, the counts `c` under them, and + new, ? help and
// ⚙ set kept to the bottom.
export function frame<A>(w: number, h: number, view: RailView, c: Record<Lane, number>, acts: RailActs<A>): { lines: string[]; buttons: Pressable<A>[] } {
  const lines = [render([], w, BG)]
  const buttons: Pressable<A>[] = []
  const add = (act: A, ls: string[]) => {
    buttons.push({ y1: lines.length + 1, y2: lines.length + ls.length, act })
    lines.push(...ls, render([], w, BG))
  }
  add(acts.work, button('▣', t('rail.work'), view === 'work', w))
  add(acts.hub, button('◫', t('rail.hub'), view === 'hub', w, c.needs > 0))
  lines.push(render([[` ${'─'.repeat(Math.max(1, w - 2))}`, fg(P.surface1)]], w, BG))
  const count = (glyph: string, n: number, color: string, bold = false) => render([[` ${glyph} ${n}`, (bold ? BOLD : '') + fg(color)]], w, BG)
  lines.push(count('▲', c.needs, c.needs ? P.peach : P.overlay1, c.needs > 0))
  lines.push(count('✻', c.working, P.blue))
  lines.push(count('✓', c.done, P.green))
  lines.push(count('○', c.idle, P.sub))
  const tail = (icon: string, label: string) => [render([[` ${icon}`, fg(P.sub)]], w, BG), render([[` ${label}`, fg(P.sub)]], w, BG)]
  const bottom: [A, string[]][] = [
    [acts.newAgent, tail('+', t('rail.new'))],
    [acts.help, tail('?', t('rail.help'))],
    [acts.settings, tail('⚙', t('rail.settings'))],
  ]
  // A rail too short for them all drops ⚙ set, then ? help, then + new,
  // rather than drawing them past its bottom edge.
  const height = () => bottom.reduce((n, [, ls]) => n + ls.length + 1, 0)
  while (bottom.length && lines.length + height() > h) bottom.pop()
  while (lines.length < h - height()) lines.push(render([], w, BG))
  for (const [act, ls] of bottom) {
    buttons.push({ y1: lines.length + 1, y2: lines.length + ls.length, act })
    lines.push(...ls, render([], w, BG))
  }
  // Only buttons drawn whole can be clicked: on a very short rail the top
  // buttons can be cut off too.
  return { lines: lines.slice(0, h), buttons: buttons.filter(b => b.y2 <= h) }
}

// The column doesn't matter, the rail being one button wide.
export function pressed<A>(buttons: Pressable<A>[], mouse: Mouse): Pressable<A> | null {
  if (!leftPress(mouse)) return null
  return buttons.find(b => mouse.y >= b.y1 && mouse.y <= b.y2) ?? null
}
