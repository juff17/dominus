// Verdigris, the one palette every terminal UI draws with: oxidised copper on
// old iron, near-neutral greys with a faint cool cast. FG and BG are made
// once, for views that would otherwise build them on every frame.

import { t } from '../core/text.ts'

// A colour is its hex, #rrggbb.
const channels = (hex: string): number[] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const rgb = (hex: string): string => channels(hex).join(';')
export const fg = (hex: string): string => `\x1b[38;2;${rgb(hex)}m`
export const bg = (hex: string): string => `\x1b[48;2;${rgb(hex)}m`

// The greys keep Catppuccin's names (crust darkest to text lightest;
// subtext0 is `sub`), and each hue is named for what it looks like. Subtext1
// is left out: nothing here draws with it, and the colours contract test
// pins it as the tray's alone. What each hue means is STATE and MONITOR's,
// below: peach is what needs you, blue what's working, green what's done,
// rose a monitor watching.
export const P = {
  base: '#161818',
  mantle: '#101212',
  crust: '#0a0b0b',
  surface0: '#262b2a',
  surface1: '#373d3c',
  surface2: '#4a5351',
  overlay0: '#61706c',
  overlay1: '#738f87',
  overlay2: '#8aa59d',
  sub: '#a2bdb5',
  text: '#d9e9e3',
  patina: '#5fcca9',
  blue: '#86afe2',
  sapphire: '#73bbe2',
  sky: '#8fd3ea',
  rose: '#d98bc4',
  green: '#a6e35f',
  yellow: '#e6d27c',
  peach: '#ffa04d',
  red: '#f2647e',
  pink: '#eaa6d0',
  mauve: '#bb9ee2',
}

// Faint washes of green and red over base, behind added and removed lines
// and passed and failed checks.
export const TINT = {
  add: '#242c1f',
  del: '#2c2022',
  ok: '#20261d',
  bad: '#251d1f',
}

// The theme colour: focus, selection, titles, frames, buttons and keys, in
// every view. Change it here to retheme; the copies TypeScript can't reach
// (theme.conf for tmux, yazi's theme, the tray's palette.js, Ghostty's
// config.ghostty) are held to it by tests/contract/colours.test.mjs. The
// state colours below stay their own, so working stays blue.
export const ACCENT = P.patina
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
  watching: { glyph: '◉', color: P.rose, name: t('states.monitors.watching') },
  stale: { glyph: '◌', color: P.sub, name: t('states.monitors.stale') },
  ended: { glyph: '✓', color: P.sub, name: t('states.monitors.ended') },
} satisfies Record<string, Look>
export type StateName = keyof typeof STATE
export type MonitorName = keyof typeof MONITOR
