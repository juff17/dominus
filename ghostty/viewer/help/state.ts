// Alt+H's overlay state and what keys and clicks do to it, apart from the
// terminal so it can be tested; draw.ts draws it.

import { t } from '../../core/text.ts'
import type { Hint } from '../../tui/chrome.ts'
import { type Mouse, leftPress } from '../../tui/input.ts'
import { editField, oneLine, pasteField } from '../../tui/line.ts'
import { width } from '../../tui/term.ts'
import { type HelpSection, SECTIONS, filter, startAt } from './help.ts'

// at is the filter's caret (tui/line.ts; none is the end). Drawing sets
// maxScroll from the body's length.
export type HelpState = { sel: number; query: string; at?: number; typing: boolean; scroll: number; maxScroll: number }

export const NAV = 24
// Gap, filter, gap above the body; footer below it. The title is in the
// frame's edge.
export const TOP = 3
export const BOTTOM = 1
// The filter's row, counted from 1.
export const FILTER_ROW = 2

export const start = (place?: string): HelpState => ({ sel: startAt(place), query: '', typing: false, scroll: 0, maxScroll: 0 })

export const filtering = (s: Pick<HelpState, 'query'>): boolean => s.query.trim() !== ''

export const shown = (s: Pick<HelpState, 'query' | 'sel'>): HelpSection[] => (filtering(s) ? filter(s.query) : [SECTIONS[s.sel]])

export const keyWidth = (groups: readonly { keys: readonly { key: string }[] }[]): number => Math.min(22, Math.max(12, ...groups.flatMap(g => g.keys.map(k => width(k.key)))) + 3)

export function fitScroll(s: Pick<HelpState, 'scroll' | 'maxScroll'>, lines: number, rows: number): void {
  s.maxScroll = Math.max(0, lines - rows)
  s.scroll = Math.min(s.scroll, s.maxScroll)
}

export function pick(s: HelpState, i: number): void {
  s.sel = Math.max(0, Math.min(SECTIONS.length - 1, i))
  s.query = ''
  delete s.at
  s.typing = false
  s.scroll = 0
}

export const scrollBy = (s: HelpState, n: number): void => {
  s.scroll = Math.max(0, Math.min(s.maxScroll, s.scroll + n))
}

// Changing the filter scrolls back to the top; moving the caret doesn't.
export function onTyping(s: HelpState, key: string) {
  if (key === '\x1b') {
    s.query = ''
    delete s.at
    s.typing = false
  } else if (key === '\r') s.typing = false
  else if (key === '\x1b[A') return scrollBy(s, -1)
  else if (key === '\x1b[B') return scrollBy(s, 1)
  else if (editField(s, 'query', key) !== 'text') return
  s.scroll = 0
}

// True when the key closes the overlay. Its own key and Ctrl+C close it
// before they get here (tui/overlay.ts).
export function onKey(s: HelpState, key: string, page: number): boolean {
  if (s.typing) {
    onTyping(s, key)
    return false
  }
  const on = filtering(s)
  const move = (n: number) => (on ? scrollBy(s, n) : pick(s, s.sel + n))
  const actions: Record<string, () => unknown> = {
    q: () => true,
    '\x1b': () => (on ? pick(s, s.sel) : true),
    '/': () => {
      s.typing = true
      delete s.at
    },
    j: () => move(1),
    k: () => move(-1),
    '\x1b[B': () => move(1),
    '\x1b[A': () => move(-1),
    '\t': () => pick(s, (s.sel + 1) % SECTIONS.length),
    '\x1b[Z': () => pick(s, (s.sel + SECTIONS.length - 1) % SECTIONS.length),
    g: () => (on ? scrollBy(s, -Infinity) : pick(s, 0)),
    G: () => (on ? scrollBy(s, Infinity) : pick(s, SECTIONS.length - 1)),
    J: () => scrollBy(s, 1),
    K: () => scrollBy(s, -1),
    '\x04': () => scrollBy(s, page),
    '\x15': () => scrollBy(s, -page),
    '\x1b[6~': () => scrollBy(s, page),
    '\x1b[5~': () => scrollBy(s, -page),
  }
  return Object.hasOwn(actions, key) ? actions[key]() === true : false
}

// `body` is how many rows the body was drawn with (draw.ts bodyRows): a short
// popup draws fewer sections than there are, and the footer under them isn't one.
export function onMouse(s: HelpState, m: Mouse, body: number) {
  const { button, x, y, up } = m
  if (up) return
  if (button === 64) return scrollBy(s, -3)
  if (button === 65) return scrollBy(s, 3)
  if (!leftPress(m)) return
  const i = y - TOP - 1
  if (x < NAV && i >= 0 && i < Math.min(SECTIONS.length, body)) pick(s, i)
  else if (y === FILTER_ROW) {
    s.typing = true
    delete s.at
  }
}

export const onPaste = (s: HelpState, text: string): void => {
  if (!s.typing) return
  pasteField(s, 'query', oneLine(text))
}

export const footerHints = (s: Pick<HelpState, 'typing' | 'query'>): Hint[] =>
  s.typing
    ? [['↵', t('help.hints.keep')], ['esc', t('hints.clear')], ['↑ ↓', t('hints.scroll')]]
    : [
        ['j k', filtering(s) ? t('hints.scroll') : t('help.hints.section')],
        ['/', t('hints.filter')],
        ['esc', filtering(s) ? t('hints.clear') : t('hints.close')],
      ]
