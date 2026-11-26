// The board the tickets tests draw and move around; no tests of its own.
import type { Prefs } from './state.ts'
import type { Board, Ticket } from './tracker.ts'

const run = { model: 'opus', effort: 'medium' }
export const prefsAt = (folder: string): Prefs => ({ showDone: false, folder, roles: { work: run, review: { model: 'opus', effort: 'high' }, test: run } })

export const tk = (key: string, column: string, assignee = false): Ticket => ({
  key,
  title: `${key} title`,
  url: `https://acme.atlassian.net/browse/${key}`,
  column,
  type: 'story',
  updated: '2026-11-22T10:00:00Z',
  ...(assignee ? { assignee: { id: 'me-1', name: 'Me' } } : {}),
})

export const BOARD: Board = {
  id: '42',
  name: 'Payments',
  sprint: { id: '8', name: 'Sprint 42', ends: '2026-12-02T00:00:00Z' },
  others: [],
  columns: [
    { id: '0', name: 'To Do', phase: 'todo', statusIds: ['1'], started: false },
    { id: '1', name: 'In Progress', phase: 'doing', statusIds: ['3'], started: true },
    { id: '2', name: 'In Review', phase: 'doing', statusIds: ['4'], started: false },
    { id: '3', name: 'Done', phase: 'done', statusIds: ['5'], started: false },
  ],
  unassigned: [tk('ENG-1', '0'), tk('ENG-2', '0'), tk('ENG-3', '1'), tk('ENG-9', '3')],
  mine: [tk('ENG-4', '1', true), tk('ENG-5', '2', true)],
}
