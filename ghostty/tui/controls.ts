// The controls every screen draws with. These only draw: the keys are left
// to the screen. Screens that build their lines as strings (Todo, Diff) turn
// the spans into one with ansi().

import { t } from '../core/text.ts'
import { type Hint, hintSpans } from './chrome.ts'
import { caretParts, head as fitHead, length } from './line.ts'
import { ACCENT, ACCENT_INK, BOLD, CAP_L, CAP_R, ITALIC, type Line, P, RESET, type Span, bg, clean, fg, render, spanWidth, split, width } from './term.ts'

// Screens take it from here with the controls.
export { spanWidth }

// An option that's off is grayed out: shown, but it can't be picked.
export type RadioOption = { label: string; color?: string; key?: string | number; off?: boolean }
export type RadioOptions = { color?: string }
export type CheckOption<V> = { value: V; label: string }
export type FieldOptions = {
  text?: string
  // In code points; undefined is the end.
  at?: number
  w: number
  focused?: boolean
  ghost?: string
  placeholder?: string
}
export type ChipsOptions = { lead?: Line; empty?: string }
// `round` gives it rounded ends, for a button on the screen's own background
// rather than inside a frame.
export type ButtonOptions = { key?: string; main?: boolean; focused?: boolean; color?: string; round?: boolean }
export type ButtonSpec = ButtonOptions & { label: string }
// Parts are joined with ·, the empty ones left out.
export type HeaderTitle = string | readonly (string | null | undefined | false)[]
export type HeaderOptions = { close?: string; right?: Line; fill?: string }
export type FrameStyle = { color?: string; fill?: string }
export type FrameTopOptions = FrameStyle & { title?: string; close?: string }
export type FrameRowOptions = FrameStyle & { inner?: string }

const REVERSE = '\x1b[7m'

export const ansi = (spans: Line): string => spans.map(([s, style = '']) => (style ? `${style}${s}${RESET}` : s)).join('')

export const fieldLabel = (name: string, focused: boolean, w: number, accent = ACCENT): Span[] => [[name.padEnd(w), fg(focused ? accent : P.sub)]]

export function radio(options: readonly RadioOption[], at: number, { color = ACCENT }: RadioOptions = {}): Span[] {
  return options.flatMap((o, i): Span[] => [
    ...(o.key !== undefined ? [[`${o.key} `, fg(ACCENT)] as const] : []),
    [`${i === at ? '●' : '○'} `, fg(o.off ? P.surface2 : (o.color ?? color))],
    [o.label, i === at ? BOLD + fg(P.text) : fg(o.off ? P.surface2 : P.sub)],
    ...(i < options.length - 1 ? [['   ', ''] as const] : []),
  ])
}

export function select(value: string, focused = false): Span[] {
  const arrows = fg(focused ? ACCENT : P.overlay0)
  return [['‹ ', arrows], [value, focused ? BOLD + fg(P.text) : fg(P.text)], [' ›', arrows]]
}

export const onOff = (on: boolean): Span[] => [[on ? `● ${t('controls.on')}` : `○ ${t('controls.off')}`, fg(on ? P.green : P.sub)]]

export const checks = <V>(options: readonly CheckOption<V>[], values: readonly V[], at = -1): Span[] =>
  options.flatMap((o, i): Span[] => {
    const on = values.includes(o.value)
    return [[`${on ? '■' : '□'} ${o.label}`, i === at ? BOLD + fg(ACCENT) : fg(on ? P.text : P.sub)], ...(i < options.length - 1 ? [[' ', ''] as const] : [])]
  })

// `ghost` is the rest of a suggestion, drawn dim after the text with the
// caret on its first character, as fish does.
export function field({ text = '', at, w, focused = true, ghost = '', placeholder = '' }: FieldOptions): Span[] {
  const shown = clean(text)
  if (!focused) return shown ? [[fitHead(shown, w), fg(P.text)]] : placeholder ? [[fitHead(placeholder, w), fg(P.overlay1)]] : []
  if (!shown && placeholder) return [[' ', REVERSE], [fitHead(placeholder, Math.max(0, w - 1)), fg(P.overlay1)]]
  const { before, under, after } = caretParts(shown, at, w)
  if (ghost && (at ?? length(shown)) === length(shown)) {
    const [first, ...rest] = ghost
    return [
      [before, fg(P.text)],
      [first, REVERSE + fg(P.overlay1)],
      [fitHead(rest.join(''), Math.max(0, w - width(before) - 1)), fg(P.overlay1)],
    ]
  }
  return [
    [before, fg(P.text)],
    [under, REVERSE],
    [after, fg(P.text)],
  ]
}

// Starts late enough that the one at `at` fits, with … for those before and
// "+n more" for those after.
export function chips(names: readonly string[], at: number, w: number, { lead = [], empty = '' }: ChipsOptions = {}): Span[] {
  if (!names.length) return [...lead, [empty, ITALIC + fg(P.overlay1)]]
  const room = w - spanWidth(lead)
  const MORE = 8
  const cost = (a: number, b: number): number => names.slice(a, b + 1).reduce((n, x) => n + width(x) + 3, a > 0 ? 2 : 0)
  let from = 0
  while (at > from && cost(from, at) + MORE > room) from++
  const spans: Span[] = [...lead, ...(from > 0 ? [['… ', fg(P.overlay1)] as const] : [])]
  let used = from > 0 ? 2 : 0
  let i = from
  for (; i < names.length; i++) {
    const c = width(names[i]) + 3
    if (used + c + (i < names.length - 1 ? MORE : 0) > room) break
    spans.push([` ${names[i]} `, i === at ? fg(ACCENT_INK) + bg(ACCENT) : fg(P.text) + bg(P.surface0)], [' ', ''])
    used += c
  }
  if (i < names.length) spans.push([t('controls.more', { n: names.length - i }), fg(P.overlay1)])
  return spans
}

export function button(label: string, { key, main = false, focused = false, color = ACCENT, round = false }: ButtonOptions = {}): Span[] {
  const filled = main || focused
  const spans: Span[] = [
    [` ${label} `, filled ? BOLD + fg(P.crust) + bg(color) : fg(color) + bg(P.surface0)],
    ...(key ? [[`${key} `, filled ? fg(P.surface0) + bg(color) : fg(P.overlay1) + bg(P.surface0)] as const] : []),
  ]
  if (!round) return spans
  const cap = fg(filled ? color : P.surface0)
  return [[CAP_L, cap], ...spans, [CAP_R, cap]]
}

export const buttons = (list: readonly ButtonSpec[]): Span[] => list.flatMap((b, i): Span[] => [...(i ? [['  ', ''] as const] : []), ...button(b.label, b)])

export const confirm = (question: string, answers: readonly Hint[]): Span[] => [[`${question}  `, BOLD + fg(P.peach)], ...hintSpans(answers)]

// A key as a hint names it: Ctrl+X arrives as \x18.
export function keyName(key: string): string {
  if (key === '\r') return '↵'
  if (key === '\t') return 'tab'
  const code = key.length === 1 ? key.charCodeAt(0) : 0
  return code >= 1 && code <= 26 ? `ctrl+${String.fromCharCode(96 + code)}` : key
}

// Every question is answered by pressing the key that asked it once more, so
// a hand already on x (or Ctrl+X) confirms without moving to y. Any other
// key says no.
export const pressAgain = (key: string, yes = t('controls.yes')): Hint[] => [
  [keyName(key), yes],
  [t('controls.otherKeys'), t('controls.no')],
]

const closeHint = (key: string, fill = ''): Span[] => [
  [key, fg(P.text) + fill],
  [` ${t('controls.close')} `, fg(P.sub) + fill],
]

export const titleText = (title: HeaderTitle): string => (typeof title === 'string' ? title : title.filter(Boolean).join(' · '))

// For clicks on the close hint at the right of a frame's top edge.
export const closeHintWidth = (close: string): number => spanWidth(closeHint(` ${close}`))

export function header(title: HeaderTitle, w: number, { close = 'esc', right = [], fill = bg(P.base) }: HeaderOptions = {}): string {
  return split([[` ${titleText(title)}`, BOLD + fg(ACCENT)]], [...right, ...closeHint(close)], w, fill)
}

export function frameTop(w: number, { title = '', close, color = ACCENT, fill = '' }: FrameTopOptions = {}): string {
  const edge = fg(color) + fill
  const name: Span[] = title ? [[` ${title} `, BOLD + fg(ACCENT) + fill]] : []
  const right = close ? closeHint(` ${close}`, fill) : []
  const dashes = Math.max(0, w - 4 - spanWidth(name) - spanWidth(right))
  return render([['╭─', edge], ...name, ['─'.repeat(dashes), edge], ...right, ['─╮', edge]], w, fill)
}
export const frameBottom = (w: number, { color = ACCENT, fill = '' }: FrameStyle = {}): string =>
  render([[`╰${'─'.repeat(Math.max(0, w - 2))}╯`, fg(color) + fill]], w, fill)
export function frameRow(spans: Line, w: number, { color = ACCENT, fill = '', inner = fill }: FrameRowOptions = {}): string {
  const side = render([['│', fg(color) + fill]], 1, fill)
  return side + render([[' ', inner], ...spans], w - 2, inner) + side
}
