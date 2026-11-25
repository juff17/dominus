// node --test ghostty/hub/actions.test.ts
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { type ActionsDeps, type Child, type Spawn, type SpawnOptions, actionsOf, pruneResults, resultPath } from './actions.ts'
import type { Monitored } from './board.ts'
import type { Agent, LaunchSpec, Monitor, Pane, Proc } from '../agents/model.ts'
import { SANDBOX_SETTINGS } from '../agents/launch.ts'
import type { Level } from '../core/log.ts'
import type { RunResult } from '../core/proc.ts'
import { P } from '../tui/term.ts'

// No instruction files, so your own task.md never joins a launch.
process.env.AGENT_HUB_PROMPTS = '/nonexistent/agent-hub/prompts'

const PROMPT = ['  Bash command', '    npm test', '  Do you want to proceed?', '❯ 1. Yes', '  2. No', ''].join('\n')

// The hub's world, faked: every tmux and program call is recorded and
// answered by the first rule whose `has` words are all in it (of `kind`,
// when given), after its `effect` runs, else ok and empty.
type Rule = { kind?: string; has: string[]; r?: Partial<RunResult>; effect?: () => void }
type Logged = { level: Level; message: string; [field: string]: unknown }
type Note = { text: string; color?: string; ms?: number }

function world({ rules = [], ...extra }: { rules?: Rule[] } & Partial<ActionsDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-actions-'))
  mkdirSync(join(dir, 'sessions'))
  const calls: unknown[][] = []
  const notes: Note[] = []
  const logs: Logged[] = []
  const answer = (kind: string, args: string[]): RunResult => {
    calls.push([kind, ...args])
    const rule = rules.find(r => (r.kind ?? kind) === kind && r.has.every(w => args.includes(w)))
    rule?.effect?.()
    // The exit code is left out, as no caller reads it.
    return { ok: true, out: '', err: '', ...rule?.r } as RunResult
  }
  const at = (level: Level) => (message: string, fields: object = {}) => {
    logs.push({ level, message, ...fields })
  }
  const deps = {
    outer: async (...args) => answer('outer', args),
    tabs: async (...args) => answer('tabs', args),
    run: async argv => answer('run', argv),
    say: (text, color, ms) => {
      notes.push({ text, color, ms })
    },
    noteMs: () => 7000,
    openSession: async a => {
      calls.push(['openSession', a])
    },
    agents: () => [],
    focusedFolder: () => '/home/x/projects/dotfiles',
    recents: () => ['/home/x/projects/dotfiles'],
    remember: d => {
      calls.push(['remember', d])
    },
    win: 1,
    CONF: '/conf',
    claude: '/bin/claude',
    // claude --bg, recorded and never run: a child that neither prints nor
    // exits, which is all start listens to.
    spawn: (cmd, args) => {
      calls.push(['spawn', cmd, ...args])
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), unref: () => {} })
      return child as unknown as Child
    },
    log: { enabled: () => true, debug: at('debug'), info: at('info'), warn: at('warn') },
    processes: () => [],
    kill: (pid, sig) => calls.push(['kill', pid, sig]),
    markStopped: (id, task, command) => {
      calls.push(['markStopped', id, task, command])
    },
    setSetting: (key, value) => calls.push(['setSetting', key, value]),
    askStopMonitor: () => true,
    sandbox: () => false,
    claudeDir: dir,
    resultFile: join(dir, 'new-agent.json'),
    env: { TMUX: '/tmp/tmux,1,0', TMUX_PANE: '%1' },
    ...extra,
  } satisfies ActionsDeps
  const session = (pid: number, status: string) => writeFileSync(join(dir, 'sessions', `${pid}.json`), JSON.stringify({ status }))
  return { act: actionsOf(deps), deps, calls, notes, logs, dir, session }
}

// Partial agents and monitors, with what the actions read of them.
const pane = { pane: '%12', session: 'ghostty-1', win: 1, window: '@12', tab: 2 } as Pane
const permission = { id: 'perm', pid: 4242, title: 'Fix it', need: 'permission', state: 'needs', cmd: 'Allow Bash(npm test)?', pane, monitors: [] } as unknown as Agent
const info = (w: ReturnType<typeof world>, message: string) => w.logs.filter(l => l.message === message)

// ------------------------------------------------------------ answer

test('a and d on anything but a permission prompt only say what they are for', async () => {
  const w = world()
  await w.act.answer({ ...permission, need: 'question' }, true)
  await w.act.answer(null, false)
  assert.deepEqual(w.notes.map(n => n.text), ['a and d answer permission prompts', 'a and d answer permission prompts'])
  assert.deepEqual(w.calls, [])
  assert.equal(info(w, 'permission answered')[0].ok, false)
})

test('a background agent’s prompt is answered by opening it', async () => {
  const w = world()
  await w.act.answer({ ...permission, pane: null }, true)
  assert.deepEqual(w.notes, [{ text: 'Open a background session (↵) to answer it', color: P.peach, ms: undefined }])
})

test('a presses 1 and d Esc in the pane while Claude waits with the prompt on screen', async () => {
  const w = world({ rules: [{ has: ['capture-pane'], r: { out: PROMPT } }] })
  w.session(4242, 'waiting')
  await w.act.answer(permission, true)
  // Another agent's prompt: the first one's is answered already.
  await w.act.answer({ ...permission, id: 'perm2' }, false)
  assert.deepEqual(
    w.calls.filter(c => c[1] === 'send-keys'),
    [
      ['tabs', 'send-keys', '-t', '%12', '1'],
      ['tabs', 'send-keys', '-t', '%12', 'Escape'],
    ],
  )
  assert.deepEqual(w.notes, [
    { text: 'Allowed Bash(npm test)', color: P.green, ms: undefined },
    { text: 'Denied Bash(npm test)', color: P.peach, ms: undefined },
  ])
  assert.deepEqual(info(w, 'permission answered').map(l => [l.allow, l.ok]), [[true, true], [false, true]])
})

test('no key is pressed unless Claude says it waits and the prompt is on screen', async () => {
  // The last: a dialog whose first choice is Yes too, for another call.
  const cases: [string | null, string][] = [['busy', PROMPT], ['waiting', 'just output\n'], [null, PROMPT], ['waiting', PROMPT.replace('npm test', 'rm -rf build')]]
  for (const [status, screen] of cases) {
    const w = world({ rules: [{ has: ['capture-pane'], r: { out: screen } }] })
    if (status) w.session(4242, status)
    await w.act.answer(permission, true)
    assert.ok(!w.calls.some(c => c[1] === 'send-keys'), `${status} ${screen}`)
    assert.deepEqual(w.notes.map(n => n.text), ["Fix it isn't showing a permission prompt right now"])
    // A session file that isn't there is worth a line in the log.
    assert.equal(w.logs.some(l => l.level === 'warn' && l.message === 'session file unreadable'), status === null)
  }
})

test('a second press on a prompt being answered, or just answered, presses nothing', async () => {
  let now = 1_000_000
  const w = world({ rules: [{ has: ['capture-pane'], r: { out: PROMPT } }], now: () => now })
  w.session(4242, 'waiting')
  // Two a's in one read of the keys: both start before either presses.
  await Promise.all([w.act.answer(permission, true), w.act.answer(permission, true)])
  const pressed = () => w.calls.filter(c => c[1] === 'send-keys').length
  assert.equal(pressed(), 1)
  // A press just after, with the prompt not yet redrawn away.
  now += 100
  await w.act.answer(permission, false)
  assert.equal(pressed(), 1)
  assert.deepEqual(info(w, 'permission answered').map(l => [l.ok, l.reason]), [[false, 'already answering'], [true, undefined], [false, 'already answered']])
  assert.deepEqual(w.notes.map(n => n.text), ['Allowed Bash(npm test)'])
  // A screen unchanged long after means the key was lost: a press tries again.
  now += 5000
  await w.act.answer(permission, true)
  assert.equal(pressed(), 2)
})

test('the footer says the prompt wasn’t answered when tmux failed to press the key', async () => {
  const w = world({ rules: [{ has: ['capture-pane'], r: { out: PROMPT } }, { has: ['send-keys'], r: { ok: false, err: 'no pane\n' } }] })
  w.session(4242, 'waiting')
  await w.act.answer(permission, true)
  await w.act.answer(permission, false)
  assert.deepEqual(w.notes, [
    { text: "Couldn't allow Bash(npm test): no pane", color: P.red, ms: 7000 },
    { text: "Couldn't deny Bash(npm test): no pane", color: P.red, ms: 7000 },
  ])
  assert.deepEqual(info(w, 'permission answered').map(l => [l.ok, l.err]), [[false, 'no pane\n'], [false, 'no pane\n']])
})

// ------------------------------------------------------------ close

const doneTab = { id: 'fin', title: 'Run the suite', state: 'done', pane, monitors: [] } as unknown as Agent

test('x refuses a working agent and one outside the layout', () => {
  const w = world()
  assert.equal(w.act.closeAgent({ ...doneTab, state: 'working' }, 'tab 2'), null)
  assert.equal(w.act.closeAgent({ ...doneTab, pane: null }, 'terminal'), null)
  assert.equal(w.act.closeAgent(null, null), null)
  assert.deepEqual(w.notes.map(n => n.text), ['Only Done and Idle agents close from here', 'Run the suite runs outside the layout; close it where it runs'])
})

test('x on a tab asks, and y closes the tab and says so', async () => {
  const w = world({ agents: () => [doneTab] })
  const q = w.act.closeAgent(doneTab, 'tab 2')
  assert.equal(q?.text, 'Close tab 2 (Run the suite)?')
  assert.deepEqual(w.calls, [])
  await q?.yes()
  assert.deepEqual(w.calls, [['run', '/conf/bin/ghostty-tabs', '--close', 'ghostty-1', '@12', 'keep']])
  assert.deepEqual(w.notes, [{ text: 'Closed tab 2 (Run the suite)', color: P.green, ms: 7000 }])
  assert.deepEqual(info(w, 'agent closed').map(l => [l.id, l.how, l.ok]), [['fin', 'tab', true]])
})

test('y runs what comes before the close first, and not when the close is called off', async () => {
  let live: Agent[] = [doneTab]
  const w = world({ agents: () => live })
  const before = async () => {
    w.calls.push(['before'])
  }
  await w.act.closeAgent(doneTab, 'tab 2', before)?.yes()
  assert.deepEqual(w.calls, [['before'], ['run', '/conf/bin/ghostty-tabs', '--close', 'ghostty-1', '@12', 'keep']])
  w.calls.length = 0
  const q = w.act.closeAgent(doneTab, 'tab 2', before)
  live = [{ ...doneTab, state: 'working' }]
  await q?.yes()
  assert.deepEqual(w.calls, [])
})

test('a tab ghostty-tabs could not close says why', async () => {
  const w = world({ rules: [{ kind: 'run', has: ['--close'], r: { ok: false, err: "can't find window: @12\n" } }], agents: () => [doneTab] })
  await w.act.closeAgent(doneTab, 'tab 2')?.yes()
  assert.deepEqual(w.notes, [{ text: "Couldn't close Run the suite: can't find window: @12 ", color: P.red, ms: 7000 }])
  assert.deepEqual(info(w, 'agent closed').map(l => [l.how, l.ok]), [['tab', false]])
})

test('a parked tab stops its job first, and keeps the tab when the stop fails', async () => {
  const parked = { ...doneTab, jobId: 'job1' }
  const ok = world({ agents: () => [parked] })
  await ok.act.closeAgent(parked, 'tab 2')?.yes()
  assert.deepEqual(ok.calls, [
    ['run', '/bin/claude', 'stop', 'job1'],
    ['run', '/conf/bin/ghostty-tabs', '--close', 'ghostty-1', '@12', 'keep'],
  ])
  assert.equal(ok.notes[0].text, 'Closed tab 2 and stopped Run the suite; claude attach job1 resumes it')
  const bad = world({ rules: [{ kind: 'run', has: ['stop'], r: { ok: false, err: 'no such job\n' } }], agents: () => [parked] })
  await bad.act.closeAgent(parked, 'tab 2')?.yes()
  assert.deepEqual(bad.calls, [['run', '/bin/claude', 'stop', 'job1']])
  assert.deepEqual(bad.notes, [{ text: "Couldn't close Run the suite: no such job ", color: P.red, ms: 7000 }])
  assert.deepEqual(info(bad, 'agent closed').map(l => [l.how, l.ok, l.err]), [['tab+job', false, 'no such job\n']])
})

test('x on a background agent stops it with claude stop', async () => {
  const bg = { ...doneTab, pane: null, jobId: 'job2', monitors: [{ state: 'watching' } as Monitor] }
  const w = world({ agents: () => [bg] })
  const q = w.act.closeAgent(bg, 'bg')
  assert.equal(q?.text, 'Stop background agent Run the suite and its monitor? Its conversation is kept.')
  await q?.yes()
  assert.deepEqual(w.calls, [['run', '/bin/claude', 'stop', 'job2']])
  assert.equal(w.notes[0].text, 'Stopped Run the suite; claude attach job2 resumes it')
})

test('y closes nothing once the agent went back to work, or went, while the question waited', async () => {
  let live: Agent[] = [doneTab]
  const w = world({ agents: () => live })
  const q = w.act.closeAgent(doneTab, 'tab 2')
  // A monitor's event started a new turn.
  live = [{ ...doneTab, state: 'working' }]
  await q?.yes()
  live = []
  await q?.yes()
  assert.deepEqual(w.calls, [])
  assert.deepEqual(w.notes.map(n => n.text), ['Only Done and Idle agents close from here'])
  assert.deepEqual(info(w, 'agent closed').map(l => [l.ok, l.reason]), [[false, 'busy'], [false, 'gone']])
})

// ------------------------------------------------------------ stop monitor

const owner = { id: 'sess', pid: 900, title: 'Babysit' }
const mon = { key: 'm1', task: 't1', description: 'PR #7 pipeline', state: 'watching', command: 'python3 watch_pr.py 7', agent: owner } as unknown as Monitored
const procs: Proc[] = [
  { pid: 950, ppid: 900, pgid: 950, start: 5, cmdline: "bash -c eval 'python3 watch_pr.py 7'" },
  { pid: 951, ppid: 950, pgid: 950, start: 6, cmdline: 'python3 watch_pr.py 7' },
]

test('x on an ended monitor says so and asks nothing', () => {
  const w = world()
  assert.equal(w.act.stopMonitor({ ...mon, state: 'ended' }), null)
  assert.deepEqual(w.notes.map(n => n.text), ['PR #7 pipeline has already ended'])
})

test('x on a monitor asks, can be skipped, and y ends its process group', () => {
  const w = world({ processes: () => procs })
  const q = w.act.stopMonitor(mon)
  assert.equal(q?.text, 'Stop monitor PR #7 pipeline? Babysit and its other monitors keep running.')
  assert.equal(q?.skip, 'hub.askStopMonitor')
  assert.deepEqual(w.calls, [])
  q?.yes()
  assert.deepEqual(w.calls, [
    ['kill', -950, 'SIGTERM'],
    ['markStopped', 'sess', 't1', 'python3 watch_pr.py 7'],
  ])
  assert.deepEqual(w.notes, [{ text: 'Stopped PR #7 pipeline; Babysit keeps running', color: P.green, ms: 7000 }])
  assert.deepEqual(info(w, 'monitor stopped').map(l => [l.id, l.task, l.ok, l.pid]), [['sess', 't1', true, 950]])
})

test('y on a monitor that ended while the question waited says so and kills nothing', () => {
  let live: Agent[] = []
  const w = world({ processes: () => procs, agents: () => live })
  const q = w.act.stopMonitor(mon)
  live = [{ ...owner, monitors: [{ key: 'm1', task: 't1', state: 'ended' }] } as unknown as Agent]
  q?.yes()
  assert.ok(!w.calls.some(c => c[0] === 'kill'))
  assert.deepEqual(w.notes.map(n => n.text), ['PR #7 pipeline has already ended'])
})

test('with the question turned off, x stops the monitor at once', () => {
  const w = world({ processes: () => procs, askStopMonitor: () => false })
  assert.equal(w.act.stopMonitor(mon), null)
  assert.deepEqual(w.calls[0], ['kill', -950, 'SIGTERM'])
})

test('a monitor whose process is gone, or that won’t die, says so', () => {
  const gone = world({ askStopMonitor: () => false })
  gone.act.stopMonitor(mon)
  assert.deepEqual(gone.notes, [{ text: "Couldn't find the process for PR #7 pipeline; it may have just ended", color: P.peach, ms: 7000 }])
  const denied = world({
    askStopMonitor: () => false,
    processes: () => procs,
    kill: () => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    },
  })
  denied.act.stopMonitor(mon)
  assert.deepEqual(denied.notes, [{ text: "Couldn't stop PR #7 pipeline: EPERM", color: P.red, ms: 7000 }])
  assert.deepEqual(denied.calls, [])
  const unreadable = world({
    askStopMonitor: () => false,
    processes: () => {
      throw new Error('EACCES /proc')
    },
  })
  unreadable.act.stopMonitor(mon)
  assert.equal(unreadable.logs.find(l => l.level === 'warn')?.message, 'processes unreadable')
})

test('don’t ask again turns the setting off, and says when it couldn’t', () => {
  const w = world()
  w.act.dontAsk('hub.askStopMonitor')
  assert.deepEqual(w.calls, [['setSetting', 'hub.askStopMonitor', false]])
  const bad = world({
    setSetting: () => {
      throw Object.assign(new Error('read-only'), { code: 'EROFS' })
    },
  })
  bad.act.dontAsk('hub.askStopMonitor')
  assert.deepEqual(bad.notes, [{ text: "Couldn't save that choice: EROFS", color: P.red, ms: 7000 }])
})

// ------------------------------------------------------------ new agent

// A task's spec as the form writes it, with the target it leaves empty.
const spec = { kind: 'task', cwd: '/home/x/projects/dotfiles', prompt: 'do it', target: '', worktree: false, model: 'default', mode: 'default', effort: 'default' } as LaunchSpec

test('New agent needs tmux to show its popup', async () => {
  const w = world({ env: {} })
  await w.act.newAgent()
  assert.deepEqual(w.notes.map(n => n.text), ['The hub is not running in tmux, so it has nowhere to show New agent'])
  assert.deepEqual(w.calls, [])
})

// The overlay's argv up to the form's command: borderless, the window's size,
// told which window to dim.
const overlayArgs = (under: string) => ['display-popup', '-E', '-B', '-t', '%1', '-w', '100%', '-h', '100%', '-s', 'bg=#0a0b0b', '-e', `OV_UNDER=${under}`]

test('New agent opens the form as an overlay over the hub’s window, then starts the agent in the background', async () => {
  let w: ReturnType<typeof world> | undefined
  const choose = () => writeFileSync(w?.deps.resultFile ?? '', JSON.stringify(spec))
  w = world({
    rules: [
      { has: ['#{window_id}'], r: { out: '@7\n' } },
      { has: ['display-popup'], effect: choose },
    ],
  })
  await w.act.newAgent()
  const popup = w.calls.find(c => c[1] === 'display-popup') as string[]
  assert.deepEqual(popup.slice(1, -1), overlayArgs('@7'))
  assert.match(popup.at(-1) ?? '', /hub\/newagent\/newagent\.ts' '.*new-agent\.json' '\{"folder":"\/home\/x\/projects\/dotfiles","recents":\["\/home\/x\/projects\/dotfiles"\]\}'$/)
  assert.ok(!existsSync(w.deps.resultFile))
  assert.deepEqual(w.calls.slice(2), [
    ['remember', '/home/x/projects/dotfiles'],
    ['spawn', '/bin/claude', '--bg', '--name', 'do-it', 'do it'],
  ])
  assert.deepEqual(info(w, 'new agent form closed').map(l => [l.ok, l.chose]), [[true, true]])
  assert.ok(!w.calls.some(c => c[0] === 'tabs'), 'no tab is opened')
})

test('Esc in the form starts nothing', async () => {
  const w = world({ rules: [{ has: ['#{window_id}'], r: { out: '@7\n' } }] })
  await w.act.newAgent()
  assert.equal(w.calls.length, 2)
  assert.deepEqual(info(w, 'new agent form closed').map(l => [l.ok, l.chose]), [[true, false]])
  assert.ok(!w.logs.some(l => l.level === 'warn'))
})

test('a window tmux won’t name leaves the overlay nothing to dim, and it still opens', async () => {
  for (const r of [{ ok: false, err: 'no current target' }, { out: '\n' }]) {
    const w = world({ rules: [{ has: ['#{window_id}'], r }] })
    await w.act.newAgent()
    const popup = w.calls.find(c => c[1] === 'display-popup') as string[]
    assert.deepEqual(popup.slice(1, -1), overlayArgs(''))
  }
})

test('a result the form left half-written is removed, not read again', async () => {
  let w: ReturnType<typeof world> | undefined
  const garble = () => writeFileSync(w?.deps.resultFile ?? '', '{"kind":')
  w = world({ rules: [{ has: ['display-popup'], effect: garble }] })
  await w.act.newAgent()
  assert.ok(!existsSync(w.deps.resultFile))
  assert.deepEqual(w.logs.filter(l => l.level === 'warn').map(l => l.message), ['new agent result unreadable'])
  assert.ok(!w.calls.some(c => c[0] === 'remember'))
})

test('a hub starting removes New agent results long left, and keeps one a restarted hub may still pick up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-results-'))
  for (const name of ['new-agent-100.json', 'new-agent-200.json', 'new-agent-x.json', 'state.json']) writeFileSync(join(dir, name), '{}')
  const hourAgo = (Date.now() - 3_600_000) / 1000
  utimesSync(join(dir, 'new-agent-200.json'), hourAgo, hourAgo)
  utimesSync(join(dir, 'new-agent-x.json'), hourAgo, hourAgo)
  const logs: Logged[] = []
  const at = (level: Level) => (message: string, fields?: object) => {
    logs.push({ level, message, ...fields })
  }
  const log = { info: at('info'), warn: at('warn') }
  pruneResults(dir, Date.now(), log)
  assert.deepEqual(readdirSync(dir).sort(), ['new-agent-100.json', 'new-agent-x.json', 'state.json'])
  assert.deepEqual(logs.map(l => [l.level, l.message, l.path]), [['info', 'stale new agent result removed', join(dir, 'new-agent-200.json')]])
  pruneResults(join(dir, 'missing'), Date.now(), log)
  assert.equal(logs.length, 1)
})

test('the form’s result is named after the hub’s pane, which the next hub there shares', () => {
  assert.equal(resultPath({ TMUX_PANE: '%12' }, '/run/agent-hub'), '/run/agent-hub/new-agent-12.json')
})

test('a result no form of this hub waits on is started, once written; one long left is removed', async () => {
  let now = Date.now()
  const w = world({ now: () => now })
  await w.act.adoptResult()
  assert.deepEqual(w.calls, [])
  // The form of the hub this one replaced writes its choice.
  writeFileSync(w.deps.resultFile, JSON.stringify(spec))
  await w.act.adoptResult()
  assert.ok(existsSync(w.deps.resultFile), 'may still be being written')
  now += 1000
  await w.act.adoptResult()
  assert.ok(!existsSync(w.deps.resultFile))
  assert.deepEqual(w.calls.at(-1), ['spawn', '/bin/claude', '--bg', '--name', 'do-it', 'do it'])
  assert.deepEqual(info(w, 'new agent result adopted').map(l => l.chose), [true])
  w.calls.length = 0
  writeFileSync(w.deps.resultFile, JSON.stringify(spec))
  now += 20 * 60_000
  await w.act.adoptResult()
  assert.ok(!existsSync(w.deps.resultFile))
  assert.deepEqual(w.calls, [])
  assert.equal(info(w, 'stale new agent result removed').length, 1)
})

test('a popup tmux won’t show says why', async () => {
  const noPopup = world({ rules: [{ has: ['display-popup'], r: { ok: false, err: 'no client' } }] })
  await noPopup.act.newAgent()
  assert.deepEqual(noPopup.notes.map(n => n.text), ["Couldn't show New agent: no client"])
})

test('with Run in the sandbox on, New agent starts its task with the sandbox settings', () => {
  const w = world({ sandbox: () => true })
  w.act.start({ kind: 'task', cwd: '/p', prompt: 'do it' })
  const argv = w.calls.find(c => c[0] === 'spawn') as string[]
  assert.equal(argv[argv.indexOf('--settings') + 1], SANDBOX_SETTINGS)
  assert.match(argv.at(-1) ?? '', /^From the hub: Your shell commands run in a sandbox\..*\n\nMy prompt:\ndo it$/s)
})

test('a background agent starts with claude --bg, and the footer says how that went', () => {
  type Fake = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; cmd: string; args: string[]; opts: SpawnOptions }
  const children: Fake[] = []
  const spawn: Spawn = (cmd, args, opts) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), unref: () => {}, cmd, args, opts })
    children.push(child)
    // Its streams are only emitters, which is all start listens to.
    return child as unknown as Child
  }
  const w = world({ spawn })
  w.act.start(spec)
  assert.deepEqual([children[0].cmd, children[0].args], ['/bin/claude', ['--bg', '--name', 'do-it', 'do it']])
  assert.equal(children[0].opts.detached, true)
  assert.deepEqual(w.notes.at(-1), { text: 'Starting do-it in the background…', color: P.sub, ms: 30000 })
  children[0].stdout.emit('data', 'bg-1\n')
  children[0].emit('close', 0)
  assert.deepEqual(w.notes.at(-1), { text: 'Started do-it in the background bg-1', color: P.green, ms: 7000 })
  w.act.start(spec)
  children[1].stderr.emit('data', 'not logged in')
  children[1].emit('close', 1)
  assert.deepEqual(w.notes.at(-1), { text: 'claude --bg failed: not logged in', color: P.red, ms: 7000 })
  // The prompt stays out of the log.
  const failed = info(w, 'agent started').at(-1)
  assert.deepEqual([failed?.ok, failed?.exit, failed?.cmd], [false, 1, ['/bin/claude', '--bg', '--name', 'do-it', '<prompt>']])
  // A claude that can't be run emits error, then close: the error's note
  // stays, logged once.
  w.act.start(spec)
  children[2].emit('error', new Error('spawn /bin/claude ENOENT'))
  children[2].emit('close', -2)
  assert.equal(w.notes.at(-1)?.text, "Couldn't start claude: spawn /bin/claude ENOENT")
  assert.equal(info(w, 'agent started').length, 3)
})

const stoppedBg = { id: 'sess-s', title: 'Nightly fix', state: 'idle', jobId: 'stop1', pane: null, stopped: true, monitors: [] } as unknown as Agent

test('r restarts a stopped background agent with claude respawn, and says so', async () => {
  const w = world()
  await w.act.restart(stoppedBg)
  assert.deepEqual(w.calls, [['run', '/bin/claude', 'respawn', 'stop1']])
  assert.deepEqual(
    w.notes.map(n => [n.text, n.color]),
    [
      ['Restarting Nightly fix…', P.sub],
      ['Restarted Nightly fix', P.green],
    ],
  )
  assert.deepEqual(
    info(w, 'agent restarted').map(l => [l.id, l.ok]),
    [['stop1', true]],
  )
})

test('r on an agent that isn’t stopped runs nothing; a failed respawn shows its error', async () => {
  const w = world()
  await w.act.restart({ ...stoppedBg, stopped: false })
  await w.act.restart(null)
  assert.deepEqual(w.calls, [])
  assert.equal(w.notes[0].text, "Nightly fix isn't stopped; r restarts only stopped background agents")
  const bad = world({ rules: [{ has: ['respawn'], r: { ok: false, err: 'no such session\n' } }] })
  await bad.act.restart(stoppedBg)
  assert.deepEqual(bad.notes.at(-1), { text: "Couldn't restart Nightly fix: no such session", color: P.red, ms: 7000 })
})

test('R asks first, then restarts every agent still stopped when you answer', async () => {
  const other = { ...stoppedBg, id: 'sess-t', jobId: 'stop2', title: 'Docs pass' } as Agent
  let live: Agent[] = [stoppedBg, other, permission]
  const w = world({ agents: () => live, rules: [{ has: ['stop2'], r: { ok: false, err: 'gone' } }] })
  const q = w.act.restartAll()
  assert.equal(q?.text, 'Restart all 2 stopped background agents?')
  assert.deepEqual(w.calls, [])
  live = [stoppedBg, other]
  await q?.yes()
  assert.deepEqual(w.calls, [
    ['run', '/bin/claude', 'respawn', 'stop1'],
    ['run', '/bin/claude', 'respawn', 'stop2'],
  ])
  assert.deepEqual(w.notes.at(-1), { text: 'Restarted 1 of 2 stopped agents', color: P.red, ms: 7000 })
  const none = world({ agents: () => [permission] })
  assert.equal(none.act.restartAll(), null)
  assert.equal(none.notes[0].text, 'No background agent is stopped')
})

test('R leaves out a stopped monitor session, which the board doesn’t show', () => {
  const monitorSession = { ...stoppedBg, id: 'sess-m', jobId: 'mon1', prompt: '/pr-babysit 12' } as Agent
  const w = world({ agents: () => [monitorSession] })
  assert.equal(w.act.restartAll(), null)
  assert.equal(w.notes[0].text, 'No background agent is stopped')
})
