import { t } from '../core/text.ts'
import { BG, BOLD, FG, RESET } from './palette.ts'
import type { Span } from './term.ts'

export type Hint = readonly [key: string, what: string]
export type HintOptions = { noBreak?: boolean }
export type ModeTab = string | { label: string }

// As an escape-coded string, for Todo and Diff.
export const keyHints = (pairs: readonly Hint[]): string => pairs.map(([key, what]) => `${FG.blue}${key}${FG.sub} ${what}${RESET}`).join('  ')
export const keyHintsWidth = (pairs: readonly Hint[]): number => pairs.map(([key, what]) => `${key} ${what}`).join('  ').length

// As spans, for the hub and the diagrams viewer. With noBreak each key keeps
// to its label when the line is wrapped.
export const hintSpans = (pairs: readonly Hint[], { noBreak = false }: HintOptions = {}): Span[] => {
  const nb = noBreak ? (s: string) => s.replaceAll(' ', ' ') : (s: string) => s
  return pairs.flatMap(([key, what], i): Span[] => [
    [`${i ? '  ' : ''}${nb(key)}`, FG.text],
    [nb(` ${what}`), FG.sub],
  ])
}

// The two spaces go after every label, the last one's too (the help and
// Settings popups).
export const hintSpansAfter = (pairs: readonly Hint[]): Span[] =>
  pairs.flatMap(([key, what]): Span[] => [
    [key, FG.text],
    [` ${what}  `, FG.sub],
  ])

const labelOf = (mode: ModeTab): string => (typeof mode === 'string' ? mode : mode.label)
const SWITCH_KEYS: Hint[] = [['tab', t('hints.switch')]]
const SWITCH = keyHints(SWITCH_KEYS)
// With `next`, Tab's hint is drawn from column `col`.
export function modeHeader(modes: readonly ModeTab[], at: number, next?: number, col?: number): string {
  const line = modes.map((m, i) => (i === at ? `${BG.text}${FG.crust}${BOLD}${labelOf(m)}${RESET}` : `${FG.sub}${BOLD}${labelOf(m)}${RESET}`)).join(' ')
  return next ? `${line}\x1b[${col}G${SWITCH}` : line
}
export const switchCol = (cols: number): number => cols - keyHintsWidth(SWITCH_KEYS) + 1

// col counts from 1; -1 when no tab is under it.
export function tabAt(modes: readonly ModeTab[], col: number): number {
  let from = 1
  for (const [i, m] of modes.entries()) {
    const w = labelOf(m).length
    if (col >= from && col < from + w) return i
    from += w + 1
  }
  return -1
}
