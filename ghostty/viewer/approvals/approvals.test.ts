import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { set } from '../../settings/settings.ts'
import type { Proposal } from '../../agents/proposals.ts'
import type { DiffFile } from '../diff/diff.ts'
import { type Approve, type Effect, type KeyResult, type State, alwaysSetting, bodyOf, canAlways, current, edited, inline, mayClose, onKey, openDiff, reload, seen, start } from './approvals.ts'

process.env.AGENT_HUB_SETTINGS = join(mkdtempSync(join(tmpdir(), 'approvals-')), 'settings.json')

const reply = (extra: Partial<Proposal> = {}): Proposal => ({ id: 'r1', kind: 'reply', status: 'pending', body: 'Fixed in abc.', thread: { author: 'alice' }, ...extra })
const push = (extra: Partial<Proposal> = {}): Proposal => ({
  id: 'p1',
  kind: 'push',
  status: 'pending',
  commits: [{ sha: 'aaa1111' }, { sha: 'bbb2222' }],
  ...extra,
})
const retry = (extra: Partial<Proposal> = {}): Proposal => ({ id: 't1', kind: 'retry', status: 'pending', job: { id: 7, name: 'test' }, ...extra })
const EDITOR = { EDITOR: 'vim' }
const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const effect = (r: KeyResult) => r as Effect
const approved = (r: KeyResult) => r as Approve
const noteOf = (s: State) => s.note?.text ?? ''
const file = (path: string) => ({ path }) as DiffFile
const diffOf = (s: State) => {
  assert.ok(s.diff)
  return s.diff
}

test('it opens on the proposal asked for, else the first, and → / ← wrap round', () => {
  const s = start([reply(), push(), retry()], 'p1')
  assert.equal(current(s)?.id, 'p1')
  assert.equal(start([reply()], 'gone').i, 0)
  onKey(s, RIGHT)
  assert.equal(current(s)?.id, 't1')
  onKey(s, RIGHT)
  assert.equal(current(s)?.id, 'r1')
  onKey(s, LEFT)
  assert.equal(current(s)?.id, 't1')
})

// j and k are Monitors', which move between monitors.
test('j and k leave the proposal shown', () => {
  const s = start([reply(), push()])
  assert.equal(onKey(s, 'j'), undefined)
  onKey(s, 'k')
  assert.equal(current(s)?.id, 'r1')
})

test('a approves as proposed; esc and q close the panel', () => {
  const s = start([reply()])
  assert.deepEqual(onKey(s, 'a'), { do: 'approve', p: reply(), always: false })
  for (const k of ['q', '\x1b']) assert.equal(onKey(s, k), 'close')
})

test('the overlay’s own keys may close it, except while a reply is edited', () => {
  assert.equal(mayClose(start([reply()])), true)
  assert.equal(mayClose({ editing: true } as State), false)
})

test('A approves and asks for always, but never for a deployment or a failed one', () => {
  assert.equal(approved(onKey(start([reply()]), 'A')).always, true)
  const deploy = start([{ id: 'd', kind: 'deploy', status: 'pending' }])
  assert.equal(onKey(deploy, 'A'), undefined)
  assert.match(noteOf(deploy), /always asks/)
  assert.equal(canAlways(retry({ status: 'failed' })), false)
  assert.deepEqual(alwaysSetting(reply()), ['approvals.reply', 'post'])
  assert.deepEqual(alwaysSetting(retry()), ['approvals.retry', 'auto'])
})

test('r rejects a pending proposal and dismisses a failed one; g goes to its session', () => {
  assert.equal(effect(onKey(start([reply()]), 'r')).do, 'reject')
  assert.equal(effect(onKey(start([reply({ status: 'failed' })]), 'r')).do, 'dismiss')
  assert.equal(effect(onKey(start([reply({ status: 'failed' })]), 'x')).do, 'dismiss')
  assert.equal(onKey(start([reply()]), 'x'), undefined, 'x never turns down a pending one by accident')
  assert.equal(effect(onKey(start([reply()]), 'g')).do, 'go')
})

test('a push: arrows pick a commit, enter shows its diff, space drops it, and a sends the drops', () => {
  const s = start([push()])
  onKey(s, '\x1b[B')
  assert.equal(s.commit, 1)
  onKey(s, '\x1b[B')
  assert.equal(s.commit, 1, 'held at the last')
  assert.deepEqual(onKey(s, '\r'), { do: 'diff', p: push(), from: 'bbb2222^', to: 'bbb2222', title: 'bbb2222' })
  onKey(s, ' ')
  assert.deepEqual(onKey(s, 'a'), { do: 'approve', p: push(), always: false, drop: ['bbb2222'] })
  onKey(s, '\x1b[A')
  onKey(s, ' ')
  assert.equal(s.drop.size, 1, 'the last commit kept can’t be dropped')
  assert.match(noteOf(s), /Keep at least one/)
  assert.deepEqual(onKey(start([push({ lease: 'l', head: 'h' })]), 'd'), { do: 'diff', p: push({ lease: 'l', head: 'h' }), from: 'l', to: 'h', title: 'all 2 commits' })
})

test('the diff: j k pick a file, enter opens one at a time, esc goes back to the proposal', () => {
  const s = start([push()])
  const files = [file('a.py'), file('b.py')]
  openDiff(s, { title: 'all 2 commits', from: 'l', to: 'h', files })
  assert.equal(diffOf(s).open, 'a.py', 'the first file opens with it')
  onKey(s, 'j')
  assert.deepEqual(onKey(s, '\r'), { do: 'diffFile', file: files[1] })
  assert.equal(diffOf(s).open, 'b.py')
  assert.equal(onKey(s, '\r'), undefined, 'enter again closes it')
  assert.equal(diffOf(s).open, '')
  assert.equal(onKey(s, 'a'), undefined, 'a doesn’t approve from the diff')
  onKey(s, '\x1b')
  assert.equal(s.diff, null)
})

test('a diff git couldn’t read keeps why; opening a file again clears it', () => {
  const s = start([push()])
  openDiff(s, { title: 'all', from: 'l', to: 'h', files: [], error: 'fatal: cannot change to /gone' })
  assert.equal(diffOf(s).error, 'fatal: cannot change to /gone')
  openDiff(s, { title: 'all', from: 'l', to: 'h', files: [file('a.py')] })
  assert.equal(diffOf(s).error, '')
  diffOf(s).error = 'fatal: bad object h'
  onKey(s, '\r')
  assert.equal(diffOf(s).error, '')
})

test('a waits until all of it was on screen, and its note goes once it has been', () => {
  const s = start([reply()])
  seen(s, 10, 30)
  assert.equal(onKey(s, 'a'), undefined)
  assert.match(noteOf(s), /Not all of it has been on screen/)
  seen(s, 20, 30)
  assert.match(noteOf(s), /Not all of it/, 'still some to see')
  seen(s, 30, 30)
  assert.equal(s.note, null)
  // Seen once is enough, scrolled back up or not.
  seen(s, 10, 30)
  assert.equal(effect(onKey(s, 'a')).do, 'approve')
  // Any other note stays.
  const other = start([reply()])
  other.note = { text: 'Edited. Press a to post it as shown.', tone: 'peach' }
  seen(other, 30, 30)
  assert.match(noteOf(other), /Edited/)
})

test('moving to another proposal forgets drops, open diffs and edits', () => {
  const s = start([push(), reply()])
  onKey(s, ' ')
  onKey(s, '\r')
  onKey(s, RIGHT)
  onKey(s, LEFT)
  assert.equal(s.drop.size, 0)
  assert.equal(s.diff, null)
})

test('e edits in $EDITOR, or inline when Settings say so or there is none', () => {
  assert.deepEqual(onKey(start([reply()]), 'e', EDITOR), { do: 'editor', p: reply(), text: 'Fixed in abc.' })
  const s = start([reply()])
  assert.equal(onKey(s, 'e', {}), undefined)
  assert.equal(s.editing, true)
  assert.equal(inline({}), true)
  set('approvals.editor', 'inline')
  assert.equal(inline(EDITOR), true)
  set('approvals.editor', 'editor')
  assert.equal(onKey(start([push()]), 'e', EDITOR), undefined, 'only a reply edits')
})

test('inline: keys edit the draft, esc drops it, enter posts it at once by default', () => {
  const s = start([reply()])
  onKey(s, 'e', {})
  for (const k of ' Thanks!') onKey(s, k, {})
  assert.equal(s.draft, 'Fixed in abc. Thanks!')
  onKey(s, '\x1b', {})
  assert.equal(s.editing, false)
  assert.equal(bodyOf(s, reply()), 'Fixed in abc.')
  onKey(s, 'e', {})
  onKey(s, '!', {})
  const e = onKey(s, '\r', {})
  assert.deepEqual(e, { do: 'approve', p: reply(), always: false, body: 'Fixed in abc.!' })
})

test('with "show it once more", an edit waits for a, which then posts the edit', () => {
  set('approvals.edited', 'confirm')
  try {
    const s = start([reply()])
    assert.equal(edited(s, reply(), 'New words'), undefined)
    assert.match(noteOf(s), /Press a to post/)
    assert.equal(bodyOf(s, reply()), 'New words')
    assert.equal(approved(onKey(s, 'a')).body, 'New words')
  } finally {
    set('approvals.edited', 'post')
  }
})

test('a second inline edit: esc keeps the first edit, enter compares with it', () => {
  set('approvals.edited', 'confirm')
  try {
    const s = start([reply()])
    onKey(s, 'e', {})
    for (const k of ' One.') onKey(s, k, {})
    assert.equal(onKey(s, '\r', {}), undefined)
    assert.equal(bodyOf(s, reply()), 'Fixed in abc. One.')
    onKey(s, 'e', {})
    for (const k of ' WRONG') onKey(s, k, {})
    onKey(s, '\x1b', {})
    assert.match(noteOf(s), /Edit dropped/)
    assert.equal(bodyOf(s, reply()), 'Fixed in abc. One.')
    assert.equal(approved(onKey(s, 'a')).body, 'Fixed in abc. One.')
    onKey(s, 'e', {})
    for (const k of ' Two.') onKey(s, k, {})
    onKey(s, '\r', {})
    assert.match(noteOf(s), /Edited/)
    assert.equal(approved(onKey(s, 'a')).body, 'Fixed in abc. One. Two.')
    onKey(s, 'e', {})
    onKey(s, '\r', {})
    assert.match(noteOf(s), /Reply unchanged/)
  } finally {
    set('approvals.edited', 'post')
  }
})

test('an unchanged edit posts nothing', () => {
  const s = start([reply()])
  assert.equal(edited(s, reply(), 'Fixed in abc.'), undefined)
  assert.equal(s.edited, false)
  assert.equal(edited(s, reply(), null), undefined)
})

test('reload keeps the proposal shown, or the one after a settled one', () => {
  const s = start([reply(), push(), retry()], 'p1')
  reload(s, [reply(), { id: 'new', kind: 'retry' } as Proposal, push(), retry()])
  assert.equal(current(s)?.id, 'p1')
  reload(s, [reply(), { id: 'new', kind: 'retry' } as Proposal, retry()])
  assert.equal(current(s)?.id, 't1')
  reload(s, [])
  assert.equal(current(s), null)
  assert.equal(onKey(s, 'a'), undefined)
})

test('when what you read is replaced, the first a only says so, and the next waits for a draw', () => {
  const s = start([push(), retry()], 'p1')
  onKey(s, ' ')
  reload(s, [push({ id: 'p2' }), retry()])
  assert.equal(current(s)?.id, 'p2')
  assert.equal(s.drop.size, 0)
  assert.equal(onKey(s, 'a'), undefined)
  assert.match(noteOf(s), /replaced what you were reading/)
  // A second a in the same read of the keyboard, before anything was drawn.
  assert.equal(onKey(s, 'a'), undefined)
  assert.match(noteOf(s), /replaced what you were reading/, 'and the note still says why')
  seen(s, 30, 30)
  assert.equal(effect(onKey(s, 'a')).do, 'approve')
  reload(s, [retry()])
  onKey(s, '\x1b[B')
  seen(s, 30, 30)
  assert.equal(effect(onKey(s, 'a')).do, 'approve', 'any other key counts as a look')
})

test('a step and an a read together approve nothing until the one stepped to is drawn', () => {
  const s = start([reply(), reply({ id: 'r2' })])
  onKey(s, RIGHT)
  assert.equal(onKey(s, 'a'), undefined)
  assert.match(noteOf(s), /Not all of it/)
  seen(s, 30, 30)
  assert.equal(s.note, null)
  assert.equal(approved(onKey(s, 'a')).p.id, 'r2')
})

test('r and x, like a, refuse once a proposal that replaced what you read', () => {
  const s = start([reply(), retry({ status: 'failed' })])
  reload(s, [reply({ id: 'r2' }), retry({ status: 'failed' })])
  assert.equal(onKey(s, 'r'), undefined)
  assert.match(noteOf(s), /settled or replaced/)
  assert.equal(onKey(s, 'r'), undefined)
  assert.match(noteOf(s), /settled or replaced/)
  seen(s, 30, 30)
  assert.equal(effect(onKey(s, 'r')).do, 'reject')
  const failed = start([retry({ status: 'failed' }), reply()])
  reload(failed, [retry({ id: 't2', status: 'failed' }), reply()])
  assert.equal(onKey(failed, 'x'), undefined)
  seen(failed, 30, 30)
  assert.equal(effect(onKey(failed, 'x')).do, 'dismiss')
  // Scrolling is a look.
  reload(failed, [reply()])
  onKey(failed, 'J')
  assert.equal(effect(onKey(failed, 'r')).do, 'reject')
})

test('one settled here goes quietly; any other one going is a replacement', () => {
  const s = start([reply(), retry()])
  reload(s, [retry()], 'r1')
  assert.deepEqual([s.changed, s.note], [false, null])
  const other = start([reply(), retry()])
  // A settle of r1 that failed because r1 was re-proposed meanwhile.
  reload(other, [reply({ id: 'r1b' }), retry()], '')
  assert.equal(other.changed, true)
})

test('a push that failed under you forgets the drops chosen while it was pending', () => {
  const s = start([push()])
  onKey(s, ' ')
  assert.equal(s.drop.size, 1)
  reload(s, [push()])
  assert.equal(s.drop.size, 1, 'the same one, unchanged, keeps them')
  reload(s, [push({ status: 'failed' })])
  assert.equal(s.drop.size, 0)
  assert.equal(approved(onKey(s, 'a')).drop, undefined)
})

test('rows seen at one width count for nothing at another; all of it seen stays seen', () => {
  const s = start([reply()])
  seen(s, 63, 100, 60)
  assert.equal(s.hidden, true)
  seen(s, 40, 50, 120)
  assert.equal(s.hidden, true, 'widened: only what this frame shows counts')
  assert.equal(s.seenTo, 40)
  seen(s, 50, 50, 120)
  assert.equal(s.hidden, false)
  seen(s, 30, 100, 60)
  assert.equal(s.hidden, false, 'narrowed again after all of it was seen')
})

test('a waits until all of a proposal has been on screen; J and K scroll', () => {
  const s = start([reply()])
  s.hidden = true
  assert.equal(onKey(s, 'a'), undefined)
  assert.equal(onKey(s, 'A'), undefined)
  assert.match(noteOf(s), /J or PgDn/)
  onKey(s, 'J')
  assert.equal(s.scroll, 5)
  onKey(s, 'K')
  onKey(s, 'K')
  assert.equal(s.scroll, 0)
  s.hidden = false
  assert.equal(effect(onKey(s, 'a')).do, 'approve')
})

test('o opens the proposal on the host; a proposal with no link takes no o', () => {
  const pr = { url: 'https://github.com/o/r/pull/2', project: 'o/r', forge: 'github' }
  const thread = { url: 'https://github.com/o/r/pull/2#discussion_r9' }
  assert.deepEqual(onKey(start([reply({ pr, thread })]), 'o'), { do: 'open', p: reply({ pr, thread }), url: thread.url })
  assert.equal(onKey(start([reply({ pr: {} })]), 'o'), undefined)
})

test('← and → step between proposals', () => {
  const s = start([reply(), push(), retry()])
  onKey(s, '\x1b[C')
  assert.equal(current(s)?.id, 'p1')
  onKey(s, '\x1b[D')
  onKey(s, '\x1b[D')
  assert.equal(current(s)?.id, 't1', 'wraps round')
})
