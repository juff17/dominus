// node --test ghostty/tui/screen.test.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { enterSeq, leaveSeq, resetSeq } from './screen.ts'

const dir = mkdtempSync(join(tmpdir(), 'screen-'))
const screen = pathToFileURL(join(import.meta.dirname, 'screen.ts')).href

function run(name: string, then: string) {
  const file = join(dir, `${name}.mjs`)
  writeFileSync(file, [`import { enter, leave } from '${screen}'`, `enter({ drag: true })`, then].join('\n'))
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout }
}

test('a view that crashes gives the terminal back, every mode off, and Node still exits 1', () => {
  const r = run('crash', "setTimeout(() => { throw new Error('boom') }, 1)")
  assert.equal(r.status, 1)
  assert.equal(r.stdout, enterSeq({ drag: true }) + resetSeq())
})

test('a view that left before crashing writes nothing more', () => {
  const r = run('left', "leave({ drag: true }); setTimeout(() => { throw new Error('boom') }, 1)")
  assert.equal(r.status, 1)
  assert.equal(r.stdout, enterSeq({ drag: true }) + leaveSeq({ drag: true }))
})

test('the reset turns off every mode any view or yazi turns on', () => {
  for (const m of [1000, 1002, 1003, 1004, 1006, 1016, 2004]) assert.ok(resetSeq().includes(`\x1b[?${m}l`), String(m))
  assert.ok(resetSeq().endsWith('\x1b[?25h\x1b[?1049l'))
})

test('entering turns off the modes the view does not use', () => {
  const seq = enterSeq({ paste: false })
  assert.ok(seq.includes('\x1b[?2004l'), 'a paste left on by a crashed view goes off')
  assert.ok(!seq.includes('\x1b[?2004h'))
  assert.ok(seq.includes('\x1b[?1000h'))
})
