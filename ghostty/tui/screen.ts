// A view picks the modes it needs:
//   drag    motion reports while a button is held (1002)
//   pixels  SGR mouse positions in pixels where the terminal has them (1016)
//   paste   bracketed paste (2004), on unless turned off
// Clicks are always reported, in SGR form (1000, 1006).
//
// A view that crashes never reaches its leave(), and the pane outlives it:
// bin/ghostty-viewer's "press any key" and the next mode would get mouse
// reports and pastes as keys. So enter() also gives the terminal back on a
// crash, and turns off whatever modes a crashed view before it left on.

import { errorMessage, logger } from '../core/log.ts'

const log = logger('screen')

export type ScreenModes = { drag?: boolean; pixels?: boolean; paste?: boolean }
export type PaintOptions = { clear?: boolean; before?: string }

export const out = (s: string): boolean => process.stdout.write(s)

const modes = ({ drag = false, pixels = false, paste = true }: ScreenModes): number[] => [1000, ...(drag ? [1002] : []), 1006, ...(pixels ? [1016] : []), ...(paste ? [2004] : [])]
// Every mode a view here, or yazi before it in the viewer pane, turns on:
// focus reports (1004) too, which Diagrams turns on itself.
const ALL_MODES = [1000, 1002, 1003, 1004, 1006, 1016, 2004]

const on = (ms: number[]): string => ms.map(m => `\x1b[?${m}h`).join('')
const off = (ms: number[]): string => ms.map(m => `\x1b[?${m}l`).join('')

export const enterSeq = (opts: ScreenModes = {}): string => {
  const used = modes(opts)
  return `\x1b[?1049h\x1b[?25l${off(ALL_MODES.filter(m => !used.includes(m)))}${on(used)}`
}
export const leaveSeq = (opts: ScreenModes = {}): string => `${off(modes(opts).reverse())}\x1b[?25h\x1b[?1049l`
// Every mode off, whichever were on, for after a crash.
export const resetSeq = (): string => `${off(ALL_MODES.toReversed())}\x1b[?25h\x1b[?1049l`

// Whether the terminal is taken over now, so a crash after leave() (or
// before enter()) writes nothing.
let entered = false
let watching = false

// Runs ahead of Node's own crash report, as core/crash.ts's log does. A
// process with an uncaughtException handler goes on running, so its screen
// is left alone. A TTY write is synchronous, so it lands before the exit.
function restoreOnCrash(): void {
  if (!entered || process.listenerCount('uncaughtException') > 0) return
  entered = false
  try {
    out(resetSeq())
  } catch (e) {
    log.warn('restore failed', { err: errorMessage(e) })
  }
}

export const enter = (opts: ScreenModes = {}, then = ''): boolean => {
  entered = true
  if (!watching) {
    watching = true
    process.on('uncaughtExceptionMonitor', restoreOnCrash)
  }
  return out(enterSeq(opts) + then)
}
export const leave = (opts: ScreenModes = {}): boolean => {
  entered = false
  return out(leaveSeq(opts))
}

// One write inside synchronized output (2026), so a redraw never flickers.
// `clear` is for views whose lines don't fill the width.
export function frame(lines: readonly string[], { clear = false, before = '' }: PaintOptions = {}): string {
  const erase = clear ? '\x1b[2K' : ''
  let s = `\x1b[?2026h${before}`
  lines.forEach((line, i) => {
    s += `\x1b[${i + 1};1H${erase}${line}`
  })
  return `${s}\x1b[?2026l`
}

export const paint = (lines: readonly string[], opts?: PaintOptions): boolean => out(frame(lines, opts))
