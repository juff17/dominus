// The one-line text input every typing field shares. Only the editing and
// the fitting live here; each field keeps its own keys and its own look.
//
// The caret is `at` code points into the text, not UTF-16 units, so an
// emoji is one step and is never cut in half. Where a caret is passed in,
// undefined means the end. A pasted image's [Image #n] is one character too:
// the caret steps over it, and Backspace deletes it whole.

import { PLACEHOLDERS } from '../core/images.ts'
import { width as cells, pieces } from './term.ts'

export type LineState = { text: string; at: number }
// `at` is left off at the end.
export type FieldState<K extends string> = Record<K, string> & { at?: number }
export type Change = 'text' | 'caret' | ''
export type CaretParts = { before: string; under: string; after: string }

export const length = (text: string): number => [...text].length

const caretIn = (chars: readonly string[], at: number | undefined): number => Math.max(0, Math.min(at ?? chars.length, chars.length))

// A joined emoji or a character with its marks is kept whole or left out.
export function head(text: string, w: number): string {
  let out = ''
  let used = 0
  for (const [piece, cells] of pieces(text)) {
    if (used + cells > w) break
    out += piece
    used += cells
  }
  return out
}
export function tail(text: string, w: number): string {
  let out = ''
  let used = 0
  for (const [piece, cells] of pieces(text).reverse()) {
    if (used + cells > w) break
    out = piece + out
    used += cells
  }
  return out
}

export function insertAt(text: string, at: number | undefined, s: string): LineState {
  const chars = [...text]
  const i = caretIn(chars, at)
  return { text: chars.toSpliced(i, 0, ...s).join(''), at: i + length(s) }
}

type Edit = (chars: string[], i: number) => { chars: string[]; at: number }
const move =
  (to: (chars: string[], i: number) => number): Edit =>
  (chars, i) => ({ chars, at: to(chars, i) })

// The spans, in code points, of the image placeholders in the text.
function atoms(chars: string[]): [start: number, end: number][] {
  const text = chars.join('')
  return [...text.matchAll(PLACEHOLDERS)].map(m => {
    const start = length(text.slice(0, m.index))
    return [start, start + length(m[0])]
  })
}

// A caret inside a placeholder moves to its start (dir < 0) or its end.
function snap(chars: string[], i: number, dir: number): number {
  const hit = atoms(chars).find(([start, end]) => i > start && i < end)
  return hit ? hit[dir < 0 ? 0 : 1] : i
}

// Where the caret may stop: the start of each piece the drawing keeps whole,
// and the end, but never inside a placeholder. Moving and deleting by these,
// not by code points, never splits an emoji or leaves a joiner behind, which
// would glue the next character typed onto it as zero cells.
function stops(chars: string[]): number[] {
  const out = [0]
  let at = 0
  for (const [piece] of pieces(chars.join(''))) {
    at += length(piece)
    out.push(at)
  }
  const spans = atoms(chars)
  return spans.length ? out.filter(s => !spans.some(([start, end]) => s > start && s < end)) : out
}
const charLeft = (chars: string[], i: number): number => stops(chars).findLast(s => s < i) ?? 0
const charRight = (chars: string[], i: number): number => stops(chars).find(s => s > i) ?? chars.length
const isSpace = (ch: string): boolean => /\s/.test(ch)
// A placeholder has a space in it, but is one word.
function wordLeft(chars: string[], i: number): number {
  while (i > 0 && isSpace(chars[i - 1])) i--
  while (i > 0 && !isSpace(chars[i - 1])) i--
  return snap(chars, i, -1)
}
function wordRight(chars: string[], i: number): number {
  while (i < chars.length && isSpace(chars[i])) i++
  while (i < chars.length && !isSpace(chars[i])) i++
  return snap(chars, i, 1)
}
const deleteWordBefore: Edit = (chars, i) => {
  const j = wordLeft(chars, i)
  return { chars: chars.toSpliced(j, i - j), at: j }
}

const KEYS: [string[], Edit][] = [
  [['\x1b[D'], move(charLeft)],
  [['\x1b[C'], move(charRight)],
  // Ctrl or Alt with an arrow, and Alt+B and Alt+F.
  [['\x1b[1;5D', '\x1b[1;3D', '\x1bb'], move(wordLeft)],
  [['\x1b[1;5C', '\x1b[1;3C', '\x1bf'], move(wordRight)],
  // Home and End, and Ctrl+A and Ctrl+E.
  [['\x1b[H', '\x1b[1~', '\x01'], move(() => 0)],
  [['\x1b[F', '\x1b[4~', '\x05'], move(chars => chars.length)],
  // Backspace takes the character before the caret, Delete the one under it,
  // each with its marks or the emoji it's joined into.
  [
    ['\x7f', '\b'],
    (chars, i) => {
      const j = charLeft(chars, i)
      return { chars: chars.toSpliced(j, i - j), at: j }
    },
  ],
  [['\x1b[3~'], (chars, i) => ({ chars: chars.toSpliced(i, charRight(chars, i) - i), at: i })],
  // Ctrl+U everything before the caret, Ctrl+K everything after, Ctrl+W
  // the word before.
  [['\x15'], (chars, i) => ({ chars: chars.slice(i), at: 0 })],
  [['\x0b'], (chars, i) => ({ chars: chars.slice(0, i), at: i })],
  [['\x17'], deleteWordBefore],
]
const EDITS = new Map(KEYS.flatMap(([keys, edit]) => keys.map(key => [key, edit] as const)))

export function editLine(text: string, at: number | undefined, key: string): LineState {
  const chars = [...text]
  const i = caretIn(chars, at)
  const edit = EDITS.get(key)
  if (edit) {
    const done = edit(chars, i)
    return { text: done.chars.join(''), at: done.at }
  }
  if (!key.startsWith('\x1b') && key >= ' ') return insertAt(text, i, key)
  return { text, at: i }
}

// The caret at the end leaves `at` off, so a state that never moved it has
// none.
export function editField<K extends string>(state: FieldState<K>, field: K, key: string): Change {
  const texts: Record<K, string> = state
  const was = texts[field]
  const wasAt = state.at ?? length(was)
  const { text, at } = editLine(was, state.at, key)
  texts[field] = text
  if (at < length(text)) state.at = at
  else delete state.at
  return text !== was ? 'text' : at !== wasAt ? 'caret' : ''
}

// For a field that draws its caret as a bar between characters.
export function splitAt(text: string, at: number | undefined): [before: string, after: string] {
  const chars = [...text]
  const i = at ?? chars.length
  return [chars.slice(0, i).join(''), chars.slice(i).join('')]
}

// For a field that draws its caret as a block on a character (a space at the
// end). Too long, it's cut from the start up to just before the caret,
// leaving the character under it and one more, and cut at the end.
export function caretParts(text: string, at: number | undefined, w: number): CaretParts {
  const chars = [...text]
  const i = caretIn(chars, at)
  const before = chars.slice(0, i).join('')
  const j = charRight(chars, i)
  const under = i < chars.length ? chars.slice(i, j).join('') : ' '
  const after = chars.slice(j).join('')
  if (cells(before) + cells(under) + cells(after) <= w) return { before, under, after }
  const lead = tail(before, Math.max(0, w - cells(under) - cells(head(after, 1))))
  return { before: lead, under, after: head(after, Math.max(0, w - cells(lead) - cells(under))) }
}

// Marks the caret in a line, for a field that wraps: a one-cell stand-in
// (a private-use character) that wraps with the text, which caretShown then
// draws as the caret.
export const CARET_MARK = ''
export const withCaret = (text: string, at: number | undefined): string => {
  const chars = [...text]
  return chars.toSpliced(at ?? chars.length, 0, CARET_MARK).join('')
}

// An escape after the mark (the span's reset, when the caret ends the text)
// is no character: taking it would print the rest of the code.
export const caretShown = (line: string): string =>
  line.replace(new RegExp(`${CARET_MARK}([^\\x1b][\\p{Mn}\\p{Me}\\u200b-\\u200f\\ufe0f]*)?`, 'u'), (_, ch?: string) => `\x1b[7m${ch ?? ' '}\x1b[27m`)

// ------------------------------------------------------------ wrapped

// What a wrapped field lays out: the pieces between caret stops, so an emoji
// or a placeholder is never split across rows.
type Unit = { at: number; cells: number; space: boolean }
function units(chars: string[]): Unit[] {
  const s = stops(chars)
  return s.slice(0, -1).map((at, i) => {
    const piece = chars.slice(at, s[i + 1]).join('')
    return { at, cells: cells(piece), space: piece === ' ' }
  })
}

// Where each row starts, in code points, as a field `w` cells wide wraps
// the text: after a space where the row has one, else at the edge. A row
// keeps its last cell for the caret, which a space may take instead, so
// typing at the end never shifts the row; a space there puts the caret on
// a row of its own, where the next word will go.
export function wrapRows(text: string, w: number): number[] {
  const chars = [...text]
  const room = Math.max(1, w - 1)
  const starts = [0]
  let first = 0
  let used = 0
  let space = -1
  const us = units(chars)
  for (let k = 0; k < us.length; k++) {
    const u = us[k]
    if (used + u.cells > room && k > first && !(u.space && used <= room)) {
      first = space >= first ? space + 1 : k
      starts.push(us[first].at)
      used = us.slice(first, k).reduce((n, x) => n + x.cells, 0)
      space = -1
    }
    used += u.cells
    if (u.space) space = k
  }
  if (used > room) starts.push(chars.length)
  return starts
}

// The row the caret is on: a caret at a row's start is on that row.
export const rowOf = (starts: readonly number[], at: number): number => Math.max(0, starts.findLastIndex(s => s <= at))

// The caret a row up (dir < 0) or down, on the nearest stop at or before
// its column; null with no row that way.
export function rowStep(text: string, at: number, w: number, dir: number): number | null {
  const chars = [...text]
  const starts = wrapRows(text, w)
  const r = rowOf(starts, at)
  const to = r + Math.sign(dir)
  if (to < 0 || to >= starts.length) return null
  const col = cells(chars.slice(starts[r], at).join(''))
  const last = to === starts.length - 1
  const end = last ? chars.length : starts[to + 1]
  // A row's own stops: the next row's start is that row's, but for the end.
  const own = stops(chars).filter(s => s >= starts[to] && (s < end || (last && s === end)))
  return own.findLast(s => cells(chars.slice(starts[to], s).join('')) <= col) ?? starts[to]
}
