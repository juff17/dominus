import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'

const { t } = await import('../../core/text.ts')
const { itemsOf, keptDismissed, keptSkips, pastePipes, pipesKey, selectedItem, startPipes, movePipes, watchTarget } = await import('./pipe-state.ts')
const { hiddenCount, nowOf, pipeItems, waitingCount, watchedPipes } = await import('./pipe-rows.ts')
const { gitlabPipe, githubPipe } = await import('./pipelines.ts')
type PipeHost = import('./pipelines.ts').PipeHost
type PipesState = import('./pipe-state.ts').PipesState
type RunRow = import('./rows.ts').RunRow

const FIXTURES = join(import.meta.dirname, '../../../tests/fixtures/viewer/monitors')
const NOW = Date.UTC(2026, 10, 11, 12)
const json = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8').replace(/"@-(\d+)([mhd])"/g, (_, n, u) => JSON.stringify(new Date(NOW - Number(n) * { m: 60e3, h: 3600e3, d: 86400e3 }[u as 'm' | 'h' | 'd']).toISOString())))
const list = (name: string): unknown[] => json(name) as unknown[]

// Platform/api's tag (two gates) and main (none), terraform's main (one
// gate), and PR #77's run (one deployment), as the fixtures have them.
function hosts(): PipeHost[] {
  const gl = 'gitlab.example.com'
  const [tag, main] = list('glab/projects_platform%2Fapi_pipelines.json')
  const pipes = [
    gitlabPipe(tag, json('glab/projects_platform%2Fapi_pipelines_4512_jobs.json'), gl, 'platform/api', { tag: true })!,
    gitlabPipe(main, json('glab/projects_platform%2Fapi_pipelines_4510_jobs.json'), gl, 'platform/api')!,
    gitlabPipe(list('glab/projects_infra%2Fterraform_pipelines.json')[0], json('glab/projects_infra%2Fterraform_pipelines_77_jobs.json'), gl, 'infra/terraform')!,
  ]
  const run = (json('gh/repos_jl_gad_actions_runs_pr.json') as { workflow_runs: unknown[] }).workflow_runs[0]
  const pr = githubPipe(run, json('gh/repos_jl_gad_actions_runs_601_jobs.json'), json('gh/repos_jl_gad_actions_runs_601_pending_deployments.json'), 'github.com', 'jl/gad', { pr: 'https://github.com/jl/gad/pull/77', prRef: '#77' })!
  return [
    { forge: 'gl', host: gl, at: NOW, ms: 1, pipes, ok: true },
    { forge: 'gh', host: 'github.com', at: NOW, ms: 1, pipes: [pr], ok: true },
  ]
}

function state(): PipesState {
  const p = startPipes(true)
  p.hosts = hosts()
  return p
}
const NONE = new Set<string>()
const notes: string[] = []
const say = (text: string) => notes.push(text)
const key = (p: PipesState, k: string) => pipesKey(p, k, NONE, say)
const sel = (p: PipesState) => {
  const it = selectedItem(p, itemsOf(p, NONE))
  return it?.kind === 'gate' ? `gate ${it.gate.name}` : `pipe ${it?.pipe.project} ${it?.pipe.ref}`
}
const down = (p: PipesState, n = 1) => movePipes(p, itemsOf(p, NONE), n)
const HOUR = 3600e3
const names = (items: ReturnType<typeof pipeItems>) => items.flatMap(i => (i.kind === 'pipe' ? [`${i.pipe.project} ${i.pipe.ref}`] : []))

test('two groups, newest first; each pipeline its row, its prompts under it', () => {
  const items = itemsOf(state(), NONE)
  assert.deepEqual(
    items.map(i => (i.kind === 'group' ? `# ${i.group} ${i.n}` : i.kind === 'pipe' ? `${i.pipe.project} ${i.pipe.ref}` : `  ? ${i.gate.name}`)),
    ['# own 3', 'platform/api main', 'platform/api v2.14.0', '  ? deploy:prod-eu', '  ? deploy:prod-us', 'infra/terraform main', '  ? apply', '# prs 1', 'jl/gad jl/sync-retry', '  ? staging'],
  )
  assert.equal(waitingCount(hosts(), { fromPrs: true, closed: new Set(), skipped: {} }), 4)
  // With pipelines from PR monitors off, From watched PRs goes.
  assert.equal(waitingCount(hosts(), { fromPrs: false, closed: new Set(), skipped: {} }), 3)
  assert.ok(!pipeItems(hosts(), { fromPrs: false, closed: new Set(), skipped: {} }, NONE).some(i => i.kind === 'group' && i.group === 'prs'))
})

test('j/k move through rows and prompts together, never onto a heading', () => {
  const p = state()
  assert.equal(sel(p), 'pipe platform/api main')
  down(p)
  assert.equal(sel(p), 'pipe platform/api v2.14.0')
  down(p)
  assert.equal(sel(p), 'gate deploy:prod-eu')
  down(p, 3)
  assert.equal(sel(p), 'gate apply')
  down(p)
  assert.equal(sel(p), 'pipe jl/gad jl/sync-retry')
  down(p, 9)
  assert.equal(sel(p), 'gate staging', 'held at the end')
  down(p, -99)
  assert.equal(sel(p), 'pipe platform/api main')
})

test('y runs the lit prompt and nothing else; on a row it says to move onto one', () => {
  const p = state()
  notes.length = 0
  assert.equal(key(p, 'y'), null)
  assert.match(notes[0], /Move onto a prompt/)
  down(p, 2)
  const act = key(p, 'y')
  assert.equal(act?.do, 'gate')
  assert.equal(act?.do === 'gate' && act.gate.name, 'deploy:prod-eu')
  assert.equal(act?.do === 'gate' && act.pipe.id, 4512)
})

test('n skips the lit prompt until the job changes, and the cursor moves on', () => {
  const p = state()
  down(p, 2)
  assert.deepEqual(key(p, 'n'), { do: 'savePipes' })
  assert.equal(sel(p), 'gate deploy:prod-us')
  assert.equal(waitingCount(p.hosts, p), 3)
  assert.ok(!itemsOf(p, NONE).some(i => i.kind === 'gate' && i.gate.name === 'deploy:prod-eu'))
  // Run again (a new job id), it's back; kept skips drop what's gone.
  const h = hosts()
  const gate = h[0].pipes[0].gates[0]
  gate.id = '9100'
  assert.deepEqual(keptSkips(h, p.skipped), {})
  assert.equal(Object.keys(keptSkips(hosts(), p.skipped)).length, 1)
})

test('↵ hides or shows a pipeline’s prompts; ! does nothing', () => {
  const p = state()
  down(p, 5)
  assert.equal(sel(p), 'gate apply')
  // ↵ on a prompt closes its pipeline's panel and lands on the row.
  key(p, '\r')
  assert.equal(sel(p), 'pipe infra/terraform main')
  assert.ok(!itemsOf(p, NONE).some(i => i.kind === 'gate' && i.gate.name === 'apply'))
  key(p, '\r')
  assert.ok(itemsOf(p, NONE).some(i => i.kind === 'gate' && i.gate.name === 'apply'), 'open again')
  assert.equal(key(p, '!'), null)
  assert.equal(sel(p), 'pipe infra/terraform main')
  // ↵ on a row without prompts does nothing.
  down(p, -99)
  key(p, '\r')
  assert.equal(sel(p), 'pipe platform/api main')
})

test('m watches the pipeline under the cursor; o opens it, or the prompt’s job', () => {
  const p = state()
  assert.deepEqual(key(p, 'm'), { do: 'watchPipe', target: 'https://gitlab.example.com/platform/api/-/pipelines/4510' })
  down(p, 2)
  assert.deepEqual(key(p, 'o'), { do: 'browse', url: 'https://gitlab.example.com/platform/api/-/jobs/9001' })
  assert.equal(watchTarget({ ...p.hosts[0].pipes[0], url: '' }), 'gitlab.example.com/platform/api@v2.14.0')
})

test('+ types a pipeline to watch: ↵ starts it when it’s one, esc goes back', () => {
  const p = state()
  key(p, '+')
  assert.equal(p.watch.typing, true)
  for (const ch of 'nope') key(p, ch)
  notes.length = 0
  assert.equal(key(p, '\r'), null)
  assert.match(notes[0], /pipeline URL, or project@ref/)
  for (let i = 0; i < 4; i++) key(p, '\x7f')
  pastePipes(p, ' platform/api@main\n')
  assert.deepEqual(key(p, '\r'), { do: 'watchPipe', target: 'platform/api@main' })
  assert.deepEqual(p.watch, { text: '', typing: false })
  key(p, '+')
  key(p, '\x1b')
  assert.equal(p.watch.typing, false)
  // Keys go back to the list: r isn't typed.
  key(p, 'r')
  assert.equal(p.watch.text, '')
})

test('P turns pipelines from PR monitors off and on, r refreshes', () => {
  const p = state()
  assert.deepEqual(key(p, 'P'), { do: 'fromPrs', on: false })
  assert.equal(p.fromPrs, false)
  assert.deepEqual(key(p, 'r'), { do: 'refreshPipes' })
})

test('a pipeline from a watched PR says via; one a pipeline monitor watches says so', () => {
  const run = (target: string, state = 'watching') => ({ kind: 'pipe', pipeTarget: target, m: { state } }) as unknown as RunRow
  const watched = watchedPipes([run('https://gitlab.example.com/platform/api/-/pipelines/4510'), run('gitlab.example.com/platform/api@v2.14.0'), run('infra/terraform@main', 'ended')])
  const items = pipeItems(hosts(), { fromPrs: true, closed: new Set(), skipped: {} }, watched).filter(i => i.kind === 'pipe')
  assert.deepEqual(
    items.map(i => (i.kind === 'pipe' ? i.monitor : null)),
    [{ kind: 'watching' }, { kind: 'watching' }, { kind: 'none' }, { kind: 'via', ref: '#77' }],
  )
})

test('now: what waits, what failed, what runs', () => {
  const w = (k: string, v?: Record<string, string | number>) => t(`monitors.pipes.now.${k}`, v)
  const [main, tag, tf] = [hosts()[0].pipes[1], hosts()[0].pipes[0], hosts()[0].pipes[2]]
  assert.equal(nowOf(tag, tag.gates, w).text, '⏸ 2 jobs wait for you')
  assert.equal(nowOf(tf, tf.gates, w).text, '⏸ apply waits for you')
  assert.deepEqual(nowOf(main, [], w), { tone: 'blue', text: '◐ security · 2 of 3 jobs' })
  assert.deepEqual(nowOf({ ...main, state: 'failed', failed: 'e2e' }, [], w), { tone: 'red', text: '✗ e2e failed' })
  assert.equal(nowOf({ ...tag, state: 'passed' }, [], w).text, '✓ passed')
})

test('a pipeline that passed goes once it started over keepMs ago; failed ones and ones waiting on you stay', () => {
  const h = hosts()
  const [, main, terraform] = h[0].pipes
  main.state = 'passed'
  main.at = NOW - 25 * HOUR
  const v = { fromPrs: true, closed: new Set<string>(), skipped: {} as Record<string, string>, keepMs: 24 * HOUR, now: NOW }
  assert.ok(!names(pipeItems(h, v, NONE)).includes('platform/api main'))
  assert.equal(hiddenCount(h, v), 1)
  assert.ok(names(pipeItems(h, { ...v, keepMs: 0 }, NONE)).includes('platform/api main'), '0 keeps every one')
  assert.ok(names(pipeItems(h, { ...v, now: NOW - 2 * HOUR }, NONE)).includes('platform/api main'), 'younger than keepMs')
  main.state = 'failed'
  assert.ok(names(pipeItems(h, v, NONE)).includes('platform/api main'), 'failed stays')
  // Passed but with a prompt still waiting: it stays until the prompt is skipped.
  terraform.state = 'passed'
  terraform.at = NOW - 72 * HOUR
  assert.ok(names(pipeItems(h, v, NONE)).includes('infra/terraform main'))
  const g = terraform.gates[0]
  assert.ok(!names(pipeItems(h, { ...v, skipped: { [`gl:gitlab.example.com:infra/terraform:${terraform.id}:${g.kind}:${g.id}`]: `${g.id}@${g.sha}` } }, NONE)).includes('infra/terraform main'))
})

test('x hides the pipeline under the cursor until its next run; u brings it back', () => {
  const p = state()
  notes.length = 0
  down(p, 2)
  assert.equal(sel(p), 'gate deploy:prod-eu')
  assert.deepEqual(key(p, 'x'), { do: 'savePipes' })
  assert.match(notes[0], /Hid api v2\.14\.0 until its next run/)
  assert.equal(sel(p), 'pipe infra/terraform main', 'the cursor goes to the next pipeline')
  assert.ok(!names(itemsOf(p, NONE)).includes('platform/api v2.14.0'))
  assert.equal(waitingCount(p.hosts, p), 2, 'its prompts no longer count')
  assert.deepEqual(key(p, 'u'), { do: 'savePipes' })
  assert.equal(sel(p), 'pipe platform/api v2.14.0')
  assert.equal(key(p, 'u'), null)
  assert.match(notes.at(-1) ?? '', /Nothing to bring back/)
  // On the last pipeline, the cursor goes up instead.
  down(p, 99)
  key(p, 'x')
  assert.equal(sel(p), 'pipe infra/terraform main')
  // A new run (a new id) shows again, and the dismissed list drops the old one.
  const h = hosts()
  h[1].pipes[0].id = 999
  assert.equal(keptDismissed(h, p.dismissed).size, 0)
  assert.equal(keptDismissed(hosts(), p.dismissed).size, 1)
})
