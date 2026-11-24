import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ansi, button, checks, chips, confirm, field, frameBottom, frameRow, frameTop, header, keyName, onOff, pressAgain, radio, select, spanWidth } from './controls.ts'
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
  assert.equal(words(confirm('Stop it?', pressAgain('x'))), 'Stop it?  x yes  other keys no')
  assert.equal(words(confirm('Start it?', pressAgain('\x13', 'start it'))), 'Start it?  ctrl+s start it  other keys no')
})

test('keyName: control keys by their letter, Enter and Tab by name', () => {
  assert.equal(keyName('\x18'), 'ctrl+x')
  assert.equal(keyName('\x13'), 'ctrl+s')
  assert.equal(keyName('\r'), '\u21b5')
  assert.equal(keyName('\t'), 'tab')
  assert.equal(keyName('R'), 'R')
})

test('header, frame and ansi', () => {
  assert.match(plain(header(['Settings', 'Tray'], 40)), /^ Settings · Tray +esc close $/)
  assert.equal(plain(frameTop(20, { title: 'Hi', close: 'q' })), '╭─ Hi ─── q close ─╮')
  assert.equal(plain(frameBottom(6)), '╰────╯')
  assert.equal(plain(frameRow([['x']], 6)), '│ x  │')
  assert.equal(plain(ansi([['a', '\x1b[1m'], ['b']])), 'ab')
  assert.equal(plain(render(select('v', true), 10)), '‹ v ›     ')
})
