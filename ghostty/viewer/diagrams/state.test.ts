import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Mouse } from '../../tui/input.ts'
import type { Diagram } from './diagram.ts'
import { type DiagramState, type Size, chipLine, config, createState, mouseAction, pictureTop, region, select } from './state.ts'

// Its own settings file, so the defaults hold.
process.env.AGENT_HUB_SETTINGS = join(mkdtempSync(join(tmpdir(), 'dv-state-')), 'settings.json')

const SIZE: Size = { cols: 100, rows: 30 }
const VIEWER = { GV_MODES: 'Files\tDiagrams', GV_AT: '1', GV_QUIT: '10' }
const press = (x: number, y: number, more: Partial<Mouse> = {}): Mouse => ({ button: 0, x, y, released: false, ...more })

function withDiagrams(env: NodeJS.ProcessEnv, n: number): DiagramState {
  const s = createState(config(env))
  s.list = { diagrams: Array.from({ length: n }, (_, i) => ({ title: `d${i}`, file: `/${i}.png`, width: 800, height: 600 }) as Diagram), current: 0 }
  return s
}

test('config: DV_TABS follows a session, DV_PANE pins a pane, neither follows nothing', () => {
  const tabs = config({ DV_TABS: 'sock:ghostty-1', XDG_CACHE_HOME: '/c' })
  assert.equal(tabs.tabsSocket, 'sock')
  assert.equal(tabs.tabsSession, 'ghostty-1')
  assert.equal(tabs.follows, true)
  assert.equal(tabs.panes, '/c/claude-diagram-pane/panes')
  const pin = config({ DV_PANE: 'lay:%7' })
  assert.deepEqual([pin.pinSocket, pin.pinPane, pin.follows], ['lay', '%7', true])
  const job = config({ DV_JOB: 'ab12cd34', DV_TITLE: 'fix the hub' })
  assert.deepEqual([job.job, job.jobTitle, job.follows], ['ab12cd34', 'fix the hub', true])
  assert.equal(config({}).follows, false)
})

test('config: the viewer pane has a header row; the diagrams window a frame and no header', () => {
  const pane = config(VIEWER)
  assert.deepEqual([pane.header, pane.edge, pane.share, pane.above, pane.below], [true, 0, 100, 2, 1])
  assert.deepEqual(
    pane.modes.map(m => m.exit),
    [10, 0],
  )
  const win = config({ ...VIEWER, DV_FRAME: '1' })
  assert.deepEqual([win.header, win.edge, win.share, win.above, win.below], [false, 1, 85, 2, 2])
})

test('the picture starts under the chips, and its region is what the frame leaves', () => {
  const s = createState(config(VIEWER))
  assert.equal(pictureTop(s, SIZE), 3)
  assert.equal(chipLine(s, SIZE), 2)
  assert.deepEqual(region(s, SIZE), { cols: 100, rows: 27, cw: 10, ch: 20 })
})

test('select clamps to the list and starts from the home view, or none', () => {
  const s = withDiagrams({}, 2)
  select(s, 5)
  assert.equal(s.index, 1)
  assert.deepEqual(s.view, { zoom: 1, cx: 400, cy: 300 })
  s.list = { diagrams: [], current: 0 }
  select(s, 0)
  assert.equal(s.view, undefined)
})

test('the wheel zooms in and out about the pointer', () => {
  const s = createState(config({}))
  assert.deepEqual(mouseAction(s, SIZE, press(1, 2, { button: 64 })), { act: 'zoom', dir: 1, at: { px: 5, py: 10 } })
  assert.deepEqual(mouseAction(s, SIZE, press(1, 2, { button: 65 })), { act: 'zoom', dir: -1, at: { px: 5, py: 10 } })
})

test('a press grabs the picture, a drag moves it, a release lets go', () => {
  const s = createState(config({}))
  assert.equal(mouseAction(s, SIZE, press(30, 15))?.act, 'grab')
  assert.equal(mouseAction(s, SIZE, press(30, 15, { button: 32 }))?.act, 'drag')
  assert.deepEqual(mouseAction(s, SIZE, press(30, 15, { released: true })), { act: 'release' })
  assert.equal(mouseAction(s, SIZE, press(30, 15, { button: 2 })), undefined, 'the right button does nothing')
})

test('a click on a mode tab exits with its code; on its own tab it grabs', () => {
  const s = createState(config(VIEWER))
  assert.deepEqual(mouseAction(s, SIZE, press(2, 1)), { act: 'quit', code: 10 })
  assert.equal(mouseAction(s, SIZE, press(10, 1))?.act, 'grab')
})

test('a click on a chip selects it, and on its × closes it', () => {
  const s = withDiagrams({}, 2)
  s.chips = [
    { i: 0, from: 1, close: 8, to: 9 },
    { i: 1, from: 11, close: 18, to: 19 },
  ]
  assert.deepEqual(mouseAction(s, SIZE, press(12, 1)), { act: 'select', i: 1 })
  assert.deepEqual(mouseAction(s, SIZE, press(8, 1)), { act: 'close', i: 0 })
  assert.equal(mouseAction(s, SIZE, press(10, 1))?.act, 'grab', 'between chips')
})

test('in the diagrams window, a click outside the frame quits', () => {
  const s = createState(config({ DV_FRAME: '1' }))
  assert.deepEqual(mouseAction(s, SIZE, press(1, 1)), { act: 'quit', code: 0 })
  assert.equal(mouseAction(s, SIZE, press(50, 15))?.act, 'grab')
})
