// Every popup is an overlay: a rounded frame over the window it opened from,
// dimmed (tui/backdrop.ts). tmux can't dim behind a popup, so each popup
// covers the whole window with no border of its own (bin/lib/core.sh overlay,
// hub/actions.ts) and draws all of that here. The overlay's own key has to
// be handled here too: tmux's bindings don't reach inside a popup.
//
// The pure parts are apart from openOverlay so tests can draw any frame.

import { logger } from '../core/log.ts'
import { type SyncRunner, runSync } from '../core/proc.ts'
import { type KeyName, altSeq } from '../settings/keybinds.ts'
import { load } from '../settings/settings.ts'
import { type Box, type BoxSpec, type Grid, captureWindow, frameBox, slice } from './backdrop.ts'
import { type HeaderTitle, closeHintWidth, frameBottom, frameTop, titleText } from './controls.ts'
import { type Mouse, leftPress } from './input.ts'
import { ACCENT, P, RESET, bg, fg } from './palette.ts'
import { type PaintOptions, type ScreenModes, enter, leave, paint } from './screen.ts'

export type { Box, BoxSpec, Grid }
export type Size = { cols: number; rows: number }
// color is the edge's, the theme's ACCENT by default.
export type Look = { title: HeaderTitle; close: string; color?: string }
type KeyValues = Partial<Record<KeyName, string>>

// The window behind, dimmed as tmux dims an inactive pane's text.
const DIM = fg(P.surface1) + bg(P.crust)
const INNER = bg(P.base)
const CTRL_C = '\x03'

export const overlayBox = (size: Size, spec: BoxSpec): Box => frameBox(size.cols, size.rows, spec)
export const innerSize = (b: Box): Size => ({ cols: Math.max(1, b.w - 2), rows: Math.max(1, b.h - 2) })

export const closeLabel = (own: KeyName, values: KeyValues = load()): string => values[own] || 'esc'

// Esc and q are the view's to decide, as they may mean something else first
// (leaving a filter, cancelling an edit).
export const closes = (key: string, own: KeyName, values: KeyValues = load()): boolean => {
  const spec = values[own]
  return key === CTRL_C || Boolean(spec && key === altSeq(spec))
}

// Each row is erased to the frame's background before its line, and the
// right edge placed by column, so a body line may be short. A line may place
// its cells by column (\e[nG, as Todo's right-hand text and the diagrams'
// picture do) counting from the frame's inside, as on a screen of its own.
export function compose(backdrop: Grid, size: Size, b: Box, look: Look, body: readonly string[]): string[] {
  const color = look.color ?? ACCENT
  const edge = `${fg(color)}│${RESET}`
  const right = b.left + b.w
  const dim = (r: number, from: number, to: number): string => (from < to ? `\x1b[${from + 1}G${DIM}${slice(backdrop[r], from, to)}${RESET}` : '')
  const inside = (line: string): string => line.replace(/\x1b\[(\d*)G/g, (_, n: string) => `\x1b[${Number(n || 1) + b.left + 1}G`)
  const top = frameTop(b.w, { title: titleText(look.title), close: look.close, color })
  const bottom = frameBottom(b.w, { color })
  const lines: string[] = []
  for (let r = 0; r < size.rows; r++) {
    const k = r - b.top
    if (k < 0 || k >= b.h) {
      lines.push(dim(r, 0, size.cols))
      continue
    }
    const row = k === 0 ? top : k === b.h - 1 ? bottom : `${edge}${INNER}\x1b[${b.w - 2}X${inside(body[k - 1] ?? '')}${RESET}\x1b[${right}G${edge}`
    lines.push(`${dim(r, 0, b.left)}\x1b[${b.left + 1}G${row}${dim(r, right, size.cols)}`)
  }
  return lines
}

// Inside the frame, as the view sees it (its first cell is 1, 1); 'close' for
// a click outside the frame or on its close hint; null for anything else.
export function mouseIn(b: Box, m: Mouse, close: string): Mouse | 'close' | null {
  const c = m.x - 1
  const r = m.y - 1
  const press = leftPress(m)
  if (c < b.left || c >= b.left + b.w || r < b.top || r >= b.top + b.h) return press ? 'close' : null
  if (r === b.top) {
    const end = b.left + b.w - 2
    return press && c >= end - closeHintWidth(close) && c < end ? 'close' : null
  }
  if (r === b.top + b.h - 1 || c === b.left || c === b.left + b.w - 1) return null
  return { ...m, x: c - b.left, y: r - b.top }
}

export type OverlaySpec = {
  name: string
  // The Keybinds row of the key that opens it, which closes it too.
  key: KeyName
  // Read again on every draw so Settings can change it.
  box: () => BoxSpec
  color?: string
  screen?: ScreenModes
  // A layout window's id (@5), from the popup's OV_UNDER. None draws a blank
  // backdrop.
  under?: string
  run?: SyncRunner
}

export type Overlay = {
  size: () => Size
  box: () => Box
  close: () => string
  paint: (body: readonly string[], title: HeaderTitle, opts?: PaintOptions) => void
  mouse: (m: Mouse) => Mouse | 'close' | null
  closes: (key: string) => boolean
  // The keys come as read, undecoded: a long paste can end a read inside a
  // character, which tui/input.ts's tokenizer holds for the next.
  start: (onData: (data: Buffer) => void, draw: () => void) => void
  quit: (code?: number) => never
}

export function openOverlay(spec: OverlaySpec): Overlay {
  const log = logger(spec.name)
  const run = spec.run ?? runSync
  const under = spec.under ?? process.env.OV_UNDER ?? ''
  let backdrop: Grid = []
  const screen = (): Size => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })
  const box = (): Box => overlayBox(screen(), spec.box())
  const close = (): string => closeLabel(spec.key)
  const capture = (): void => {
    const { cols, rows } = screen()
    backdrop = captureWindow(under, cols, rows, run, why => log.warn('backdrop not captured', { id: under, ...why }))
  }
  const quit = (code = 0): never => {
    leave(spec.screen)
    process.exit(code)
  }
  return {
    size: () => innerSize(box()),
    box,
    close,
    paint: (body, title, opts) => paint(compose(backdrop, screen(), box(), { title, close: close(), color: spec.color }, body), opts),
    mouse: m => mouseIn(box(), m, close()),
    closes: key => closes(key, spec.key),
    start(onData, draw) {
      if (!process.stdin.isTTY) {
        console.error(`${spec.name} needs a terminal.`)
        process.exit(1)
      }
      capture()
      process.stdin.setRawMode(true)
      process.stdin.on('data', (data: Buffer) => onData(data))
      process.stdout.on('resize', () => {
        capture()
        draw()
      })
      process.on('SIGTERM', () => quit())
      process.on('SIGHUP', () => quit())
      enter(spec.screen)
      draw()
    },
    quit,
  }
}
