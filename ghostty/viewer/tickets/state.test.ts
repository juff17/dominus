import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Agent } from '../../agents/model.ts'
import { type Setup, type TicketsState, agentOf, agentsOf, missing, onKey, screenFor, selected, setBoard, start } from './state.ts'
import { BOARD, prefsAt, tk } from './fixtures.test.ts'

const ready: Setup = { env: { JIRA_SITE: true, JIRA_EMAIL: true, JIRA_API_TOKEN: true, JIRA_TOKEN_KIND: false }, board: '42', team: 'Payments', mcp: true, check: { state: 'ok', name: 'Me' } }
const prefs = prefsAt('~/projects')

const boardState = (): TicketsState => {
  const s = start(ready, prefs)
  setBoard(s, structuredClone(BOARD), 1000)
  return s
}

test('setup until the .env values and the board are there, then the board', () => {
  const s = start({ ...ready, env: { ...ready.env, JIRA_API_TOKEN: false }, board: '' }, prefs)
  assert.deepEqual(missing(s.setup), ['JIRA_API_TOKEN', 'board'])
  assert.equal(screenFor(s), 'setup')
  assert.equal(screenFor(start(ready, prefs)), 'board')
})

test('the cursor starts on the first unassigned card and moves by column, card and lane', () => {
  const s = boardState()
  assert.equal(selected(s)?.key, 'ENG-1')
  onKey(s, 'j')
  assert.equal(selected(s)?.key, 'ENG-2')
  onKey(s, 'l')
  assert.equal(selected(s)?.key, 'ENG-3')
  onKey(s, '\t')
  assert.equal(selected(s)?.key, 'ENG-4')
  onKey(s, 'l')
  assert.equal(selected(s)?.key, 'ENG-5')
  // Done is collapsed, so there is nowhere further right.
  onKey(s, 'l')
  assert.equal(selected(s)?.key, 'ENG-5')
})

test('o opens the ticket, and ↵ with no agent opens it too', () => {
  const s = boardState()
  assert.deepEqual(onKey(s, 'o'), { do: 'open', url: 'https://acme.atlassian.net/browse/ENG-1', key: 'ENG-1' })
  assert.deepEqual(onKey(s, '\r'), { do: 'open', url: 'https://acme.atlassian.net/browse/ENG-1', key: 'ENG-1' })
})

const started = (act: ReturnType<typeof onKey>) => (act?.do === 'start' ? { key: act.ticket.key, role: act.role, fix: act.fix } : act)

test('a asks for a role, then a worker asks y/n, and n or any other key cancels', () => {
  const s = boardState()
  assert.equal(onKey(s, 'a'), null)
  assert.deepEqual(s.confirm, { key: 'ENG-1', step: 'role' })
  assert.equal(onKey(s, 'w'), null)
  assert.deepEqual(s.confirm, { key: 'ENG-1', step: 'start', role: 'work' })
  assert.deepEqual(started(onKey(s, 'y')), { key: 'ENG-1', role: 'work', fix: true })
  onKey(s, 'a')
  onKey(s, 'w')
  assert.equal(onKey(s, 'n'), null)
  assert.equal(s.confirm, null)
  onKey(s, 'a')
  assert.equal(onKey(s, 'x'), null, 'a key that is no role cancels')
  assert.equal(s.confirm, null)
})

test('r and t start a reviewer or tester, asking fixes or feedback; ↵ takes fixes', () => {
  const s = boardState()
  assert.equal(onKey(s, 'r'), null)
  assert.deepEqual(s.confirm, { key: 'ENG-1', step: 'mode', role: 'review' })
  assert.deepEqual(started(onKey(s, 'o')), { key: 'ENG-1', role: 'review', fix: false })
  onKey(s, 't')
  assert.deepEqual(started(onKey(s, 'f')), { key: 'ENG-1', role: 'test', fix: true })
  onKey(s, 'a')
  onKey(s, 't')
  assert.deepEqual(started(onKey(s, '\r')), { key: 'ENG-1', role: 'test', fix: true })
  onKey(s, 'r')
  assert.equal(onKey(s, '\x1b'), null)
  assert.equal(s.confirm, null)
})

test('R refreshes, as r now starts a reviewer', () => {
  const s = boardState()
  assert.deepEqual(onKey(s, 'R'), { do: 'refresh' })
  assert.notDeepEqual(onKey(s, 'r'), { do: 'refresh' })
})

test('a role with a live agent goes to it rather than starting a second', () => {
  const s = boardState()
  const agent = { kind: 'bg', title: 'ENG-1-eng-1-title', state: 'working' } as Agent
  s.links = { 'ENG-1': { work: { name: 'ENG-1-eng-1-title', at: 1 } } }
  s.agents = [agent]
  assert.equal(agentOf(s, 'ENG-1'), agent)
  assert.deepEqual(onKey(s, 'w'), { do: 'go', agent, key: 'ENG-1' })
  onKey(s, 'a')
  assert.deepEqual(onKey(s, 'w'), { do: 'go', agent, key: 'ENG-1' })
  assert.deepEqual(onKey(s, '\r'), { do: 'go', agent, key: 'ENG-1' })
  // The worker being there doesn't stop a reviewer starting.
  onKey(s, 'r')
  assert.deepEqual(s.confirm, { key: 'ENG-1', step: 'mode', role: 'review' })
  s.confirm = null
  s.agents = []
  assert.equal(agentOf(s, 'ENG-1'), null)
})

test('↵ goes to the agent that needs you first', () => {
  const s = boardState()
  const worker = { kind: 'bg', title: 'w', state: 'working' } as Agent
  const tester = { kind: 'bg', title: 't', state: 'needs' } as Agent
  s.links = { 'ENG-1': { work: { name: 'w', at: 1 }, test: { name: 't', at: 2 } } }
  s.agents = [worker, tester]
  assert.deepEqual(agentsOf(s, 'ENG-1').map(a => a.role), ['test', 'work'])
  assert.deepEqual(onKey(s, '\r'), { do: 'go', agent: tester, key: 'ENG-1' })
})

test('a refresh keeps the cursor on the same ticket after it moves column and lane', () => {
  const s = boardState()
  const moved = structuredClone(BOARD)
  moved.unassigned = moved.unassigned.filter(x => x.key !== 'ENG-1')
  moved.mine = [{ ...tk('ENG-1', '1', true) }, ...moved.mine]
  setBoard(s, moved, 2000)
  assert.equal(s.lane, 1)
  assert.equal(selected(s)?.key, 'ENG-1')
})

test('the picker searches a changed name first, then ↵ picks', () => {
  const s = boardState()
  assert.deepEqual(onKey(s, 'b'), { do: 'search', query: 'Payments' })
  assert.equal(s.screen, 'picker')
  const p = s.picker
  assert.ok(p)
  Object.assign(p, { state: 'ok', boards: [{ id: '42', name: 'Payments', project: 'PAY' }, { id: '57', name: 'Payments Platform', project: 'PLAT' }] })
  onKey(s, 'j')
  assert.equal(p.query, 'Paymentsj')
  assert.deepEqual(onKey(s, '\r'), { do: 'search', query: 'Paymentsj' })
  Object.assign(p, { state: 'ok', boards: [{ id: '57', name: 'Payments Platform', project: 'PLAT' }] })
  assert.deepEqual(onKey(s, '\r'), { do: 'pick', board: { id: '57', name: 'Payments Platform', project: 'PLAT' }, query: 'Paymentsj' })
  onKey(s, '\x1b')
  assert.equal(s.screen, 'board')
})
