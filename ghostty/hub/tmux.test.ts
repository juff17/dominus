// node --test ghostty/hub/tmux.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Level } from '../core/log.ts'
import type { RunResult } from '../core/proc.ts'
import { tmuxOf } from './tmux.ts'

type Logged = { level: Level; message: string; [field: string]: unknown }
// The fake runner's results leave out the exit code, which no caller reads.
type Result = Omit<RunResult, 'exit'>

function world(results: Result[], level: Level = 'debug') {
  const ran: string[][] = []
  const logs: Logged[] = []
  let t = 0
  const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
  const at = (l: Level) => (message: string, fields?: object) => {
    logs.push({ level: l, message, ...fields })
  }
  const log = { enabled: (l: Level) => LEVELS[l] >= LEVELS[level], debug: at('debug'), warn: at('warn') }
  const run = async (cmd: string[]): Promise<RunResult> => (ran.push(cmd), (results.shift() ?? { ok: true, out: '', err: '' }) as RunResult)
  const tmux = tmuxOf({ log, socket: 'tabs-test', layoutSocket: 'layout-test', run, now: () => t })
  return { tmux, ran, logs, tick: (ms: number) => (t += ms) }
}

test('the outer server is bare tmux, the tab and layout servers their sockets', async () => {
  const w = world([])
  await w.tmux.outer('display', '-p')
  await w.tmux.tabs('send-keys', '-t', '%1', 'Enter')
  await w.tmux.layout('select-window', '-t', 'layout-1:hub')
  assert.deepEqual(w.ran, [
    ['tmux', 'display', '-p'],
    ['tmux', '-L', 'tabs-test', 'send-keys', '-t', '%1', 'Enter'],
    ['tmux', '-L', 'layout-test', 'select-window', '-t', 'layout-1:hub'],
  ])
  assert.deepEqual(w.logs, [])
})

test('a failure is returned as it was, and logged at warn once a minute', async () => {
  const fail = () => ({ ok: false, out: '', err: "can't find pane" })
  const w = world([fail(), fail(), fail()])
  assert.deepEqual(await w.tmux.outer('kill-pane', '-t', '%9'), fail())
  await w.tmux.outer('kill-pane', '-t', '%9')
  w.tick(60_000)
  await w.tmux.outer('kill-pane', '-t', '%9')
  assert.deepEqual(w.logs, [
    { level: 'warn', message: 'tmux failed', cmd: ['tmux', 'kill-pane', '-t', '%9'], err: "can't find pane" },
    { level: 'warn', message: 'tmux failed', cmd: ['tmux', 'kill-pane', '-t', '%9'], err: "can't find pane" },
  ])
})

test('a probe that fails logs at debug only, and only when debug is on', async () => {
  const fail = () => ({ ok: false, out: '', err: 'no session' })
  const on = world([fail()])
  await on.tmux.probeTabs('list-windows', '-t', '=peek-5')
  assert.deepEqual(on.logs.map(l => l.level), ['debug'])
  const off = world([fail()], 'info')
  await off.tmux.probeTabs('list-windows', '-t', '=peek-5')
  assert.deepEqual(off.logs, [])
})
