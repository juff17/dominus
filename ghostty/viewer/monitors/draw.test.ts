import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'

const { frame } = await import('./draw.ts')
const { prColumns, pipelineText, reviewsText, branchText } = await import('./draw-prs.ts')
const { onKey, setAgents, setProposals, start } = await import('./state.ts')
const { parseGithub } = await import('./forge.ts')
const { P, bg, fg } = await import('../../tui/palette.ts')
type Agent = import('../../agents/model.ts').Agent
type HostResult = import('./forge.ts').HostResult
type Pr = import('./forge.ts').Pr
type MonitorsState = import('./state.ts').MonitorsState
type Proposal = import('../../agents/proposals.ts').Proposal

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
const PROPOSALS = (fixture('proposals.json') as { proposals: Proposal[] }).proposals
const GH = parseGithub(fixture('gh-graphql.json', true), 'github.com')!
const GL: Pr = {
  ...GH.prs[0],
  forge: 'gl',
  host: 'gitlab.example.com',
  repo: 'platform/api',
  number: 512,
  url: 'https://gitlab.example.com/platform/api/-/merge_requests/512',
  title: 'Rate-limit the export endpoint',
  head: 'jl/rate-limit',
  createdAt: NOW - 2 * 86400e3,
  pipeline: { state: 'passed', job: '', done: 4, total: 4 },
  reviews: { approvedBy: [], required: 2, changes: false, waiting: true, threads: 0, reviewers: ['raj', 'mei'] },
  branch: { state: 'conflict', behind: null },
}
const SIZE = { cols: 150, rows: 30 }

const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+$/, '')
const text = (f: { lines: string[] }): string => f.lines.map(plain).join('\n')

function state(more: Partial<MonitorsState> = {}, hosts?: HostResult[]): MonitorsState {
  const s = start({ options: { models: ['opus', 'sonnet'], efforts: ['low', 'medium'], model: 'sonnet', effort: 'medium', askStop: true } })
  s.hosts = hosts ?? [
    { forge: 'gh', host: 'github.com', me: 'jl', at: NOW - 40e3, ms: 1, prs: GH.prs, ok: true },
    { forge: 'gl', host: 'gitlab.example.com', me: 'jl', at: NOW - 40e3, ms: 1, prs: [GL], ok: true },
  ]
  s.checkouts = new Map([['gitlab.example.com/platform/api', '/home/jl/projects/platform-api']])
  Object.assign(s, more)
  setAgents(s, AGENTS)
  return s
}
const draw = (s: MonitorsState, size = SIZE) => frame(s, size, NOW)

// DUMP=1 prints each frame, for looking at while changing the drawing.
const dump = (name: string, f: { lines: string[] }) => process.env.DUMP && console.log(`--- ${name}\n${text(f)}`)

test('a [pipeline] event is red when it failed and green when it passed', () => {
  const withEvent = (line: string) => {
    const s = state()
    const agents = structuredClone(AGENTS)
    const m = agents.find(a => a.id === 's-jstack')?.monitors[0]
    assert.ok(m)
    m.event = { ...m.event, tag: 'pipeline', line } as typeof m.event
    setAgents(s, agents)
    return draw(s).lines.find(l => plain(l).includes(line.slice(0, 20))) ?? ''
  }
  assert.ok(withEvent('[pipeline] failed for 3f2a1b9c, 1 of 7 checks failed').includes(fg(P.red)))
  assert.ok(withEvent('[pipeline] passed for 3f2a1b9c, 0 of 7 checks failed').includes(fg(P.green)))
})

test('the PR tab counts … until the first fetch lands, not 0', () => {
  assert.match(draw(state({ refreshing: true }, [])).lines.map(plain)[1], /│ {2}PR {2}… {2}│/)
  assert.match(draw(state({ refreshing: true })).lines.map(plain)[1], /│ {2}PR {2}5 {2}│/, 'a refresh after one landed keeps the count')
})

test('Running: the views, the groups with their monitors, and the selected one beside them', () => {
  const f = draw(state())
  dump('running', f)
  assert.deepEqual(f.title, ['Monitors', '5 running'])
  const t = text(f)
  assert.match(f.lines.map(plain)[1], /^ │ {2}Running {2}5 {2}│ {2}│ {2}PR {2}5 {2}│ {2}│ {2}Pipelines {2}0 {2}│ {2}│ {2}Logs {2}\+ {2}│ .*▲ 2 need you {2}◉ 2 watching {2}◌ 1 stale {2}✓ 1 ended$/)
  assert.match(f.lines.map(plain)[0], /^ ╭─+╮ {2}╭─+╮ {2}╭─+╮ {2}╭─+╮$/, 'each tab is a box')
  assert.match(f.lines.map(plain)[2], /^ ╰─+╯ {2}╰─+╯ {2}╰─+╯ {2}╰─+╯$/)
  assert.match(t, / {2}Needs you 2 ─/)
  assert.match(t, / ▌▲ needs action +PR +gl ci-playground !128 +\[failed\] test:unit · retry proposed +3m/)
  assert.match(t, / {2}Watching 3 ─/)
  assert.match(t, /◌ stale +LOGS +prod-eu worker OOM kills +waiting for its first event +18m/)
  assert.match(t, / {2}Ended 1 · leave after 5m ─/)
  assert.match(t, /│ PR {2}gl ci-playground !128 +▲ needs action/)
  assert.match(t, /│ bg session · pr-babysit · sonnet · 50m/)
  assert.match(t, /│ 3m {3}\[failed\] test:unit · retry proposed/)
  assert.match(f.lines.at(-1)!, /j\/k.*move.*↵.*open session/)
  for (const line of f.lines) assert.ok(plain(line).length <= SIZE.cols)
})

test('Running: what the drawer chose shows under Watching', () => {
  const s = state()
  s.attached = { 'https://github.com/jl/gad/pull/77': { watch: { pipeline: true, comments: false, rebase: true, ping: true }, until: 'pipeline', model: 'sonnet', effort: 'low', brief: 'deploy needs a nod', at: NOW } }
  onKey(s, 'j')
  const t = text(draw(s))
  dump('running-attached', draw(s))
  assert.match(t, /│ Retry the sync job/)
  assert.match(t, /│ ⎇ jl\/sync-retry → main/)
  assert.match(t, /│ Watching, until the pipeline passes/)
  assert.match(t, /│ ✓ pipeline\n.*│ ✓ rebase\n.*│ ✓ ping on every comment\n.*│ brief: deploy needs a nod/)
  assert.doesNotMatch(t, /review comments/)
})

test('Running with nothing to show says so', () => {
  const s = state()
  setAgents(s, [])
  assert.match(text(draw(s)), /Nothing is being watched/)
  assert.deepEqual(draw(s).title, ['Monitors', '0 running'])
})

test('PRs: a row per PR with its forge, checks, reviews, branch and monitor; the selected one’s box under them', () => {
  const s = state({ view: 'prs' })
  const f = draw(s)
  dump('prs', f)
  assert.deepEqual(f.title, ['Monitors', 'PR'])
  const lines = f.lines.map(plain)
  assert.match(lines[1], /^ │ {2}Running {2}5 {2}│ {2}│ {2}PR {2}5 {2}│ .* Mine 5 │ Reviewer 1 {3}⟳ 40s ago$/)
  assert.match(lines[3], /^ {2}\[ \] {4}PR +title +pipeline +reviews +branch +monitor$/)
  const t = text(f)
  assert.match(t, / ▌\[ \] gh notes #3 +Weekly report script +✗ lint +no reviewers +up to date +\+ attach/)
  assert.match(t, / {2}\[ \] gh gad #77 +Retry the sync job +⏸ manual deploy:staging +✓ approved +up to date +▲ needs you/)
  assert.match(t, /gh jstack #9 +Parser rewrite +◐ running 3\/9 +review required · 2 threads +up to date +◉ watching/)
  assert.match(t, /gh dotfiles #44 +Tidy the install script +✓ passed +changes requested · 3 threads +↓ behind/)
  assert.match(t, /gl platform\/api !512 +Rate-limit the export endpoint +✓ passed +0 of 2 approvals +⚠ conflicts/)
  assert.match(t, / selected +gh notes #3 · ⎇ jl\/weekly → main · opened 2h ago/)
  assert.match(t, / reviewers +none/)
  assert.match(t, / checkout +no clone of jl\/notes on this machine/)
  for (let i = 0; i < 3; i++) onKey(s, 'j')
  assert.match(text(draw(s)), / checkout +\/home\/jl\/projects\/platform-api · ⑂ babysit\/512/)
  assert.match(text(draw(s)), / selected +gl platform\/api !512 · ⎇ jl\/rate-limit → main · opened 2d ago · ⚠ conflicts/)
})

test('PRs: marking lights the header, a host that can’t be read is one dim line, drafts are dim', () => {
  const draft = { ...GH.prs[0], draft: true }
  const hosts: HostResult[] = [
    { forge: 'gh', host: 'github.com', me: 'jl', at: NOW - 40e3, ms: 1, prs: [...GH.prs.slice(1), draft], ok: true },
    { forge: 'gl', host: 'gitlab.example.com', me: '', at: 0, ms: 1, prs: [], ok: false, why: 'auth', err: '401' },
  ]
  const s = state({ view: 'prs' }, hosts)
  onKey(s, ' ')
  const f = draw(s)
  dump('prs-marked', f)
  const lines = f.lines.map(plain)
  assert.match(lines[3], /^ {2}\[-\]/)
  assert.match(text(f), /^ {3}gl gitlab\.example\.com · glab isn't logged in$/m)
  const row = f.lines.find(l => plain(l).includes('dotfiles #44'))!
  assert.ok(row.includes(`${fg(P.overlay1)}Tidy the install script`), 'a draft’s title is dim')
  onKey(s, '*')
  assert.match(draw(s).lines.map(plain)[3], /^ {2}\[x\]/)
})

test('the filter row: what was typed, how many it keeps, the matches lit, what it hid', () => {
  const s = state({ view: 'prs' })
  onKey(s, '/')
  for (const ch of 'pla') onKey(s, ch)
  const f = draw(s)
  dump('prs-filter', f)
  const lines = f.lines.map(plain)
  assert.match(lines[3], /^ \/ pla +1 of 5$/)
  assert.match(text(f), /4 more hidden by the filter · esc shows them/)
  const row = f.lines.find(l => plain(l).includes('!512'))!
  assert.ok(row.includes(`${fg(P.yellow)}pla`), 'the match is lit yellow')
  assert.match(f.lines.at(-1)!, /keep filter/)
})

test('the drawer: who it attaches to, what it watches, the brief and Start; m opens the choices', () => {
  const s = state({ view: 'prs' })
  onKey(s, 'j')
  onKey(s, ' ')
  onKey(s, 'j')
  onKey(s, 'j')
  onKey(s, ' ')
  onKey(s, '\r')
  const f = draw(s)
  dump('drawer', f)
  const t = text(f)
  assert.match(t, /╭─+╮/)
  assert.match(t, /│ Attach to 2 marked {2}#9, #44 +until merged · sonnet · medium effort · m more +│/)
  assert.match(t, /│ watch {3}1 pipeline {3}2 comments {3}3 rebase {3}4 ping on every comment +│/)
  assert.match(t, /│ brief {2}optional: e2e:checkout is flaky, retry it once +Start {2}ctrl\+s +│/)
  assert.doesNotMatch(t, / selected /, 'the drawer takes the info box’s place')
  assert.match(f.lines.at(-1)!, /1–4.*toggle/)
  onKey(s, 'm')
  assert.match(text(draw(s)), /until ‹ merged › {2}model ‹ sonnet › {2}effort ‹ medium ›/)
})

test('a list longer than the screen scrolls to keep the cursor above the drawer, and counts marked PRs out of view', () => {
  const many: Pr[] = Array.from({ length: 40 }, (_, i) => ({ ...GH.prs[0], number: 100 + i, url: `https://github.com/jl/many/pull/${100 + i}`, repo: 'jl/many', title: `Change ${i}`, createdAt: NOW - i * 60e3 }))
  const s = state({ view: 'prs' }, [{ forge: 'gh', host: 'github.com', me: 'jl', at: NOW, ms: 1, prs: many, ok: true }])
  for (let i = 0; i < 5; i++) onKey(s, ' ')
  onKey(s, '\r')
  let f = draw(s)
  assert.match(text(f), /Attach to 5 marked {2}#100, #101, #102, #103, #104/)
  assert.doesNotMatch(text(f), /off screen/)
  for (let i = 0; i < 30; i++) onKey(s, 'j')
  f = draw(s)
  s.prs.scroll = f.scroll
  dump('drawer-long', f)
  const t = text(f)
  assert.match(t, / ▌\[ \] gh many #135 +Change 35/, 'the cursor is on screen')
  assert.match(t, /Attach to 5 marked \(5 off screen\)/)
  // Back up to the first, and the marked ones show again.
  for (let i = 0; i < 35; i++) {
    onKey(s, 'k')
    s.prs.scroll = draw(s).scroll
  }
  f = draw(s)
  assert.match(text(f), / ▌\[x\] gh many #100/)
  assert.doesNotMatch(text(f), /off screen/)
  for (const line of f.lines) assert.ok(plain(line).length <= SIZE.cols)
  assert.equal(f.lines.length, SIZE.rows)
})

test('narrow frames drop reviews, then branch, then the pipeline, before the title gets too thin', () => {
  assert.deepEqual(prColumns(150).cols, ['ref', 'title', 'pipe', 'rev', 'branch', 'mon'])
  assert.deepEqual(prColumns(120).cols, ['ref', 'title', 'pipe', 'branch', 'mon'])
  assert.deepEqual(prColumns(80).cols, ['ref', 'title', 'mon'])
  const f = draw(state({ view: 'prs' }), { cols: 80, rows: 20 })
  for (const line of f.lines) assert.ok(plain(line).length <= 80)
})

test('the cells say what they are', () => {
  assert.equal(pipelineText({ state: 'none', job: '', done: 0, total: 0 }), '— none')
  assert.equal(pipelineText({ state: 'failed', job: '', done: 0, total: 0 }), '✗ failed')
  assert.deepEqual(reviewsText({ approvedBy: ['a'], required: 2, changes: false, waiting: true, threads: 1, reviewers: ['a', 'b'] }, false), ['1 of 2 approvals · 1 thread', P.sub])
  assert.deepEqual(reviewsText({ approvedBy: [], required: 0, changes: false, waiting: false, threads: 0, reviewers: [] }, true), ['draft', P.overlay1])
  assert.deepEqual(branchText({ state: 'behind', behind: 4 }), ['↓ 4 behind', P.sub])
})

// ------------------------------------------------------------ Pipelines and Logs

const { gitlabPipe, githubPipe } = await import('./pipelines.ts')
const { setWorld } = await import('./logs-state.ts')
type PipeHost = import('./pipelines.ts').PipeHost
const raw = (name: string): unknown => fixture(name, true)

// The fixtures' pipelines: platform/api's tag (two manual deploys) and
// main, terraform's apply, and PR #77's deploy waiting on staging.
function pipeHosts(): PipeHost[] {
  const gl = 'gitlab.example.com'
  const [tag, main] = raw('glab/projects_platform%2Fapi_pipelines.json') as unknown[]
  const run = (raw('gh/repos_jl_gad_actions_runs_pr.json') as { workflow_runs: unknown[] }).workflow_runs[0]
  return [
    {
      forge: 'gl',
      host: gl,
      at: NOW - 20e3,
      ms: 1,
      ok: true,
      pipes: [
        gitlabPipe(tag, raw('glab/projects_platform%2Fapi_pipelines_4512_jobs.json'), gl, 'platform/api', { tag: true })!,
        gitlabPipe(main, raw('glab/projects_platform%2Fapi_pipelines_4510_jobs.json'), gl, 'platform/api')!,
        gitlabPipe((raw('glab/projects_infra%2Fterraform_pipelines.json') as unknown[])[0], raw('glab/projects_infra%2Fterraform_pipelines_77_jobs.json'), gl, 'infra/terraform')!,
      ],
    },
    {
      forge: 'gh',
      host: 'github.com',
      at: NOW - 20e3,
      ms: 1,
      ok: true,
      pipes: [githubPipe(run, raw('gh/repos_jl_gad_actions_runs_601_jobs.json'), raw('gh/repos_jl_gad_actions_runs_601_pending_deployments.json'), 'github.com', 'jl/gad', { pr: 'https://github.com/jl/gad/pull/77', prRef: '#77' })!],
    },
  ]
}

function pipesState(): MonitorsState {
  const s = state({ view: 'pipes' })
  s.pipes.hosts = pipeHosts()
  return s
}

test('Pipelines: two groups, the stages a glyph each, what waits under its pipeline, the + watch bar', () => {
  const s = pipesState()
  const f = draw(s)
  dump('pipes', f)
  assert.deepEqual(f.title, ['Monitors', 'Pipelines', '⏸ 4 waiting for you'])
  const t = text(f)
  assert.match(t, /Pipelines {2}4 {2}│/)
  assert.match(t, /your projects' default branches and tags · ⟳ 20s ago/)
  assert.match(t, /project +ref +trigger +stages +now +age +monitor/)
  assert.match(t, /Not from a PR/)
  assert.match(t, /▌gl platform\/api +main +push +✓ ✓ ◐ ○ +◐ security · 2 of 3 jobs +4m +\+ watch/)
  assert.match(t, /gl platform\/api +v2\.14\.0 +tag +✓ ✓ ✓ ⏸ ○ +⏸ 2 jobs wait for you +6m/)
  assert.match(t, / Run deploy:prod-eu\? +8c41d2e · stage deploy +y run +n skip/)
  assert.match(t, /From watched PRs/)
  assert.match(t, /gh jl\/gad +#77 +PR +✓ ✓ ⏸ +⏸ staging waits for you +9m +via #77/)
  assert.match(t, / Deploy to staging\? +4f2a1c9 · protected env staging/)
  assert.match(t, /\+ watch {2}paste a pipeline URL, or project@ref +P pipelines from PR monitors on/)
  assert.match(f.lines.at(-1)!, /j\/k.*move.*y\/n.*run or skip.*m.*watch.*\+.*paste a URL.*o.*open in browser.*tab.*view/)
  for (const line of f.lines) assert.ok(plain(line).length <= SIZE.cols)
})

test('Pipelines: / filters by project, ref, PR, job or state, lights what matched, and esc shows them all again', () => {
  const s = pipesState()
  onKey(s, '/')
  for (const ch of 'api tag') onKey(s, ch)
  let f = draw(s)
  let t = text(f)
  assert.match(t, /platform\/api +v2\.14\.0/)
  assert.doesNotMatch(t, /platform\/api +main/)
  assert.doesNotMatch(t, /jl\/gad/)
  assert.match(t, /1 of 4/)
  assert.ok(f.lines.some(l => l.includes(`${fg(P.yellow)}api`)), 'what matched is lit')
  assert.match(f.lines.at(-1)!, /↑\/↓.*move.*↵.*esc/)
  // A job waiting on it or a PR's number finds it too.
  onKey(s, '\x1b')
  onKey(s, '/')
  for (const ch of 'staging') onKey(s, ch)
  t = text(draw(s))
  assert.match(t, /jl\/gad +#77/)
  assert.doesNotMatch(t, /platform\/api/)
  for (const ch of ' nothing') onKey(s, ch)
  assert.match(text(draw(s)), /Nothing matches “staging nothing”/)
  onKey(s, '\r')
  assert.equal(s.filters.pipes.typing, false)
  onKey(s, '\x1b')
  f = draw(s)
  assert.equal(s.filters.pipes.open, false)
  assert.match(text(f), /platform\/api +main/)
  assert.match(f.lines.at(-1)!, /\/.*filter/)
})

test('Pipelines: the prompt under the cursor is lit and boxed in peach, the others a dim line each', () => {
  const s = pipesState()
  onKey(s, 'j')
  onKey(s, 'j')
  const f = draw(s)
  dump('pipes-stacked', f)
  const lines = f.lines.map(plain)
  const at = lines.findIndex(l => l.includes('Run deploy:prod-eu?'))
  assert.match(lines[at - 1], /╭─+╮/)
  assert.match(lines[at + 1], /╰─+╯/)
  assert.match(lines[at + 2], /Run deploy:prod-us\? +8c41d2e/, 'the next one a line of its own')
  assert.ok(f.lines[at].includes(fg(P.peach)), 'lit in peach')
  assert.ok(!f.lines[at + 2].includes(fg(P.peach)), 'the other dim')
  const act = onKey(s, 'y')
  assert.equal(act?.do === 'gate' && act.gate.id, '9001')
})

test('Pipelines: a host that can’t be read is one dim line; with nothing yet it says where they come from', () => {
  const s = pipesState()
  s.pipes.hosts = [{ forge: 'gl', host: 'gitlab.example.com', at: 0, ms: 1, pipes: [], ok: false, why: 'auth', err: '401' }]
  const t = text(draw(s))
  assert.match(t, /No pipelines yet/)
  assert.match(t, /gl gitlab\.example\.com · glab isn't logged in/)
  assert.deepEqual(draw(s).title, ['Monitors', 'Pipelines'])
})

function logsState(blocked: Parameters<typeof setWorld>[1] = {}): MonitorsState {
  const s = state({ view: 'logs' })
  s.logs.options = { ...s.logs.options, protect: ['eu'] }
  setWorld(s.logs, blocked, '/home/jl/projects/x')
  return s
}

test('Logs: the envs as chips, protected ones red, then Source as radio buttons, the form and Start', () => {
  const s = logsState()
  onKey(s, '\x1b[C')
  onKey(s, '\x1b[C')
  const f = draw(s)
  dump('logs', f)
  assert.deepEqual(f.title, ['Monitors', 'New log watcher'])
  const t = text(f)
  assert.match(t, /Logs {2}\+ {2}│/)
  assert.match(t, /log watchers? running/)
  assert.match(t, /▸ Environment +local +qa +stage +eu +ca +us/)
  assert.match(t, /Source +○ Docker +● Kubernetes +○ Elastic/)
  assert.match(t, /Watch for/)
  assert.match(t, /Level +‹ warn and up ›/)
  assert.match(t, /Start log watcher +ctrl\+s +\/log-watcher watch · stage · Kubernetes · read-only · in \/home\/jl\/projects\/x/)
  assert.match(f.lines.at(-1)!, /↑\/↓.*field.*←\/→.*choose.*ctrl\+s.*start.*tab.*view/)
  const envLine = f.lines.find(l => plain(l).includes('Environment'))!
  assert.ok(envLine.includes(`${fg(P.red)}${bg(P.surface0)} eu `), 'eu is protected')
  const sourceLine = f.lines.find(l => plain(l).includes('Source'))!
  assert.ok(sourceLine.includes(`${fg(P.surface2)}Docker`), 'Docker is grayed out off local')
  for (const line of f.lines) assert.ok(plain(line).length <= SIZE.cols)
})

test('Logs: Watch for with the keys draws its caret whole, empty or typed in', () => {
  const s = logsState()
  onKey(s, '\x1b[B')
  onKey(s, '\x1b[B')
  assert.equal(s.logs.field, 'task')
  for (const typed of ['', 'oom']) {
    for (const ch of typed) onKey(s, ch)
    const box = draw(s).lines.find(l => plain(l).includes('Watch for'))!
    assert.ok(box.includes('\x1b[7m'), 'the caret shows')
    assert.doesNotMatch(plain(box), /\[\d*m/, 'no escape code left half-drawn')
    assert.doesNotMatch(box, /\x1b(?!\[)/, 'every escape starts a code')
  }
})

test('Logs: without kubectl or an Elastic MCP the rest gray out and one dim line says why; a protected env asks in the footer', () => {
  const s = logsState({ kubernetes: 'kubectl', elastic: 'elastic' })
  const f = draw(s)
  dump('logs-only-local', f)
  let t = text(f)
  assert.match(t, /Source +● Docker +○ Kubernetes +○ Elastic/)
  assert.match(t, /only local can be watched · Kubernetes: kubectl isn't installed · Elastic: no Elastic MCP in Claude Code/)
  const envLine = f.lines.find(l => plain(l).includes('Environment'))!
  assert.ok(envLine.includes(`${fg(P.surface2)}${bg(P.mantle)} qa `), 'qa is grayed out')
  assert.match(text(draw(logsState({ kubernetes: 'kubeconfig' }))), /Kubernetes: no kubeconfig file/)
  assert.match(text(draw(state({ view: 'logs' }))), /checking for kubectl and an Elastic MCP…/)
  const p = logsState()
  for (let i = 0; i < 3; i++) onKey(p, '\x1b[C')
  p.logs.task = 'OOM kills'
  onKey(p, '\x13')
  t = text(draw(p))
  assert.match(t.split('\n').at(-1)!, /eu is protected\. Start a read-only log watcher there\? +ctrl\+s start it +other keys no/)
})

// ------------------------------------------------------------ approvals

function waiting(): MonitorsState {
  const s = state()
  setProposals(s, PROPOSALS)
  return s
}

test('Running with proposals: each row says how many wait, the counts and title too, and the selected one lists them', () => {
  const f = draw(waiting())
  dump('running-approvals', f)
  assert.deepEqual(f.title, ['Monitors', '5 running', '▲ 5 to approve'])
  const lines = f.lines.map(plain)
  assert.match(lines[1], /▲ 5 to approve {2}◉ 2 watching {2}◌ 1 stale {2}✓ 1 ended$/)
  const t = text(f)
  assert.match(t, / ▌▲ 2 to approve +PR +gl ci-playground !128 +\[failed\] test:unit/)
  assert.match(t, /▲ 1 to approve +PR +gh notes #3 +Retry lint +30m/)
  assert.match(t, /▲ 1 left +PR +gh dotfiles #41/)
  assert.match(t, /╭─ Waiting for you · 2 ─+╮/)
  assert.match(t, /│ ↩ Reply to @amy on \.gitlab-ci\.yml:12 +6m │/)
  assert.match(t, /│ ✗ Retry test:unit +3m │/)
  assert.match(t, /│ a review them here +│/)
  assert.ok(t.indexOf('Waiting for you') < t.indexOf('Latest'), 'above Latest')
  const peach = f.lines.find(l => plain(l).includes('Waiting for you'))
  assert.ok(peach?.includes(fg(P.peach)), 'a peach box')
})

test('a stand-in says where its monitor went instead of its session and latest event', () => {
  const s = waiting()
  onKey(s, 'j')
  onKey(s, 'j')
  const t = text(draw(s))
  assert.match(t, /PR {2}gh notes #3 +▲ 1 to approve/)
  assert.match(t, /the session that proposed these is gone/)
  assert.doesNotMatch(t, /Latest/)
})

test('the panel open: the list narrows to state, kind and target, the panel beside it in a peach edge', () => {
  const s = waiting()
  onKey(s, 'a')
  const f = draw(s)
  dump('panel', f)
  const lines = f.lines.map(plain)
  const t = text(f)
  assert.match(lines[3], /^ {2}state {11}kind {2}target +┃ Approvals · ci-playground !128 · 1 of 2 +● ○$/)
  assert.match(t, / ▌▲ 2 to approve {2}PR {4}gl ci-playground !128 +┃/)
  assert.doesNotMatch(t, /latest|\[failed\]/, 'no latest column')
  // 60% of 150 columns.
  assert.equal(lines[3].indexOf('┃'), 150 - 90)
  assert.ok(f.lines[3].includes(`${fg(P.peach)}┃`), 'its edge is peach')
  assert.match(t, /┃ +Reply to @amy on \.gitlab-ci\.yml:12/)
  assert.match(t, /┃ +THEIR COMMENT · @amy/)
  assert.match(t, /┃ +Post reply a +Edit e +Reject r +Go to session g/)
  assert.match(lines.at(-1) ?? '', /^ ← → proposal {2}j\/k monitor {2}esc close panel {2}e edit/)
  assert.ok(f.approvals?.seen, 'what it drew of the proposal goes back to the view')
})

test('a push’s diff takes the whole body; nothing waiting says so in the panel; narrow, the panel takes it all', () => {
  const s = waiting()
  onKey(s, 'j')
  onKey(s, 'a')
  s.panel!.ap.diff = { title: 'all 2 commits', from: 'a', to: 'b', files: [{ path: 'src/sync.ts', status: 'M', untracked: false, add: 12, del: 3, binary: false }], error: '', cursor: 0, open: '', rows: [], scroll: 0, follow: true }
  const diff = text(draw(s))
  assert.match(diff, /^ DIFF +all 2 commits +1 file$/m)
  assert.doesNotMatch(diff, /┃|state +kind/)
  assert.match(diff.split('\n').at(-1) ?? '', /j k file .*esc back/)
  s.panel!.ap.diff = null
  onKey(s, 'j')
  onKey(s, 'j')
  assert.match(text(draw(s)), /┃ Approvals · jstack #9\n[\s\S]*┃ +Nothing waits on jstack #9/)
  const narrow = text(draw(s, { cols: 80, rows: 24 }))
  assert.doesNotMatch(narrow, /state +kind/)
  assert.match(narrow, /^┃ Approvals · jstack #9/m)
})

test('while the panel settles a proposal, the footer says so', () => {
  const s = waiting()
  onKey(s, 'a')
  s.panel!.ap.busy = 'Posting…'
  assert.match(plain(draw(s).lines.at(-1) ?? ''), /Posting…$/)
})
