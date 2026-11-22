// Contract: the Verdigris colours in the tray's palette.js, the hub's palette
// (tui/term.ts P) and state colours, and the hex values handed to tmux, yazi
// and Ghostty. Where they drift today, the test pins today's values.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

import { BIN, CONF, REPO } from '../harness.mjs'

const { ACCENT, ACCENT_INK, P, STATE, MONITOR } = await import(join(CONF, 'tui/term.ts'))
const TRAY_FILE = join(REPO, 'plasmoid', 'dev.dotfiles.agents', 'contents', 'ui', 'palette.js')

// palette.js is a QML .pragma library of vars; run it as a plain script.
function loadTray() {
  const ctx = {}
  vm.runInNewContext(readFileSync(TRAY_FILE, 'utf8').replace(/^\.pragma library$/m, ''), ctx)
  return ctx
}
const M = loadTray()

// The same names on each side, except that term.ts calls subtext0 `sub`.
const SAME = {
  crust: 'crust',
  mantle: 'mantle',
  base: 'base',
  surface0: 'surface0',
  surface1: 'surface1',
  overlay0: 'overlay0',
  overlay1: 'overlay1',
  subtext0: 'sub',
  text: 'text',
  blue: 'blue',
  peach: 'peach',
  red: 'red',
  green: 'green',
  mauve: 'mauve',
  rose: 'rose',
  patina: 'patina',
}

test('palette.js and term.ts P give each shared colour the same hex', () => {
  for (const [qml, node] of Object.entries(SAME)) assert.equal(M[qml].toLowerCase(), P[node], `${qml} / P.${node}`)
  // Each side has one the other lacks.
  assert.equal(M.subtext1, '#bed3cc')
  assert.equal(Object.values(P).includes('#bed3cc'), false)
  assert.equal(P.yellow, '#e6d27c')
  assert.equal(M.yellow, undefined)
})

test('the tray’s section colours match the hub’s state colours', () => {
  assert.equal(M.section.you, STATE.needs.color)
  assert.equal(M.section.you, MONITOR.action.color)
  assert.equal(M.section.broke, P.red)
  assert.equal(M.section.work, STATE.working.color)
  assert.equal(M.section.done, STATE.done.color)
  // ◉ watch is rose, as the hub draws a monitor watching.
  assert.equal(M.section.watch, MONITOR.watching.color)
  assert.equal(M.section.watch, P.rose)
  // The ~8% tint behind rows that need you is the section colour with alpha 0x14.
  assert.equal(M.tint.you, `#14${M.section.you.slice(1)}`)
  assert.equal(M.tint.broke, `#14${M.section.broke.slice(1)}`)
  // The chip's ring while something needs you is that colour too, at 0x38.
  assert.match(readFileSync(join(TRAY_FILE, '..', 'Chip.qml'), 'utf8'), new RegExp(`border\\.color: "#38${M.section.you.slice(1)}"`))
})

test('the state glyphs are the tray chip’s glyphs', () => {
  const chip = readFileSync(join(TRAY_FILE, '..', 'Chip.qml'), 'utf8')
  const kinds = Object.fromEntries([...chip.matchAll(/\["(\w+)", "(.)", (?:true|false)\]/g)].map(m => [m[1], m[2]]))
  assert.deepEqual(kinds, { you: '▲', broke: '✗', work: '✻', watch: '◉', done: '✓' })
  assert.equal(kinds.you, STATE.needs.glyph)
  assert.equal(kinds.work, STATE.working.glyph)
  assert.equal(kinds.done, STATE.done.glyph)
  assert.equal(kinds.watch, MONITOR.watching.glyph)
})

// Every #rrggbb a tmux config or a bin/ script (or its bin/lib/ helpers) uses.
function hexes() {
  const files = ['layout.conf', 'tmux.conf', 'theme.conf'].map(f => join(CONF, f))
  for (const dir of [BIN, join(BIN, 'lib')]) for (const d of readdirSync(dir)) if (statSync(join(dir, d)).isFile()) files.push(join(dir, d))
  const out = {}
  for (const f of files)
    for (const m of readFileSync(f, 'utf8').matchAll(/#[0-9a-fA-F]{6}\b/g)) (out[m[0].toLowerCase()] ??= new Set()).add(f.slice(CONF.length + 1))
  return out
}

test('every hex the tmux configs and the popup scripts use is a term.ts P colour', () => {
  const used = hexes()
  const name = Object.fromEntries(Object.entries(P).map(([k, v]) => [v, k]))
  assert.deepEqual(
    Object.fromEntries(Object.keys(used).sort().map(h => [h, name[h] ?? null])),
    {
      '#0a0b0b': 'crust',
      '#262b2a': 'surface0',
      '#373d3c': 'surface1',
      '#5fcca9': 'patina',
      '#738f87': 'overlay1',
      '#a2bdb5': 'sub',
      '#d9e9e3': 'text',
      '#e6d27c': 'yellow',
      '#f2647e': 'red',
    },
  )
  // Borders: the theme colour for the active pane in both servers, except in
  // the layout's hub, whose dividers stay grey while a bar in the theme colour
  // over the focused pane shows focus. The popups' frames are drawn in
  // TypeScript (tui/overlay.ts), so their colours are P's already.
  for (const conf of ['layout.conf', 'tmux.conf']) {
    const text = readFileSync(join(CONF, conf), 'utf8')
    assert.match(text, /^set -g pane-border-style "fg=#373d3c"$/m)
  }
  assert.match(readFileSync(join(CONF, 'tmux.conf'), 'utf8'), /^set -g pane-active-border-style "fg=#\{@accent\}"$/m)
  const layout = readFileSync(join(CONF, 'layout.conf'), 'utf8')
  assert.match(layout, /^set -g pane-active-border-style "#\{\?#\{==:#\{window_name\},hub\},fg=#373d3c,fg=#\{@accent\}\}"$/m)
  assert.match(layout, /^set -g pane-border-format ".*#\[fg=#\{@accent\}\]#\{R:━,#\{pane_width\}\}/m)
  // lib/core.sh's overlay opens its borderless popup on crust, the dimmed window's
  // background, which paint_backdrop then draws the window on.
  assert.match(readFileSync(join(BIN, 'lib', 'core.sh'), 'utf8'), /display-popup .*-B .*-s "bg=#0a0b0b"/)
  // A ringing tab is red, the colour of broke.
  assert.match(readFileSync(join(CONF, 'tmux.conf'), 'utf8'), /window-status-bell-style "bg=#f2647e,/)
})

// The theme colour is ACCENT in tui/palette.ts. What can't import it keeps a
// copy, so a new theme is ACCENT plus these, and this names any left behind.
test('every copy of the theme colour outside TypeScript is ACCENT', () => {
  const theme = readFileSync(join(CONF, 'theme.conf'), 'utf8')
  assert.match(theme, new RegExp(`^set -g @accent "${ACCENT}"$`, 'm'))
  assert.match(theme, new RegExp(`^set -g @accent_ink "${ACCENT_INK}"$`, 'm'))
  for (const conf of ['layout.conf', 'tmux.conf']) {
    assert.match(readFileSync(join(CONF, conf), 'utf8'), /^source-file -F "#\{d:current_file\}\/theme\.conf"$/m, conf)
  }
  // The terminal popup's border asks the layout server for it.
  assert.match(readFileSync(join(BIN, 'ghostty-term'), 'utf8'), /display-popup .*-S "fg=\$\(layout show -gv @accent /)
  const lua = readFileSync(join(CONF, 'yazi', 'init.lua'), 'utf8')
  assert.match(lua, new RegExp(`^local ACCENT, ACCENT_INK = "${ACCENT}", "${ACCENT_INK}"$`, 'm'))
  const toml = readFileSync(join(CONF, 'yazi', 'theme.toml'), 'utf8')
  for (const key of ['cwd', 'normal_alt']) assert.match(toml, new RegExp(`^${key} += \\{ fg = "${ACCENT}"`, 'm'), key)
  for (const key of ['parent', 'current', 'normal_main']) {
    assert.match(toml, new RegExp(`^${key} += \\{ fg = "${ACCENT_INK}", bg = "${ACCENT}"`, 'm'), key)
  }
  assert.match(toml, new RegExp(`\\{ url = "\\*/", fg = "${ACCENT}"`), 'folders')
  assert.equal(M.accent, ACCENT)
})

// Ghostty draws the terminal itself in the palette too, so the tabs, shells
// and Claude Code sit on the hub's background.
test('config.ghostty draws the terminal in the hub palette', () => {
  const conf = readFileSync(join(CONF, 'config.ghostty'), 'utf8')
  const get = key => conf.match(new RegExp(`^${key} = (#[0-9a-f]{6})$`, 'm'))?.[1]
  assert.doesNotMatch(conf, /^theme = /m)
  assert.equal(get('background'), P.base)
  assert.equal(get('foreground'), P.text)
  assert.equal(get('cursor-color'), ACCENT)
  assert.equal(get('cursor-text'), ACCENT_INK)
  const ansi = Object.fromEntries([...conf.matchAll(/^palette = (\d+)=(#[0-9a-f]{6})$/gm)].map(m => [Number(m[1]), m[2]]))
  assert.equal(Object.keys(ansi).length, 16)
  const hues = [P.red, P.green, P.yellow, P.blue, P.rose, P.patina]
  hues.forEach((hex, i) => {
    assert.equal(ansi[i + 1], hex, `ANSI ${i + 1}`)
    assert.equal(ansi[i + 9], hex, `ANSI ${i + 9}`)
  })
  assert.deepEqual([ansi[0], ansi[7], ansi[8], ansi[15]], [P.surface1, M.subtext1, P.overlay0, P.sub])
})
