import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'

const { groupCounts, monitorFor, monitorUrl, parsePrUrl, prRows, refLabel, roleCounts, runRows, sameUrl, watchedPrs, hitsIn } = await import('./rows.ts')
const { monitorsOf } = await import('../../agents/model.ts')
const { parseGithub } = await import('./forge.ts')
type Agent = import('../../agents/model.ts').Agent
type HostResult = import('./forge.ts').HostResult
type Proposal = import('../../tray/approvals.ts').Proposal

const FIXTURES = join(import.meta.dirname, '../../../tests/fixtures/viewer/monitors')
const NOW = Date.UTC(2026, 10, 11, 12)
const UNIT: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }
// The fixtures' "@-9.5m" times, as numbers (agents) or ISO strings (forges).
const fixture = (name: string, iso = false): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'), (_, v) => {
    const m = typeof v === 'string' ? /^@-([\d.]+)([smhd])$/.exec(v) : null
    if (!m) return v
    const at = NOW - Number(m[1]) * UNIT[m[2]]
    return iso ? new Date(at).toISOString() : at
  })
const agents = (fixture('agents.json') as { agents: Agent[] }).agents
const gh = parseGithub(fixture('gh-graphql.json', true), 'github.com')!
const hosts: HostResult[] = [{ forge: 'gh', host: 'github.com', me: gh.me, at: NOW, ms: 1, prs: gh.prs, ok: true }]
const proposals = (fixture('proposals.json') as { proposals: Proposal[] }).proposals
const byId = (id: string): Proposal => proposals.find(p => p.id.endsWith(id)) as Proposal

test('a PR’s address: GitHub and GitLab, and its name in a row', () => {
  assert.deepEqual(parsePrUrl('https://github.com/jl/gad/pull/77'), { forge: 'gh', host: 'github.com', repo: 'jl/gad', number: 77 })
  assert.deepEqual(parsePrUrl('https://gitlab.example.com/platform/api/-/merge_requests/512#note_1'), { forge: 'gl', host: 'gitlab.example.com', repo: 'platform/api', number: 512 })
  assert.equal(parsePrUrl('https://example.com/nothing'), null)
  assert.equal(refLabel('gh', 'jl/gad', 77, 'jl'), 'gad #77')
  assert.equal(refLabel('gl', 'platform/api', 512, 'jl'), 'platform/api !512')
  assert.equal(sameUrl('HTTP://GitHub.com/jl/gad/pull/77/'), 'https://github.com/jl/gad/pull/77')
})

test('the PR a monitor watches: watch_pr.py’s argument, else its session’s first prompt', () => {
  const m = { kind: 'pr-babysit', command: "python3 -u watch_pr.py 'https://github.com/a/b/pull/1' -C /x", agent: { prompt: '' } }
  assert.equal(monitorUrl(m), 'https://github.com/a/b/pull/1')
  assert.equal(monitorUrl({ ...m, command: 'python3 other.py', agent: { prompt: '/pr-babysit https://github.com/a/b/pull/2.' } }), 'https://github.com/a/b/pull/2')
  assert.equal(monitorUrl({ ...m, kind: 'logger' }), '')
})

test('Running: Needs you, then Watching with stale last, then Ended, the latest first; named from the PR list when it has the PR', () => {
  const rows = runRows(agents, hosts)
  assert.deepEqual(
    rows.map(r => [r.group, r.m.state, r.kind, r.forge, r.target]),
    [
      ['needs', 'action', 'pr', 'gl', 'ci-playground !128'],
      ['needs', 'action', 'pr', 'gh', 'gad #77'],
      ['watching', 'watching', 'pr', 'gh', 'jstack #9'],
      ['watching', 'watching', 'logs', '', 'staging-eu payments 500s on /v2/export'],
      ['watching', 'stale', 'logs', '', 'prod-eu worker OOM kills'],
      ['ended', 'ended', 'pr', 'gh', 'dotfiles #41'],
    ],
  )
  assert.equal(rows[1].pr?.title, 'Retry the sync job')
  assert.equal(rows[0].pr, null, 'GitLab isn’t in this list, so the name comes from the address')
})

test('Running’s filter: every word somewhere, the name lit', () => {
  const rows = runRows(agents, hosts, 'GAD')
  assert.deepEqual(
    rows.map(r => [r.target, r.hit]),
    [['gad #77', [0, 1, 2]]],
  )
  assert.deepEqual(
    runRows(agents, hosts, 'oom').map(r => r.target),
    ['prod-eu worker OOM kills'],
  )
  assert.deepEqual(runRows(agents, hosts, 'retry sync').map(r => r.target), ['gad #77'], 'the PR’s title counts')
})

test('a PR’s monitor: an ended one watches nothing, needing you wins', () => {
  const w = watchedPrs(runRows(agents, hosts))
  assert.equal(w.get('https://github.com/jl/gad/pull/77'), 'action')
  assert.equal(w.get('https://github.com/jl/jstack/pull/9'), 'watching')
  assert.equal(w.has('https://github.com/jl/dotfiles/pull/41'), false)
})

test('the PR list: a role, drafts after the rest, and a filter with what it hid', () => {
  const w = watchedPrs(runRows(agents, hosts))
  const mine = prRows(hosts, 'mine', true, '', w)
  assert.deepEqual(
    mine.rows.map(r => [r.ref, r.monitor]),
    [
      ['notes #3', null],
      ['jstack #9', 'watching'],
      ['gad #77', 'action'],
      ['dotfiles #44', null],
    ],
  )
  assert.deepEqual(prRows(hosts, 'reviewer', true, '', w).rows.map(r => r.ref), ['amy/site #12'])
  const found = prRows(hosts, 'mine', true, 'tidy', w)
  assert.deepEqual([found.rows.map(r => r.ref), found.hidden], [['dotfiles #44'], 3])
  assert.deepEqual(found.rows[0].hit, { ref: [], title: [0, 1, 2, 3] })
  assert.deepEqual(prRows(hosts, 'mine', true, '#9', w).rows.map(r => r.ref), ['jstack #9'], 'a number finds its PR')
  assert.deepEqual(prRows(hosts, 'mine', true, 'jl/parser', w).rows.map(r => r.ref), ['jstack #9'], 'so does its branch')
  const drafts: HostResult[] = [{ ...hosts[0], prs: [{ ...gh.prs[0], draft: true, createdAt: NOW }, ...gh.prs.slice(1)] }]
  assert.equal(prRows(drafts, 'mine', true, '', w).rows.at(-1)?.ref, 'dotfiles #44', 'a draft goes last')
  assert.deepEqual(roleCounts(drafts, false), { mine: 3, reviewer: 1 })
  assert.deepEqual(hitsIn('Rate-limit', ['limit', 'zz']), [5, 6, 7, 8, 9])
})

test('a proposal waits under its session’s monitor: by its Claude session, else its tab pane', () => {
  const monitors = monitorsOf(agents)
  assert.equal(monitorFor(byId('retry-ci'), agents, monitors)?.key, 's-ci:t1')
  const byPane: Proposal = { id: 'x', kind: 'reply', status: 'pending', pane: '%7' }
  assert.equal(monitorFor(byPane, agents, monitors)?.agent.id, 's-logs')
  // A pane on another tmux server names some other pane.
  assert.equal(monitorFor({ ...byPane, tmux: '/tmp/tmux-1000/layout,1,0' }, agents, monitors), null)
  assert.equal(monitorFor(byId('retry-gone'), agents, monitors), null)
})

test('of a session’s monitors, the one watching the proposal’s PR, else its pr-babysit one', () => {
  const two: Agent = {
    ...agents[0],
    monitors: [
      { ...agents[0].monitors[0], key: 's-gad:t0', kind: 'logger', command: 'tail -f x' },
      { ...agents[0].monitors[0], key: 's-gad:t2', command: 'python3 watch_pr.py https://github.com/jl/gad/pull/78' },
      agents[0].monitors[0],
    ],
  }
  const monitors = monitorsOf([two])
  assert.equal(monitorFor(byId('push-gad'), [two], monitors)?.key, 's-gad:t1')
  assert.equal(monitorFor({ ...byId('push-gad'), pr: {} }, [two], monitors)?.key, 's-gad:t2', 'no PR: the first pr-babysit one')
})

test('Running with proposals: what waits moves a monitor to Needs you, an ended one stays under Ended, and one with no session gets a row', () => {
  const rows = runRows(agents, hosts, '', proposals)
  assert.deepEqual(
    rows.map(r => [r.group, r.target, r.waits.map(p => p.id), r.standIn ?? '']),
    [
      ['needs', 'ci-playground !128', ['1002-reply-ci', '1003-retry-ci'], ''],
      ['needs', 'gad #77', ['1001-push-gad'], ''],
      ['needs', 'notes #3', ['1005-retry-gone'], 'gone'],
      ['watching', 'jstack #9', [], ''],
      ['watching', 'staging-eu payments 500s on /v2/export', [], ''],
      ['watching', 'prod-eu worker OOM kills', [], ''],
      ['ended', 'dotfiles #41', ['1004-reply-dot'], ''],
    ],
  )
  const gone = rows[2]
  assert.deepEqual([gone.url, gone.forge, gone.pr?.title, gone.m.agent.id, gone.match], ['https://github.com/jl/notes/pull/3', 'gh', gh.prs.find(p => p.number === 3)?.title, '', []])
  assert.deepEqual(groupCounts(rows), { approve: 5, action: 0, watching: 2, stale: 1, ended: 1 })
  assert.deepEqual(groupCounts(runRows(agents, hosts)), { approve: 0, action: 2, watching: 2, stale: 1, ended: 1 })
  assert.equal(watchedPrs(rows).has('https://github.com/jl/notes/pull/3'), false, 'a stand-in watches nothing')
  assert.deepEqual(
    runRows(agents, hosts, 'lint', proposals).map(r => r.target),
    ['notes #3'],
    'the filter reads a stand-in’s proposals',
  )
})

test('an ended monitor that left keeps its proposals in reach while its session is there', () => {
  const left = agents.map(a => (a.id === 's-dot' ? { ...a, monitors: [] } : a))
  const row = runRows(left, hosts, '', proposals).find(r => r.key === 'left:s-dot')
  assert.deepEqual([row?.group, row?.standIn, row?.target, row?.m.agent.id, row?.m.state], ['ended', 'left', 'dotfiles #41', 's-dot', 'ended'])
})
