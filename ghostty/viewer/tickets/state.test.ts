import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Agent } from '../../agents/model.ts'
import { type Setup, type TicketsState, agentOf, missing, onKey, screenFor, selected, setBoard, start } from './state.ts'
import { BOARD, tk } from './fixtures.test.ts'

const ready: Setup = { env: { JIRA_SITE: true, JIRA_EMAIL: true, JIRA_API_TOKEN: true, JIRA_TOKEN_KIND: false }, board: '42', team: 'Payments', mcp: true, check: { state: 'ok', name: 'Me' } }
const prefs = { showDone: false, folder: '~/projects', model: 'opus', effort: 'medium' }

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

test('a asks y/n before starting, and n or any other key cancels', () => {
  const s = boardState()
  assert.equal(onKey(s, 'a'), null)
  assert.deepEqual(s.confirm, { key: 'ENG-1' })
  const act = onKey(s, 'y')
  assert.equal(act?.do, 'start')
  assert.equal(act?.do === 'start' && act.ticket.key, 'ENG-1')
  onKey(s, 'a')
  assert.equal(onKey(s, 'n'), null)
  assert.equal(s.confirm, null)
})

test('a ticket with a live agent goes to it rather than starting a second', () => {
  const s = boardState()
  const agent = { kind: 'bg', title: 'ENG-1-eng-1-title', state: 'working' } as Agent
  s.links = { 'ENG-1': { name: 'ENG-1-eng-1-title', at: 1 } }
  s.agents = [agent]
  assert.equal(agentOf(s, 'ENG-1'), agent)
  assert.deepEqual(onKey(s, 'a'), { do: 'go', agent, key: 'ENG-1' })
  assert.deepEqual(onKey(s, '\r'), { do: 'go', agent, key: 'ENG-1' })
  s.agents = []
  assert.equal(agentOf(s, 'ENG-1'), null)
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
