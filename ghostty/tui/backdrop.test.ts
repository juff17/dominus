import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LAYOUT_SOCKET } from '../core/paths.ts'
import type { RunResult } from '../core/proc.ts'
import { type Missed, captureWindow, compose, frameBox, slice } from './backdrop.ts'

const ok = (out: string): RunResult => ({ ok: true, out, err: '', exit: 0 })

test('the frame takes its share of the screen, centered', () => {
  assert.deepEqual(frameBox(200, 60, { w: '85%', h: '85%' }), { left: 15, top: 4, w: 170, h: 51 })
  assert.deepEqual(frameBox(200, 60, { w: '70%', h: '50%' }), { left: 30, top: 15, w: 140, h: 30 })
})

test('a frame sized in cells keeps that size, but never more than the screen', () => {
  assert.deepEqual(frameBox(200, 60, { w: 80, h: 10 }), { left: 60, top: 25, w: 80, h: 10 })
  assert.deepEqual(frameBox(100, 30, { w: 120, h: 40 }), { left: 0, top: 0, w: 100, h: 30 })
})

test('a small screen gives the frame all of it', () => {
  assert.deepEqual(frameBox(60, 40, { w: '85%', h: '85%' }), { left: 0, top: 0, w: 60, h: 40 })
  assert.deepEqual(frameBox(200, 60, { w: '100%', h: '100%' }), { left: 0, top: 0, w: 200, h: 60 })
})

test('captureWindow lays out each pane of the window from the layout’s tmux', () => {
  const runs: string[][] = []
  const run = (args: string[]): RunResult => {
    runs.push(args)
    if (args.includes('list-panes')) return ok('%1 0 0 3 1\n%2 4 0 3 1\n')
    return ok(args.at(-1) === '%1' ? 'abc\n' : 'xyz\n')
  }
  const missed: Missed[] = []
  const grid = captureWindow('@5', 7, 1, run, why => missed.push(why))
  assert.deepEqual(
    grid.map(r => r.join('')),
    ['abc│xyz'],
  )
  assert.deepEqual(runs[0].slice(0, 6), ['tmux', '-L', LAYOUT_SOCKET, 'list-panes', '-t', '@5'])
  assert.deepEqual(missed, [])
})

test('captureWindow is blank with no window, and says why when tmux fails', () => {
  const missed: Missed[] = []
  const never = (): RunResult => assert.fail('ran tmux')
  assert.deepEqual(captureWindow('', 7, 1, never, why => missed.push(why)), [])
  assert.deepEqual(
    captureWindow('@5', 7, 1, () => ({ ok: false, out: '', err: 'no window', exit: 1 }), why => missed.push(why)),
    [],
  )
  assert.deepEqual(missed, [{ exit: 1, err: 'no window' }])
})

test('panes land where tmux draws them, with dividers between', () => {
  const grid = compose(
    [
      { left: 0, top: 0, width: 5, height: 1, lines: ['top'] },
      { left: 0, top: 2, width: 2, height: 1, lines: ['ab'] },
      { left: 3, top: 2, width: 2, height: 1, lines: ['cdef'] },
    ],
    5,
    3,
  )
  assert.deepEqual(
    grid.map(r => r.join('')),
    ['top  ', '─────', 'ab│cd'],
  )
})

test('picture placeholders become blanks', () => {
  const cell = '\u{10EEEE}̅̅'
  const grid = compose([{ left: 0, top: 0, width: 4, height: 1, lines: [`a${cell}${cell}b`] }], 4, 1)
  assert.equal(grid[0].join(''), 'a  b')
})

test('a wide character cut by a slice end becomes a blank', () => {
  const grid = compose([{ left: 0, top: 0, width: 4, height: 1, lines: ['a漢b'] }], 4, 1)
  assert.equal(slice(grid[0], 0, 4), 'a漢b')
  assert.equal(slice(grid[0], 0, 2), 'a ')
  assert.equal(slice(grid[0], 2, 4), ' b')
})
