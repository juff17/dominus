// Catppuccin Mocha, the one palette every terminal UI draws with. FG and BG
// are made once, for views that would otherwise build them on every frame.

import { t } from '../core/text.ts'

// A colour is its hex, #rrggbb.
const channels = (hex: string): number[] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const rgb = (hex: string): string => channels(hex).join(';')
export const fg = (hex: string): string => `\x1b[38;2;${rgb(hex)}m`
export const bg = (hex: string): string => `\x1b[48;2;${rgb(hex)}m`

// Mocha's names, except subtext0, which is `sub`. Subtext1 (#bac2de) is
// left out: nothing here draws with it, and the colours contract test pins
// it as the tray's alone.
export const P = {
  base: '#1e1e2e',
  mantle: '#181825',
  crust: '#11111b',
  surface0: '#313244',
  surface1: '#45475a',
  surface2: '#585b70',
  overlay0: '#6c7086',
  overlay1: '#7f849c',
  overlay2: '#9399b2',
  sub: '#a6adc8',
  text: '#cdd6f4',
  blue: '#89b4fa',
  sapphire: '#74c7ec',
  sky: '#89dceb',
  teal: '#94e2d5',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  peach: '#fab387',
  red: '#f38ba8',
  pink: '#f5c2e7',
  mauve: '#cba6f7',
}

export const TINT = {
  add: '#292e37',
  del: '#2f2738',
  ok: '#1f2b26',
  bad: '#2b1f27',
}

// The theme colour: focus, selection, titles, frames, buttons and keys, in
// every view. Change it here to retheme; the copies TypeScript can't reach
// (theme.conf for tmux, yazi's theme, the tray's mocha.js) are held to it by
// tests/contract/colours.test.mjs. The state colours below stay their own,
// so working is blue even when the theme isn't.
export const ACCENT = P.blue
// Text drawn on an ACCENT fill.
export const ACCENT_INK = P.crust

export type ColorName = keyof typeof P
export type TintName = keyof typeof TINT

function sequences<K extends string>(colors: Record<K, string>, seq: (hex: string) => string): Record<K, string> {
  // fromEntries can't know the keys are the ones it was given.
  return Object.fromEntries(Object.entries<string>(colors).map(([name, hex]) => [name, seq(hex)])) as Record<K, string>
}

export const FG = sequences({ ...P, accent: ACCENT, accentInk: ACCENT_INK }, fg)
export const BG = sequences({ ...P, ...TINT, accent: ACCENT }, bg)

export const BOLD = '\x1b[1m'
export const ITALIC = '\x1b[3m'
export const UNDERLINE = '\x1b[4m'
export const STRIKE = '\x1b[9m'
export const RESET = '\x1b[0m'

// t of a over b, for the tinted header bars.
export const mix = (a: string, b: string, t: number): string => {
  const under = channels(b)
  return `#${channels(a)
    .map((c, i) => Math.round(c * t + under[i] * (1 - t)))
    .map(n => n.toString(16).padStart(2, '0'))
    .join('')}`
}

// The same on the board, the rail and the tmux tabs, so a state reads the
// same everywhere and without color too. Names are states.<state> and states.monitors.<state> in core/text.json.
export type Look = { glyph: string; color: string; name: string }
export const STATE = {
  needs: { glyph: '▲', color: P.peach, name: t('states.needs') },
  working: { glyph: '✻', color: P.blue, name: t('states.working') },
  done: { glyph: '✓', color: P.green, name: t('states.done') },
  idle: { glyph: '○', color: P.sub, name: t('states.idle') },
} satisfies Record<string, Look>
// A background agent with no process (agents/stopped.ts), in Idle.
export const STOPPED = { glyph: '■', color: P.overlay1, name: t('states.stopped') } satisfies Look
export const MONITOR = {
  action: { glyph: '▲', color: P.peach, name: t('states.monitors.action') },
  watching: { glyph: '◉', color: P.teal, name: t('states.monitors.watching') },
  stale: { glyph: '◌', color: P.sub, name: t('states.monitors.stale') },
  ended: { glyph: '✓', color: P.sub, name: t('states.monitors.ended') },
} satisfies Record<string, Look>
export type StateName = keyof typeof STATE
export type MonitorName = keyof typeof MONITOR
