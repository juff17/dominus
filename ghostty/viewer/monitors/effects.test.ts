// Each test hands monitorsEffects a fake world, so nothing real is started
// or stopped.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'

const { monitorsEffects, readCache, configuredHosts } = await import('./effects.ts')
const { onKey, start, setAgents } = await import('./state.ts')
const { load } = await import('../../settings/settings.ts')
type World = import('./effects.ts').World
type HostResult = import('./forge.ts').HostResult
type Pr = import('./forge.ts').Pr
type Agent = import('../../agents/model.ts').Agent
type Settings = import('../../settings/settings.ts').Settings
type ApprovalsWorld = import('../approvals/effects.ts').ApprovalsWorld
type Proposal = import('../../tray/approvals.ts').Proposal
type SpawnSyncReturns<T> = import('node:child_process').SpawnSyncReturns<T>

const NOW = Date.UTC(2026, 10, 11, 12)
const PR: Pr = {
  forge: 'gh',
  host: 'github.com',
  repo: 'jl/gad',
  number: 77,
  url: 'https://github.com/jl/gad/pull/77',
  title: 'Retry the sync job',
  draft: false,
  author: 'jl',
  head: 'jl/sync-retry',
  base: 'main',
  createdAt: NOW,
  pipeline: { state: 'passed', job: '', done: 1, total: 1 },
  reviews: { approvedBy: [], required: 0, changes: false, waiting: false, threads: 0, reviewers: [] },
  branch: { state: 'ok', behind: 0 },
  mine: true,
  review: false,
}
const OTHER: Pr = { ...PR, repo: 'jl/elsewhere', number: 5, url: 'https://github.com/jl/elsewhere/pull/5' }
const host = (prs: Pr[], more: Partial<HostResult> = {}): HostResult => ({ forge: 'gh', host: 'github.com', me: 'jl', at: NOW, ms: 5, prs, ok: true, ...more }) as HostResult

const AGENT = {
  id: 's1',
  pid: 900,
  kind: 'bg',
  title: 'monitor #77',
  repo: 'gad',
  cwd: '/p/gad',
  model: 'claude-sonnet-5-5',
  prompt: '',
  pane: null,
  jobId: 'j1',
  monitors: [{ key: 's1:t1', task: 't1', description: 'PR #77', kind: 'pr-babysit', command: 'python3 watch_pr.py https://github.com/jl/gad/pull/77', state: 'watching', busy: false, event: null, startedAt: NOW, ended: null }],
} as unknown as Agent

// A child that says `out` and exits with `code` once listened to.
function child(code: number, out = '') {
  const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), unref: () => {} })
  setImmediate(() => {
    if (out) c.stdout.emit('data', Buffer.from(out))
    c.emit('close', code)
  })
  return c
}

function world(dir: string, more: Partial<World> = {}) {
  const calls: unknown[][] = []
  const settings = { ...load(), 'monitors.githubHosts': ['github.com'], 'monitors.gitlabHosts': [] } as Settings
  const w: World = {
    forge: { fetch: async (forge, h) => (calls.push(['fetch', forge, h]), host([PR, OTHER])) },
    spawn: ((cmd: string, args: readonly string[], opts: { cwd?: string }) => (calls.push(['spawn', cmd, args, opts.cwd]), child(0, 'started job 1'))) as unknown as World['spawn'],
    agents: () => [AGENT],
    proposals: () => [],
    approvals: {
      git: () => ({ out: '' }),
      runApproval: async (_, args) => (calls.push(['approval', ...args]), { ok: true, message: 'Retried' }),
      setSetting: () => {},
      spawn: (() => ({})) as unknown as ApprovalsWorld['spawn'],
    },
    go: async a => (calls.push(['go', a.id]), { ok: true, message: 'in the hub' }),
    stop: m => (calls.push(['stop', m.task]), { ok: true, pid: 950, group: true }),
    settings: () => settings,
    dontAskStop: () => calls.push(['dontAskStop']),
    claude: () => '/bin/claude',
    plugin: () => true,
    pipelines: {
      fetch: async q => (calls.push(['pipes', q.forge, q.host, q.projects, q.prs.map(p => p.url)]), { forge: q.forge, host: q.host, at: NOW, ms: 1, pipes: [], ok: true }),
      run: async (pipe, gate) => (calls.push(['gate', pipe.id, gate.id]), { ok: true }),
    },
    sources: folder => (calls.push(['sources', folder]), { elastic: 'elastic' }),
    tabFolder: async layout => (calls.push(['tabFolder', layout]), dir),
    setFromPrs: on => calls.push(['setFromPrs', on]),
    cacheFile: join(dir, 'cache.json'),
    attachedFile: join(dir, 'attached.json'),
    known: () => [],
    home: dir,
    now: () => NOW,
    ...more,
  }
  const views: string[] = []
  const io = { ...w, draw: () => {}, quit: () => void views.push('quit'), outside: () => ({ status: 0 }) as SpawnSyncReturns<Buffer> }
  return { w, io, calls, views }
}

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'monitors-fx-'))
  const s = start({ options: { models: ['sonnet'], efforts: ['medium'], model: 'sonnet', effort: 'medium', askStop: true } })
  return { dir, s, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('it opens with the cache, kept to the hosts Settings lists, then refreshes and writes it back', async () => {
  const { dir, s, done } = fresh()
  try {
    writeFileSync(join(dir, 'cache.json'), JSON.stringify({ v: 1, prs: [host([PR]), host([], { host: 'gone.example' })] }))
    const { io, calls } = world(dir)
    const fx = monitorsEffects(s, io)
    fx.load()
    assert.deepEqual(
      s.hosts.map(h => h.host),
      ['github.com'],
    )
    assert.equal(s.agents.length, 1)
    await fx.refresh()
    assert.deepEqual(calls.filter(c => c[0] === 'fetch'), [['fetch', 'gh', 'github.com']])
    // Then the pipelines: the projects of its open PRs, and the PR its monitor watches.
    assert.deepEqual(calls.filter(c => c[0] === 'pipes'), [['pipes', 'gh', 'github.com', ['jl/gad', 'jl/elsewhere'], ['https://github.com/jl/gad/pull/77']]])
    assert.equal(s.hosts[0].prs.length, 2)
    assert.equal(s.refreshing, false)
    assert.equal(readCache(join(dir, 'cache.json')).prs[0].prs.length, 2)
    assert.equal(readCache(join(dir, 'cache.json')).pipes.hosts.length, 1, 'the pipelines are written beside the PRs')
    assert.deepEqual(readCache(join(dir, 'nothing.json')), { prs: [], pipes: { hosts: [], skipped: {}, dismissed: [] } })
  } finally {
    done()
  }
})

test('the hosts: GitHub’s then GitLab’s', () => {
  assert.deepEqual(configuredHosts({ 'monitors.githubHosts': ['github.com'], 'monitors.gitlabHosts': ['gl.example'] }), [
    { forge: 'gh', host: 'github.com' },
    { forge: 'gl', host: 'gl.example' },
  ])
})

test('ctrl+s starts claude --bg in each PR’s clone with the options in its prompt, records them, and goes to Running', async () => {
  const { dir, s, done } = fresh()
  try {
    const { io, calls } = world(dir)
    const fx = monitorsEffects(s, io)
    s.hosts = [host([PR, OTHER])]
    s.checkouts = new Map([['github.com/jl/gad', '/p/gad']])
    setAgents(s, [])
    s.view = 'prs'
    for (const k of ['*', '\r', '4']) onKey(s, k)
    await fx.run(onKey(s, '\x13'))
    const spawned = calls.filter(c => c[0] === 'spawn')
    assert.equal(spawned.length, 1, 'the PR with no clone isn’t started')
    assert.deepEqual(spawned[0], [
      'spawn',
      '/bin/claude',
      ['--bg', '--name', 'monitor #77', '--model', 'sonnet', '--permission-mode', 'auto', '--effort', 'medium', '/dominus:pr-babysit https://github.com/jl/gad/pull/77 Attach options: watch pipeline, comments, rebase; ping on every comment; until merged or closed.'],
      '/p/gad',
    ])
    const record = JSON.parse(readFileSync(join(dir, 'attached.json'), 'utf8'))
    assert.deepEqual(Object.keys(record), ['https://github.com/jl/gad/pull/77'])
    assert.equal(record['https://github.com/jl/gad/pull/77'].watch.ping, true)
    assert.equal(s.view, 'running')
    assert.equal(s.drawer, null)
    assert.equal(s.prs.marked.size, 0)
    assert.equal(s.note?.tone, 'red')
    assert.match(s.note?.text ?? '', /Started a monitor on #77.*Couldn't start jl\/elsewhere #5: no clone of jl\/elsewhere/)
  } finally {
    done()
  }
})

test('a claude that fails to start says why, and nothing is recorded', async () => {
  const { dir, s, done } = fresh()
  try {
    const { io } = world(dir, { spawn: (() => child(1, 'Error: not logged in\n')) as unknown as World['spawn'] })
    const fx = monitorsEffects(s, io)
    s.hosts = [host([PR])]
    s.checkouts = new Map([['github.com/jl/gad', '/p/gad']])
    s.view = 'prs'
    onKey(s, '\r')
    await fx.run(onKey(s, '\x13'))
    assert.match(s.note?.text ?? '', /Couldn't start jl\/gad #77: Error: not logged in/)
    assert.equal(s.view, 'prs', 'the drawer stays to try again')
    assert.notEqual(s.drawer, null)
  } finally {
    done()
  }
})

test('without the dominus plugin a monitor isn’t started, and the note says to install it', async () => {
  const { dir, s, done } = fresh()
  try {
    const { io, calls } = world(dir, { plugin: () => false })
    const fx = monitorsEffects(s, io)
    s.hosts = [host([PR])]
    s.checkouts = new Map([['github.com/jl/gad', '/p/gad']])
    s.view = 'prs'
    onKey(s, '\r')
    await fx.run(onKey(s, '\x13'))
    assert.equal(calls.filter(c => c[0] === 'spawn').length, 0)
    assert.match(s.note?.text ?? '', /Couldn't start jl\/gad #77: the dominus Claude Code plugin isn't installed; run \.\/install\.sh/)
    s.view = 'pipes'
    await fx.run({ do: 'watchPipe', target: PIPE.url })
    assert.equal(calls.filter(c => c[0] === 'spawn').length, 0)
    assert.match(s.note?.text ?? '', /plugin isn't installed/)
  } finally {
    done()
  }
})

test('↵ opens the session in the hub and closes; a with nothing waiting says so; x stops it the hub’s way, a stops asking', async () => {
  const { dir, s, done } = fresh()
  try {
    const { io, calls, views } = world(dir)
    const fx = monitorsEffects(s, io, { layout: 'layout-1' })
    fx.load()
    await fx.run(onKey(s, '\r'))
    assert.deepEqual(calls.at(-1), ['go', 's1'])
    assert.deepEqual(views, ['quit'])
    await fx.run(onKey(s, 'a'))
    assert.equal(s.panel, null)
    assert.equal(s.note?.text, 'Nothing waits on gad #77')
    assert.deepEqual(views, ['quit'])
    onKey(s, 'x')
    await fx.run(onKey(s, 'a'))
    assert.deepEqual(calls.slice(-2), [['dontAskStop'], ['stop', 't1']])
    assert.equal(s.options.askStop, false)
    assert.match(s.note?.text ?? '', /Stopped PR #77; monitor #77 keeps running/)
  } finally {
    done()
  }
})

test('a monitor with no process, or one that won’t stop, says so', async () => {
  const { dir, s, done } = fresh()
  try {
    const gone = world(dir, { stop: () => ({ ok: false, reason: 'no process' }) })
    const fx = monitorsEffects(s, gone.io)
    fx.load()
    onKey(s, 'x')
    await fx.run(onKey(s, 'x'))
    assert.match(s.note?.text ?? '', /Couldn't find the process/)
    const denied = world(dir, { stop: () => ({ ok: false, reason: 'kill failed', pid: 1, err: new Error('EPERM') }) })
    const fx2 = monitorsEffects(s, denied.io)
    onKey(s, 'x')
    await fx2.run(onKey(s, 'x'))
    assert.match(s.note?.text ?? '', /Couldn't stop PR #77: EPERM/)
  } finally {
    done()
  }
})

test('o opens the PR with xdg-open, without waiting for it', async () => {
  const { dir, s, done } = fresh()
  try {
    const { io, calls } = world(dir)
    const fx = monitorsEffects(s, io)
    fx.load()
    await fx.run(onKey(s, 'o'))
    assert.deepEqual(calls.at(-1), ['spawn', 'xdg-open', ['https://github.com/jl/gad/pull/77'], undefined])
    assert.match(s.note?.text ?? '', /Opened/)
  } finally {
    done()
  }
})

test('a session the hub can’t open says why and stays open', async () => {
  const { dir, s, done } = fresh()
  try {
    const { io, views } = world(dir, { go: async () => ({ ok: false, message: 'The hub isn’t running' }) })
    const fx = monitorsEffects(s, io)
    fx.load()
    await fx.run(onKey(s, '\r'))
    assert.deepEqual(views, [])
    assert.deepEqual(s.note, { text: 'The hub isn’t running', tone: 'red' })
  } finally {
    done()
  }
})

// ------------------------------------------------------------ Pipelines and Logs

const { pipeQueries } = await import('./effects.ts')
const { allRunning } = await import('./state.ts')
type Pipe = import('./pipelines.ts').Pipe

const PIPE: Pipe = {
  forge: 'gl',
  host: 'gitlab.example.com',
  project: 'platform/api',
  id: 4512,
  url: 'https://gitlab.example.com/platform/api/-/pipelines/4512',
  ref: 'v2.14.0',
  sha: '8c41d2e',
  trigger: 'tag',
  state: 'manual',
  stages: [{ name: 'deploy', state: 'manual', done: 0, total: 1 }],
  gates: [{ id: '9001', kind: 'job', name: 'deploy:prod-eu', stage: 'deploy', env: '', sha: '8c41d2e', url: '' }],
  failed: '',
  at: NOW,
  pr: '',
  prRef: '',
}

test('the pipelines to fetch: Settings’ projects per host, else its open PRs’ projects, and the PRs monitors watch', () => {
  const s = start()
  setAgents(s, [AGENT])
  const v = { 'monitors.githubHosts': ['github.com'], 'monitors.gitlabHosts': ['gitlab.example.com'], 'monitors.pipelines.projects': [], 'monitors.pipelines.refs': ['default branch', 'v*'] }
  assert.deepEqual(pipeQueries(v, [host([PR, OTHER])], allRunning(s), true), [
    {
      forge: 'gh',
      host: 'github.com',
      projects: ['jl/gad', 'jl/elsewhere'],
      refs: ['default branch', 'v*'],
      prs: [{ forge: 'gh', host: 'github.com', project: 'jl/gad', number: 77, url: 'https://github.com/jl/gad/pull/77' }],
    },
  ])
  // Projects named in Settings go to their host; with PR monitors' pipelines off, no PRs.
  const named = pipeQueries({ ...v, 'monitors.pipelines.projects': ['gitlab.example.com/platform/api', 'github.com/jl/dotfiles'] }, [], allRunning(s), false)
  assert.deepEqual(
    named.map(q => [q.host, q.projects, q.prs.length]),
    [
      ['github.com', ['jl/dotfiles'], 0],
      ['gitlab.example.com', ['platform/api'], 0],
    ],
  )
})

test('y on a gate runs it through the client, says so, and fetches the pipelines again', async () => {
  const { dir, s, done } = fresh()
  try {
    const { io, calls } = world(dir)
    const fx = monitorsEffects(s, io)
    s.hosts = [host([PR])]
    await fx.run({ do: 'gate', pipe: PIPE, gate: PIPE.gates[0] })
    assert.deepEqual(
      calls.filter(c => c[0] === 'gate' || c[0] === 'pipes').map(c => c[0]),
      ['gate', 'pipes'],
    )
    assert.deepEqual(s.note, { text: 'Ran deploy:prod-eu on v2.14.0', tone: 'green' })
    const refused = world(dir, { pipelines: { fetch: io.pipelines.fetch, run: async () => ({ ok: false, why: 'changed', err: 'running' }) } })
    await monitorsEffects(s, refused.io).run({ do: 'gate', pipe: PIPE, gate: PIPE.gates[0] })
    assert.equal(s.note?.tone, 'peach')
    assert.match(s.note?.text ?? '', /deploy:prod-eu changed since it was shown \(running\), so it didn't run/)
  } finally {
    done()
  }
})

test('m starts a pipeline-watch in the background with Settings’ pipeline model and effort, then goes to Running', async () => {
  const { dir, s, done } = fresh()
  try {
    const { io, calls } = world(dir)
    const fx = monitorsEffects(s, io)
    s.checkouts = new Map([['gitlab.example.com/platform/api', '/p/platform-api']])
    s.view = 'pipes'
    await fx.run({ do: 'watchPipe', target: PIPE.url })
    assert.deepEqual(calls.filter(c => c[0] === 'spawn').at(-1), [
      'spawn',
      '/bin/claude',
      ['--bg', '--name', 'pipeline platform/api #4512', '--model', 'haiku', '--permission-mode', 'auto', '--effort', 'low', '/dominus:pipeline-watch https://gitlab.example.com/platform/api/-/pipelines/4512\nUntil: finished'],
      '/p/platform-api',
    ])
    assert.equal(s.view, 'running')
    assert.deepEqual(s.run.want, ['target:https://gitlab.example.com/platform/api/-/pipelines/4512'])
    // Once agentd lists it, Running selects it.
    const watcher = { ...AGENT, id: 's9', title: 'pipeline platform/api #4512', prompt: `/dominus:pipeline-watch ${PIPE.url}`, monitors: [{ ...AGENT.monitors[0], key: 's9:t1', kind: 'python3', command: 'python3 watch_pipeline.py' }] } as Agent
    setAgents(s, [AGENT, watcher])
    assert.equal(s.run.sel, 's9:t1')
    assert.equal(allRunning(s).find(r => r.key === 's9:t1')?.kind, 'pipe')
  } finally {
    done()
  }
})

test('the Logs form reads the tab’s folder and what it can watch from; ctrl+s starts a log-watcher there', async () => {
  const { dir, s, done } = fresh()
  try {
    const { io, calls } = world(dir)
    const fx = monitorsEffects(s, io, { layout: 'layout-3' })
    await fx.readLogsWorld()
    assert.deepEqual(calls.slice(0, 2), [
      ['tabFolder', 'layout-3'],
      ['sources', dir],
    ])
    assert.equal(s.logs.folder, dir)
    assert.deepEqual(s.logs.blocked, { elastic: 'elastic' })
    assert.equal(s.logs.env, 'local')
    s.view = 'logs'
    s.logs.task = '500s on /v2/export'
    onKey(s, '\x1b[C')
    assert.equal(s.logs.env, 'qa')
    assert.equal(s.logs.source, 'kubernetes')
    s.logs.field = 'task'
    await fx.run(onKey(s, '\x13'))
    assert.deepEqual(calls.filter(c => c[0] === 'spawn').at(-1), [
      'spawn',
      '/bin/claude',
      [
        '--bg',
        '--name',
        'logs qa',
        '--model',
        'haiku',
        '--permission-mode',
        'auto',
        '--effort',
        'low',
        `/dominus:log-watcher watch\nEnvironment: qa\nSource: kubernetes\nFolder: ${dir}\nLevel: warn\nFor: 2h\n\nWatch for:\n500s on /v2/export`,
      ],
      dir,
    ])
    assert.deepEqual(s.run.want, ['name:logs qa'])
    assert.equal(s.view, 'running')
    assert.equal(s.logs.task, '', 'the form is ready for the next')
  } finally {
    done()
  }
})

test('P saves pipelines from PR monitors and fetches again; n’s skips are kept in the cache', async () => {
  const { dir, s, done } = fresh()
  try {
    const { io, calls } = world(dir)
    const fx = monitorsEffects(s, io)
    s.view = 'pipes'
    await fx.run(onKey(s, 'P'))
    assert.deepEqual(
      calls.find(c => c[0] === 'setFromPrs'),
      ['setFromPrs', false],
    )
    s.hosts = [host([PR])]
    s.pipes.skipped = { k: 'v' }
    await fx.run({ do: 'savePipes' })
    assert.equal(readCache(join(dir, 'cache.json')).prs.length, 1, 'saving the pipelines keeps the PRs')
    assert.deepEqual(readCache(join(dir, 'cache.json')).pipes.skipped, { k: 'v' })
    s.pipes.dismissed = new Set(['gl:h:p:1'])
    await fx.run({ do: 'savePipes' })
    assert.deepEqual(readCache(join(dir, 'cache.json')).pipes.dismissed, ['gl:h:p:1'])
  } finally {
    done()
  }
})

test('the panel settles through approval.py, re-reads the proposals, and closes green once the monitor has none left', async () => {
  const { dir, s, done } = fresh()
  try {
    const retry: Proposal = { id: 'p1', kind: 'retry', status: 'pending', title: 'Retry test:unit', claude_session: 's1', at: NOW, job: { name: 'test:unit' } }
    let waiting = [retry]
    const { io, calls, views } = world(dir, { proposals: () => waiting })
    io.approvals.runApproval = async (_, args) => {
      calls.push(['approval', ...args])
      waiting = []
      return { ok: true, message: 'Retried' }
    }
    const fx = monitorsEffects(s, io, { layout: 'layout-1' })
    fx.load()
    assert.equal(s.proposals.length, 1)
    onKey(s, 'a')
    assert.equal(s.panel?.key, 's1:t1')
    // The view's draw says all of it was on screen.
    s.panel.ap.hidden = false
    await fx.run(onKey(s, 'a'))
    assert.deepEqual(calls.at(-1), ['approval', 'approve', 'p1'])
    assert.equal(s.panel, null)
    assert.deepEqual(s.note, { text: 'Retried · nothing left on gad #77', tone: 'green' })
    assert.deepEqual(s.proposals, [])
    assert.deepEqual(views, [])
  } finally {
    done()
  }
})

test('g in the panel goes to the session that proposed it, in this window, and closes Monitors', async () => {
  const { dir, s, done } = fresh()
  try {
    const retry: Proposal = { id: 'p1', kind: 'retry', status: 'pending', title: 'Retry test:unit', claude_session: 's1', at: NOW }
    const { io, calls, views } = world(dir, { proposals: () => [retry] })
    const fx = monitorsEffects(s, io, { layout: 'layout-1' })
    fx.load()
    onKey(s, 'a')
    await fx.run(onKey(s, 'g'))
    assert.deepEqual(calls.at(-1), ['go', 's1'])
    assert.deepEqual(views, ['quit'])
  } finally {
    done()
  }
})
