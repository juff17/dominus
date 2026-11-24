import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Agent } from '../../agents/model.ts'
import { columnsShown, frame, shortDate, title } from './draw.ts'
import { type Setup, type TicketsState, onKey, setBoard, start } from './state.ts'
import { BOARD } from './fixtures.test.ts'
import type { Board } from './tracker.ts'

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*[mGX]/g, '')
const text = (lines: string[]): string => lines.map(plain).join('\n')
const NOW = Date.parse('2026-11-22T12:00:00Z')
const SIZE = { cols: 140, rows: 40 }

const ready: Setup = { env: { JIRA_SITE: true, JIRA_EMAIL: true, JIRA_API_TOKEN: true, JIRA_TOKEN_KIND: false }, board: '42', team: 'Payments', mcp: true, check: { state: 'ok', name: 'Me' } }
const prefs = { showDone: false, folder: '~/projects', model: 'opus', effort: 'medium' }

const boardState = (b: Board = BOARD): TicketsState => {
  const s = start(ready, prefs)
  setBoard(s, structuredClone(b), NOW - 12_000)
  return s
}

test('every line is the frame’s width, and the last is the footer', () => {
  const f = frame(boardState(), SIZE, NOW)
  assert.equal(f.lines.length, SIZE.rows)
  for (const l of f.lines) assert.equal([...plain(l)].length <= SIZE.cols, true)
  assert.match(plain(f.lines.at(-1) ?? ''), /o\sopen\s+a\sagent/)
})

test('the board draws both lanes in Jira’s columns, its cards, and Done as a count', () => {
  const out = text(frame(boardState(), SIZE, NOW).lines)
  assert.match(out, /Unassigned {2}4/)
  assert.match(out, /Mine {2}2/)
  for (const name of ['To Do', 'In Progress', 'In Review', 'Done']) assert.ok(out.includes(name), name)
  assert.match(out, /╭─ ENG-1 story ─+ 2h ─╮/)
  assert.match(out, /ENG-1 title/)
  assert.match(out, /✓ 1 done · hidden/)
  assert.doesNotMatch(out, /ENG-9 title/)
  assert.match(out, /updated 12s ago/)
})

test('a linked agent shows on its card in the hub’s words, and an ended one says so', () => {
  const s = boardState()
  s.links = { 'ENG-4': { name: 'eng-4', at: 1 }, 'ENG-5': { name: 'eng-5', at: 1 } }
  s.agents = [{ kind: 'bg', title: 'eng-4', state: 'needs', cmd: 'which repo?' } as Agent]
  const out = text(frame(s, SIZE, NOW).lines)
  assert.match(out, /▲ Needs you · which repo\?/)
  assert.match(out, /○ ended · a starts a new agent/)
})

test('the confirm names the ticket, folder, model and effort', () => {
  const s = boardState()
  onKey(s, 'a')
  assert.match(plain(frame(s, SIZE, NOW).lines.at(-1) ?? ''), /Start an agent on ENG-1 in ~\/projects \(opus · medium\)\?.*y\sstart\s+n\scancel/)
})

test('at most 6 columns show, never under 24 cells, and the focused one stays in view', () => {
  assert.deepEqual(columnsShown(8, 200, 0, 0), { n: 6, w: 31, first: 0 })
  assert.equal(columnsShown(4, 80, 0, 0).n, 3)
  assert.deepEqual(columnsShown(8, 200, 7, 0).first, 2)
  assert.ok(columnsShown(4, 80, 0, 0).w >= 24)
})

test('more columns than fit say how many are hidden on each side', () => {
  const many: Board = { ...structuredClone(BOARD), columns: Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: `Col ${i}`, phase: 'doing' as const, statusIds: [], started: false })) }
  const s = boardState(many)
  s.col = 7
  const out = text(frame(s, { cols: 200, rows: 40 }, NOW).lines)
  assert.match(out, /‹ 2 more/)
  s.col = 0
  assert.match(text(frame(s, { cols: 200, rows: 40 }, NOW).lines), /2 more ›/)
})

test('a full column says how many more are below', () => {
  const full: Board = { ...structuredClone(BOARD), unassigned: Array.from({ length: 9 }, (_, i) => ({ ...BOARD.unassigned[0], key: `ENG-${10 + i}` })) }
  assert.match(text(frame(boardState(full), SIZE, NOW).lines), /▾ \d more/)
})

test('a window under 80 × 24 shows only what it needs', () => {
  const out = text(frame(boardState(), { cols: 70, rows: 18 }, NOW).lines)
  assert.match(out, /Window too small/)
  assert.match(out, /needs at least 80 × 24 cells\. This window is 72 × 20/)
})

test('setup lists what’s missing and the lines to add, never a value', () => {
  const s = start({ ...ready, env: { JIRA_SITE: true, JIRA_EMAIL: false, JIRA_API_TOKEN: false, JIRA_TOKEN_KIND: false }, board: '', mcp: false, check: { state: 'idle' } }, prefs)
  const out = text(frame(s, SIZE, NOW, '~/dominus/.env').lines)
  assert.match(out, /✓ JIRA_SITE +set in \.env/)
  assert.match(out, /✗ JIRA_API_TOKEN +not set in \.env/)
  assert.match(out, /✗ Team board +not chosen/)
  assert.match(out, /! Atlassian MCP/)
  assert.match(out, /read:board-scope\.admin:jira-software/)
  assert.match(out, /~\/dominus\/\.env/)
})

test('a refused token keeps the board and says why', () => {
  const s = boardState()
  s.fetch = { state: 'failed', why: 'auth', err: 'HTTP 401 on /rest/api/3/myself', at: NOW }
  const out = text(frame(s, SIZE, NOW).lines)
  assert.match(out, /Jira refused the token \(HTTP 401/)
  assert.match(out, /board from 12s ago/)
  assert.match(out, /ENG-1 title/)
})

test('between sprints the board says so and names the next one', () => {
  const none: Board = { ...structuredClone(BOARD), sprint: null, next: { id: '9', name: 'Sprint 43', starts: '2026-12-03T00:00:00Z' }, unassigned: [], mine: [] }
  const out = text(frame(boardState(none), SIZE, NOW).lines)
  assert.match(out, /Payments has no active sprint/)
  assert.match(out, /Sprint 43, is planned to start 2026-12-03/)
})

test('the title names the team, the sprint and when it ends, and any other active sprint', () => {
  assert.deepEqual(title(boardState()), ['Tickets', 'Payments', 'Sprint 42', 'ends Dec 2', ''])
  assert.equal(shortDate('2026-12-02T00:00:00Z'), 'Dec 2')
  const two = boardState({ ...structuredClone(BOARD), others: ['Hotfix'] })
  assert.equal((title(two) as string[]).at(-1), 'also active: Hotfix, not shown')
})
