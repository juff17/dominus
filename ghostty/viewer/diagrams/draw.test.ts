import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { visible } from '../../tui/text.ts'
import type { Diagram } from './diagram.ts'
import { frame } from './draw.ts'
import { transmitFile } from '../../tui/kitty.ts'
import { type DiagramState, type Size, config, createState } from './state.ts'

process.env.AGENT_HUB_SETTINGS = join(mkdtempSync(join(tmpdir(), 'dv-draw-')), 'settings.json')

const SIZE: Size = { cols: 80, rows: 20 }
const plain = (line: string) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

const noTmux = (t: TestContext) => {
  const was = process.env.TMUX
  delete process.env.TMUX
  t.after(() => {
    if (was !== undefined) process.env.TMUX = was
  })
}

function withDiagrams(n: number): DiagramState {
  const s = createState(config({}))
  s.list = { diagrams: Array.from({ length: n }, (_, i) => ({ title: `d${i}`, file: `/${i}.png`, width: 800, height: 600 }) as Diagram), current: 0 }
  return s
}

test('with no diagrams, the panel asks for one and nothing is sent', () => {
  const f = frame(createState(config({})), SIZE, false)
  assert.equal(f.lines.length, SIZE.rows)
  assert.equal(f.setup, '')
  assert.deepEqual(f.chips, [])
  assert.ok(f.lines.some(l => plain(l).includes('No diagrams yet')))
})

test('a followed tab that closed says so', () => {
  const s = createState(config({}))
  s.gone = true
  assert.ok(frame(s, SIZE, false).lines.some(l => plain(l).includes('closed')))
})

test('a diagram whose PNG left the cache says so, with its chip and size', () => {
  const s = withDiagrams(2)
  const f = frame(s, SIZE, false)
  assert.equal(f.setup, '')
  assert.deepEqual(
    f.chips.map(c => c.i),
    [0, 1],
  )
  assert.ok(f.chips[0] && f.chips[1] && f.chips[0].to < f.chips[1].from)
  assert.ok(plain(f.lines.at(-1) ?? '').includes('800×600'))
  assert.equal(visible(f.lines[0] ?? ''), SIZE.cols)
})

test('a picture is sent once, placed, and drawn from its home view', t => {
  noTmux(t)
  const s = withDiagrams(1)
  const first = frame(s, SIZE, true)
  assert.ok(first.setup.startsWith(transmitFile(1, '/0.png')))
  assert.deepEqual(first.view, { zoom: 1, cx: 400, cy: 300 })
  assert.ok(first.lines.some(l => l.includes('\u{10EEEE}')))
  s.view = first.view
  assert.equal(frame(s, SIZE, true).setup, '', 'nothing new to send')
})
