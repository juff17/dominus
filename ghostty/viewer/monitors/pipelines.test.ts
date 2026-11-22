// Runs against a fake gh and glab
// (tests/fixtures/viewer/monitors/fake-forge.mjs), never the network.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { run } from '../../core/proc.ts'
import { type Pipe, gitlabPipe, githubPipe, parsePipeTarget, pipelinesClient, refMatches, targetLabel } from './pipelines.ts'

const FIXTURES = join(import.meta.dirname, '../../../tests/fixtures/viewer/monitors')
const FAKE = join(FIXTURES, 'fake-forge.mjs')
const DIR = mkdtempSync(join(tmpdir(), 'pipelines-'))
after(() => rmSync(DIR, { recursive: true, force: true }))
const CALLS = join(DIR, 'calls')
process.env.FAKE_FORGE_CALLS = CALLS
const calls = (): string[][] => readFileSync(CALLS, 'utf8').trim().split('\n').map(l => JSON.parse(l))

const json = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8').replace(/"@-\d+[mhd]"/g, '"2026-11-11T12:00:00.000Z"'))
const logged: [string, string, Record<string, unknown>][] = []
const log = {
  debug: (m: string, f: Record<string, unknown> = {}) => logged.push(['debug', m, f]),
  info: (m: string, f: Record<string, unknown> = {}) => logged.push(['info', m, f]),
  warn: (m: string, f: Record<string, unknown> = {}) => logged.push(['warn', m, f]),
  error: (m: string, f: Record<string, unknown> = {}) => logged.push(['error', m, f]),
}
const client = pipelinesClient({ run: ([cli = '', ...args], opts) => run(['node', FAKE, cli, ...args], opts), log })

test('a GitLab pipeline: stages in the order they ran, its manual jobs the gates, a tag a tag', () => {
  const p = gitlabPipe((json('glab/projects_platform%2Fapi_pipelines.json') as unknown[])[0], json('glab/projects_platform%2Fapi_pipelines_4512_jobs.json'), 'gitlab.example.com', 'platform/api', { tag: true })!
  assert.deepEqual(
    p.stages.map(s => [s.name, s.state]),
    [
      ['build', 'passed'],
      ['test', 'passed'],
      ['scan', 'passed'],
      ['deploy', 'manual'],
      ['notify', 'waiting'],
    ],
  )
  assert.deepEqual(
    p.gates.map(g => [g.kind, g.id, g.name, g.stage, g.sha.slice(0, 7)]),
    [
      ['job', '9001', 'deploy:prod-eu', 'deploy', '8c41d2e'],
      ['job', '9002', 'deploy:prod-us', 'deploy', '8c41d2e'],
    ],
  )
  assert.equal(p.trigger, 'tag')
  assert.equal(p.state, 'manual')
  const running = gitlabPipe({ id: 1, ref: 'main', status: 'running', source: 'schedule' }, json('glab/projects_platform%2Fapi_pipelines_4510_jobs.json'), 'h', 'p')!
  assert.deepEqual(running.stages.find(s => s.name === 'security'), { name: 'security', state: 'running', done: 2, total: 3 })
  assert.equal(running.trigger, 'schedule')
  assert.equal(gitlabPipe({}, [], 'h', 'p'), null)
})

test('a GitHub run: each job a stage, the deployments you may approve its gates', () => {
  const runs = (json('gh/repos_jl_gad_actions_runs_pr.json') as { workflow_runs: unknown[] }).workflow_runs
  const p = githubPipe(runs[0], json('gh/repos_jl_gad_actions_runs_601_jobs.json'), json('gh/repos_jl_gad_actions_runs_601_pending_deployments.json'), 'github.com', 'jl/gad', { pr: 'https://github.com/jl/gad/pull/77', prRef: '#77' })!
  assert.deepEqual(
    p.stages.map(s => s.state),
    ['passed', 'passed', 'manual'],
  )
  assert.deepEqual(p.gates, [{ id: '31', kind: 'deployment', name: 'staging', stage: '', env: 'staging', sha: '4f2a1c9b8e7d6c5b4a39281706f5e4d3c2b1a090', url: 'https://github.com/jl/gad/actions/runs/601' }])
  assert.equal(p.state, 'manual')
  assert.equal(p.trigger, 'pr')
  const nightly = githubPipe((json('gh/repos_jl_dotfiles_actions_runs.json') as { workflow_runs: unknown[] }).workflow_runs[0], json('gh/repos_jl_dotfiles_actions_runs_501_jobs.json'), [], 'github.com', 'jl/dotfiles')!
  assert.equal(nightly.state, 'failed')
  assert.equal(nightly.failed, 'e2e')
  assert.equal(nightly.trigger, 'schedule')
  assert.deepEqual(
    nightly.stages.map(s => s.state),
    ['passed', 'failed', 'skipped'],
  )
  // One you can't approve isn't yours to answer.
  assert.deepEqual(githubPipe(runs[0], {}, [{ environment: { id: 9, name: 'prod' }, current_user_can_approve: false }], 'h', 'p')!.gates, [])
})

test('refs: the default branch by name, and globs', () => {
  assert.equal(refMatches('main', ['default branch'], 'main'), true)
  assert.equal(refMatches('develop', ['default branch'], 'main'), false)
  assert.equal(refMatches('v2.14.0', ['v*'], 'main'), true)
  assert.equal(refMatches('release/2026', ['release/*'], 'main'), true)
  assert.equal(refMatches('jl/rate-limit', ['default branch', 'v*'], 'main'), false)
})

test('a pipeline target: a pipeline or run address, or [host/]project@ref', () => {
  assert.deepEqual(parsePipeTarget('https://gitlab.example.com/platform/api/-/pipelines/4512'), {
    url: 'https://gitlab.example.com/platform/api/-/pipelines/4512',
    forge: 'gl',
    host: 'gitlab.example.com',
    project: 'platform/api',
    ref: '',
    id: 4512,
  })
  assert.equal(parsePipeTarget('https://github.com/jl/gad/actions/runs/601')?.forge, 'gh')
  assert.deepEqual(parsePipeTarget('platform/api@v2.14.0'), { url: '', forge: '', host: '', project: 'platform/api', ref: 'v2.14.0', id: 0 })
  assert.deepEqual(parsePipeTarget('gitlab.example.com/platform/api@main'), { url: '', forge: '', host: 'gitlab.example.com', project: 'platform/api', ref: 'main', id: 0 })
  assert.equal(parsePipeTarget('https://github.com/jl/gad/pull/77'), null)
  assert.equal(parsePipeTarget('just words'), null)
  assert.equal(targetLabel(parsePipeTarget('gitlab.example.com/group/platform/api@v2.14.0')!), 'platform/api v2.14.0')
  assert.equal(targetLabel(parsePipeTarget('https://gitlab.example.com/platform/api/-/pipelines/4512')!), 'platform/api #4512')
})

test('fetching a GitLab host: each project’s default branch and tags, the newest per ref, and a watched MR’s pipeline', async () => {
  const h = await client.fetch({
    forge: 'gl',
    host: 'gitlab.example.com',
    projects: ['platform/api', 'infra/terraform', 'gone/project'],
    refs: ['default branch', 'v*'],
    prs: [{ forge: 'gl', host: 'gitlab.example.com', project: 'jl/ci-playground', number: 128, url: 'https://gitlab.example.com/jl/ci-playground/-/merge_requests/128' }],
  })
  assert.equal(h.ok, true)
  assert.deepEqual(
    h.pipes.map(p => [p.project, p.ref, p.id, p.trigger, p.prRef]),
    [
      ['platform/api', 'v2.14.0', 4512, 'tag', ''],
      ['platform/api', 'main', 4510, 'push', ''],
      ['infra/terraform', 'main', 77, 'push', ''],
      ['jl/ci-playground', 'refs/merge-requests/128/head', 902, 'mr', '!128'],
    ],
  )
  // A project it can't read is left out, and said in the log.
  assert.ok(logged.some(([lvl, m, f]) => lvl === 'warn' && m === 'pipelines part not fetched' && f.project === 'gone/project'))
  assert.ok(logged.some(([lvl, m, f]) => lvl === 'info' && m === 'pipelines fetched' && f.pipes === 4 && f.gates === 3 && typeof f.ms === 'number'))
})

test('fetching a GitHub host: runs per ref and workflow, and a watched PR’s runs by its head commit', async () => {
  const h = await client.fetch({
    forge: 'gh',
    host: 'github.com',
    projects: ['jl/dotfiles'],
    refs: ['default branch'],
    prs: [{ forge: 'gh', host: 'github.com', project: 'jl/gad', number: 77, url: 'https://github.com/jl/gad/pull/77' }],
  })
  assert.deepEqual(
    h.pipes.map(p => [p.project, p.id, p.state, p.gates.length]),
    [
      ['jl/dotfiles', 501, 'failed', 0],
      ['jl/gad', 601, 'manual', 1],
    ],
  )
  assert.ok(calls().some(c => c.join(' ') === 'gh api --hostname github.com repos/jl/gad/actions/runs/601/pending_deployments'))
})

test('a host whose CLI isn’t logged in fails as a whole, keeping nothing', async () => {
  process.env.FAKE_FORGE_DOWN = 'glab'
  try {
    const h = await client.fetch({ forge: 'gl', host: 'gitlab.example.com', projects: ['platform/api'], refs: ['v*'], prs: [] })
    assert.equal(h.ok, false)
    assert.equal(!h.ok && h.why, 'auth')
    assert.deepEqual(h.pipes, [])
  } finally {
    delete process.env.FAKE_FORGE_DOWN
  }
})

const pipeOf = async (forge: 'gl' | 'gh'): Promise<Pipe> => {
  const h =
    forge === 'gl'
      ? await client.fetch({ forge: 'gl', host: 'gitlab.example.com', projects: ['platform/api'], refs: ['v*'], prs: [] })
      : await client.fetch({ forge: 'gh', host: 'github.com', projects: [], refs: [], prs: [{ forge: 'gh', host: 'github.com', project: 'jl/gad', number: 77, url: 'https://github.com/jl/gad/pull/77' }] })
  return h.pipes[0]
}

test('y on a GitLab manual job reads it again, then plays it', async () => {
  const pipe = await pipeOf('gl')
  const r = await client.run(pipe, pipe.gates[0])
  assert.deepEqual(r, { ok: true })
  const last = calls().slice(-2)
  assert.deepEqual(last[0], ['glab', 'api', '--hostname', 'gitlab.example.com', 'projects/platform%2Fapi/jobs/9001'])
  assert.deepEqual(last[1], ['glab', 'api', '--hostname', 'gitlab.example.com', '-X', 'POST', 'projects/platform%2Fapi/jobs/9001/play'])
  assert.ok(logged.some(([lvl, m, f]) => lvl === 'info' && m === 'gate ran' && f.id === '9001' && f.pipeline === 4512))
})

test('y on a job that ran since it was shown is refused, and plays nothing', async () => {
  const pipe = await pipeOf('gl')
  const before = calls().length
  const r = await client.run(pipe, pipe.gates[1])
  assert.deepEqual(r, { ok: false, why: 'changed', err: 'running' })
  assert.equal(
    calls()
      .slice(before)
      .some(c => c.includes('-X')),
    false,
  )
  // Nor on another commit.
  const moved = await client.run(pipe, { ...pipe.gates[0], sha: 'feedface' })
  assert.equal(moved.ok, false)
})

test('y on a GitHub deployment checks the run still waits on it, then approves it', async () => {
  const pipe = await pipeOf('gh')
  assert.deepEqual(await client.run(pipe, pipe.gates[0]), { ok: true })
  assert.deepEqual(calls().at(-1), [
    'gh',
    'api',
    '--hostname',
    'github.com',
    '-X',
    'POST',
    '-F',
    'environment_ids[]=31',
    '-f',
    'state=approved',
    '-f',
    'comment=Approved from Alt+M',
    'repos/jl/gad/actions/runs/601/pending_deployments',
  ])
  assert.deepEqual((await client.run(pipe, { ...pipe.gates[0], id: '99' })).ok, false, 'an environment it no longer waits on')
})
