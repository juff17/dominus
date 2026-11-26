// The Dominus gear on screen: the rail's mark, which turns as a window opens,
// and the empty board's. Each is a kitty picture shown through placeholder
// cells (kitty.ts), drawn in the theme colour at a whole-number scale and
// sized to fill its cells exactly, so the terminal shows it 1:1 and the
// pixels stay square and sharp instead of being smoothed by a resize.

import { createHash } from 'node:crypto'
import { existsSync, } from 'node:fs'
import { join } from 'node:path'
import type { Art } from './gear-art.ts'
import { type ImageId, gridRow, placeGrid, transmitFile } from './kitty.ts'
import { ACCENT } from './palette.ts'
import { png } from './png.ts'
import { writeAtomic } from '../core/json.ts'

// A terminal cell's size in pixels.
export type Cell = { cw: number; ch: number }
// A gear ready to draw: its rows of placeholder cells, and how many cells
// wide they are.
export type GearCells = { rows: readonly string[]; cols: number }
// The art, `px` pixels square, drawn `scale` times over in cols × rows cells.
export type Fit = { px: number; scale: number; cols: number; rows: number }

// At rest and turned half a tooth. Both rails of a window (in its workspace
// and its hub) draw the same pictures on these ids, so whichever is on
// screen has sent them for the other.
export const RAIL_IDS = [5, 6] as const
export const BOARD_ID: ImageId = 7
const PLACEMENT = 1

// The biggest whole-number scale that fits in maxCols × maxRows cells, and
// the cells that takes; null when even 1× doesn't fit.
export function fit(art: Art, cell: Cell, maxCols: number, maxRows: number): Fit | null {
  const px = art.length
  const scale = Math.floor(Math.min(maxCols * cell.cw, maxRows * cell.ch) / px)
  if (scale < 1) return null
  return { px, scale, cols: Math.ceil((px * scale) / cell.cw), rows: Math.ceil((px * scale) / cell.ch) }
}

// The whole of the cells' area, w × h pixels, with the art scaled and
// centred in it and the rest clear, so the cells' background shows through.
export function pixels(art: Art, f: Fit, cell: Cell, color = ACCENT): { w: number; h: number; rgba: Uint8Array } {
  const w = f.cols * cell.cw
  const h = f.rows * cell.ch
  const size = f.px * f.scale
  const left = Math.floor((w - size) / 2)
  const top = Math.floor((h - size) / 2)
  const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(color.slice(i, i + 2), 16))
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < size; y++) {
    const row = art[Math.floor(y / f.scale)]
    for (let x = 0; x < size; x++) {
      if (row[Math.floor(x / f.scale)] !== '#') continue
      rgba.set([r, g, b, 255], ((top + y) * w + left + x) * 4)
    }
  }
  return { w, h, rgba }
}

// The picture's PNG under `dir`, written the first time an art, size and
// colour is asked for and shared by every window after: the name carries a
// hash of the art, so an edit to it isn't hidden by the old file. Renamed
// into place, so the terminal never reads half a file another window is
// still writing. Throws when it can't be written.
export function gearFile(dir: string, name: string, art: Art, f: Fit, cell: Cell, color = ACCENT): string {
  const drawn = createHash('sha1').update(art.join('\n')).digest('hex').slice(0, 8)
  const path = join(dir, `${name}-${drawn}-${f.scale}x-${f.cols}x${f.rows}-${cell.cw}x${cell.ch}-${color.slice(1)}.png`)
  if (existsSync(path)) return path
  const { w, h, rgba } = pixels(art, f, cell, color)
  writeAtomic(path, png(w, h, rgba))
  return path
}

// Sending an id again replaces its picture and drops its placement, so the
// placement goes with it every time.
export const sendGear = (id: ImageId, path: string, f: Fit): string => transmitFile(id, path) + placeGrid(id, PLACEMENT, f.cols, f.rows)

// Row `row` of the picture's placeholder cells.
export const gearRow = (id: ImageId, f: Fit, row: number): string => gridRow(id, PLACEMENT, row, 0, f.cols)

// A full-width row of `fill` with `cells` centred on it; the fill shows
// through the picture's clear pixels.
export const centredRow = (cells: string, cols: number, w: number, fill: string): string =>
  `${fill}${' '.repeat(w)}\x1b[${Math.floor((w - cols) / 2) + 1}G${fill}${cells}\x1b[0m`
