// dv's state: one object that diagram-view.ts creates, draw.ts draws and
// effects.ts fills from the world. The pane file's own logic, the picture's
// kitty ids and the keys are in diagram.ts.

import { homedir } from 'node:os'

import { load as settings } from '../../settings/settings.ts'
import { type CellSize, type Mouse, leftPress } from '../../tui/input.ts'
import { type PaneModes, paneModes, tabs as modeTabs } from '../modes.ts'
import { type Region, type View, home } from '../view.ts'
import { type Box, type Grid, frameBox } from '../../tui/backdrop.ts'
import { closeLabel, mouseIn } from '../../tui/overlay.ts'
import { t } from '../../core/text.ts'
import {
  type CellAt,
  type Diagram,
  FRAME_FIRST_ID,
  type PaneState,
  type Picture,
  type Point,
  cellAt,
  clampIndex,
  modeAt,
  picture,
  pointer as pointerAt,
} from './diagram.ts'

// exit is the code dv exits with to switch to the mode, 0 for its own.
export type ModeLink = { label: string; exit: number }

export type Config = {
  panes: string
  // The tab session to follow as DV_TABS's `socket:session` (bin/ghostty-claude-start
  // sets it for the viewer pane): dv shows its active tab.
  tabsSocket: string
  tabsSession: string
  // One tab's pane as DV_PANE's `socket:%id`, which dv shows whatever tab is
  // active: the tab of the card selected on the hub's board.
  pinSocket: string
  pinPane: string
  // A background job's id (DV_JOB), which has no tmux pane, and the title
  // to show for it (DV_TITLE).
  job: string
  jobTitle: string
  // With none of them, dv shows whichever pane's tabs changed last.
  follows: boolean
  // The diagrams window (DV_FRAME), an overlay like every popup
  // (tui/overlay.ts) over the window Alt+D was pressed in.
  frame: boolean
  // That window (OV_UNDER, a layout window id).
  under: string
  // The viewer pane's mode header (GV_MODES, viewer/modes.ts). The diagrams
  // window has none.
  pane: PaneModes
  modes: ModeLink[]
  header: boolean
  edge: number
  // The frame's share of the screen each way (layout.diagramsPercent).
  share: number
  // Rows inside the frame above the picture (the frame's top, the mode
  // header, the row of diagram chips) and below it (the hint row, the
  // frame's bottom).
  above: number
  below: number
}

export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const [tabsSocket = '', tabsSession = ''] = (env.DV_TABS ?? '').split(':')
  const [pinSocket = '', pinPane = ''] = (env.DV_PANE ?? '').split(':')
  const frame = Boolean(env.DV_FRAME)
  const pane = paneModes(t('settings.modes.diagrams.name'), frame ? {} : env)
  const modes = modeTabs(pane).map(tab => ({ label: tab.label, exit: pane.exitOf(tab.i) }))
  const header = !frame && modes.length > 1
  const edge = frame ? 1 : 0
  return {
    panes: `${env.XDG_CACHE_HOME || `${homedir()}/.cache`}/claude-diagram-pane/panes`,
    tabsSocket,
    tabsSession,
    pinSocket,
    pinPane,
    job: env.DV_JOB ?? '',
    jobTitle: env.DV_TITLE ?? '',
    follows: Boolean(tabsSession || pinPane || env.DV_JOB),
    frame,
    under: env.OV_UNDER ?? '',
    pane,
    modes,
    header,
    edge,
    share: frame ? settings()['layout.diagramsPercent'] : 100,
    above: edge + (header ? 1 : 0) + 1,
    below: 1 + edge,
  }
}

// A chip's columns on its row, for clicks: from..to, the × from close on.
export type ChipHit = { i: number; from: number; close: number; to: number }

export type DiagramState = {
  config: Config
  list: PaneState
  paneFile: string
  tabTitle: string
  // The pane file list was read from, set only once a read succeeds, so a
  // half-written file read during a tab switch still counts as the switch.
  stateFile: string
  // The followed tab's pane is gone (its tab closed).
  gone: boolean
  index: number
  view: View | undefined
  // In pixels; a guess until the terminal answers the size query.
  cell: CellSize
  pixelMouse: boolean
  // Where a drag last was.
  drag: Point | undefined
  chips: ChipHit[]
  // Shown in the footer in place of its keys, for a few seconds.
  note: string
  pic: Picture
  // The window Alt+D was pressed in, as it looked when dv started.
  backdrop: Grid
}

export function createState(conf: Config): DiagramState {
  return {
    config: conf,
    list: { diagrams: [], current: 0 },
    paneFile: '',
    tabTitle: '',
    stateFile: '',
    gone: false,
    index: 0,
    view: undefined,
    cell: { cw: 10, ch: 20 },
    pixelMouse: false,
    drag: undefined,
    chips: [],
    note: '',
    pic: picture(conf.frame ? FRAME_FIRST_ID : 1),
    backdrop: [],
  }
}

// Settings › Viewers, read on each step so a change applies at once.
export const zoomStep = (): number => 1 + settings()['viewer.zoomStep'] / 100
export const panStep = (): number => settings()['viewer.panPercent'] / 100

// The terminal's size in cells.
export type Size = { cols: number; rows: number }

export const box = (s: DiagramState, size: Size): Box => frameBox(size.cols, size.rows, { w: `${s.config.share}%`, h: `${s.config.share}%` })
// Screen rows, counted from 1.
export const pictureTop = (s: DiagramState, size: Size): number => box(s, size).top + s.config.above + 1
export const chipLine = (s: DiagramState, size: Size): number => pictureTop(s, size) - 1
export const inner = (s: DiagramState, size: Size): number => box(s, size).w - 2 * s.config.edge

export const region = (s: DiagramState, size: Size): Region => ({
  cols: inner(s, size),
  rows: Math.max(1, box(s, size).h - s.config.above - s.config.below),
  ...s.cell,
})

export const middle = (r: Region): Point => ({ px: (r.cols * r.cw) / 2, py: (r.rows * r.ch) / 2 })

// x and y are shares of the region.
export const panPixels = (r: Region, x: number, y: number, share = panStep()): Point => ({
  px: x * r.cols * r.cw * share,
  py: y * r.rows * r.ch * share,
})

export const diagram = (s: DiagramState): Diagram | undefined => s.list.diagrams[s.index]

export function select(s: DiagramState, i: number): void {
  s.index = clampIndex(i, s.list.diagrams.length)
  const d = diagram(s)
  s.view = d ? home(d) : undefined
}

export const pointer = (s: DiagramState, size: Size, x: number, y: number): Point =>
  pointerAt(x, y, { left: box(s, size).left + s.config.edge, top: pictureTop(s, size), cell: s.cell, pixelMouse: s.pixelMouse })

export type MouseAction =
  | { act: 'zoom'; dir: 1 | -1; at: Point }
  | { act: 'grab' | 'drag'; at: Point }
  | { act: 'release' }
  | { act: 'quit'; code: number }
  | { act: 'select' | 'close'; i: number }

export function mouseAction(s: DiagramState, size: Size, mouse: Mouse): MouseAction | undefined {
  const { button, x, y } = mouse
  const at = pointer(s, size, x, y)
  if (button & 64) return { act: 'zoom', dir: (button & 1) === 0 ? 1 : -1, at }
  if (mouse.released) return { act: 'release' }
  if (button & 32) return { act: 'drag', at }
  if (!leftPress(mouse)) return undefined
  return clickAction(s, size, cellAt(x, y, s), at)
}

function clickAction(s: DiagramState, size: Size, { row, col }: CellAt, at: Point): MouseAction {
  // A click outside the frame, or on its close hint, closes it, as it would
  // any overlay.
  if (s.config.frame && mouseIn(box(s, size), { button: 0, x: col, y: row }, closeLabel('keys.diagrams')) === 'close') return { act: 'quit', code: 0 }
  const mode = s.config.header && row === 1 ? modeAt(s.config.modes, col) : undefined
  if (mode?.exit) return { act: 'quit', code: mode.exit }
  const chip = row === chipLine(s, size) ? s.chips.find(c => col >= c.from && col <= c.to) : undefined
  if (chip) return { act: col >= chip.close ? 'close' : 'select', i: chip.i }
  return { act: 'grab', at }
}
