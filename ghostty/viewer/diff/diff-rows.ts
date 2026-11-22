// The Diff mode's rows as the terminal draws them, shared by diff-view.ts and
// the approvals panel's diff of a push (viewer/approvals/draw.ts).

import { t } from '../../core/text.ts'
import { BG, BOLD, FG, RESET } from '../../tui/palette.ts'
import { width as cells } from '../../tui/term.ts'
import { type DiffFile, type DiffRow, changeCells, fit, fitPath } from './diff.ts'

// most is the change bar's scale (scaleOf).
export type FileRowOptions = { open: boolean; selected: boolean; width: number; most: number }

export const C = {
  text: FG.text,
  sub: FG.sub,
  overlay: FG.overlay0,
  line: FG.surface1,
  track: FG.surface0,
  accent: FG.accent,
  green: FG.green,
  red: FG.red,
  yellow: FG.yellow,
  mauve: FG.mauve,
  ink: FG.accentInk,
  cursorBg: BG.surface0,
  addBg: BG.add,
  delBg: BG.del,
  pillBg: BG.accent,
  bold: BOLD,
  reset: RESET,
}
export const STATUS_COLORS: Record<string, string> = { M: C.yellow, T: C.yellow, A: C.green, '?': C.green, D: C.red, U: C.red, R: C.mauve, C: C.mauve }

// The change bar's width in cells.
export const BAR = 10

// A reduce, not Math.max(...files): spreading tens of thousands of untracked
// files overflows the call stack.
export const scaleOf = (files: readonly Pick<DiffFile, 'add' | 'del'>[]): number => Math.sqrt(files.reduce((most, f) => Math.max(most, f.add + f.del), 1))

export function changeBar(file: Pick<DiffFile, 'add' | 'del'>, most: number): string {
  const [green, red, track] = changeCells(file, most, BAR)
  return `${C.green}${'━'.repeat(green)}${C.red}${'━'.repeat(red)}${C.track}${'━'.repeat(track)}${C.reset}`
}

export function fileRow(file: DiffFile, { open, selected, width, most }: FileRowOptions): string {
  const back = selected ? C.cursorBg : ''
  const counts = file.binary ? t('diff.binary') : `+${file.add} −${file.del}`
  const countsText = file.binary ? `${C.sub}${counts}` : `${C.green}+${file.add} ${file.del ? C.red : C.line}−${file.del}`
  const right = ` ${' '.repeat(Math.max(0, 11 - cells(counts)))}${countsText}${C.reset}${back} ${changeBar(file, most)}${back} `
  const room = Math.max(4, width - 5 - 11 - BAR - 3)
  const { dir, name } = fitPath(file.path, room)
  const nameColor = open ? C.accent : C.text
  const pad = ' '.repeat(Math.max(0, room - cells(dir) - cells(name)))
  const status = `${STATUS_COLORS[file.status] ?? C.text}${C.bold}${file.status}${C.reset}${back}`
  return `${back} ${C.overlay}${open ? '▾' : '▸'}${C.reset}${back} ${status} ${C.overlay}${dir}${C.reset}${back}${nameColor}${C.bold}${name}${C.reset}${back}${pad}${right}${C.reset}`
}

export function diffRow(row: DiffRow, width: number): string {
  const edge = `   ${C.accent}▎${C.reset}`
  const room = Math.max(1, width - 4 - 5 - 2)
  switch (row.kind) {
    case 'hunk':
      return `${edge}     ${C.mauve}${fit(row.text, room + 2)}${C.reset}`
    case 'note':
      return `${edge}       ${C.overlay}${fit(row.text, room)}${C.reset}`
    case 'add':
      return `${edge}${C.addBg}${C.overlay}${String(row.num).padStart(4)} ${C.green}+ ${fit(row.text, room)}${C.reset}`
    case 'del':
      return `${edge}${C.delBg}${C.overlay}${String(row.num).padStart(4)} ${C.red}- ${fit(row.text, room)}${C.reset}`
    default:
      return `${edge}${C.overlay}${String(row.num).padStart(4)} ${C.text}  ${fit(row.text, room)}${C.reset}`
  }
}
