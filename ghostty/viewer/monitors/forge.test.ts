// Runs against the fixtures' fake gh and glab
// (tests/fixtures/viewer/monitors/fake-forge.mjs), never a real host.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { type RunResult, type Runner, run } from '../../core/proc.ts'
import { type Pr, forgeClient, githubPipeline, gitlabPipeline, loggedIn, onPath, parseGithub, whyFailed } from './forge.ts'

const FIXTURES = join(import.meta.dirname, '../../../tests/fixtures/viewer/monitors')
const FAKE = join(FIXTURES, 'fake-forge.mjs')
const quiet = { debug: () => {}, info: () => {}, warn: () => {} }

// gh and glab as the fake answers them; `down` fails those as not logged in.
const fake =
  (down = ''): Runner =>
  ([cli, ...args], opts) =>
    run([process.execPath, FAKE, cli, ...args], { ...opts, env: { ...process.env, FAKE_FORGE_DOWN: down } })

const byRef = (prs: Pr[]) => new Map(prs.map(p => [`${p.repo}${p.forge === 'gh' ? '#' : '!'}${p.number}`, p]))

test('GitHub: one GraphQL answer gives every PR, flagged mine or review, with its checks, reviews and branch', () => {
  const json = JSON.parse(readFileSync(join(FIXTURES, 'gh-graphql.json'), 'utf8'))
  const parsed = parseGithub(json, 'github.com')
  assert.ok(parsed)
  assert.equal(parsed.me, 'jl')
  const prs = byRef(parsed.prs)
  assert.deepEqual([...prs.keys()], ['jl/dotfiles#44', 'jl/gad#77', 'jl/jstack#9', 'jl/notes#3', 'amy/site#12'])
  const dot = prs.get('jl/dotfiles#44')!
  assert.deepEqual([dot.mine, dot.review, dot.head, dot.base, dot.url], [true, false, 'jl/tidy-install', 'main', 'https://github.com/jl/dotfiles/pull/44'])
  assert.deepEqual(dot.pipeline, { state: 'passed', job: '', done: 2, total: 2 })
  assert.deepEqual(dot.reviews, { approvedBy: [], required: 0, changes: true, waiting: false, threads: 3, reviewers: ['amy'] })
  assert.deepEqual(dot.branch, { state: 'behind', behind: null })
  assert.deepEqual(prs.get('jl/gad#77')!.pipeline, { state: 'manual', job: 'deploy:staging', done: 2, total: 3 })
  assert.deepEqual(prs.get('jl/gad#77')!.reviews.approvedBy, ['amy'])
  assert.deepEqual(prs.get('jl/jstack#9')!.pipeline, { state: 'running', job: '', done: 3, total: 9 })
  assert.equal(prs.get('jl/jstack#9')!.reviews.waiting, true)
  assert.deepEqual(prs.get('jl/notes#3')!.pipeline, { state: 'failed', job: 'lint', done: 2, total: 2 })
  assert.deepEqual([prs.get('amy/site#12')!.mine, prs.get('amy/site#12')!.review, prs.get('amy/site#12')!.author], [false, true, 'amy'])
  assert.equal(parseGithub({ errors: [{ message: 'no' }] }, 'github.com'), null)
})

test('GitHub checks: none, all canceled, and a status still pending', () => {
  assert.equal(githubPipeline(null).state, 'none')
  const cancelled = { contexts: { nodes: [{ name: 'a', status: 'COMPLETED', conclusion: 'CANCELLED' }] } }
  assert.equal(githubPipeline(cancelled).state, 'canceled')
  const status = { contexts: { nodes: [{ __typename: 'StatusContext', context: 'ci/x', state: 'PENDING' }] } }
  assert.deepEqual(githubPipeline(status), { state: 'running', job: '', done: 0, total: 1 })
})

test('GitLab: the lists, then each MR’s detail, approvals, threads and jobs', async () => {
  const r = await forgeClient({ run: fake(), log: quiet }).fetch('gl', 'gitlab.example.com')
  assert.equal(r.ok, true)
  assert.equal(r.me, 'jl')
  const prs = byRef(r.prs)
  assert.deepEqual([...prs.keys()].sort(), ['jl/ci-playground!128', 'platform/api!512', 'platform/api!520', 'platform/web!88'])
  const api = prs.get('platform/api!512')!
  assert.deepEqual([api.mine, api.review, api.title, api.url], [true, false, 'Rate-limit the export endpoint', 'https://gitlab.example.com/platform/api/-/merge_requests/512'])
  assert.deepEqual(api.branch, { state: 'conflict', behind: null })
  assert.deepEqual(api.pipeline.state, 'passed')
  assert.deepEqual(api.reviews, { approvedBy: [], required: 2, changes: false, waiting: true, threads: 0, reviewers: ['raj', 'mei'] })
  const ci = prs.get('jl/ci-playground!128')!
  // The job that may fail doesn't count as the failure.
  assert.deepEqual(ci.pipeline, { state: 'failed', job: 'test:unit', done: 3, total: 3 })
  assert.deepEqual(ci.branch, { state: 'behind', behind: 4 })
  assert.deepEqual([ci.reviews.approvedBy, ci.reviews.threads], [['mei'], 3])
  const web = prs.get('platform/web!88')!
  assert.deepEqual([web.draft, web.pipeline.state, web.branch.behind], [true, 'none', 11])
  const bump = prs.get('platform/api!520')!
  assert.deepEqual([bump.mine, bump.review], [false, true])
  assert.deepEqual(bump.pipeline, { state: 'running', job: '', done: 1, total: 3 })
})

test('GitLab pipelines: a manual job waiting, and a pipeline still pending', () => {
  const jobs = [
    { name: 'build', status: 'success' },
    { name: 'deploy:staging', status: 'manual' },
  ]
  assert.deepEqual(gitlabPipeline({ id: 1, status: 'manual' }, jobs), { state: 'manual', job: 'deploy:staging', done: 1, total: 1 })
  assert.equal(gitlabPipeline({ id: 1, status: 'pending' }, null).state, 'pending')
  assert.equal(gitlabPipeline(null, null).state, 'none')
})

test('why a host failed: not installed, not logged in, or anything else', () => {
  const r = (err: string): Pick<RunResult, 'err' | 'exit'> => ({ err, exit: 1 })
  assert.equal(whyFailed(r('spawn glab ENOENT')), 'missing')
  assert.equal(whyFailed(r('To get started with GitHub CLI, please run:  gh auth login')), 'auth')
  assert.equal(whyFailed(r('glab: 401 Unauthorized')), 'auth')
  assert.equal(whyFailed(r('Post "https://api.github.com/graphql": dial tcp: i/o timeout')), 'failed')
})

test('a host that can’t be read shows no rows; one that failed this time keeps the last ones', async () => {
  const logs: unknown[][] = []
  const log = { ...quiet, warn: (...a: unknown[]) => logs.push(a) }
  const down = await forgeClient({ run: fake('gh'), log }).fetch('gh', 'github.com')
  assert.deepEqual([down.ok, !down.ok && down.why, down.prs.length], [false, 'auth', 0])
  assert.equal(logs[0][0], 'prs not fetched')
  const before = await forgeClient({ run: fake(), log: quiet }).fetch('gh', 'github.com')
  assert.equal(before.prs.length, 5)
  const timeout: Runner = async () => ({ ok: false, out: '', err: 'Command failed: gh api graphql', exit: null })
  const stale = await forgeClient({ run: timeout, log: quiet }).fetch('gh', 'github.com', before)
  assert.deepEqual([stale.ok, !stale.ok && stale.why, stale.prs.length, stale.at], [false, 'failed', 5, before.at])
  const missing: Runner = async () => ({ ok: false, out: '', err: 'spawn gh ENOENT', exit: null })
  const gone = await forgeClient({ run: missing, log: quiet }).fetch('gh', 'github.com', before)
  assert.deepEqual([!gone.ok && gone.why, gone.prs.length], ['missing', 0])
})

test('onPath: finds an executable in a PATH folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-path-'))
  try {
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'glab'), '#!/bin/sh\n')
    chmodSync(join(dir, 'bin', 'glab'), 0o755)
    const PATH = join(dir, 'bin')
    assert.equal(onPath('glab', PATH), true)
    assert.equal(onPath('gh', PATH), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loggedIn: asks the CLI for the user on that host, and keeps only whether it worked', async () => {
  const calls: string[][] = []
  const answer =
    (ok: boolean): Runner =>
    async args => {
      calls.push(args)
      return { ok, out: ok ? '{"login":"me"}' : '', err: ok ? '' : 'To get started with GitHub CLI, please run:  gh auth login', exit: ok ? 0 : 4 }
    }
  assert.equal(await loggedIn('gh', 'ghe.corp.example', answer(true)), true)
  assert.equal(await loggedIn('gl', 'gitlab.example.com', answer(false)), false)
  assert.deepEqual(calls, [
    ['gh', 'api', '--hostname', 'ghe.corp.example', 'user'],
    ['glab', 'api', '--hostname', 'gitlab.example.com', 'user'],
  ])
})
