// Safety: everything is the sandbox's: the Claude folder, the runtime
// folder, the settings file and the log folder. tmux is never run: `exec`
// is a fake that answers from a pane list held here. The sessions' pids are
// this test runner's, which is how the fixture keeps them live.
//   node --test ghostty/agents/tick.test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import type { AgentdState, Exec } from './tick.ts'

// tests/ is plain JS: its helpers are typed here by what this test uses.
type Box = { root: string; claude: string; env: Record<string, string>; cleanup(): void }
type World = { runner: number; panePid: number; pane: string; deadPid: number; monitorCmd: string; goneCmd: string }
const fromTests = (path: string) => new URL(`../../tests/${path}`, import.meta.url).href
const { sandbox }: { sandbox(name: string): Box } = await import(fromTests('harness.mjs'))
const { claudeWorld }: { claudeWorld(box: Box, base: number, world: World): unknown } = await import(fromTests('fixtures/hub/claude.mjs'))

const box = sandbox('tick')
after(() => box.cleanup())
process.env.AGENT_HUB_SETTINGS = box.env.AGENT_HUB_SETTINGS
process.env.AGENT_HUB_LOG_DIR ??= join(box.root, 'logs')
const { createAgentd } = await import('./tick.ts')
const { PANE_FORMAT } = await import('./panes.ts')
const { lanes } = await import('./board.ts')

const BASE = Date.UTC(2026, 10, 10, 12, 0, 0)
const MONITOR = `node -e watching-${process.pid}`
claudeWorld(box, BASE, {
  runner: process.pid,
  panePid: process.pid,
  pane: 'ghostty-1:@1.%1',
  deadPid: 0x7ffffffe,
  monitorCmd: MONITOR,
  goneCmd: `python3 -u /s/watch_logs.py gone-${process.pid}`,
})

// The tab server: ghostty-1's one tab (@1, Claude's pane %1, looked at) and
// hubtabs-1 with a tab of its own (@9). `set -w @agent` calls change the
// marks it lists, as tmux's would. With `linkedAfter`, @1 shows in hubtabs-1
// from that many tab-server pane lists on, as an earlier version linked it.
// The layout server lists nothing: no hub in front.
type Fake = { fail?: boolean; linkedAfter?: number; dismissed?: string[]; jobs?: unknown[] | null }

function fakeTmux({ fail = false, linkedAfter = Number.POSITIVE_INFINITY }: Fake = {}) {
  const calls: string[][] = []
  let lists = 0
  // window -> option -> value
  const options = new Map<string, Map<string, string>>()
  const option = (win: string, name: string) => options.get(win)?.get(name) ?? ''
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (fail) return null
    const sub = args[2]
    if (sub === 'list-panes' && args[1] === 'layout-sock') return ''
    if (sub === 'list-panes') {
      assert.equal(args.at(-1), PANE_FORMAT)
      const row = (pane: string, session: string, win: string, index = '0') =>
        [pane, session, win, index, '1', '1', `${option(win, '@agent')} ${option(win, '@agent_fg')}`, String(process.pid)].join('\t')
      const linked = lists++ >= linkedAfter ? `${row('%1', 'hubtabs-1', '@1', '1')}\n` : ''
      return `${row('%1', 'ghostty-1', '@1')}\n${row('%9', 'hubtabs-1', '@9')}\n${linked}`
    }
    for (let i = 2; i < args.length; i++) {
      if (args[i] !== 'set') continue
      const [flag, , win, name, value] = args.slice(i + 1)
      const set = options.get(win) ?? new Map<string, string>()
      options.set(win, set)
      if (flag === '-w') set.set(name, value)
      else set.delete(name)
    }
    return ''
  }
  return { exec, calls, tmuxCalls: () => calls.filter(c => c[3] !== 'list-panes') }
}

function agentd(opts: Fake = {}) {
  const run = join(box.root, `run-${Math.random().toString(36).slice(2)}`)
  for (const d of ['reviewed', 'stopped', 'clients']) mkdirSync(join(run, d), { recursive: true })
  const tmux = fakeTmux(opts)
  let clock = BASE
  const procs: string[] = []
  // claude is never run either: `claude agents --json` answers from `jobs`,
  // and a restart is only recorded.
  const jobs = { list: opts.jobs === undefined ? [] : opts.jobs, asked: 0 }
  const restarted: string[] = []
  const d = createAgentd({
    listJobs: async () => {
      jobs.asked++
      return jobs.list === null ? null : JSON.stringify(jobs.list)
    },
    restart: async id => {
      restarted.push(id)
      return { ok: true, err: '' }
    },
    exec: tmux.exec,
    now: () => clock,
    claudeDir: box.claude,
    run,
    tabsSocket: 'tabs-sock',
    layoutSocket: 'layout-sock',
    scanProcs: () => procs.slice(),
    dismiss: async p => {
      opts.dismissed?.push(p.id)
      return { ok: true, message: 'Dismissed' }
    },
    pid: 4242,
  })
  return { d, run, tmux, procs, jobs, restarted, tick: (ms: number) => (clock += ms) }
}

const IDS = ['ask', 'bgjob', 'busy', 'done', 'monfail', 'monwatch', 'orphanpark', 'seen', 'subperm', 'tabperm']

test('tick classifies every live session, on the sockets it was given', async () => {
  const { d, tmux } = agentd()
  const agents = await d.tick()
  assert.deepEqual(agents.map(a => a.id).sort(), IDS)
  const by = Object.fromEntries(agents.map(a => [a.id, a]))
  assert.deepEqual([by.tabperm.state, by.tabperm.need, by.tabperm.kind, by.tabperm.pane?.window], ['needs', 'permission', 'tab', '@1'])
  assert.deepEqual([by.subperm.need, by.subperm.via], ['permission', 'Run the tests'])
  assert.deepEqual(
    tmux.calls.map(c => c.slice(0, 4)),
    [
      ['tmux', '-L', 'tabs-sock', 'list-panes'],
      ['tmux', '-L', 'layout-sock', 'list-panes'],
    ],
  )
})

test("a tick drops a babysit proposal once its session has been gone a minute, and keeps a live session's", async () => {
  const dismissed: string[] = []
  const { d, run, tick } = agentd({ dismissed })
  mkdirSync(join(run, 'approvals'))
  const script = join(run, 'approval.py')
  writeFileSync(script, '')
  for (const [id, session] of [
    ['p-gone', 'ended-session'],
    ['p-live', 'tabperm'],
  ])
    writeFileSync(join(run, 'approvals', `${id}.json`), JSON.stringify({ id, kind: 'retry', status: 'pending', claude_session: session, script }))
  await d.tick()
  tick(61_000)
  await d.tick()
  // The sweep isn't waited for; the fake answers at once.
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(dismissed, ['p-gone'])
})

test('a tab you are looking at marks its session reviewed', async () => {
  const { d, run } = agentd()
  await d.tick()
  // Only tabperm has a pane.
  assert.deepEqual(readdirSync(join(run, 'reviewed')), ['tabperm'])
})

test('a tick reads only the live sessions’ review marks, and prunes the long-gone ones every ten minutes', async () => {
  const { d, run, tick } = agentd()
  const dir = join(run, 'reviewed')
  const old = (BASE - 2 * 86400000) / 1000
  for (const id of ['gone1', 'gone2', 'done']) {
    writeFileSync(join(dir, id), '')
    utimesSync(join(dir, id), old, old)
  }
  const first = await d.tick()
  assert.deepEqual(readdirSync(dir).sort(), ['done', 'tabperm'])
  // done's mark, two days old, is older than its turn: still Done.
  assert.equal(first.find(a => a.id === 'done')!.state, 'done')
  writeFileSync(join(dir, 'gone3'), '')
  utimesSync(join(dir, 'gone3'), old, old)
  tick(60_000)
  await d.tick()
  assert.ok(readdirSync(dir).includes('gone3'), 'not pruned again within ten minutes')
  tick(10 * 60_000)
  await d.tick()
  assert.ok(!readdirSync(dir).includes('gone3'))
})

test('monitors: unknown until the first process scan, then stale when their command is gone', async () => {
  const { d, procs, tick } = agentd()
  procs.push(`${MONITOR}`)
  const first = (await d.tick()).find(a => a.id === 'monwatch')!.monitors.map(m => [m.task, m.state])
  // The scan comes after the first tick's classifying, as it always has.
  assert.deepEqual(first, [
    ['t1', 'watching'],
    ['t2', 'watching'],
    ['t3', 'ended'],
  ])
  tick(1000)
  const second = (await d.tick()).find(a => a.id === 'monwatch')!.monitors.map(m => [m.task, m.state])
  assert.deepEqual(second, [
    ['t1', 'watching'],
    ['t2', 'stale'],
    ['t3', 'ended'],
  ])
})

test('a monitor that started after the last process scan is unknown to it, not gone', async () => {
  const { d, tick } = agentd()
  // An hour-old scan with neither monitor's command in it.
  tick(-3600_000)
  d.scanNow()
  tick(3600_000)
  const states = async () => (await d.tick()).find(a => a.id === 'monwatch')!.monitors.map(m => [m.task, m.state])
  assert.deepEqual(await states(), [
    ['t1', 'watching'],
    ['t2', 'watching'],
    ['t3', 'ended'],
  ])
  // That tick scanned again: now the scan is newer than both.
  tick(1000)
  assert.deepEqual(await states(), [
    ['t1', 'stale'],
    ['t2', 'stale'],
    ['t3', 'ended'],
  ])
})

test("step writes state.json and marks the tab, leaving the hub's tabs alone, then only what changed", async () => {
  const { d, run, tmux, tick, procs } = agentd()
  // Scanned first, as --once does, so the monitors don't change on the second tick.
  procs.push(MONITOR)
  d.scanNow()
  await d.step()
  const state: AgentdState = JSON.parse(readFileSync(join(run, 'state.json'), 'utf8'))
  assert.equal(state.at, BASE)
  assert.deepEqual(state.agents.map(a => a.id).sort(), IDS)
  assert.equal(existsSync(join(run, 'state.json.4242')), false, 'written through a temp file named for the pid')
  assert.deepEqual(tmux.tmuxCalls(), [
    ['tmux', '-L', 'tabs-sock', 'set', '-w', '-t', '@1', '@agent', '▲', ';', 'set', '-w', '-t', '@1', '@agent_fg', '#ffa04d'],
  ])
  // Nothing changed: no new state, no tmux but the lists.
  tick(1000)
  tmux.calls.length = 0
  await d.step()
  assert.equal(JSON.parse(readFileSync(join(run, 'state.json'), 'utf8')).at, BASE)
  assert.deepEqual(tmux.tmuxCalls(), [])
  // The heartbeat moves on every tick all the same, for the tray to see.
  assert.equal(readFileSync(join(run, 'agentd.beat'), 'utf8'), String(BASE + 1000))
})

test('a workspace tab an earlier version linked into the hub is unlinked, by the pane list taken last', async () => {
  const { d, tmux } = agentd({ linkedAfter: 1 })
  await d.step()
  assert.deepEqual(tmux.tmuxCalls(), [
    ['tmux', '-L', 'tabs-sock', 'set', '-w', '-t', '@1', '@agent', '▲', ';', 'set', '-w', '-t', '@1', '@agent_fg', '#ffa04d'],
    ['tmux', '-L', 'tabs-sock', 'unlink-window', '-t', '=hubtabs-1:1'],
  ])
})

test('clearTabs takes the marks off once agentd stops', async () => {
  const { d, tmux } = agentd()
  await d.step()
  tmux.calls.length = 0
  await d.clearTabs()
  assert.deepEqual(tmux.tmuxCalls(), [['tmux', '-L', 'tabs-sock', 'set', '-wu', '-t', '@1', '@agent', ';', 'set', '-wu', '-t', '@1', '@agent_fg']])
})

test('with tmux failing, a tick still classifies, and no tab is linked or unlinked', async () => {
  const { d, run, tmux } = agentd({ fail: true })
  const agents = await d.step()
  assert.deepEqual(agents.map(a => a.id).sort(), IDS)
  assert.equal(agents.find(a => a.id === 'tabperm')!.pane, null)
  assert.ok(existsSync(join(run, 'state.json')))
  assert.deepEqual(tmux.tmuxCalls(), [])
})

test('a state that cannot be written fails the step and is logged as an error', async () => {
  const { d, run } = agentd()
  rmSync(run, { recursive: true, force: true })
  await assert.rejects(d.step(), { code: 'ENOENT' })
  const logged = readFileSync(join(process.env.AGENT_HUB_LOG_DIR!, 'agentd.log'), 'utf8')
  assert.match(logged, /ERROR agentd: state not written \{"path":"[^"]+state\.json\.4242","err":"ENOENT/)
})

test('a state that failed to write is written once it can be, though nothing changed', async () => {
  const { d, run } = agentd()
  // Scanned first, so the monitors read the same on both ticks.
  d.scanNow()
  rmSync(run, { recursive: true, force: true })
  await assert.rejects(d.step(), { code: 'ENOENT' })
  mkdirSync(run)
  await d.step()
  assert.ok(existsSync(join(run, 'state.json')))
})

// As `claude agents --json` lists them: a background job with no process,
// one still running (bgjob's, live in the fixture), and an interactive session.
const JOBS = [
  { id: 'stop1', sessionId: 'stopped-session', kind: 'background', name: 'nightly fix', cwd: '/p/dominus/.claude/worktrees/fix-it', startedAt: BASE - 3_600_000, state: 'blocked' },
  { id: 'job1', sessionId: 'bgjob', kind: 'background', name: 'nightly', cwd: '/p/dotfiles', startedAt: BASE, pid: process.pid, state: 'working' },
  { id: 'tab1', sessionId: 'tabperm', kind: 'interactive', cwd: '/p/dotfiles', startedAt: BASE, pid: process.pid },
]

const setRestart = (on: boolean) => writeFileSync(process.env.AGENT_HUB_SETTINGS!, JSON.stringify({ 'hub.restartStopped': on }))

test('a background job with no process shows as a stopped agent in Idle, by its job id', async () => {
  setRestart(false)
  const { d, restarted } = agentd({ jobs: JOBS })
  const agents = await d.tick()
  const stopped = agents.filter(a => a.stopped)
  assert.equal(stopped.length, 1)
  const [a] = stopped
  assert.deepEqual(
    [a.id, a.jobId, a.kind, a.state, a.title, a.repo, a.worktree, a.pane, a.since],
    ['stopped-session', 'stop1', 'bg', 'idle', 'nightly fix', 'dominus', 'fix-it', null, BASE - 3_600_000],
  )
  assert.deepEqual(agents.map(a => a.id).sort(), [...IDS, 'stopped-session'].sort())
  assert.deepEqual(restarted, [])
})

test('agentd asks claude for its jobs every five seconds, and keeps the last list when it fails', async () => {
  setRestart(false)
  const { d, jobs, tick } = agentd({ jobs: JOBS })
  await d.tick()
  tick(1000)
  await d.tick()
  assert.equal(jobs.asked, 1)
  jobs.list = null
  tick(5000)
  const agents = await d.tick()
  assert.equal(jobs.asked, 2)
  assert.ok(agents.some(a => a.stopped))
})

test('a stopped job whose session is live again is not listed twice', async () => {
  setRestart(false)
  const { d } = agentd({ jobs: [{ ...JOBS[0], sessionId: 'done' }] })
  const agents = await d.tick()
  assert.deepEqual(agents.filter(a => a.id === 'done').map(a => Boolean(a.stopped)), [false])
})

// A session started as a monitor: its transcript begins with the command.
const MONITOR_JOB = { id: 'mon1', sessionId: 'stopped-monitor', kind: 'background', name: 'pipeline ci', cwd: '/p/ci', startedAt: BASE, state: 'stopped' }
mkdirSync(join(box.claude, 'projects', '-p-ci'), { recursive: true })
writeFileSync(
  join(box.claude, 'projects', '-p-ci', 'stopped-monitor.jsonl'),
  `${JSON.stringify({ type: 'user', timestamp: new Date(BASE).toISOString(), message: { role: 'user', content: '<command-name>/pipeline-watch</command-name>\n<command-args>gh ci@main</command-args>' } })}\n`,
)

test('a stopped monitor session carries its first prompt, so it stays out of Idle', async () => {
  setRestart(false)
  const { d } = agentd({ jobs: [...JOBS, MONITOR_JOB] })
  const agents = await d.tick()
  const mon = agents.find(a => a.id === 'stopped-monitor')
  assert.equal(mon?.prompt, '/pipeline-watch gh ci@main')
  assert.deepEqual(
    lanes(agents).idle.filter(a => a.stopped).map(a => a.id),
    ['stopped-session'],
  )
})

test('with Restart stopped agents on, each stopped task agent is restarted once per login, and no monitor', async () => {
  setRestart(true)
  const { d, run, restarted, tick } = agentd({ jobs: [...JOBS, MONITOR_JOB] })
  await d.tick()
  tick(5000)
  await d.tick()
  assert.deepEqual(restarted, ['stop1'])
  assert.ok(existsSync(join(run, 'restarted', 'stop1')))
  setRestart(false)
})
