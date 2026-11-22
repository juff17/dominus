import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Grid } from './backdrop.ts'
import { closeLabel, closes, compose, innerSize, mouseIn, overlayBox } from './overlay.ts'

// Plays the line's column moves and erases onto a row of cells, as a
// terminal would.
function cells(line: string, cols: number): string {
  const row = Array<string>(cols).fill('·')
  let c = 0
  for (const part of line.split(/(\x1b\[[0-9;]*[A-Za-z])/)) {
    const esc = /^\x1b\[([0-9;]*)([A-Za-z])$/.exec(part)
    if (!esc) {
      for (const ch of part) if (c < cols) row[c++] = ch
    } else if (esc[2] === 'G') c = Number(esc[1]) - 1
    else if (esc[2] === 'X') for (let i = c; i < Math.min(cols, c + Number(esc[1])); i++) row[i] = ' '
  }
  return row.join('')
}

const backdrop = (cols: number, rows: number): Grid => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, () => String(r % 10)))

test('the frame sits over the backdrop, the body inside it, the rest dimmed', () => {
  const size = { cols: 30, rows: 6 }
  const b = { left: 3, top: 1, w: 24, h: 4 }
  const lines = compose(backdrop(30, 6), size, b, { title: 'Hi', close: 'esc' }, ['body', 'x'])
  assert.deepEqual(
    lines.map(l => cells(l, 30)),
    [
      '000000000000000000000000000000',
      '111╭─ Hi ───── esc close ─╮111',
      '222│body                  │222',
      '333│x                     │333',
      '444╰──────────────────────╯444',
      '555555555555555555555555555555',
    ],
  )
})

test('a body line too long is cut by the right edge, and the backdrop beyond it stands', () => {
  const lines = compose(backdrop(12, 3), { cols: 12, rows: 3 }, { left: 2, top: 0, w: 8, h: 3 }, { title: '', close: 'esc' }, ['abcdefghijkl'])
  assert.equal(cells(lines[1], 12), '11│abcdef│11')
})

test('a body line places its cells by column from the frame’s inside', () => {
  const lines = compose([], { cols: 20, rows: 3 }, { left: 4, top: 0, w: 12, h: 3 }, { title: '', close: 'q' }, ['a\x1b[8Gz'])
  assert.equal(cells(lines[1], 20), '    │a      z  │    ')
})

test('with no backdrop the space round the frame is blank', () => {
  const lines = compose([], { cols: 10, rows: 3 }, { left: 2, top: 0, w: 6, h: 3 }, { title: '', close: 'q' }, [])
  assert.equal(cells(lines[1], 10), '  │    │  ')
})

test('the box is the spec’s share of the screen, and the view draws inside its edges', () => {
  const b = overlayBox({ cols: 100, rows: 40 }, { w: '80%', h: '50%' })
  assert.deepEqual(b, { left: 10, top: 10, w: 80, h: 20 })
  assert.deepEqual(innerSize(b), { cols: 78, rows: 18 })
})

test('a click inside reaches the view from its own 1, 1; outside or on the close hint closes', () => {
  const b = { left: 10, top: 5, w: 30, h: 10 }
  const press = (x: number, y: number) => mouseIn(b, { button: 0, x, y }, 'esc')
  // The first cell inside: column 12, row 7 counted from 1.
  assert.deepEqual(press(12, 7), { button: 0, x: 1, y: 1 })
  assert.deepEqual(press(39, 15 - 1), { button: 0, x: 28, y: 8 })
  assert.equal(press(1, 1), 'close')
  assert.equal(press(41, 7), 'close')
  // ' esc close ' sits just left of the corner's '─╮'.
  assert.equal(press(38, 6), 'close')
  assert.equal(press(28, 6), 'close')
  assert.equal(press(27, 6), null)
  // The edges and a release take nothing; nor does the wheel outside.
  assert.equal(press(11, 7), null)
  assert.equal(press(12, 15), null)
  assert.equal(mouseIn(b, { button: 0, x: 1, y: 1, up: true }, 'esc'), null)
  assert.equal(mouseIn(b, { button: 64, x: 1, y: 1 }, 'esc'), null)
})

test('Ctrl+C and the overlay’s own key close it, wherever Keybinds put that', () => {
  assert.ok(closes('\x03', 'keys.help', {}))
  assert.ok(closes('\x1bh', 'keys.help', { 'keys.help': 'alt+h' }))
  assert.ok(!closes('\x1bh', 'keys.help', { 'keys.help': 'alt+y' }))
  assert.ok(closes('\x1by', 'keys.help', { 'keys.help': 'alt+y' }))
  // A key turned off in Keybinds closes nothing.
  assert.ok(!closes('\x1bh', 'keys.help', { 'keys.help': '' }))
  assert.ok(!closes('\x1b', 'keys.help', { 'keys.help': 'alt+h' }))
})

test('the close hint names the own key, or esc when it has none', () => {
  assert.equal(closeLabel('keys.todo', { 'keys.todo': 'alt+t' }), 'alt+t')
  assert.equal(closeLabel('keys.todo', { 'keys.todo': '' }), 'esc')
})
