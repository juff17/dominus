// The Tickets popup's state and what each key does to it. Pure: what a key
// asks of the world comes back as an Act, which effects.ts carries out.

import type { Agent } from '../../agents/model.ts'
import type { Board, BoardChoice, Person, Ticket, Why } from './tracker.ts'
import { JIRA_NEEDED, type JiraKey } from '../../settings/env.ts'

// setup: something is missing, or the check is running. picker: choosing the
// board. board: the sprint.
export type Screen = 'setup' | 'picker' | 'board'
export type Tone = 'ok' | 'working' | 'warn' | 'bad' | 'sub'
export type Note = { text: string; tone: Tone }

// The setup screen's lines: each .env key, the board, the MCP, and the
// /myself check once the rest is there.
export type Setup = {
  env: Record<JiraKey, boolean>
  board: string
  team: string
  mcp: boolean | null
  check: { state: 'idle' | 'running' | 'ok' | 'failed'; name?: string; why?: Why; err?: string }
}

export type Picker = { query: string; searched: string; state: 'loading' | 'ok' | 'failed'; boards: BoardChoice[]; sel: number; err?: string; why?: Why }

// A ticket's agent: its session's name, which agentd lists as a bg agent's title.
export type Link = { name: string; at: number }

export type Fetch = { state: 'idle' | 'loading' | 'failed'; why?: Why; err?: string; retryAfter?: number; at: number }

export type Prefs = { showDone: boolean; folder: string; model: string; effort: string }

export type TicketsState = {
  screen: Screen
  setup: Setup
  picker: Picker | null
  board: Board | null
  me: Person | null
  // When the board shown was fetched, ms; 0 for never.
  fetchedAt: number
  fetch: Fetch
  // The lane (0 Unassigned, 1 Mine), the column and the card focused.
  lane: number
  col: number
  row: number
  // The first column shown, when they don't all fit.
  firstCol: number
  confirm: { key: string } | null
  note: Note | null
  links: Record<string, Link>
  agents: Agent[]
  prefs: Prefs
}

export type Act =
  | { do: 'open'; url: string; key: string }
  | { do: 'start'; ticket: Ticket }
  | { do: 'go'; agent: Agent; key: string }
  | { do: 'refresh' }
  | { do: 'settings' }
  | { do: 'env' }
  | { do: 'check' }
  | { do: 'search'; query: string }
  | { do: 'pick'; board: BoardChoice; query: string }
  | { do: 'quit' }

export const LANES = ['unassigned', 'mine'] as const

export function start(setup: Setup, prefs: Prefs): TicketsState {
  return {
    screen: 'setup',
    setup,
    picker: null,
    board: null,
    me: null,
    fetchedAt: 0,
    fetch: { state: 'idle', at: 0 },
    lane: 0,
    col: 0,
    row: 0,
    firstCol: 0,
    confirm: null,
    note: null,
    links: {},
    agents: [],
    prefs,
  }
}

// What's still needed before the board can show, by name: the .env keys, then
// the board.
export function missing(setup: Setup): string[] {
  const env = JIRA_NEEDED.filter(k => !setup.env[k])
  return [...env, ...(setup.board ? [] : ['board'])]
}

// The board shows once nothing's missing and the check passed or a board was
// shown before (the cache).
export function screenFor(s: TicketsState): Screen {
  if (s.picker) return 'picker'
  if (missing(s.setup).length) return 'setup'
  if (s.board || s.setup.check.state === 'ok') return 'board'
  return 'setup'
}

// A lane's tickets in one column, in the tracker's order.
export const laneTickets = (b: Board, lane: number): Ticket[] => (lane === 0 ? b.unassigned : b.mine)
export const columnTickets = (b: Board, lane: number, col: number): Ticket[] => {
  const id = b.columns[col]?.id
  return laneTickets(b, lane).filter(t => t.column === id)
}

// A Done column with Show Done off holds nothing to pick.
export const pickable = (s: TicketsState, col: number): boolean => !!s.board && (s.prefs.showDone || s.board.columns[col]?.phase !== 'done')

export function selected(s: TicketsState): Ticket | null {
  if (!s.board || !pickable(s, s.col)) return null
  return columnTickets(s.board, s.lane, s.col)[s.row] ?? null
}

// The agent linked to a ticket, as agentd lists it now; null when it has
// ended or there's none.
export function agentOf(s: Pick<TicketsState, 'links' | 'agents'>, key: string): Agent | null {
  const link = s.links[key]
  if (!link) return null
  return s.agents.find(a => a.kind === 'bg' && a.title === link.name) ?? null
}

// Keeps the focus on a ticket that's still there after a refresh, and in
// range otherwise.
export function clampFocus(s: TicketsState, keep?: string): void {
  const b = s.board
  if (!b) return
  if (keep) {
    for (const lane of [s.lane, 1 - s.lane]) {
      const t = laneTickets(b, lane).find(x => x.key === keep)
      if (!t) continue
      const col = b.columns.findIndex(c => c.id === t.column)
      s.lane = lane
      s.col = col
      s.row = columnTickets(b, lane, col).findIndex(x => x.key === keep)
      return
    }
  }
  s.col = Math.max(0, Math.min(b.columns.length - 1, s.col))
  const n = columnTickets(b, s.lane, s.col).length
  s.row = Math.max(0, Math.min(Math.max(0, n - 1), s.row))
}

// The first card on the board, Unassigned first: where the cursor starts.
export function firstCard(s: TicketsState): void {
  const b = s.board
  if (!b) return
  for (const lane of [0, 1])
    for (let col = 0; col < b.columns.length; col++)
      if (pickable(s, col) && columnTickets(b, lane, col).length) {
        s.lane = lane
        s.col = col
        s.row = 0
        return
      }
}

export function setBoard(s: TicketsState, board: Board, at: number): void {
  const keep = selected(s)?.key
  const first = !s.board
  s.board = board
  s.fetchedAt = at
  s.fetch = { state: 'idle', at }
  if (first && !keep) firstCard(s)
  else clampFocus(s, keep)
  s.screen = screenFor(s)
}

function move(s: TicketsState, dCol: number, dRow: number): void {
  const b = s.board
  if (!b) return
  if (dCol) {
    let col = s.col + dCol
    while (col >= 0 && col < b.columns.length && !pickable(s, col) && !columnTickets(b, s.lane, col).length) col += dCol
    if (col < 0 || col >= b.columns.length) return
    s.col = col
    s.row = Math.min(s.row, Math.max(0, columnTickets(b, s.lane, col).length - 1))
  }
  if (dRow) {
    const n = columnTickets(b, s.lane, s.col).length
    s.row = Math.max(0, Math.min(Math.max(0, n - 1), s.row + dRow))
  }
}

function switchLane(s: TicketsState): void {
  if (!s.board) return
  s.lane = 1 - s.lane
  s.row = Math.min(s.row, Math.max(0, columnTickets(s.board, s.lane, s.col).length - 1))
}

const LEFT = ['\x1b[D', 'h']
const RIGHT = ['\x1b[C', 'l']
const UP = ['\x1b[A', 'k']
const DOWN = ['\x1b[B', 'j']

function boardKey(s: TicketsState, key: string): Act | null {
  if (s.confirm) {
    const ticket = s.board && [...s.board.unassigned, ...s.board.mine].find(t => t.key === s.confirm?.key)
    s.confirm = null
    if ((key === 'y' || key === 'Y') && ticket) return { do: 'start', ticket }
    return null
  }
  if (LEFT.includes(key)) move(s, -1, 0)
  else if (RIGHT.includes(key)) move(s, 1, 0)
  else if (UP.includes(key)) move(s, 0, -1)
  else if (DOWN.includes(key)) move(s, 0, 1)
  else if (key === '\t' || key === '\x1b[Z') switchLane(s)
  else if (key === 'r') return { do: 'refresh' }
  else if (key === 's') return { do: 'settings' }
  else if (key === 'b') return openPicker(s)
  else if (key === 'q' || key === '\x1b') return { do: 'quit' }
  else {
    const t = selected(s)
    if (!t) return null
    const agent = agentOf(s, t.key)
    if (key === 'o') return { do: 'open', url: t.url, key: t.key }
    if (key === '\r') return agent ? { do: 'go', agent, key: t.key } : { do: 'open', url: t.url, key: t.key }
    if (key === 'a') {
      // One agent a ticket: a goes to the one it has.
      if (agent) return { do: 'go', agent, key: t.key }
      s.confirm = { key: t.key }
    }
  }
  return null
}

export function openPicker(s: TicketsState): Act {
  const query = s.setup.team
  s.picker = { query, searched: query, state: 'loading', boards: [], sel: 0 }
  s.screen = 'picker'
  return { do: 'search', query }
}

function pickerKey(s: TicketsState, key: string): Act | null {
  const p = s.picker
  if (!p) return null
  if (key === '\x1b') {
    s.picker = null
    s.screen = screenFor(s)
    return null
  }
  if (UP.slice(0, 1).includes(key)) p.sel = Math.max(0, p.sel - 1)
  else if (DOWN.slice(0, 1).includes(key)) p.sel = Math.min(Math.max(0, p.boards.length - 1), p.sel + 1)
  else if (key === '\r') {
    // A changed name searches first; ↵ again picks.
    if (p.query.trim() !== p.searched || p.state !== 'ok') {
      p.searched = p.query.trim()
      p.state = 'loading'
      p.sel = 0
      return { do: 'search', query: p.searched }
    }
    const board = p.boards[p.sel]
    if (board) return { do: 'pick', board, query: p.searched }
  } else if (key === '\x7f' || key === '\b') p.query = [...p.query].slice(0, -1).join('')
  else if ([...key].length === 1 && key >= ' ' && p.query.length < 100) p.query += key
  return null
}

function setupKey(s: TicketsState, key: string): Act | null {
  if (key === 'q' || key === '\x1b') return { do: 'quit' }
  if (key === 'e') return { do: 'env' }
  if (key === 's') return { do: 'settings' }
  if (key === 'r') return { do: 'check' }
  if (key === 'b' && !missing({ ...s.setup, board: 'x' }).length) return openPicker(s)
  if (key === '\r' && !missing(s.setup).length && s.setup.check.state === 'ok') {
    s.screen = 'board'
    return { do: 'refresh' }
  }
  return null
}

export function onKey(s: TicketsState, key: string): Act | null {
  s.note = null
  if (s.screen === 'picker') return pickerKey(s, key)
  if (s.screen === 'setup') return setupKey(s, key)
  return boardKey(s, key)
}

export function onPaste(s: TicketsState, text: string): void {
  if (s.screen === 'picker' && s.picker) s.picker.query = (s.picker.query + text.replace(/[\r\n\t]/g, ' ')).slice(0, 100)
}

// Whether Alt+J or a click outside may close it now: not mid-confirm.
export const mayClose = (s: TicketsState): boolean => !s.confirm
