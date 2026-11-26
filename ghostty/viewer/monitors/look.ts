// The fills and colours every part of the popup draws with.

import { t } from '../../core/text.ts'
import { type Line, P, bg, fg, render } from '../../tui/term.ts'

export const BASE = bg(P.base)
export const SEL = bg(P.surface0)
export const BOX = bg(P.mantle)
export const DIM = fg(P.overlay1)
export const SUB = fg(P.sub)
export const blank = (w: number, fill = BASE): string => render([], w, fill)

export const TONE = { green: P.green, red: P.red, peach: P.peach, sub: P.sub }

export const cell = (spans: Line, w: number, fill: string): string => render(spans, w, fill)

// The line under a filtered list saying how many it hides.
export const hiddenLine = (n: number, w: number): string => render([['   '], [t('monitors.filter.hidden', { n }), DIM]], w, BASE)
