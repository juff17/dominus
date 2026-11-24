// Runs against a fake fetch answering from the fixtures below, never a real
// Jira site.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type FetchLike, type JiraConfig, columnPhase, jiraClient, parseMeta, pickSprint, sprintJql } from './jira.ts'
import { factLines, handoffFacts, startedColumn } from './tracker.ts'

const quiet = { debug: () => {}, info: () => {}, warn: () => {} }

const CONFIG: JiraConfig = { site: 'https://acme.atlassian.net/', email: 'me@acme.test', token: 'secret-token', kind: 'scoped', cloudId: '', boardId: '42', teamId: '' }

const BOARD_CONFIG = {
  name: 'Payments',
  columnConfig: {
    columns: [
      { name: 'To Do', statuses: [{ id: '1' }] },
      { name: 'In Progress', statuses: [{ id: '3' }] },
      { name: 'In Review', statuses: [{ id: '4' }] },
      { name: 'Done', statuses: [{ id: '5' }] },
    ],
  },
  estimation: { field: { fieldId: 'customfield_10016' } },
}
const STATUSES = [
  { id: '1', statusCategory: { key: 'new' } },
  { id: '3', statusCategory: { key: 'indeterminate' } },
  { id: '4', statusCategory: { key: 'indeterminate' } },
  { id: '5', statusCategory: { key: 'done' } },
  { id: '9', statusCategory: { key: 'new' } },
]
const SPRINTS = {
  values: [
    { id: 7, name: 'Sprint 41b', state: 'active', startDate: '2026-11-10T00:00:00Z' },
    { id: 8, name: 'Sprint 42', state: 'active', startDate: '2026-11-18T00:00:00Z', endDate: '2026-12-02T00:00:00Z' },
    { id: 9, name: 'Sprint 43', state: 'future', startDate: '2026-12-03T00:00:00Z' },
  ],
}
const issue = (key: string, status: string, assignee?: string, extra: Record<string, unknown> = {}) => ({
  key,
  fields: {
    summary: `${key} summary`,
    status: { id: status },
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    updated: '2026-11-22T10:00:00Z',
    assignee: assignee ? { accountId: assignee, displayName: assignee === 'me-1' ? 'Me' : 'Other' } : null,
    customfield_10016: 3,
    ...extra,
  },
})
const ISSUES = [issue('ENG-1', '1'), issue('ENG-2', '3', 'me-1'), issue('ENG-3', '9'), issue('ENG-4', '4', 'someone-else')]

type Call = { url: string; auth: boolean }
function fakeFetch(answers: Record<string, unknown>, opts: { status?: Record<string, number>; headers?: Record<string, string> } = {}) {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, auth: 'Authorization' in init.headers })
    const match = Object.keys(answers).find(k => url.includes(k)) ?? Object.keys(opts.status ?? {}).find(k => url.includes(k))
    const status: number = (match ? opts.status?.[match] : undefined) ?? (match ? 200 : 404)
    return {
      ok: status < 300,
      status,
      headers: { get: (n: string) => opts.headers?.[n] ?? null },
      text: async () => (match && match in answers ? JSON.stringify(answers[match]) : ''),
    }
  }
  return { fetch, calls }
}

const ANSWERS = {
  '_edge/tenant_info': { cloudId: 'cloud-1' },
  '/rest/api/3/myself': { accountId: 'me-1', displayName: 'Me' },
  '/configuration': BOARD_CONFIG,
  '/rest/api/3/status': STATUSES,
  '/sprint?state=': SPRINTS,
  '/rest/software/1.0/board/42/sprint/8/issue': { issues: ISSUES, nextPageToken: null, isLast: true },
}

test('a scoped token goes through the gateway, with the cloud id tenant_info gives, unauthenticated only there', async () => {
  const { fetch, calls } = fakeFetch(ANSWERS)
  let saved = ''
  const jira = jiraClient({ config: CONFIG, fetch, log: quiet, onCloudId: id => (saved = id) })
  const r = await jira.board()
  assert.ok(r.ok)
  assert.equal(saved, 'cloud-1')
  assert.equal(calls[0].url, 'https://acme.atlassian.net/_edge/tenant_info')
  assert.equal(calls[0].auth, false)
  assert.ok(calls.slice(1).every(c => c.url.startsWith('https://api.atlassian.com/ex/jira/cloud-1/') && c.auth))
})

test('a classic token reads the site itself', async () => {
  const { fetch, calls } = fakeFetch(ANSWERS)
  const r = await jiraClient({ config: { ...CONFIG, kind: 'classic' }, fetch, log: quiet }).board()
  assert.ok(r.ok)
  assert.ok(calls.every(c => c.url.startsWith('https://acme.atlassian.net/rest/')))
})

test('the board copies the columns, picks the newest active sprint and splits unassigned from mine', async () => {
  const { fetch } = fakeFetch(ANSWERS)
  const r = await jiraClient({ config: CONFIG, fetch, log: quiet }).board()
  assert.ok(r.ok)
  const b = r.value
  assert.deepEqual(
    b.columns.map(c => [c.name, c.phase]),
    [
      ['To Do', 'todo'],
      ['In Progress', 'doing'],
      ['In Review', 'doing'],
      ['Done', 'done'],
    ],
  )
  assert.equal(b.sprint?.name, 'Sprint 42')
  assert.deepEqual(b.others, ['Sprint 41b'])
  assert.equal(b.next?.name, 'Sprint 43')
  // ENG-3's status is in no column, so it's hidden; ENG-4 is someone else's.
  assert.deepEqual(
    b.unassigned.map(t => t.key),
    ['ENG-1'],
  )
  assert.deepEqual(
    b.mine.map(t => t.key),
    ['ENG-2'],
  )
  const mine = b.mine[0]
  assert.equal(mine.url, 'https://acme.atlassian.net/browse/ENG-2')
  assert.equal(mine.points, 3)
  assert.equal(mine.type, 'story')
  assert.equal(mine.column, '1')
})

test('the issue call asks only for unassigned or mine, with the team when one is set, and the reconciled ids', async () => {
  const { fetch, calls } = fakeFetch(ANSWERS)
  await jiraClient({ config: { ...CONFIG, teamId: 'team-uuid' }, fetch, log: quiet }).board({ reconcile: ['10001'] })
  const url = new URL(calls.find(c => c.url.includes('/issue?'))?.url ?? '')
  assert.equal(url.searchParams.get('jql'), '(assignee is EMPTY OR assignee = currentUser()) AND "Team[Team]" = team-uuid')
  assert.equal(url.searchParams.get('reconcileIssues'), '10001')
  assert.match(url.searchParams.get('fields') ?? '', /customfield_10016/)
  assert.equal(sprintJql(''), '(assignee is EMPTY OR assignee = currentUser())')
})

test('a site without the new endpoint falls back to the agile one', async () => {
  const answers: Record<string, unknown> = { ...ANSWERS, '/rest/agile/1.0/board/42/sprint/8/issue': { issues: ISSUES, total: 4 } }
  delete answers['/rest/software/1.0/board/42/sprint/8/issue']
  const { fetch, calls } = fakeFetch(answers)
  const r = await jiraClient({ config: CONFIG, fetch, log: quiet }).board()
  assert.ok(r.ok)
  assert.equal(r.value.unassigned.length, 1)
  assert.ok(calls.some(c => c.url.includes('/rest/agile/1.0/board/42/sprint/8/issue')))
})

test('columns and sprint are cached, and fresh asks again', async () => {
  const { fetch, calls } = fakeFetch(ANSWERS)
  let t = 0
  const jira = jiraClient({ config: CONFIG, fetch, log: quiet, now: () => t })
  await jira.board()
  await jira.board()
  assert.equal(calls.filter(c => c.url.includes('/configuration')).length, 1)
  await jira.board({ fresh: true })
  assert.equal(calls.filter(c => c.url.includes('/configuration')).length, 2)
  t = 16 * 60 * 1000
  await jira.board()
  assert.equal(calls.filter(c => c.url.includes('/configuration')).length, 3)
})

test('a refused token, a 429 and a missing value each say why, and the token never appears', async () => {
  const refused = fakeFetch({}, { status: { '/rest/api/3/myself': 401, '/configuration': 401, '/sprint?state=': 401, '/rest/api/3/status': 401, '_edge/tenant_info': 200 } })
  const r1 = await jiraClient({ config: { ...CONFIG, kind: 'classic' }, fetch: refused.fetch, log: quiet }).board()
  assert.equal(r1.ok, false)
  assert.ok(!r1.ok && r1.why === 'auth')
  assert.ok(!JSON.stringify(r1).includes('secret-token'))

  const limited = fakeFetch({}, { status: { '/rest/api/3/myself': 429, '/configuration': 429, '/sprint?state=': 429, '/rest/api/3/status': 429 }, headers: { 'Retry-After': '12' } })
  const r2 = await jiraClient({ config: { ...CONFIG, kind: 'classic' }, fetch: limited.fetch, log: quiet }).board()
  assert.ok(!r2.ok && r2.why === 'limited' && r2.retryAfter === 12)

  const r3 = await jiraClient({ config: { ...CONFIG, token: '' }, fetch: fakeFetch(ANSWERS).fetch, log: quiet }).board()
  assert.ok(!r3.ok && r3.why === 'missing' && r3.err === 'JIRA_API_TOKEN')
  const r4 = await jiraClient({ config: { ...CONFIG, boardId: '' }, fetch: fakeFetch(ANSWERS).fetch, log: quiet }).board()
  assert.ok(!r4.ok && r4.why === 'missing' && r4.err === 'board')
})

test('the token goes only in the Authorization header, base64 with the email', async () => {
  const seen: string[] = []
  const fetch: FetchLike = async (url, init) => {
    seen.push(url, init.headers.Authorization ?? '')
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ accountId: 'me-1', displayName: 'Me' }) }
  }
  await jiraClient({ config: { ...CONFIG, kind: 'classic' }, fetch, log: quiet }).me()
  assert.equal(seen[1], `Basic ${Buffer.from('me@acme.test:secret-token').toString('base64')}`)
  assert.ok(!seen[0].includes('secret-token'))
})

test('boards are found by name, scrum only', async () => {
  const { fetch, calls } = fakeFetch({
    '/rest/agile/1.0/board?': { values: [{ id: 42, name: 'Payments', location: { projectKey: 'PAY' } }] },
  })
  const r = await jiraClient({ config: { ...CONFIG, kind: 'classic', boardId: '' }, fetch, log: quiet }).boards('Payments')
  assert.ok(r.ok)
  assert.deepEqual(r.value, [{ id: '42', name: 'Payments', project: 'PAY' }])
  const url = new URL(calls[0].url)
  assert.equal(url.searchParams.get('type'), 'scrum')
  assert.equal(url.searchParams.get('name'), 'Payments')
})

test('a column is started only when every status in it is in progress, and the started one follows the to-do ones', () => {
  assert.deepEqual(columnPhase(['new'], 0, 4), { phase: 'todo', started: false })
  assert.deepEqual(columnPhase(['indeterminate', 'indeterminate'], 1, 4), { phase: 'doing', started: true })
  assert.deepEqual(columnPhase(['indeterminate', 'new'], 1, 4), { phase: 'doing', started: false })
  assert.deepEqual(columnPhase(['', ''], 3, 4), { phase: 'done', started: false })
  const meta = parseMeta(BOARD_CONFIG, STATUSES)
  assert.equal(startedColumn(meta.columns)?.name, 'In Progress')
  // "Selected for Development" is still to do, so started is the one after it.
  const withSelected = parseMeta(
    { columnConfig: { columns: [{ name: 'Backlog', statuses: [{ id: '1' }] }, { name: 'Selected', statuses: [{ id: '9' }] }, ...BOARD_CONFIG.columnConfig.columns.slice(1)] } },
    STATUSES,
  )
  assert.equal(startedColumn(withSelected.columns)?.name, 'In Progress')
  // Without categories nothing is known to be started.
  assert.equal(startedColumn(parseMeta(BOARD_CONFIG, []).columns), undefined)
})

test('between sprints there is no sprint, but the next planned one', () => {
  const p = pickSprint([{ id: 9, name: 'Sprint 43', state: 'future', startDate: '2026-12-03' }])
  assert.equal(p.sprint, null)
  assert.equal(p.next?.name, 'Sprint 43')
})

test('the hand-off facts read the same for any tracker', () => {
  const meta = parseMeta(BOARD_CONFIG, STATUSES)
  const board = { id: '42', name: 'Payments', sprint: { id: '8', name: 'Sprint 42' }, others: [], columns: meta.columns, unassigned: [], mine: [] }
  const ticket = { key: 'ENG-1', title: 't', url: 'https://acme.atlassian.net/browse/ENG-1', column: '0', type: 'story', updated: '' }
  const f = handoffFacts('jira', 'https://acme.atlassian.net', ticket, { id: 'me-1', name: 'Me' }, board)
  assert.deepEqual(factLines(f), [
    'Ticket: ENG-1 (jira)',
    'Link: https://acme.atlassian.net/browse/ENG-1',
    'Site: https://acme.atlassian.net',
    'Assign to: account me-1 (Me)',
    'Unassigned: yes',
    'Started column: In Progress (status ids 3)',
    'Board: Payments, Sprint 42',
  ])
})
