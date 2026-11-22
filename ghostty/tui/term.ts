// Text from transcripts (prompts, PR comments, log lines) is written by other
// people, so clean() strips control characters before they can reach the
// terminal as escape sequences. The palette, tokenizer and screen are
// re-exported, as the hub, the rail and the popups take them from here.

import { RESET, bg, fg } from './palette.ts'

export { ACCENT, ACCENT_INK, BOLD, ITALIC, MONITOR, P, RESET, STATE, STOPPED, bg, fg, mix } from './palette.ts'
export { tokens } from './input.ts'
export { enter, leave, out, paint } from './screen.ts'

export type Span = readonly [text: string, style?: string]
export type Line = readonly Span[]
export type Piece = [text: string, cells: number]

// Powerline glyphs, which Ghostty draws itself: no Nerd Font needed.
export const CAP_L = '\ue0b6'
export const CAP_R = '\ue0b4'

export const clean = (s: unknown): string => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')

const WIDE =
  /\p{Emoji_Presentation}|[ᄀ-ᅟ⺀-〾ぁ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u
// biome-ignore lint/suspicious/noMisleadingCharacterClass: each zero-width code point is matched on its own, not as a pair
const ZERO = /[\p{Mn}\p{Me}\u200B-\u200F\uFE0F]/u

const ZWJ = '\u200d'
const VS16 = '\ufe0f'

export const charWidth = (ch: string): number => (ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1)
// A character after a zero-width joiner is drawn inside the one before it
// (👩‍👧 is one emoji, two cells), so it takes no cells of its own.
// A narrow symbol with VS16 after it (⚠️, ❤️) asks for its emoji, which
// Ghostty draws two cells wide: counted as one, every line holding it would
// run a cell past the edge. Counted from pieces(), so measuring and cutting
// always agree.
export const width = (s: string): number => pieces(s).reduce((w, [, cells]) => w + cells, 0)

// Text as the pieces a cut must keep whole, each with the cells it takes: a
// character with the zero-width marks after it, and anything a zero-width
// joiner ties on.
export function pieces(text: string): Piece[] {
  const out: Piece[] = []
  let joined = false
  for (const ch of text) {
    const w = charWidth(ch)
    const last = out.at(-1)
    if (last && (joined || w === 0)) {
      last[0] += ch
      if (ch === VS16 && last[1] === 1) last[1] = 2
    } else out.push([ch, w])
    joined = ch === ZWJ
  }
  return out
}

export const spanWidth = (spans: Line): number => spans.reduce((n, [s]) => n + width(s), 0)

// Exactly `cols` cells: past the edge, the last visible character becomes ….
// `fill` is a style.
export function render(spans: Line, cols: number, fill = ''): string {
  if (cols <= 0) return ''
  const cut = spanWidth(spans) > cols
  const limit = cut ? cols - 1 : cols
  let out = fill
  let used = 0
  let full = false
  for (const [text, style = ''] of spans) {
    let piece = ''
    for (const [ch, w] of pieces(text)) {
      if (used + w > limit) {
        full = true
        break
      }
      piece += ch
      used += w
    }
    if (piece) out += `${style}${piece}${RESET}${fill}`
    if (full) break
  }
  if (cut) {
    out += `${fill}…`
    used++
  }
  return `${out}${' '.repeat(Math.max(0, cols - used))}${RESET}`
}

// `tint` and `outer` are hex. Cells are all one size, so a header stands out
// by its background rather than bigger text.
export function bar(left: Line, right: Line, w: number, tint: string, outer: string): string {
  const edge = fg(tint) + bg(outer)
  return render([[CAP_L, edge]], 1) + split(left, right, w - 2, bg(tint)) + render([[CAP_R, edge]], 1)
}

export const pill = (text: string, color: string, outer: string, style = ''): Span[] => [
  [CAP_L, fg(color) + bg(outer)],
  [text, style + bg(color)],
  [CAP_R, fg(color) + bg(outer)],
]

// Breaks only at plain spaces (a no-break space holds two words together).
// What's past `max` lines joins the last, for render() to cut with ….
// A line's trailing spaces go, and so do a wrapped line's leading ones.
export function wrap(spans: Line, cols: number, max = Number.POSITIVE_INFINITY): Span[][] {
  // Each word with the spaces before it.
  const words: { gap: string; parts: Span[] }[] = []
  let word: (typeof words)[number] | null = null
  let gap = ''
  for (const [text, style = ''] of spans)
    for (const piece of text.split(/( +)/)) {
      if (!piece) continue
      if (piece[0] === ' ') {
        word = null
        gap += piece
        continue
      }
      if (!word) {
        word = { gap, parts: [] }
        words.push(word)
        gap = ''
      }
      word.parts.push([piece, style])
    }
  const lines: Span[][] = []
  let line: Span[] = []
  let used = 0
  for (const w of words) {
    const ww = spanWidth(w.parts)
    if (used > 0 && used + width(w.gap) + ww > cols && lines.length < max - 1) {
      lines.push(line)
      line = []
      used = 0
    }
    const lead = lines.length === 0 || used > 0 ? w.gap : ''
    if (lead) line.push([lead])
    line.push(...w.parts)
    used += width(lead) + ww
  }
  if (line.length || !lines.length) lines.push(line)
  return lines
}

// The left is cut first when they don't fit.
export function split(left: Line, right: Line, cols: number, fill = ''): string {
  const rw = spanWidth(right)
  if (rw >= cols) return render(right, cols, fill)
  return render(left, cols - rw, fill) + render(right, rw, fill)
}

export const ago = (ms: number | null | undefined, now = Date.now()): string => {
  if (!ms) return ''
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}
