import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'

const { attachImage, onKey, openOldest, openOn, panelEmptied, paste, prList, runningRows, selectedPr, selectedRun, setAgents, setProposals, start, started, targets } = await import('./state.ts')
const { parseGithub } = await import('./forge.ts')
const { takesImages } = await import('./state.ts')
type Agent = import('../../agents/model.ts').Agent
type HostResult = import('./forge.ts').HostResult
type MonitorsState = import('./state.ts').MonitorsState
type Proposal = import('../../tray/approvals.ts').Proposal

const FIXTURES = join(import.meta.dirname, '../../../tests/fixtures/viewer/monitors')
const NOW = Date.UTC(2026, 10, 11, 12)
const UNIT: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }
const fixture = (name: string, iso = false): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'), (_, v) => {
    const m = typeof v === 'string' ? /^@-([\d.]+)([smhd])$/.exec(v) : null
    if (!m) return v
    const at = NOW - Number(m[1]) * UNIT[m[2]]
    return iso ? new Date(at).toISOString() : at
  })
const AGENTS = (fixture('agents.json') as { agents: Agent[] }).agents
const GH = parseGithub(fixture('gh-graphql.json', true), 'github.com')!
const PROPOSALS = (fixture('proposals.json') as { proposals: Proposal[] }).proposals

const CTRL_S = '\x13'
const ESC = '\x1b'

function state(more: Partial<MonitorsState> = {}): MonitorsState {
  const s = start({ options: { models: ['fable', 'opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high', 'xhigh'], model: 'sonnet', effort: 'medium', askStop: true } })
  const hosts: HostResult[] = [{ forge: 'gh', host: 'github.com', me: 'jl', at: NOW, ms: 1, prs: GH.prs, ok: true }]
  Object.assign(s, { hosts, ...more })
  setAgents(s, AGENTS)
  return s
}
const keys = (s: MonitorsState, ...ks: string[]) => ks.map(k => onKey(s, k)).at(-1)
const type = (s: MonitorsState, text: string) => [...text].forEach(ch => onKey(s, ch))
const selRef = (s: MonitorsState) => selectedPr(s)?.ref
const marked = (s: MonitorsState) => [...s.prs.marked].sort()

test('tab and shift+tab switch views, digits don’t; q and esc close', () => {
  const s = state()
  assert.equal(s.view, 'running')
  keys(s, '2')
  assert.equal(s.view, 'running')
  keys(s, '\t')
  assert.equal(s.view, 'prs')
  keys(s, '1', '\x1b[Z')
  assert.equal(s.view, 'running')
  keys(s, '\x1b[Z')
  assert.equal(s.view, 'logs', 'round the back to Logs')
  keys(s, '\x1b[Z')
  assert.equal(s.view, 'pipes')
  keys(s, '\t', '\t')
  assert.equal(s.view, 'running')
  assert.deepEqual(onKey(s, 'q'), { do: 'quit' })
  assert.deepEqual(onKey(s, ESC), { do: 'quit' })
})

test('Running: j/k move by monitor, past the groups, and stop at the ends', () => {
  const s = state()
  assert.equal(selectedRun(s)?.target, 'ci-playground !128')
  keys(s, 'j', 'j')
  assert.equal(selectedRun(s)?.target, 'jstack #9')
  keys(s, 'j', 'j', 'j', 'j', 'j')
  assert.equal(selectedRun(s)?.target, 'dotfiles #41')
  keys(s, 'k')
  assert.equal(selectedRun(s)?.target, 'prod-eu worker OOM kills')
})

test('Running: ↵ opens its session, a with nothing waiting says so, o opens its PR, which a log watcher hasn’t', () => {
  const s = state()
  keys(s, 'j')
  assert.deepEqual(onKey(s, '\r'), { do: 'open', key: 's-gad:t1' })
  assert.equal(onKey(s, 'a'), null)
  assert.equal(s.panel, null)
  assert.deepEqual(s.note, { text: 'Nothing waits on gad #77', tone: 'sub' })
  assert.deepEqual(onKey(s, 'o'), { do: 'browse', url: 'https://github.com/jl/gad/pull/77' })
  keys(s, 'j', 'j')
  assert.equal(onKey(s, 'o'), null)
  assert.match(s.note?.text ?? '', /No PR to open/)
})

test('x asks first; y stops it, a stops it and stops asking, anything else leaves it', () => {
  const s = state()
  assert.equal(onKey(s, 'x'), null)
  assert.deepEqual(s.ask, { key: 's-ci:t1', name: 'MR !128 pipeline, rebase state, comments', title: 'monitor !128' })
  assert.equal(onKey(s, 'n'), null)
  assert.equal(s.ask, null)
  keys(s, 'x')
  assert.deepEqual(onKey(s, 'y'), { do: 'stop', key: 's-ci:t1', remember: false })
  keys(s, 'x')
  assert.deepEqual(onKey(s, 'a'), { do: 'stop', key: 's-ci:t1', remember: true })
  const quiet = state()
  quiet.options.askStop = false
  assert.deepEqual(onKey(quiet, 'x'), { do: 'stop', key: 's-ci:t1', remember: false })
  keys(quiet, 'G', 'j', 'j', 'j', 'j', 'j')
  assert.equal(onKey(quiet, 'x'), null, 'an ended one has nothing to stop')
  assert.match(quiet.note?.text ?? '', /already ended/)
})

test('/ filters as you type; ↵ keeps it, esc clears it and hides its row', () => {
  const s = state()
  keys(s, '/')
  assert.deepEqual(s.filters.running, { open: true, typing: true, query: '' })
  type(s, 'logs')
  assert.equal(runningRows(s).length, 0, 'no match yet: the kind isn’t a field')
  keys(s, '\x7f', '\x7f', '\x7f', '\x7f')
  type(s, 'eu')
  assert.deepEqual(runningRows(s).map(r => r.target), ['staging-eu payments 500s on /v2/export', 'prod-eu worker OOM kills'])
  keys(s, '\x1b[B')
  assert.equal(selectedRun(s)?.target, 'prod-eu worker OOM kills', '↓ moves the list while typing')
  keys(s, '\r')
  assert.deepEqual([s.filters.running.open, s.filters.running.typing, s.filters.running.query], [true, false, 'eu'])
  keys(s, 'k')
  assert.equal(selectedRun(s)?.target, 'staging-eu payments 500s on /v2/export', 'back to the list')
  keys(s, ESC)
  assert.deepEqual(s.filters.running, { open: false, typing: false, query: '' })
  keys(s, '/')
  type(s, 'zz')
  keys(s, ESC)
  assert.equal(s.filters.running.open, false, 'esc while typing clears too')
  keys(s, '/', '\r')
  assert.equal(s.filters.running.open, false, 'an empty filter kept is no filter')
})

test('each view keeps its own filter', () => {
  const s = state()
  keys(s, '/')
  type(s, 'gad')
  keys(s, '\r', '\t', '/')
  type(s, 'tidy')
  keys(s, '\r')
  assert.deepEqual(prList(s).rows.map(r => r.ref), ['dotfiles #44'])
  keys(s, '\t')
  assert.deepEqual(runningRows(s).map(r => r.target), ['gad #77'])
})

test('PRs: space marks and moves on, * marks all or none, w and d change the list, r refreshes', () => {
  const s = state({ view: 'prs' })
  assert.equal(selRef(s), 'notes #3')
  keys(s, ' ')
  assert.deepEqual(marked(s), ['https://github.com/jl/notes/pull/3'])
  assert.equal(selRef(s), 'jstack #9')
  keys(s, ' ', 'k', ' ')
  assert.deepEqual(marked(s), ['https://github.com/jl/notes/pull/3'], 'space again unmarks')
  keys(s, '*')
  assert.equal(marked(s).length, 4)
  keys(s, '*')
  assert.equal(marked(s).length, 0)
  keys(s, 'w')
  assert.deepEqual(prList(s).rows.map(r => r.ref), ['amy/site #12'])
  keys(s, 'w', 'd')
  assert.equal(s.drafts, true, 'd does nothing: Settings › Monitors › Show drafts decides')
  assert.deepEqual(onKey(s, 'r'), { do: 'refresh' })
})

test('PRs: g goes to the PR’s monitor in Running; o opens it', () => {
  const s = state({ view: 'prs' })
  keys(s, 'j', 'j')
  assert.equal(selRef(s), 'gad #77')
  assert.deepEqual(onKey(s, 'o'), { do: 'browse', url: 'https://github.com/jl/gad/pull/77' })
  keys(s, 'g')
  assert.equal(s.view, 'running')
  assert.equal(selectedRun(s)?.target, 'gad #77')
  keys(s, '\t', 'k', 'k', 'g')
  assert.equal(s.view, 'prs', 'a PR with no monitor stays')
  assert.match(s.note?.text ?? '', /No monitor watches notes #3/)
})

test('↵ opens the drawer for the marked PRs, else the selected one, from Settings’ model and effort', () => {
  const s = state({ view: 'prs' })
  keys(s, '\r')
  assert.deepEqual(
    targets(s).map(p => p.number),
    [3],
  )
  assert.deepEqual(s.drawer, { watch: { pipeline: true, comments: true, rebase: true, ping: false }, until: 'merged', model: 'sonnet', effort: 'medium', brief: '', more: false, focus: 'list' })
  keys(s, ESC)
  assert.equal(s.drawer, null)
  keys(s, 'j', ' ', ' ', '\r')
  assert.deepEqual(
    targets(s).map(p => p.number),
    [9, 77],
  )
})

test('the drawer: the list keeps j/k and space, 1–4 toggle what it watches', () => {
  const s = state({ view: 'prs' })
  keys(s, '\r', '2', '4', 'j', ' ')
  assert.equal(s.view, 'prs')
  assert.deepEqual(s.drawer?.watch, { pipeline: true, comments: false, rebase: true, ping: true })
  assert.deepEqual(marked(s), ['https://github.com/jl/jstack/pull/9'])
  assert.equal(selRef(s), 'gad #77')
  keys(s, '\t')
  assert.equal(s.drawer?.focus, 'brief', 'tab goes to the brief, not the next view')
})

test('the drawer: / and ↵ take the brief, which takes typing and paste; esc gives the keys back', () => {
  const s = state({ view: 'prs' })
  keys(s, '\r', '/')
  type(s, 'retry once 1')
  paste(s, ' e2e\nflaky')
  assert.equal(s.drawer?.brief, 'retry once 1 e2e flaky')
  assert.deepEqual(s.drawer?.watch, { pipeline: true, comments: true, rebase: true, ping: false }, '1 is typed, not toggled')
  keys(s, ESC)
  assert.equal(s.drawer?.focus, 'list')
  keys(s, ESC)
  assert.equal(s.drawer, null)
})

test('Ctrl+V’s image goes in the brief, the Watch for, and nowhere else; the agents get those still named', () => {
  const s = state({ view: 'prs' })
  assert.equal(takesImages(s), false, 'not on the list')
  keys(s, '\r')
  assert.equal(attachImage(s, '/i/a.png'), false, 'nor in the drawer off its brief')
  keys(s, '/')
  type(s, 'see ')
  assert.ok(attachImage(s, '/i/a.png'))
  type(s, ' and ')
  assert.ok(attachImage(s, '/i/b.png'))
  assert.equal(s.drawer?.brief, 'see [Image #1] and [Image #2]')
  keys(s, '\x7f')
  const act = keys(s, CTRL_S)
  assert.equal(act?.do, 'start')
  assert.deepEqual(act?.do === 'start' && act.images, [{ n: 1, path: '/i/a.png' }])
  s.view = 'logs'
  s.logs.field = 'task'
  assert.ok(attachImage(s, '/i/c.png'))
  assert.equal(s.logs.task, '[Image #1]')
  assert.deepEqual(s.logs.images, [{ n: 1, path: '/i/c.png' }])
  s.logs.field = 'env'
  assert.equal(takesImages(s), false)
})

test('the drawer: m opens until, model and effort; ←/→ change the one tab is on', () => {
  const s = state({ view: 'prs' })
  keys(s, '\r', 'm')
  assert.deepEqual([s.drawer?.more, s.drawer?.focus], [true, 'until'])
  keys(s, '\x1b[C', '\x1b[C')
  assert.equal(s.drawer?.until, '8h')
  keys(s, '\t', '\x1b[D')
  assert.deepEqual([s.drawer?.focus, s.drawer?.model], ['model', 'opus'])
  keys(s, '\t', 'l', 'l')
  assert.deepEqual([s.drawer?.focus, s.drawer?.effort], ['effort', 'xhigh'])
  keys(s, '\t')
  assert.equal(s.drawer?.focus, 'list', 'round to the list again')
  keys(s, 'm')
  assert.deepEqual([s.drawer?.more, s.drawer?.focus], [false, 'list'])
})

test('ctrl+s starts one monitor per marked PR; then Running selects each as it shows', () => {
  const s = state({ view: 'prs' })
  keys(s, 'j', 'j', ' ', ' ', '\r', '3')
  keys(s, '/')
  type(s, 'be quick')
  const act = onKey(s, CTRL_S)
  assert.equal(act?.do, 'start')
  if (act?.do !== 'start') return
  assert.deepEqual(
    act.prs.map(p => p.number),
    [77, 44],
  )
  assert.deepEqual(act.options, { watch: { pipeline: true, comments: true, rebase: false, ping: false }, until: 'merged', model: 'sonnet', effort: 'medium', brief: 'be quick' })
  started(s, ['https://github.com/jl/dotfiles/pull/44'])
  assert.deepEqual([s.view, s.drawer, s.prs.marked.size], ['running', null, 0])
  const before = selectedRun(s)?.key
  setAgents(s, AGENTS)
  assert.equal(selectedRun(s)?.key, before, 'not there yet')
  const dot = structuredClone(AGENTS.find(a => a.id === 's-dot')!)
  dot.id = 's-new'
  dot.monitors = [{ ...dot.monitors[0], key: 's-new:t1', state: 'watching', ended: null, command: 'python3 watch_pr.py https://github.com/jl/dotfiles/pull/44' }]
  setAgents(s, [...AGENTS, dot])
  assert.equal(selectedRun(s)?.key, 's-new:t1')
  assert.deepEqual(s.run.want, [])
})

test('the drawer starts from Settings › Monitors’ watch and until', () => {
  const s = state({ view: 'prs' })
  Object.assign(s.options, { watch: { pipeline: false, comments: true, rebase: false, ping: true }, until: '24h', model: 'opus', effort: 'high' })
  onKey(s, '\r')
  assert.deepEqual(s.drawer, { watch: { pipeline: false, comments: true, rebase: false, ping: true }, until: '24h', model: 'opus', effort: 'high', brief: '', more: false, focus: 'list' })
})

// ------------------------------------------------------------ the approvals panel

const RIGHT = '\x1b[C'
function waiting(list = PROPOSALS): MonitorsState {
  const s = state()
  setProposals(s, list)
  return s
}
const shown = (s: MonitorsState) => s.panel?.ap.list[s.panel.ap.i]?.id

test('a on a monitor opens the panel on its proposals, oldest first; esc and q close it', () => {
  const s = waiting()
  assert.equal(selectedRun(s)?.target, 'ci-playground !128')
  assert.equal(onKey(s, 'a'), null)
  assert.deepEqual([s.panel?.key, s.panel?.target, s.panel?.ap.list.map(p => p.id)], ['s-ci:t1', 'ci-playground !128', ['1002-reply-ci', '1003-retry-ci']])
  assert.equal(s.panel?.ap.hidden, true, 'not drawn yet, so a second a approves nothing')
  assert.equal(onKey(s, 'a'), null)
  assert.match(s.panel?.ap.note?.text ?? '', /Not all of it/)
  onKey(s, RIGHT)
  assert.equal(shown(s), '1003-retry-ci')
  onKey(s, ESC)
  assert.equal(s.panel, null)
  keys(s, 'a', 'q')
  assert.equal(s.panel, null)
  assert.equal(s.view, 'running', 'q closed the panel, not the popup')
})

test('the panel’s keys are its own: a approves, r rejects, g goes; j/k move between monitors and it follows', () => {
  const s = waiting()
  onKey(s, 'a')
  s.panel!.ap.hidden = false
  const approve = onKey(s, 'a')
  assert.deepEqual(approve?.do === 'approval' && approve.e.do === 'approve' && approve.e.p.id, '1002-reply-ci')
  const go = onKey(s, 'g')
  assert.deepEqual(go?.do === 'approval' && go.e.do, 'go')
  onKey(s, 'j')
  assert.deepEqual([selectedRun(s)?.target, s.panel?.key, shown(s)], ['gad #77', 's-gad:t1', '1001-push-gad'])
  onKey(s, 'j')
  assert.deepEqual([selectedRun(s)?.target, s.panel?.ap.list], ['notes #3', [PROPOSALS[4]]], 'a stand-in’s proposals too')
  onKey(s, 'j')
  assert.deepEqual([selectedRun(s)?.target, s.panel?.ap.list], ['jstack #9', []], 'nothing waits on it: the panel stays, empty')
  onKey(s, 'k')
  assert.equal(shown(s), '1005-retry-gone')
})

test('while a diff shows or a reply is edited, j and k and esc are the panel’s', () => {
  const s = waiting()
  onKey(s, 'a')
  onKey(s, 'e')
  assert.equal(s.panel?.ap.editing, true)
  keys(s, 'j', 'k')
  assert.equal(s.panel?.ap.draft, 'Done: the image is cached per branch.jk')
  paste(s, ' Pasted')
  assert.match(s.panel?.ap.draft ?? '', /jk Pasted$/)
  onKey(s, ESC)
  assert.deepEqual([s.panel?.key, s.panel?.ap.editing], ['s-ci:t1', false], 'esc dropped the edit, not the panel')
})

test('a monitor with nothing waiting: a says so in the footer', () => {
  const s = waiting()
  keys(s, 'j', 'j', 'j')
  assert.equal(selectedRun(s)?.target, 'jstack #9')
  onKey(s, 'a')
  assert.deepEqual([s.panel, s.note], [null, { text: 'Nothing waits on jstack #9', tone: 'sub' }])
})

test('the last one settled closes the panel with a green note; proposals read again follow the panel', () => {
  const s = waiting()
  onKey(s, 'a')
  setProposals(s, PROPOSALS.filter(p => p.id !== '1002-reply-ci'))
  assert.deepEqual(s.panel?.ap.list.map(p => p.id), ['1003-retry-ci'])
  s.panel!.ap.note = { text: 'Retried', tone: 'green' }
  panelEmptied(s)
  assert.deepEqual([s.panel, s.note], [null, { text: 'Retried · nothing left on ci-playground !128', tone: 'green' }])
})

test('the tray’s Review lands on the proposal’s monitor with the panel on it; Alt+A on the oldest one', () => {
  const s = waiting()
  s.view = 'prs'
  openOn(s, '1003-retry-ci')
  assert.deepEqual([s.view, selectedRun(s)?.key, shown(s)], ['running', 's-ci:t1', '1003-retry-ci'])
  const gone = waiting([])
  openOn(gone, '1003-retry-ci')
  assert.deepEqual([gone.panel, gone.note?.text], [null, 'That proposal was settled or replaced'])
  const oldest = waiting()
  oldest.filters.running = { open: true, typing: false, query: 'jstack' }
  openOldest(oldest)
  assert.deepEqual([oldest.filters.running.query, selectedRun(oldest)?.target, shown(oldest)], ['', 'notes #3', '1005-retry-gone'])
  const none = waiting([])
  openOldest(none)
  assert.deepEqual([none.panel, none.note?.text], [null, 'Nothing is waiting for you'])
})

test('a stand-in has no session to open and nothing to stop', () => {
  const s = waiting()
  keys(s, 'j', 'j')
  assert.equal(selectedRun(s)?.standIn, 'gone')
  assert.equal(onKey(s, '\r'), null)
  assert.equal(s.note?.text, 'The session that proposed this is gone')
  assert.equal(onKey(s, 'x'), null)
  assert.equal(s.ask, null)
})
