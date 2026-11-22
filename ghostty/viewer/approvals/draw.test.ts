import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Proposal } from '../../tray/approvals.ts'
import { onKey, start } from './approvals.ts'
import { dots, keysFor, panel } from './draw.ts'

process.env.AGENT_HUB_SETTINGS = join(mkdtempSync(join(tmpdir(), 'approvals-draw-')), 'settings.json')

const reply = (body: string): Proposal => ({ id: 'r1', kind: 'reply', status: 'pending', title: 'Reply', body, thread: { author: 'alice', body: 'Why?' } })
const strip = (line: string) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const widthOf = (line: string) => [...strip(line)].length

test('it fills exactly the region it is given, the buttons on the last row', () => {
  const s = start([reply('Short.')])
  const f = panel(s, 64, 20, { env: { EDITOR: 'vim' } })
  assert.equal(f.lines.length, 20)
  assert.ok(f.lines.every(l => widthOf(l) === 64))
  assert.match(strip(f.lines.at(-1) ?? ''), /Post reply a .*Edit e/)
})

test('a body taller than the region scrolls, and says how much is below', () => {
  const s = start([reply(Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'))])
  s.scroll = 1000
  const f = panel(s, 80, 22, { env: { EDITOR: 'vim' } })
  assert.equal(f.lines.length, 22)
  assert.equal(s.scroll, 1000, 'the state is left as it was')
  assert.ok(f.scroll < 1000, 'the scroll it drew at is kept in range')
  assert.deepEqual(f.seen && [f.seen.hidden, f.seen.seenTo > 0], [false, true])
  assert.match(strip(f.lines.join('\n')), /K or PgUp for the top/)
})

test('once all of it has been on screen, the note saying it hadn’t is gone from what it drew', () => {
  const s = start([reply('Short.')])
  s.hidden = true
  onKey(s, 'a')
  assert.match(s.note?.text ?? '', /Not all of it/)
  const f = panel(s, 100, 38, { env: { EDITOR: 'vim' } })
  assert.equal(f.seen?.note, null)
  assert.match(s.note?.text ?? '', /Not all of it/, 'the view applies it, not panel')
})

test('the inline editor keeps its caret on screen as the draft grows past the bottom', () => {
  const draft = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
  const s = start([reply('Short.')])
  onKey(s, 'e', {})
  s.draft = draft
  s.at = [...draft].length - 2
  const f = panel(s, 80, 22, { env: {} })
  assert.ok(f.scroll > 0, 'scrolled to the caret')
  assert.ok(f.lines.some(l => l.includes('\x1b[7m') && strip(l).includes('line 39')), 'the caret’s line is drawn')
  s.at = 0
  assert.ok(panel(s, 80, 22, { env: {} }).lines.some(l => l.includes('\x1b[7m') && strip(l).includes('line 0')), 'and back up with it')
})

test('the inline editor fills every row, the caret on a character or past the last one', () => {
  const draft = 'spread() now raises ValueError with a clear message on an empty list, and there is a test for it.'
  const s = start([reply('Short.')])
  onKey(s, 'e', {})
  s.draft = draft
  for (const at of [5, undefined]) {
    s.at = at
    const lines = panel(s, 64, 30, { env: {} }).lines
    assert.ok(lines.every(l => widthOf(l) === 64), `every row is 64 cells with the caret at ${at}`)
  }
})

test('with the caret at the end, the editor still shows it, after the last character', () => {
  const s = start([reply('Short.')])
  onKey(s, 'e', {})
  s.draft = 'Fixed.'
  delete s.at
  const caret = panel(s, 64, 30, { env: {} }).lines.find(l => l.includes('\x1b[7m'))
  assert.ok(caret, 'a reverse-video caret is drawn')
  assert.match(strip(caret), /Fixed\. /)
})

test('while editing, the line under the reply leaves out how to start editing', () => {
  const s = start([reply('Short.')])
  assert.match(strip(panel(s, 80, 30, { env: {} }).lines.join('\n')), /Press e to edit it here/)
  onKey(s, 'e', {})
  assert.doesNotMatch(strip(panel(s, 80, 30, { env: {} }).lines.join('\n')), /Press e to edit it here/)
})

test('a reply with a briefing shows why it needs you, between their comment and the reply', () => {
  const s = start([{ ...reply('Good question.'), briefing: 'A design choice: keep the cache, or drop it?' }])
  const f = panel(s, 80, 40, { env: { EDITOR: 'vim' } })
  const text = f.lines.map(strip)
  const at = (re: RegExp) => text.findIndex(l => re.test(l))
  assert.ok(f.lines.every(l => widthOf(l) === 80))
  assert.ok(at(/THEIR COMMENT/) < at(/WHY IT NEEDS YOU/) && at(/WHY IT NEEDS YOU/) < at(/REPLY THAT WILL BE POSTED/))
  assert.ok(at(/keep the cache, or drop it/) > at(/WHY IT NEEDS YOU/))
})

test('widened before all of it was seen, it starts from the top again', () => {
  const s = start([reply('word '.repeat(600).trim())])
  // What the view keeps of each frame.
  const draw = (cols: number) => {
    const f = panel(s, cols, 22, { env: { EDITOR: 'vim' } })
    Object.assign(s, { scroll: f.scroll }, f.seen)
    return f
  }
  draw(60)
  s.scroll = 20
  draw(60)
  assert.equal(s.hidden, true)
  // At 120 columns the scroll it was at would reach the end.
  const wide = draw(120)
  assert.equal(wide.scroll, 0)
  assert.equal(s.hidden, true)
})

test('nothing waiting says what the caller gives, with no buttons', () => {
  const f = panel(start([]), 60, 6, { empty: 'Nothing waits on gad #77' })
  assert.match(strip(f.lines.join('\n')), /Nothing waits on gad #77/)
  assert.equal(strip(f.lines.at(-1) ?? '').trim(), '')
})

test('the footer’s keys: the proposal’s, the diff’s or the editor’s; dots for more than one', () => {
  const s = start([reply('Short.'), { id: 'p', kind: 'push', status: 'pending', commits: [] }])
  assert.deepEqual(keysFor(s, s.list[0])[0], ['← →', 'proposal'])
  assert.deepEqual(keysFor(s, null), [])
  assert.equal(dots(s), '● ○')
  assert.equal(dots(start([reply('x')])), '')
  onKey(s, 'e', {})
  assert.equal(keysFor(s, s.list[0])[0][0], 'enter')
})
