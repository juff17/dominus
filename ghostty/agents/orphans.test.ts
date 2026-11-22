// Safety: the approvals and sessions folders are a temp folder's, and
// approval.py is never run: `dismiss` is a fake that removes the file.
//   node --test ghostty/agents/orphans.test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import type { Proposal } from './proposals.ts'

const root = mkdtempSync(join(tmpdir(), 'orphans-'))
after(() => rmSync(root, { recursive: true, force: true }))
process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'
process.env.AGENT_HUB_LOG_DIR ??= join(root, 'logs')
const { ORPHAN_GRACE_MS, orphanSweeper } = await import('./orphans.ts')

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0)

function world() {
  const base = mkdtempSync(join(root, 'w-'))
  const dir = join(base, 'approvals')
  const sessionsDir = join(base, 'sessions')
  mkdirSync(dir)
  mkdirSync(sessionsDir)
  const script = join(base, 'approval.py')
  writeFileSync(script, '')
  const dismissed: string[] = []
  let refuse = false
  const sweeper = orphanSweeper({
    dir,
    sessionsDir,
    dismiss: async p => {
      dismissed.push(p.id)
      if (refuse) return { ok: false, message: "It's being approved right now" }
      rmSync(join(dir, `${p.id}.json`))
      return { ok: true, message: 'Dismissed' }
    },
  })
  const propose = (id: string, session: string, extra: Partial<Proposal> = {}) =>
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, kind: 'retry', status: 'pending', claude_session: session, script, ...extra }))
  const left = () => readdirSync(dir).sort()
  return { dir, sessionsDir, sweeper, propose, left, dismissed, refuse: (on: boolean) => (refuse = on) }
}

test("a proposal whose session ended is dropped once it's been gone a minute, through approval.py dismiss", async () => {
  const w = world()
  w.propose('p1', 'gone')
  w.propose('p2', 'alive')
  const live = new Set(['alive'])
  await w.sweeper.sweep(live, T0)
  await w.sweeper.sweep(live, T0 + ORPHAN_GRACE_MS - 1)
  assert.deepEqual(w.left(), ['p1.json', 'p2.json'], 'kept through the grace')
  await w.sweeper.sweep(live, T0 + ORPHAN_GRACE_MS + 10_000)
  assert.deepEqual(w.left(), ['p2.json'])
  assert.deepEqual(w.dismissed, ['p1'])
})

test('a failed proposal goes the same way', async () => {
  const w = world()
  w.propose('f1', 'gone', { status: 'failed' })
  await w.sweeper.sweep(new Set(), T0)
  await w.sweeper.sweep(new Set(), T0 + ORPHAN_GRACE_MS)
  assert.deepEqual(w.left(), [])
})

test('a session back within the grace keeps its proposal, and its clock starts over', async () => {
  const w = world()
  w.propose('p1', 's1')
  await w.sweeper.sweep(new Set(), T0)
  await w.sweeper.sweep(new Set(['s1']), T0 + 30_000)
  await w.sweeper.sweep(new Set(), T0 + ORPHAN_GRACE_MS)
  assert.deepEqual(w.left(), ['p1.json'])
  await w.sweeper.sweep(new Set(), T0 + ORPHAN_GRACE_MS + 30_000 + ORPHAN_GRACE_MS)
  assert.deepEqual(w.left(), [])
})

test('one being approved right now is left, and tried again on the next sweep', async () => {
  const w = world()
  w.propose('p1', 'gone')
  await w.sweeper.sweep(new Set(), T0)
  w.refuse(true)
  await w.sweeper.sweep(new Set(), T0 + ORPHAN_GRACE_MS)
  assert.deepEqual(w.left(), ['p1.json'])
  w.refuse(false)
  await w.sweeper.sweep(new Set(), T0 + ORPHAN_GRACE_MS + 10_000)
  assert.deepEqual(w.left(), [])
  assert.deepEqual(w.dismissed, ['p1', 'p1'])
})

test('with its approval.py gone, the file is removed without it', async () => {
  const w = world()
  w.propose('p1', 'gone', { script: join(w.dir, 'removed-worktree', 'approval.py') })
  await w.sweeper.sweep(new Set(), T0)
  await w.sweeper.sweep(new Set(), T0 + ORPHAN_GRACE_MS)
  assert.deepEqual(w.left(), [])
  assert.deepEqual(w.dismissed, [])
})

test("a proposal with no session id, or while the sessions folder can't be read, is never dropped", async () => {
  const w = world()
  w.propose('p1', '')
  await w.sweeper.sweep(new Set(), T0)
  await w.sweeper.sweep(new Set(), T0 + 2 * ORPHAN_GRACE_MS)
  assert.deepEqual(w.left(), ['p1.json'])

  const v = world()
  v.propose('p2', 'gone')
  rmSync(v.sessionsDir, { recursive: true })
  await v.sweeper.sweep(new Set(), T0)
  await v.sweeper.sweep(new Set(), T0 + 2 * ORPHAN_GRACE_MS)
  assert.ok(existsSync(join(v.dir, 'p2.json')))
})

test('a sweep within ten seconds of the last does nothing', async () => {
  const w = world()
  w.propose('p1', 'gone')
  await w.sweeper.sweep(new Set(), T0)
  await w.sweeper.sweep(new Set(), T0 + ORPHAN_GRACE_MS - 5_000)
  await w.sweeper.sweep(new Set(), T0 + ORPHAN_GRACE_MS + 1_000)
  assert.deepEqual(w.left(), ['p1.json'])
  await w.sweeper.sweep(new Set(), T0 + ORPHAN_GRACE_MS + 5_000)
  assert.deepEqual(w.left(), [])
})
