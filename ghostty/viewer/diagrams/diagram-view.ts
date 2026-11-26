#!/usr/bin/env node
// dv: shows the diagrams that the claude module's diagram-pane mod draws. The
// mod renders each to a PNG and lists a session's tabs in a file per tmux
// pane or background job (panes/); dv shows one of those files, so it runs
// outside Claude Code. It runs in the viewer pane, following the window's
// active tab (DV_TABS), and in the diagrams window Alt+D opens
// (bin/ghostty-diagrams, DV_FRAME), following a tab session, pinned to one
// tab's pane (DV_PANE) or to a background agent's job (DV_JOB).
//
// This file wires the keys and the terminal; state.ts holds the state,
// draw.ts draws it and effects.ts does what touches the world.

import { existsSync, mkdirSync, watch } from 'node:fs'

import { errorMessage, logger } from '../../core/log.ts'
import { runSync } from '../../core/proc.ts'
import type { Mouse } from '../../tui/input.ts'
import { leave, needTerminal, out, paint, startPane } from '../../tui/screen.ts'
import { logCrashes } from '../logging.ts'
import { type View, panBy, zoomAt } from '../view.ts'
import { type Diagram, type Point, dropPicture, keyAction, parseInput, resendPicture } from './diagram.ts'
import { frame } from './draw.ts'
import { diagramEffects } from './effects.ts'
import { type Size, config, createState, diagram, middle, mouseAction, panPixels, region, select as selectIn, zoomStep } from './state.ts'
import { onTabChanged } from '../tab.ts'
import { FOCUS_IN, FOCUS_OFF, FOCUS_ON } from '../../tui/input.ts'

const log = logger('diagrams')
logCrashes(log)

const SCREEN = { drag: true, pixels: true, paste: false }
// tmux passes focus reports on with focus-events on.

const s = createState(config())
const { pane: PANE, panes: PANES, follows: FOLLOWS } = s.config

const size = (): Size => ({ cols: process.stdout.columns, rows: process.stdout.rows })

// Each frame goes out in one write, inside synchronized output.
function draw(): void {
  const d = diagram(s)
  const there = Boolean(d && existsSync(d.file))
  awaitPng(d && !there ? d.file : '')
  const f = frame(s, size(), there)
  s.chips = f.chips
  s.view = f.view
  paint(f.lines, { clear: true, before: f.setup })
}

// A listed diagram's PNG that left the cache comes back when the mod draws
// it again, which it does without rewriting the pane file, so no change
// event says so: while one is missing, look for it every second.
let missingPng = ''
let pngTimer: NodeJS.Timeout | undefined
function awaitPng(file: string): void {
  if (file === missingPng) return
  clearInterval(pngTimer)
  missingPng = file
  pngTimer = file
    ? setInterval(() => {
        if (existsSync(file)) schedule()
      }, 1000)
    : undefined
}

let pending = false
function schedule(): void {
  if (pending) return
  pending = true
  setTimeout(() => {
    pending = false
    draw()
  }, 8)
}

let noteTimer: NodeJS.Timeout | undefined
function say(text: string): void {
  s.note = text
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => {
    s.note = ''
    schedule()
  }, 4000)
  schedule()
}

const fx = diagramEffects(s, { run: runSync, schedule, say })

function select(i: number): void {
  selectIn(s, i)
  schedule()
}

// One whose PNG left the cache shows a message instead, and a zoom on it
// would only show in the footer.
function drawn(): { d: Diagram; view: View } | undefined {
  const d = diagram(s)
  return d && s.view && existsSync(d.file) ? { d, view: s.view } : undefined
}

function zoom(dir: 1 | -1, at: Point): void {
  const shown = drawn()
  if (!shown) return
  const step = zoomStep()
  s.view = zoomAt(shown.d, region(s, size()), shown.view, dir > 0 ? step : 1 / step, at.px, at.py)
  schedule()
}

function pan({ px, py }: Point): void {
  const shown = drawn()
  if (!shown) return
  s.view = panBy(shown.d, region(s, size()), shown.view, px, py)
  schedule()
}

function onMouse(mouse: Mouse): void {
  const a = mouseAction(s, size(), mouse)
  if (!a) return
  switch (a.act) {
    case 'zoom':
      zoom(a.dir, a.at)
      break
    case 'drag':
      if (s.drag) pan({ px: a.at.px - s.drag.px, py: a.at.py - s.drag.py })
      s.drag = a.at
      break
    case 'grab':
      s.drag = a.at
      break
    case 'release':
      s.drag = undefined
      break
    case 'quit':
      quit(a.code)
      break
    case 'close':
      fx.closeTab(a.i)
      break
    case 'select':
      select(a.i)
      break
  }
}

function onKey(key: string): void {
  const act = keyAction(key, { frame: s.config.frame, count: s.list.diagrams.length })
  if (!act) return
  switch (act[0]) {
    case 'quit':
      quit(PANE.quit)
      break
    case 'tab':
      if (PANE.next) quit(PANE.next)
      break
    case 'pan':
      pan(panPixels(region(s, size()), act[1], act[2]))
      break
    case 'zoom':
      zoom(act[1], middle(region(s, size())))
      break
    case 'home':
      select(s.index)
      break
    case 'step':
      select(s.index + act[1])
      break
    case 'jump':
      select(act[1])
      break
    case 'close':
      fx.closeTab(s.index)
      break
  }
}

function onInput(data: Buffer): void {
  for (const tok of parseInput(data)) {
    if (tok.mouse) onMouse(tok.mouse)
    else if (tok.cell) {
      s.cell = { cw: tok.cell.cw || s.cell.cw, ch: tok.cell.ch || s.cell.ch }
      schedule()
    } else if (tok.pixels !== undefined) s.pixelMouse = tok.pixels
    else if (tok.key === FOCUS_IN) resend()
    else onKey(tok.key ?? '')
  }
}

// Alt+V hides the viewer pane with passthrough off, so a picture drawn while
// it's hidden never reaches the terminal. Showing it resizes the pane and
// then focuses it, after passthrough is back; either is when to send the
// picture again.
function resend(): void {
  resendPicture(s.pic)
  schedule()
}

function quit(code = 0): never {
  try {
    out(dropPicture(s.pic) + FOCUS_OFF)
    leave(SCREEN)
  } catch (err) {
    // The pane is already gone.
    log.warn('screen not restored', { err: errorMessage(err) })
  }
  process.exit(code)
}

needTerminal('diagram-view')

mkdirSync(PANES, { recursive: true })
fx.readCell()
fx.captureBackdrop(size())
// Asks for the cell size and whether pixel mouse positions took, and turns
// on focus reports.
startPane({
  onData: onInput,
  onResize: () => {
    out('\x1b[16t')
    resend()
  },
  quit: () => quit(),
  screen: SCREEN,
  onEnter: `\x1b[16t\x1b[?1016$p${FOCUS_ON}`,
})

watch(PANES, (_, name) => {
  if (!FOLLOWS || `${PANES}/${name}` === s.paneFile) setTimeout(fx.readState, 30)
})
onTabChanged(() => setTimeout(fx.readState, 30), log)
fx.readState()
schedule()
