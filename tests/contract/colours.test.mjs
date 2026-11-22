// Contract: the Catppuccin Mocha colours in the tray's mocha.js, the hub's
// palette (tui/term.ts P) and state colours, and the hex values handed to tmux.
// Where they drift today, the test pins today's values.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

import { BIN, CONF, REPO } from '../harness.mjs'

const { P, STATE, MONITOR } = await import(join(CONF, 'tui/term.ts'))
const MOCHA_FILE = join(REPO, 'plasmoid', 'dev.dotfiles.agents', 'contents', 'ui', 'mocha.js')

// mocha.js is a QML .pragma library of vars; run it as a plain script.
function loadMocha() {
  const ctx = {}
  vm.runInNewContext(readFileSync(MOCHA_FILE, 'utf8').replace(/^\.pragma library$/m, ''), ctx)
  return ctx
}
const M = loadMocha()

// Catppuccin Mocha's names on each side: term.ts calls subtext0 `sub`.
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
  teal: 'teal',
}

test('mocha.js and term.ts P give each shared colour the same hex', () => {
  for (const [qml, node] of Object.entries(SAME)) assert.equal(M[qml].toLowerCase(), P[node], `${qml} / P.${node}`)
  // Each side has one the other lacks.
  assert.equal(M.subtext1, '#bac2de')
  assert.equal(Object.values(P).includes('#bac2de'), false)
  assert.equal(P.yellow, '#f9e2af')
  assert.equal(M.yellow, undefined)
})

test('the tray’s section colours match the hub’s state colours', () => {
  assert.equal(M.section.you, STATE.needs.color)
  assert.equal(M.section.you, MONITOR.action.color)
  assert.equal(M.section.broke, P.red)
  assert.equal(M.section.work, STATE.working.color)
  assert.equal(M.section.done, STATE.done.color)
  // ◉ watch is teal, as the hub draws a monitor watching.
  assert.equal(M.section.watch, MONITOR.watching.color)
  assert.equal(M.section.watch, P.teal)
  // The ~8% tint behind rows that need you is the section colour with alpha 0x14.
  assert.equal(M.tint.you, `#14${M.section.you.slice(1)}`)
  assert.equal(M.tint.broke, `#14${M.section.broke.slice(1)}`)
})

test('the state glyphs are the tray chip’s glyphs', () => {
  const chip = readFileSync(join(MOCHA_FILE, '..', 'Chip.qml'), 'utf8')
  const kinds = Object.fromEntries([...chip.matchAll(/\["(\w+)", "(.)", (?:true|false)\]/g)].map(m => [m[1], m[2]]))
  assert.deepEqual(kinds, { you: '▲', broke: '✗', work: '✻', watch: '◉', done: '✓' })
  assert.equal(kinds.you, STATE.needs.glyph)
  assert.equal(kinds.work, STATE.working.glyph)
  assert.equal(kinds.done, STATE.done.glyph)
  assert.equal(kinds.watch, MONITOR.watching.glyph)
})

// Every #rrggbb a tmux config or a bin/ script (or its bin/lib/ helpers) uses.
function hexes() {
  const files = ['layout.conf', 'tmux.conf'].map(f => join(CONF, f))
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
      '#11111b': 'crust',
      '#313244': 'surface0',
      '#45475a': 'surface1',
      '#7f849c': 'overlay1',
      '#89b4fa': 'blue',
      '#a6adc8': 'sub',
      '#cdd6f4': 'text',
      '#f38ba8': 'red',
      '#f9e2af': 'yellow',
    },
  )
  // Borders: blue for the active pane in both servers, except in the layout's
  // hub, whose dividers stay grey while a blue bar over the focused pane
  // shows focus. The popups' frames are drawn in TypeScript
  // (tui/overlay.ts), so their colours are P's already.
  for (const conf of ['layout.conf', 'tmux.conf']) {
    const text = readFileSync(join(CONF, conf), 'utf8')
    assert.match(text, /^set -g pane-border-style "fg=#45475a"$/m)
  }
  assert.match(readFileSync(join(CONF, 'tmux.conf'), 'utf8'), /^set -g pane-active-border-style "fg=#89b4fa"$/m)
  const layout = readFileSync(join(CONF, 'layout.conf'), 'utf8')
  assert.match(layout, /^set -g pane-active-border-style "#\{\?#\{==:#\{window_name\},hub\},fg=#45475a,fg=#89b4fa\}"$/m)
  assert.match(layout, /^set -g pane-border-format ".*#\[fg=#89b4fa\]#\{R:━,#\{pane_width\}\}/m)
  // lib/core.sh's overlay opens its borderless popup on crust, the dimmed window's
  // background, which paint_backdrop then draws the window on.
  assert.match(readFileSync(join(BIN, 'lib', 'core.sh'), 'utf8'), /display-popup .*-B .*-s "bg=#11111b"/)
  // A ringing tab is red, the colour of broke.
  assert.match(readFileSync(join(CONF, 'tmux.conf'), 'utf8'), /window-status-bell-style "bg=#f38ba8,/)
})
