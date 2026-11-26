// frame() reads Settings, the instructions files and, while a path is typed,
// the folders it could complete to, and nothing else, so a test can draw any
// state.

import { existsSync } from 'node:fs'

import { tilde } from '../../core/paths.ts'
import { t } from '../../core/text.ts'
import { fileOf, instructions } from '../../settings/prompts.ts'
import { BUILTIN_MODES, type EnvLine, type FixedLine, type Heading, type Mode, type PromptLine, SECTIONS, type SettingRow, type Settings, load, settingsFile, show } from '../../settings/settings.ts'
import { type Hint, hintSpansAfter } from '../../tui/chrome.ts'
import { matchesOf } from '../../tui/complete.ts'
import { checks, chips, field, onOff, select, spanWidth } from '../../tui/controls.ts'
import { clampScroll } from '../../tui/list.ts'
import type { Size } from '../../tui/overlay.ts'
import { ACCENT, BOLD, type Line, P, type Span, bg, fg, render, split, width } from '../../tui/term.ts'
import { CLI, type ForgeId, onPath } from '../../core/forge.ts'
import { type JiraKey, envFile, envSet } from '../tickets/env.ts'
import { type FileInput, type Input, type Item, type SettingItem, type SettingsState, current, loginKey, logins, modeRows, pathGhost } from './state.ts'

export const NAV = 22
// Gap, the section's note, gap above the body; footer below it. The title
// is in the overlay frame's edge.
export const TOP = 3
export const BOTTOM = 1
export const VALUE = 30

export type { Size }
export type Frame = { lines: string[]; title: string[]; scroll: number }

const BASE = bg(P.base)
const SEL = bg(P.surface0)

export const bodyRows = (rows: number): number => Math.max(1, rows - TOP - BOTTOM)

const modeSub = (m: Mode): string => BUILTIN_MODES.find(b => b.id === m.id)?.sub ?? t('settings.ui.addedMode', { cmd: m.cmd ?? '' })

function valueSpans(r: SettingItem, values: Settings, on: boolean, flag: number, capture: boolean): Span[] {
  switch (r.type) {
    case 'key': {
      if (on && capture) return [[t('settings.ui.pressKey'), BOLD + fg(ACCENT)], [t('settings.ui.escCancels'), fg(P.sub)]]
      const v = values[r.key]
      return [[show(r, v), v ? (on ? BOLD : '') + fg(P.text) : fg(P.overlay1)]]
    }
    case 'bool':
      return onOff(values[r.key])
    // A long path keeps its end, which names the file.
    case 'file': {
      const v = values[r.key]
      const text = v.length > VALUE - 1 ? `…${v.slice(-(VALUE - 2))}` : show(r, v)
      return [[text, v ? (on ? BOLD : '') + fg(P.text) : fg(P.overlay1)]]
    }
    case 'flags':
      return checks(r.choices, values[r.key], on ? flag : -1)
    case 'hosts':
      return hostSpans(r.cli === 'gh' ? 'gh' : 'gl', values[r.key], on)
    case 'list': {
      const v = values[r.key]
      return [[show(r, v), v.length ? (on ? BOLD : '') + fg(P.text) : fg(P.overlay1)]]
    }
    case 'text': {
      const v = values[r.key]
      return [[show(r, v), v ? (on ? BOLD : '') + fg(P.text) : fg(P.overlay1)]]
    }
    default:
      return select(show(r, values[r.key]), on)
  }
}

// ✓ when the CLI is on PATH and logged in to the host, … while that is still
// being asked (askLogins).
function hostSpans(forge: ForgeId, hosts: readonly string[], on: boolean): Span[] {
  if (!hosts.length) return [[t('settings.ui.none'), fg(P.overlay1)]]
  const cli = onPath(CLI[forge])
  return hosts.flatMap((h, i): Span[] => {
    const login = cli ? logins.get(loginKey(forge, h)) : false
    return [
      [`${i ? '  ' : ''}${h} `, (on ? BOLD : '') + fg(P.text)],
      [CLI[forge], fg(P.overlay1)],
      login === undefined ? [' …', fg(P.overlay1)] : [login ? ' ✓' : ' ✗', fg(login ? P.green : P.peach)],
    ]
  })
}

// `at` is each row's first line, for scrolling.
type Body = { lines: string[]; at: number[] }

const twoLines = (name: Line, value: Line, sub: string, w: number, fill: string, vw = VALUE): string[] => [
  render(name, w - vw, fill) + render(value, vw, fill),
  render([[`  ${sub}`, fg(P.overlay1)]], w, fill),
]

function heading(b: Body, r: Heading, w: number): void {
  if (b.lines.length) b.lines.push(render([], w, BASE))
  b.lines.push(render([[r.head.toUpperCase(), BOLD + fg(ACCENT)]], w, BASE))
}

function prompt(b: Body, r: PromptLine, w: number): void {
  const count = instructions(r.prompt).split('\n').filter(l => l.trim()).length
  // Install copies it from its .example (after-link.sh).
  const value = !existsSync(fileOf(r.prompt)) ? t('settings.ui.noPromptFile') : count ? t('settings.ui.lines', { n: count }) : t('settings.ui.none')
  b.lines.push(...twoLines([[`  ${t('settings.ui.instructions')}`, fg(P.text)]], [[value, fg(count ? P.text : P.overlay1)]], tilde(fileOf(r.prompt)), w, BASE))
}

// Set or missing in .env, and where that file is; never the value.
function envRow(b: Body, r: EnvLine, w: number): void {
  const set = envSet()[r.env as JiraKey] ?? false
  const value: Span[] = [[set ? `✓ ${t('settings.ui.envSet')}` : `✗ ${t('settings.ui.envMissing')}`, fg(set ? P.green : P.peach)]]
  b.lines.push(...twoLines([[`  ${r.label}`, fg(P.text)]], value, [r.sub, tilde(envFile())].filter(Boolean).join(' · '), w, BASE))
}

function fixed(b: Body, r: FixedLine, w: number): void {
  b.lines.push(...twoLines([[`  ${r.label}`, fg(P.text)]], [[r.fixed, fg(P.sub)]], r.sub, w, BASE))
}

function modes(b: Body, r: Extract<SettingRow, { type: 'modes' }>, s: SettingsState, values: Settings, w: number): void {
  for (const m of modeRows(r, values)) {
    const on = b.at.length === s.sel
    const fill = on ? SEL : BASE
    const add = m.type === 'addMode'
    const name = add ? m.label : `⠿ ${m.index + 1}  ${m.label}`
    const value: Span[] = add ? [['a', fg(ACCENT)], [` ${t('hints.add')}`, fg(P.sub)]] : onOff(m.mode.on)
    b.at.push(b.lines.length)
    b.lines.push(...twoLines([['  '], [name, (on ? BOLD : '') + fg(add ? ACCENT : P.text)]], value, add ? t('settings.ui.addModeSub') : modeSub(m.mode), w, fill))
  }
  b.lines.push(render([[`  ${r.sub}`, fg(P.overlay1)]], w, BASE))
}

function setting(b: Body, r: SettingItem, s: SettingsState, values: Settings, w: number): void {
  const on = b.at.length === s.sel
  const fill = on ? SEL : BASE
  const v = values[r.key]
  const changed = JSON.stringify(v) !== JSON.stringify(r.default)
  const vw = r.type === 'flags' ? Math.min(w - 20, r.choices.reduce((n, c) => n + width(c.label) + 3, 0)) : VALUE
  const sub = changed ? [r.sub, t('settings.ui.changedFrom', { value: show(r, r.default) })].filter(Boolean).join(' · ') : r.sub
  b.at.push(b.lines.length)
  b.lines.push(
    ...twoLines([[changed ? '• ' : '  ', fg(ACCENT)], [r.label, (on ? BOLD : '') + fg(P.text)]], valueSpans(r, values, on, s.flag, s.capture), sub, w, fill, vw),
  )
}

function content(s: SettingsState, w: number, values: Settings): Body {
  const b: Body = { lines: [], at: [] }
  for (const r of SECTIONS[s.sec].rows) {
    if ('head' in r) heading(b, r, w)
    else if ('prompt' in r) prompt(b, r, w)
    else if ('fixed' in r) fixed(b, r, w)
    else if ('env' in r) envRow(b, r, w)
    else if (r.type === 'modes') modes(b, r, s, values, w)
    else setting(b, r, s, values, w)
  }
  return b
}

// Keeps the line above the selected setting in view too, so the first under
// a heading shows its heading.
function scrollFor(s: SettingsState, { lines, at }: Body, height: number): number {
  let scroll = s.scroll
  const first = at[s.sel] ?? 0
  if (s.sel === 0 || first - 1 < scroll) scroll = s.sel === 0 ? 0 : first - 1
  if (first + 1 >= scroll + height) scroll = first + 2 - height
  return clampScroll(scroll, lines.length, height)
}

function navRow(s: SettingsState, i: number): string {
  const on = i === s.sec
  return render([[` ${on ? '▸' : ' '} `, fg(ACCENT)], [SECTIONS[i].name, on ? BOLD + fg(P.text) : fg(P.sub)]], NAV - 1, on ? SEL : BASE)
}

const H = (k: string) => t(`hints.${k}`)
const K = (k: string) => t(`settings.ui.keys.${k}`)

function rowHints(r: Item, capture: boolean): Hint[] {
  switch (r.type) {
    case 'key':
      return capture
        ? [['esc', H('cancel')], ['backspace', K('unbind')]]
        : [['↵', K('pressNewKey')], ['backspace', K('unbind')]]
    case 'mode':
      return [['space', H('onOff')], ['J K', H('move')], ['x', H('remove')], ['a', H('add')]]
    case 'addMode':
      return [['↵', K('addMode')]]
    case 'file':
      return [['↵', K('typePath')], ['backspace', H('clear')]]
    case 'hosts':
      return [['↵', K('typeHosts')], ['backspace', H('clear')]]
    case 'list':
      return [['↵', K('typeList')], ['backspace', H('clear')]]
    case 'text':
      return [['↵', K('typeText')], ['backspace', H('clear')]]
    case 'flags':
      return [['←→', H('pick')], ['space', H('turnOnOff')]]
    case 'bool':
      return [['space', H('turnOnOff')]]
    default:
      return [['←→', H('change')]]
  }
}

function footer(s: SettingsState, w: number): string {
  const hints: Hint[] = [['↑↓', K('setting')], ['tab', K('section')], ...rowHints(current(s), s.capture), ['r', H('default')]]
  const right: Span[] = s.note ? [[`${s.note.text} `, fg(s.note.color)]] : [[`${t('settings.ui.savedTo', { file: tilde(settingsFile()) })} `, fg(P.overlay1)]]
  return split([[' '], ...hintSpansAfter(hints)], right, w, BASE)
}

function asking(input: Input): [ask: string, done: string] {
  if (input.field === 'file') return [t('settings.ui.askFile', { label: input.label }), t('hints.save')]
  if (input.field === 'hosts') return [t('settings.ui.askHosts', { label: input.label }), t('hints.save')]
  if (input.field === 'list') return [t('settings.ui.askList', { label: input.label }), t('hints.save')]
  if (input.field === 'text') return [t('settings.ui.askText', { label: input.label }), t('hints.save')]
  if (input.field === 'name') return [t('settings.ui.askName'), t('hints.next')]
  return [t('settings.ui.askCommand', { name: input.name }), t('hints.add')]
}

function promptLine(s: SettingsState, input: Input, w: number): string {
  const [question, done] = asking(input)
  const ask = ` ${question}`
  const keys = hintSpansAfter([...(input.field === 'file' ? [['tab', t('hints.complete')] as const] : []), ['↵', done], ['esc', t('hints.cancel')]])
  const right = s.note ? [[`${s.note.text} `, fg(s.note.color)] as const, ...keys] : keys
  const room = Math.max(1, w - spanWidth(right) - width(ask) - 1)
  const at = input.field === 'file' || input.field === 'hosts' || input.field === 'list' || input.field === 'text' ? input.at : undefined
  return split([[ask, BOLD + fg(ACCENT)], ...field({ text: input.text, at, w: room, ghost: pathGhost(input) })], right, w, BASE)
}

function matchesLine(input: FileInput, w: number): string | null {
  const { text, menu, files } = input
  const m = menu ?? matchesOf(text, { files })
  if (!menu && !m.part && !text.endsWith('/')) return null
  const shown = m.names.map(n => `${n}${m.folders.has(n) ? '/' : ''}`)
  const lead: Span[] = [[` ${t('settings.ui.matches')}  `, fg(ACCENT)]]
  return render(chips(shown, menu ? menu.i : -1, w, { lead, empty: t('settings.ui.noMatches') }), w, BASE)
}

export function frame(s: SettingsState, { cols: w, rows }: Size): Frame {
  const right = w - NAV - 2
  const height = bodyRows(rows)
  const body = content(s, right, load())
  const scroll = scrollFor(s, body, height)

  const lines = [
    render([], w, BASE),
    render([[` ${SECTIONS[s.sec].where}`, fg(P.sub)]], w, BASE),
    render([], w, BASE),
  ]
  for (let y = 0; y < height; y++) {
    const nav = y < SECTIONS.length ? navRow(s, y) : render([], NAV - 1, BASE)
    const more = y === height - 1 && scroll + height < body.lines.length
    const line = more ? render([[t('settings.ui.more'), fg(P.overlay1)]], right, BASE) : (body.lines[scroll + y] ?? render([], right, BASE))
    lines.push(`${nav}${render([['│', fg(P.surface0)]], 1, BASE)}${BASE} ${line}`)
  }
  // While a path is typed, the matches take the body's last line.
  const matches = s.input?.field === 'file' && matchesLine(s.input, w)
  if (matches) lines[lines.length - 1] = matches
  lines.push(s.input ? promptLine(s, s.input, w) : footer(s, w))
  return { lines: lines.slice(0, rows), title: [t('settings.ui.title'), SECTIONS[s.sec].name], scroll }
}
