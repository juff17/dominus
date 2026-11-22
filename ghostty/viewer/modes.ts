#!/usr/bin/env node
// bin/ghostty-viewer runs one mode at a time and tells it the modes that are
// on through the environment: GV_MODES, their names joined by tabs, and
// GV_AT, which of them it is. A mode exits with FIRST_EXIT + i to switch the
// pane to mode i, or with GV_QUIT's code for q (0 closes the pane).
// `popup <id>` prints on or off rather than exiting with it, as a crash exits 1 too.

import { load, modeName, type Settings } from '../settings/settings.ts'

export const FIRST_EXIT = 10

// cmd is '' for a built-in mode.
export type OnMode = { id: string; name: string; cmd: string }

export type PaneModes = {
  names: string[]
  at: number
  exitOf: (i: number) => number
  next: number
  quit: number
  alone: boolean
}

export type ModeTab = { label: string; i: number }

export const onModes = (values: Settings = load()): OnMode[] =>
  values['workspace.modes'].filter(m => m.on).map(m => ({ id: m.id, name: modeName(m), cmd: m.cmd ?? '' }))

export function startMode(values: Settings = load()): string {
  const on = onModes(values)
  const want = values['workspace.startMode']
  return (on.find(m => m.id === want) ?? on[0]).id
}

// Whether Alt+T (todo) or Alt+D (diagrams) opens its popup: always while the
// mode is on, and while it's off unless Settings says the key goes off too.
export const popupOpens = (id: string, values: Settings = load()): boolean =>
  values['workspace.popupsWhenOff'] === 'works' || values['workspace.modes'].some(m => m.id === id && m.on)

// Run on its own, outside the viewer, a view has just its own tab and
// switches nowhere (codes of 0).
export function paneModes(self: string, env: Record<string, string | undefined> = process.env): PaneModes {
  const names = env.GV_MODES ? env.GV_MODES.split('\t') : []
  const at = Number(env.GV_AT)
  if (!names.length || !Number.isInteger(at) || at < 0 || at >= names.length)
    return { names: [self], at: 0, exitOf: () => 0, next: 0, quit: 0, alone: true }
  return {
    names,
    at,
    exitOf: (i: number) => (i === at || i < 0 || i >= names.length ? 0 : FIRST_EXIT + i),
    next: names.length > 1 ? FIRST_EXIT + ((at + 1) % names.length) : 0,
    quit: Number(env.GV_QUIT) || 0,
    alone: false,
  }
}

export const tabs = (pane: Pick<PaneModes, 'names'>): ModeTab[] => pane.names.map((name, i) => ({ label: ` ${name} `, i }))

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'list') for (const m of onModes()) console.log([m.id, m.name, m.cmd].join('\t'))
  else if (cmd === 'start') console.log(startMode())
  else if (cmd === 'popup') console.log(popupOpens(arg) ? 'on' : 'off')
  else {
    console.error('modes.ts list | start | popup <id>')
    process.exit(2)
  }
}
