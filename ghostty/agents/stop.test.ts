import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Proc } from './classify.ts'
import { type StopWorld, stopMonitor } from './stop.ts'

const target = { task: 't1', command: 'python3 watch_pr.py 7', agent: { id: 'sess', pid: 900 } }

function world(procs: Proc[], more: Partial<StopWorld> = {}) {
  const calls: unknown[][] = []
  const w: StopWorld = {
    processes: () => procs,
    kill: (pid, signal) => calls.push(['kill', pid, signal]),
    markStopped: (id, task, command) => calls.push(['markStopped', id, task, command]),
    ...more,
  }
  return { w, calls }
}

test('a monitor that leads its process group is stopped with the group, then marked', () => {
  const { w, calls } = world([{ pid: 950, ppid: 900, pgid: 950, start: 5, cmdline: "bash -c eval 'python3 watch_pr.py 7'" }])
  assert.deepEqual(stopMonitor(target, w), { ok: true, pid: 950, group: true })
  assert.deepEqual(calls, [
    ['kill', -950, 'SIGTERM'],
    ['markStopped', 'sess', 't1', 'python3 watch_pr.py 7'],
  ])
})

test('one that shares a group is stopped alone', () => {
  const { w, calls } = world([{ pid: 950, ppid: 900, pgid: 1, start: 5, cmdline: "bash -c eval 'python3 watch_pr.py 7'" }])
  assert.deepEqual(stopMonitor(target, w), { ok: true, pid: 950, group: false })
  assert.deepEqual(calls[0], ['kill', 950, 'SIGTERM'])
})

test('no process, a kill that fails, and an unreadable /proc each say so', () => {
  assert.deepEqual(stopMonitor(target, world([]).w), { ok: false, reason: 'no process' })
  const err = new Error('EPERM')
  const denied = world([{ pid: 950, ppid: 900, pgid: 950, start: 5, cmdline: "bash -c eval 'python3 watch_pr.py 7'" }], {
    kill: () => {
      throw err
    },
  })
  assert.deepEqual(stopMonitor(target, denied.w), { ok: false, reason: 'kill failed', pid: 950, err })
  assert.deepEqual(denied.calls, [], 'not marked stopped when it wasn’t')
  const why = new Error('EACCES')
  const r = stopMonitor(target, world([], { processes: () => { throw why } }).w)
  assert.deepEqual(r, { ok: false, reason: 'no process', unreadable: why })
})
