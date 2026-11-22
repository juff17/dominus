// What an overlay draws round its frame: the window it opened over, dimmed.
// tmux can't dim behind a popup, and the diagrams window isn't a popup at all
// (its pictures need passthrough, which popups drop), so each overlay covers
// the whole window and draws a snapshot of its text. Nothing is lost by it
// being a snapshot: tmux doesn't redraw the panes behind a popup either.

import { LAYOUT_SOCKET } from '../core/paths.ts'
import type { RunResult, SyncRunner } from '../core/proc.ts'
import { charWidth } from './term.ts'

// A picture in the viewer pane is kitty placeholder cells: U+10EEEE and the
// marks that number its rows and columns. Drawn again here they would name an
// image, so they become blanks.
const PLACEHOLDER = /\u{10EEEE}\p{Mn}*/gu

// In cells from 0.
export type Box = { left: number; top: number; w: number; h: number }
export type PaneText = { left: number; top: number; width: number; height: number; lines: string[] }
// A wide character's second cell is ''.
export type Grid = string[][]
export type Extent = number | `${number}%`
export type BoxSpec = { w: Extent; h: Extent }

const cells = (e: Extent, of: number): number => (typeof e === 'number' ? e : Math.round((of * Number.parseFloat(e)) / 100))

export function frameBox(cols: number, rows: number, spec: BoxSpec): Box {
  if (cols < 70 || rows < 20) return { left: 0, top: 0, w: cols, h: rows }
  const w = Math.max(1, Math.min(cols, cells(spec.w, cols)))
  const h = Math.max(1, Math.min(rows, cells(spec.h, rows)))
  return { left: Math.floor((cols - w) / 2), top: Math.floor((rows - h) / 2), w, h }
}

export function compose(panes: readonly PaneText[], cols: number, rows: number): Grid {
  const grid: Grid = Array.from({ length: rows }, () => Array<string>(cols).fill(' '))
  const put = (r: number, c: number, ch: string) => {
    if (r >= 0 && r < rows && c >= 0 && c < cols) grid[r][c] = ch
  }
  for (const p of panes) {
    if (p.left > 0) for (let r = 0; r < p.height; r++) put(p.top + r, p.left - 1, '│')
    // From the column of the pane's left divider, so the dividers meet.
    if (p.top > 0) for (let c = p.left > 0 ? -1 : 0; c < p.width; c++) put(p.top - 1, p.left + c, '─')
  }
  for (const p of panes) {
    p.lines.slice(0, p.height).forEach((line, r) => {
      let c = 0
      for (const ch of line.replace(PLACEHOLDER, ' ')) {
        const w = charWidth(ch)
        if (w === 0) continue
        if (c + w > p.width) break
        put(p.top + r, p.left + c, ch)
        if (w === 2) put(p.top + r, p.left + c + 1, '')
        c += w
      }
    })
  }
  return grid
}

// `to` is not included. A wide character cut in half by either end becomes a
// blank, so the text is exactly that wide.
export function slice(row: readonly string[] = [], from: number, to: number): string {
  let s = ''
  for (let c = from; c < to; c++) {
    const ch = row[c] ?? ' '
    if (ch === '') s += c === from ? ' ' : ''
    else if (row[c + 1] === '' && c + 1 >= to) s += ' '
    else s += ch
  }
  return s
}

const paneBox = (line: string) => {
  const [id = '', left, top, width, height] = line.split(' ')
  return { id, left: Number(left), top: Number(top), width: Number(width), height: Number(height) }
}

export type Missed = { exit: number | null; err: string }

// `win` is a window id (@5). It's asked of the layout's tmux by name, not
// whichever server $TMUX points at.
export function capturePanes(win: string, run: SyncRunner): PaneText[] | Missed {
  const tmux = (args: string[]): RunResult => run(['tmux', '-L', LAYOUT_SOCKET, ...args])
  const list = tmux(['list-panes', '-t', win, '-F', '#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}'])
  if (!list.ok) return { exit: list.exit, err: list.err }
  const panes: PaneText[] = []
  for (const line of list.out.trim().split('\n')) {
    const { id, ...at } = paneBox(line)
    const text = tmux(['capture-pane', '-p', '-t', id])
    if (!text.ok) return { exit: text.exit, err: text.err }
    panes.push({ ...at, lines: text.out.split('\n') })
  }
  return panes
}

// Blank when there's no window (run outside the layout, as tests are) or tmux
// can't say, which `missed` hears.
export function captureWindow(win: string, cols: number, rows: number, run: SyncRunner, missed: (why: Missed) => void): Grid {
  if (!win) return []
  const panes = capturePanes(win, run)
  if (Array.isArray(panes)) return compose(panes, cols, rows)
  missed(panes)
  return []
}
