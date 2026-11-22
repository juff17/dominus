// dv's logic, apart from the terminal so it can be tested.

import { readdirSync, statSync } from 'node:fs'
import { DIAGRAMS_CLOSE_KEY } from '../../core/keys.ts'
import { t } from '../../core/text.ts'

import { type Hint, type ModeTab, hintSpans, tabAt } from '../../tui/chrome.ts'
import { type CellSize, type Tokenizer, tokenizer } from '../../tui/input.ts'
import { type Span, width } from '../../tui/term.ts'
import type { Image } from '../view.ts'
import { type ImageId, type PlacementId, deleteImage, placeGrid, transmitFile } from './kitty.ts'

export const TAB_MAX = 24

export type Diagram = Image & { title: string; file: string }
// `more` is whatever else the mod keeps there (its session), which a close
// writes back as it was.
export type PaneState = { diagrams: Diagram[]; current?: number; [more: string]: unknown }
// A pixel position from the picture region's top left.
export type Point = { px: number; py: number }
// A screen cell, counted from 1.
export type CellAt = { row: number; col: number }
export type MouseUnits = { cell: CellSize; pixelMouse: boolean }
// The picture region's left column and top row (from 1).
export type PointerOptions = MouseUnits & { left: number; top: number }
export type KeyOptions = { frame: boolean; count: number }
export type KeyAction =
  | readonly ['quit']
  | readonly ['tab']
  | readonly ['pan', x: number, y: number]
  | readonly ['zoom', 1 | -1]
  | readonly ['home']
  | readonly ['step', number]
  | readonly ['jump', number]
  | readonly ['close']

// The tab's name is left out when it's just the folder tmux named it after.
export const tabTitle = (dir: string, tab: string, name: string): string => (name === dir ? t('diagrams.tabTitle', { dir, tab }) : `${dir} · ${tab}:${name}`)

// The mod's file for a tmux pane, `%12` on socket `s` being `s-12.json`.
export const paneFile = (panes: string, socket: string, pane: string): string => `${panes}/${socket}-${pane.replace('%', '')}.json`

// The mod's file for a background job, which runs outside tmux.
export const jobFile = (panes: string, job: string): string => `${panes}/job-${job}.json`

// A file the mod removes between listing and stat is skipped.
export function newestPane(panes: string): string {
  const newest = readdirSync(panes)
    .filter(name => name.endsWith('.json'))
    .flatMap(name => {
      const stat = statSync(`${panes}/${name}`, { throwIfNoEntry: false })
      return stat ? [{ name, at: stat.mtimeMs }] : []
    })
    .sort((a, b) => b.at - a.at)[0]
  return newest ? `${panes}/${newest.name}` : ''
}

export const clampIndex = (i: number, count: number): number => Math.max(0, Math.min(i, count - 1))

// Which diagram this is across rewrites of the pane file: the mod's id, or
// its PNG for a file without ids.
export const diagramKey = (d: Diagram): unknown => ('id' in d && d.id !== undefined ? d.id : d.file)

const sameDiagrams = (a: readonly Diagram[], b: readonly Diagram[]): boolean =>
  a.length === b.length && a.every((d, i) => diagramKey(d) === diagramKey(b[i]))

// The diagram to select, or undefined to keep the one showing. The list is
// compared by diagram and not only by length: at the mod's cap a new diagram
// evicts an old one, leaving the length and current as they were but a
// different picture at the index.
export function reread(prev: PaneState, next: PaneState, index: number, switched = false): number | undefined {
  const jumped = switched || next.current !== prev.current || !sameDiagrams(prev.diagrams, next.diagrams)
  if (jumped || !next.diagrams[index]) return Math.min(next.current ?? 0, next.diagrams.length - 1)
  return undefined
}

const isDiagram = (d: unknown): d is Diagram =>
  typeof d === 'object' &&
  d !== null &&
  'title' in d &&
  typeof d.title === 'string' &&
  'file' in d &&
  typeof d.file === 'string' &&
  'width' in d &&
  typeof d.width === 'number' &&
  'height' in d &&
  typeof d.height === 'number'

// Each diagram is kept whole, with fields dv doesn't read, for a close to
// write back.
export function paneState(json: unknown): PaneState | undefined {
  if (typeof json !== 'object' || json === null || !('diagrams' in json)) return undefined
  const { diagrams } = json
  if (!Array.isArray(diagrams) || !diagrams.every(isDiagram)) return undefined
  const current = 'current' in json && typeof json.current === 'number' ? json.current : undefined
  return { ...json, diagrams, current }
}

// The one showing stays showing, or its neighbour does when it's the one
// closed.
export function dropTab<S extends PaneState>(state: S, i: number, index: number): S & { current: number } {
  const diagrams = state.diagrams.filter((_, n) => n !== i)
  const current = Math.max(0, Math.min(i < index ? index - 1 : index, diagrams.length - 1))
  return { ...state, diagrams, current }
}

export const truncate = (title: string): string => (title.length > TAB_MAX ? `${title.slice(0, TAB_MAX - 1)}…` : title)

// col is counted from 1.
export const modeAt = <M extends ModeTab>(modes: readonly M[], col: number): M | undefined => modes[tabAt(modes, col)]

export const hints = (pairs: readonly Hint[]): Span[] => hintSpans(pairs)

// Whole hints only, dropped from the end, but always the first.
export function fitHints(keys: readonly Hint[], room: number): readonly Hint[] {
  let shown = keys
  while (shown.length > 1 && hints(shown).reduce((n, [t]) => n + width(t), 0) > room) shown = shown.slice(0, -1)
  return shown
}

// Two image ids taken in turn, so a new picture lands before the old one
// goes. placedGrid is kept so a pan doesn't place it again; a new grid goes
// to the other of two placements: tmux sends a placement on to the terminal
// at once but the cells only at its next redraw, and old cells naming the
// old placement keep drawing the right slice until then.
// shownId is 0 while no picture is shown.
// Image ids belong to the whole Ghostty surface, not to a tmux pane, so the
// viewer pane's dv and the Alt+D window's, which share one, each take their
// own pair from firstId: on the same ids, one's transmit would replace the
// other's picture and its quit would delete it.
export type Picture = { firstId: ImageId; shownId: ImageId; shownFile: string; placedGrid: string; placedId: PlacementId }
export const picture = (firstId: ImageId = 1): Picture => ({ firstId, shownId: 0, shownFile: '', placedGrid: '', placedId: 1 })
// The diagrams window's pair, apart from the viewer pane's 1 and 2.
export const FRAME_FIRST_ID: ImageId = 3

export function showFile(pic: Picture, file: string): string {
  if (file === pic.shownFile) return ''
  const id = pic.shownId === pic.firstId ? pic.firstId + 1 : pic.firstId
  let setup = transmitFile(id, file)
  if (pic.shownId) setup += deleteImage(pic.shownId)
  pic.shownId = id
  pic.shownFile = file
  pic.placedGrid = ''
  return setup
}

export function placeIn(pic: Picture, cols: number, rows: number): string {
  const grid = `${pic.shownId} ${cols} ${rows}`
  if (grid === pic.placedGrid) return ''
  pic.placedId = pic.placedId === 1 ? 2 : 1
  pic.placedGrid = grid
  return placeGrid(pic.shownId, pic.placedId, cols, rows)
}

// The terminal may no longer have the picture: tmux drops passthrough to a
// pane that's hidden (Alt+V turns it off before breaking the pane out), so
// what was sent meanwhile never arrived. The next draw sends and places it
// again, to the other id, and deletes the old one in case it did arrive.
export function resendPicture(pic: Picture): void {
  pic.shownFile = ''
  pic.placedGrid = ''
}

export function dropPicture(pic: Picture): string {
  const s = pic.shownId ? deleteImage(pic.shownId) : ''
  pic.shownId = 0
  pic.shownFile = ''
  pic.placedGrid = ''
  return s
}

// With pixel reports x and y are pixels from 1; otherwise cells, taken at
// their middle.
export const pointer = (x: number, y: number, { left, top, cell, pixelMouse }: PointerOptions): Point =>
  pixelMouse
    ? { px: x - 1 - left * cell.cw, py: y - 1 - (top - 1) * cell.ch }
    : { px: (x - left - 0.5) * cell.cw, py: (y - top + 0.5) * cell.ch }

export const cellAt = (x: number, y: number, { cell, pixelMouse }: MouseUnits): CellAt =>
  pixelMouse ? { col: Math.floor((x - 1) / cell.cw) + 1, row: Math.floor((y - 1) / cell.ch) + 1 } : { col: x, row: y }

// The diagrams window's own key arrives as DIAGRAMS_CLOSE_KEY: layout.conf's
// binding, copied wherever Settings › Keybinds moves it, sends that rather
// than the key itself, so a real Alt+D after a move doesn't close it.
export function keyAction(key: string, { frame, count }: KeyOptions): KeyAction | undefined {
  if (frame && (key === '\x1b' || key === DIAGRAMS_CLOSE_KEY)) return ['quit']
  if (/^[1-9]$/.test(key)) return Number(key) <= count ? ['jump', Number(key) - 1] : undefined
  const actions: Record<string, KeyAction> = {
    q: ['quit'],
    '\x03': ['quit'],
    '\t': ['tab'],
    h: ['pan', 1, 0],
    l: ['pan', -1, 0],
    k: ['pan', 0, 1],
    j: ['pan', 0, -1],
    '\x1b[D': ['pan', 1, 0],
    '\x1b[C': ['pan', -1, 0],
    '\x1b[A': ['pan', 0, 1],
    '\x1b[B': ['pan', 0, -1],
    '+': ['zoom', 1],
    '=': ['zoom', 1],
    '-': ['zoom', -1],
    0: ['home'],
    '[': ['step', -1],
    ']': ['step', 1],
    x: ['close'],
  }
  return Object.hasOwn(actions, key) ? actions[key] : undefined
}

// A 0 in a `cell` reply means the terminal didn't say.
export const parseInput: Tokenizer = tokenizer({ alt: 'lowercase', replies: true, release: 'released' })
