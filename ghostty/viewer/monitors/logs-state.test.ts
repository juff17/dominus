// The sources are checked against files in a temp folder, never the real ones.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'

const { blockedSources, kubeconfigs, matchesAny, mcpServers } = await import('./sources.ts')
const { onPath } = await import('../../core/forge.ts')
const { WATCH_FOR_LABEL, envOpen, envsOf, logsKey, logsLines, pasteLogs, setWorld, sourcesFor, startLogs } = await import('./logs-state.ts')
const { launch } = await import('../../agents/launch.ts')
type LogsState = import('./logs-state.ts').LogsState
type Blocked = import('./sources.ts').Blocked

const DIR = mkdtempSync(join(tmpdir(), 'logs-'))
after(() => rmSync(DIR, { recursive: true, force: true }))

test('protected envs match globs with * and ?', () => {
  assert.equal(matchesAny('prod-eu', ['prod-*']), true)
  assert.equal(matchesAny('preprod-eu', ['prod-*']), false)
  assert.equal(matchesAny('eu', ['e?']), true)
})

test('Kubernetes needs kubectl on PATH and a kubeconfig file; Settings’ file and $KUBECONFIG’s, else ~/.kube/config', () => {
  assert.deepEqual(kubeconfigs('', undefined, '/home/x'), ['/home/x/.kube/config'])
  assert.deepEqual(kubeconfigs('/k/main', '/k/a:/k/b:/k/main', '/home/x'), ['/k/main', '/k/a', '/k/b'])
  const bin = join(DIR, 'bin')
  mkdirSync(bin)
  const config = join(DIR, 'kubeconfig')
  const input = { path: bin, kubeconfigs: [config], claudeJson: join(DIR, 'none.json'), folder: '' }
  assert.equal(onPath('kubectl', bin), false)
  assert.equal(blockedSources(input).kubernetes, 'kubectl')
  writeFileSync(join(bin, 'kubectl'), '#!/bin/sh\n')
  chmodSync(join(bin, 'kubectl'), 0o755)
  assert.equal(onPath('kubectl', `/nowhere:${bin}`), true)
  assert.equal(blockedSources(input).kubernetes, 'kubeconfig')
  writeFileSync(config, 'apiVersion: v1\n')
  assert.equal(blockedSources(input).kubernetes, undefined)
})

test('Elastic needs an MCP server named elastic or kibana, in user, local or project scope', () => {
  const folder = join(DIR, 'repo')
  mkdirSync(folder)
  const claudeJson = join(DIR, 'claude.json')
  const input = { path: '', kubeconfigs: [], claudeJson, folder }
  assert.equal(blockedSources(input).elastic, 'elastic', 'no file')
  writeFileSync(claudeJson, JSON.stringify({ mcpServers: { github: {} }, projects: { [folder]: { mcpServers: { 'my-kibana': {} } } } }))
  assert.deepEqual(mcpServers(claudeJson, folder), ['github', 'my-kibana'])
  assert.equal(blockedSources(input).elastic, undefined, 'local scope')
  assert.equal(blockedSources({ ...input, folder: DIR }).elastic, 'elastic', 'another folder’s')
  writeFileSync(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { Elastic: {} } }))
  writeFileSync(claudeJson, '{ broken')
  assert.deepEqual(mcpServers(claudeJson, folder), ['Elastic'], 'a broken file has none; the project’s still counts')
})

const OPTIONS = { models: ['sonnet', 'haiku'], efforts: ['low', 'medium'], model: 'haiku', effort: 'low', protect: ['eu'] }
const BOTH: Blocked = {}
const NEITHER: Blocked = { kubernetes: 'kubectl', elastic: 'elastic' }

function form(blocked: Blocked = BOTH, envs?: string[]): LogsState {
  const l = startLogs({ ...OPTIONS, ...(envs ? { envs } : {}) })
  setWorld(l, blocked, '/home/jl/projects/x')
  return l
}
const notes: string[] = []
const say = (text: string) => notes.push(text)
const keys = (l: LogsState, ...ks: string[]) => ks.map(k => logsKey(l, k, say)).at(-1)

test('the envs are Settings’ list, local first and always there; the form starts on local with Docker', () => {
  assert.deepEqual(envsOf(form()), ['local', 'qa', 'stage', 'eu', 'ca', 'us'])
  assert.deepEqual(envsOf(form(BOTH, ['qa', 'eu'])), ['local', 'qa', 'eu'])
  assert.deepEqual(envsOf(form(BOTH, ['qa', 'local'])), ['local', 'qa'])
  const l = form()
  assert.equal(l.env, 'local')
  assert.equal(l.source, 'docker')
})

test('local is Docker alone; another env is Kubernetes or Elastic, whichever is set up, Kubernetes first', () => {
  const l = form()
  keys(l, '\x1b[C')
  assert.equal(l.env, 'qa')
  assert.equal(l.source, 'kubernetes', 'local’s Docker goes')
  keys(l, '\x1b[B', '\x1b[C')
  assert.equal(l.source, 'elastic')
  keys(l, '\x1b[C')
  assert.equal(l.source, 'elastic', 'held at the last')
  keys(l, '\x1b[A', '\x1b[C')
  assert.equal(l.source, 'elastic', 'kept from qa to stage')
  keys(l, '\x1b[D', '\x1b[D')
  assert.equal(l.env, 'local')
  assert.equal(l.source, 'docker')
  assert.deepEqual(sourcesFor(l, 'local'), ['docker'])
  assert.deepEqual(sourcesFor(form({ kubernetes: 'kubeconfig' }), 'qa'), ['elastic'])
  assert.deepEqual(sourcesFor(form({ elastic: 'elastic' }), 'qa'), ['kubernetes'])
})

test('with neither Kubernetes nor Elastic, only local is open; ←/→ skip the rest', () => {
  const l = form(NEITHER)
  assert.equal(envOpen(l, 'local'), true)
  assert.equal(envOpen(l, 'qa'), false)
  keys(l, '\x1b[C', '\x1b[C')
  assert.equal(l.env, 'local')
  // Before the check, too.
  const unchecked = startLogs(OPTIONS)
  assert.equal(envOpen(unchecked, 'qa'), false)
  logsKey(unchecked, '\x1b[C', say)
  assert.equal(unchecked.env, 'local')
})

test('↑/↓ move between fields; Watch for takes several lines, q and j included', () => {
  const l = form()
  keys(l, '\x1b[B')
  assert.equal(l.field, 'source')
  keys(l, '\x1b[B')
  assert.equal(l.field, 'task')
  for (const ch of 'quiet j') keys(l, ch)
  keys(l, '\r')
  pasteLogs(l, '500s on /v2/export\r\nand rate limits')
  assert.equal(l.task, 'quiet j\n500s on /v2/export\nand rate limits')
  keys(l, '\x1b[B')
  assert.equal(l.field, 'level')
  keys(l, '\x1b[C')
  assert.equal(l.level, 'error')
  keys(l, 'j')
  assert.equal(l.field, 'for')
  keys(l, 'h')
  assert.equal(l.for, '1h')
  keys(l, 'j', 'l')
  assert.equal(l.model, 'sonnet', 'model steps round')
  keys(l, 'j', 'j', 'j')
  assert.equal(l.field, 'effort', 'held at the last')
})

test('ctrl+s needs something to watch for, then starts it with the env and source', () => {
  const l = form()
  notes.length = 0
  assert.equal(keys(l, '\x13'), null)
  assert.equal(l.field, 'task')
  assert.match(notes[0], /Say what to watch for/)
  pasteLogs(l, 'OOM kills')
  assert.deepEqual(keys(l, '\x13'), {
    do: 'logs',
    spec: { env: 'local', source: 'docker', folder: '/home/jl/projects/x', level: 'warn', for: '2h', watchFor: 'OOM kills', model: 'haiku', effort: 'low', protected: false },
  })
  // An env that closed after it was picked.
  const shut = form()
  keys(shut, '\x1b[C')
  setWorld(shut, NEITHER, shut.folder)
  assert.equal(shut.env, 'local', 'the check moves it back to local')
  shut.env = 'qa'
  pasteLogs(shut, 'x')
  assert.equal(keys(shut, '\x13'), null)
  assert.match(notes.at(-1)!, /Pick an environment/)
})

test('the images pasted into Watch for, still named there, go with the spec', () => {
  const l = form()
  l.field = 'task'
  pasteLogs(l, 'errors like ')
  l.task += '[Image #1] [Image #2]'
  l.images = [{ n: 1, path: '/i/a.png' }, { n: 2, path: '/i/b.png' }]
  delete l.at
  keys(l, '\x7f')
  const act = keys(l, '\x13')
  assert.deepEqual(act?.spec.images, [{ n: 1, path: '/i/a.png' }])
  const spec = act!.spec
  const plan = launch({ kind: 'monitor', skill: 'logs', cwd: '/p', target: '', lines: logsLines(spec), typed: { label: WATCH_FOR_LABEL, text: spec.watchFor }, images: spec.images })
  assert.match(plan.argv.at(-1)!, /\nFor: 2h\nThe prompt has images attached: \[Image #1\] is \/i\/a\.png\. Read each one with the Read tool before you start\.\n\nWatch for:\nerrors like \[Image #1\]$/)
})

test('a protected environment asks once more: ctrl+s again starts it, anything else goes back', () => {
  const l = form()
  keys(l, '\x1b[C', '\x1b[C', '\x1b[C')
  assert.equal(l.env, 'eu')
  l.field = 'task'
  pasteLogs(l, 'errors')
  assert.equal(keys(l, '\x13'), null)
  assert.equal(l.confirm, true)
  assert.equal(keys(l, 'x'), null)
  assert.equal(l.confirm, false)
  keys(l, '\x13')
  assert.equal(keys(l, 'y'), null, 'y is no longer yes')
  keys(l, '\x13')
  const act = keys(l, '\x13')
  assert.equal(act?.do, 'logs')
  assert.equal(act?.spec.env, 'eu')
  assert.equal(act?.spec.source, 'kubernetes')
  assert.equal(act?.spec.protected, true)
  assert.equal(l.confirm, false)
})

test('the prompt: /dominus:log-watcher watch, then a line each, then Watch for as typed', () => {
  const spec = { env: 'stage', source: 'elastic' as const, folder: '/home/jl/projects/x', level: 'warn', for: '2h', watchFor: '500s on /v2/export\nrequest ids too', model: 'haiku', effort: 'low', protected: false }
  const plan = launch({ kind: 'monitor', skill: 'logs', target: '', lines: logsLines(spec), typed: { label: WATCH_FOR_LABEL, text: spec.watchFor }, name: 'logs stage', cwd: '/home/jl/projects/x', model: 'haiku', effort: 'low', mode: 'auto' })
  assert.deepEqual(plan.argv, [
    'claude',
    '--bg',
    '--name',
    'logs stage',
    '--model',
    'haiku',
    '--permission-mode',
    'auto',
    '--effort',
    'low',
    '/dominus:log-watcher watch\nEnvironment: stage\nSource: elastic\nFolder: /home/jl/projects/x\nLevel: warn\nFor: 2h\n\nWatch for:\n500s on /v2/export\nrequest ids too',
  ])
})

test('a pipeline monitor’s prompt: /dominus:pipeline-watch <target>, then Until', () => {
  const plan = launch({ kind: 'monitor', skill: 'pipe', target: 'https://gitlab.example.com/platform/api/-/pipelines/4512', lines: ['Until: finished'], cwd: '/p', model: 'haiku', effort: 'low', mode: 'auto' })
  assert.equal(plan.argv?.at(-1), '/dominus:pipeline-watch https://gitlab.example.com/platform/api/-/pipelines/4512\nUntil: finished')
  assert.equal(plan.name, 'pipeline platform/api #4512')
})
