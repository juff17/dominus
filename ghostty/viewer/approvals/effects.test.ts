import assert from 'node:assert/strict'
import type { ChildProcess, SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Agent } from '../../agents/model.ts'
import type { ApprovalResult, Proposal } from '../../agents/proposals.ts'
import { start } from './approvals.ts'
import { type ApprovalsIo, approvalEffects } from './effects.ts'

process.env.AGENT_HUB_SETTINGS = join(mkdtempSync(join(tmpdir(), 'approvals-effects-')), 'settings.json')

const push: Proposal = { id: 'p1', kind: 'push', status: 'pending', worktree: '/gone', claude_session: 's1', commits: [{ sha: 'aaa1111' }] }

function fake(over: Partial<ApprovalsIo> = {}) {
  const calls = { approval: [] as string[][], draws: 0, quits: 0, emptied: 0 }
  const io: ApprovalsIo = {
    git: () => ({ err: "fatal: cannot change to '/gone'", exit: 128 }),
    proposals: () => [],
    runApproval: async (_, args) => (calls.approval.push(args), { ok: true, message: 'Rejected' }),
    agents: () => [],
    go: async () => ({ ok: true, message: '' }),
    setSetting: () => {},
    spawn: (() => ({}) as ChildProcess) as unknown as ApprovalsIo['spawn'],
    draw: () => calls.draws++,
    quit: () => calls.quits++,
    emptied: () => calls.emptied++,
    outside: () => ({ status: 0 }) as SpawnSyncReturns<Buffer>,
    ...over,
  }
  return { io, calls }
}

test('r asks approval.py to reject it, says what it said, and empties the panel once nothing is left', async () => {
  const s = start([push])
  const { io, calls } = fake()
  await approvalEffects(s, io).run({ do: 'reject', p: push })
  assert.deepEqual(calls.approval, [['reject', 'p1']])
  assert.deepEqual([s.busy, s.note], ['', { text: 'Rejected', tone: 'green' }])
  assert.equal(s.list.length, 0)
  assert.deepEqual([calls.emptied, calls.quits], [1, 0])
})

test('a diff git can’t read keeps git’s own line', async () => {
  const s = start([push])
  await approvalEffects(s, fake().io).run({ do: 'diff', p: push, from: 'a', to: 'b', title: 'all' })
  assert.deepEqual([s.diff?.files, s.diff?.error], [[], "fatal: cannot change to '/gone'"])
})

test('g with the session gone says so and stays open; with it there, goes and closes Monitors', async () => {
  const s = start([push])
  const gone = fake()
  await approvalEffects(s, gone.io).run({ do: 'go', p: push })
  assert.match(s.note?.text ?? '', /gone/)
  assert.equal(gone.calls.quits, 0)
  const there = fake({ agents: () => [{ id: 's1', pane: null } as Agent] })
  await approvalEffects(s, there.io).run({ do: 'go', p: push })
  assert.equal(there.calls.quits, 1)
})

test('a proposal that came in while the last one settled keeps the panel open on it', async () => {
  const s = start([push])
  const { io, calls } = fake({ proposals: () => [{ ...push, id: 'p2' }] })
  await approvalEffects(s, io).run({ do: 'reject', p: push })
  assert.equal(calls.emptied, 0)
  assert.equal(s.list[0].id, 'p2')
})

test('a settle that failed because its proposal went still guards the one that replaced it', async () => {
  const s = start([push])
  const next: Proposal = { ...push, id: 'p2' }
  const { io } = fake({ proposals: () => [next], runApproval: async () => ({ ok: false, message: 'That approval is gone' }) })
  await approvalEffects(s, io).run({ do: 'approve', p: push, always: false })
  assert.equal(s.changed, true)
  const settled = start([push])
  await approvalEffects(settled, fake({ proposals: () => [next] }).io).run({ do: 'approve', p: push, always: false })
  assert.equal(settled.changed, false, 'one approved here goes quietly')
})

test('A whose always couldn’t be saved says so with the result', async () => {
  const s = start([push])
  const { io } = fake({
    setSetting: () => {
      throw new Error('disk full')
    },
    proposals: () => [push],
  })
  await approvalEffects(s, io).run({ do: 'approve', p: push, always: true })
  assert.equal(s.note?.tone, 'red')
  assert.match(s.note?.text ?? '', /Rejected · Couldn't save the setting: disk full/)
})

test('a close key while it settles closes once it is done; a second closes at once', async () => {
  const s = start([push])
  let finish = (_: ApprovalResult) => {}
  const { io, calls } = fake({
    runApproval: () =>
      new Promise<ApprovalResult>(resolve => {
        finish = resolve
      }),
  })
  const fx = approvalEffects(s, io)
  const done = fx.run({ do: 'reject', p: push })
  fx.closeWhenDone()
  assert.equal(calls.quits, 0)
  assert.match(s.busy, /press again to close now/)
  finish({ ok: true, message: 'Rejected' })
  await done
  assert.equal(calls.quits, 1)
  const again = fake({ runApproval: () => new Promise<ApprovalResult>(() => {}) })
  const fx2 = approvalEffects(start([push]), again.io)
  void fx2.run({ do: 'reject', p: push })
  fx2.closeWhenDone()
  fx2.closeWhenDone()
  assert.equal(again.calls.quits, 1)
})
