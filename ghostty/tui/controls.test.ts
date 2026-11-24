import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ansi, button, card, checks, chips, confirm, field, frameBottom, frameRow, frameTop, header, laneHeader, onOff, radio, select, spanWidth } from './controls.ts'
import { type Line, render } from './term.ts'

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
const words = (spans: Line): string => spans.map(([s]) => s).join('')

test('radio marks the chosen option, with digit keys when given', () => {
  assert.equal(words(radio([{ label: 'Task' }, { label: 'Monitor' }], 1)), '○ Task   ● Monitor')
  assert.equal(words(radio([{ label: 'a', key: 1 }, { label: 'b', key: 2 }], 0)), '1 ● a   2 ○ b')
})

test('select shows its value between arrows, focused or not', () => {
  assert.equal(words(select('opus', true)), '‹ opus ›')
  assert.equal(words(select('opus', false)), '‹ opus ›')
  assert.notDeepEqual(select('opus', true), select('opus', false))
})

test('onOff and checks', () => {
  assert.equal(words(onOff(true)), '● on')
  assert.equal(words(onOff(false)), '○ off')
  const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]
  assert.equal(words(checks(opts, ['b'])), '□ A ■ B')
})

test('a field cuts round its caret and fits its width', () => {
  const long = 'abcdefghijklmnopqrstuvwxyz'
  assert.equal(spanWidth(field({ text: long, at: 20, w: 10 })), 10)
  assert.match(words(field({ text: long, at: 20, w: 10 })), /u/)
  assert.equal(words(field({ text: '', w: 12, placeholder: 'type here' })), ' type here')
  assert.equal(words(field({ text: '', w: 12, placeholder: 'type here', focused: false })), 'type here')
  // A suggestion's rest is drawn after the text, its first character as the caret.
  assert.equal(words(field({ text: '~/pro', w: 20, ghost: 'jects/' })), '~/projects/')
})

test('chips keep the picked one in view and count the rest', () => {
  const names = Array.from({ length: 12 }, (_, i) => `name${i}`)
  const shown = words(chips(names, 10, 40))
  assert.match(shown, / name10 /)
  assert.match(shown, /^… /)
  assert.ok(spanWidth(chips(names, 0, 40)) <= 40)
  assert.match(words(chips(names, 0, 40)), /\+\d+ more$/)
  assert.equal(words(chips([], -1, 40, { lead: [['Matches ']], empty: 'none' })), 'Matches none')
})

test('button and confirm', () => {
  assert.equal(words(button('Push', { key: 'a', main: true })), ' Push a ')
  assert.equal(words(button('Push', { key: 'a', main: true, round: true })), '\ue0b6 Push a \ue0b4')
  assert.equal(words(confirm('Stop it?')), 'Stop it?  y yes  n no')
})

test('header, frame and ansi', () => {
  assert.match(plain(header(['Settings', 'Tray'], 40)), /^ Settings · Tray +esc close $/)
  assert.equal(plain(frameTop(20, { title: 'Hi', close: 'q' })), '╭─ Hi ─── q close ─╮')
  assert.equal(plain(frameBottom(6)), '╰────╯')
  assert.equal(plain(frameRow([['x']], 6)), '│ x  │')
  assert.equal(plain(ansi([['a', '\x1b[1m'], ['b']])), 'ab')
  assert.equal(plain(render(select('v', true), 10)), '‹ v ›     ')
})

test('card puts its title and note in the top edge, and every row is its width', () => {
  const rows = card([[' ENG-1 story']], [[' 3 pts · 2d ']], [[['Retry failed webhooks']], { left: [['✻ working']], right: [['1h']] }], 30, { border: '#373d3c', fill: '' })
  assert.equal(rows.length, 4)
  assert.match(plain(rows[0]), /^╭─ ENG-1 story─+ 3 pts · 2d ─╮$/)
  assert.match(plain(rows[1]), /^│ Retry failed webhooks +│$/)
  assert.match(plain(rows[2]), /^│ ✻ working +1h │$/)
  assert.match(plain(rows[3]), /^╰─+╯$/)
  for (const r of rows) assert.equal(plain(r).length, 30)
})

test('laneHeader shows the name and the count, and a look with no glyph has no gap for one', () => {
  assert.match(plain(laneHeader({ glyph: '✻', color: '#86afe2', name: 'Working' }, 3, 24)), / ✻ Working\s+3\s/)
  assert.match(plain(laneHeader({ glyph: '', color: '#a2bdb5', name: 'To Do' }, 4, 24)), /[^✻] To Do\s+4\s/)
})
