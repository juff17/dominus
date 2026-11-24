// The words the Tickets popup, Settings and the agent hand-off use, and the
// one thing that knows a tracker's own: an adapter. Jira is the only one
// today (jira.ts); another tracker is another adapter filling these types.

// Where a column sits in the flow, from its statuses' categories (Jira's
// new / indeterminate / done).
export type Phase = 'todo' | 'doing' | 'done'

// started: every status in it means work has begun, so an agent may move a
// ticket here (tracker.started below picks one).
export type Column = { id: string; name: string; phase: Phase; statusIds: string[]; started: boolean }

export type Person = { id: string; name: string }

export type Ticket = {
  key: string
  title: string
  url: string
  // Column.id
  column: string
  type: string
  priority?: string
  points?: number
  parent?: string
  assignee?: Person
  // ISO time
  updated: string
}

export type Sprint = { id: string; name: string; ends?: string; starts?: string }

// sprint is null between sprints; next is the earliest planned one then.
// others are active sprints the board also has, which it doesn't show.
export type Board = {
  id: string
  name: string
  sprint: Sprint | null
  next?: Sprint
  others: string[]
  columns: Column[]
  unassigned: Ticket[]
  mine: Ticket[]
}

export type BoardChoice = { id: string; name: string; project: string }

// What went wrong, as the popup shows it: a setting or .env value missing,
// the token refused, the tracker asking us to wait, anything else.
export type Why = 'missing' | 'auth' | 'limited' | 'failed'
export type Failure = { ok: false; why: Why; err: string; retryAfter?: number; status?: number }
export type Result<T> = { ok: true; value: T } | Failure

// What an agent is told about its ticket: the same fields from any tracker,
// so the prompt and the skill read only these.
export type HandoffFacts = {
  provider: string
  key: string
  url: string
  site: string
  assignee: Person
  unassigned: boolean
  started: { name: string; statusIds: string[] } | null
  board: string
  sprint: string
}

export type Tracker = {
  id: string
  me(): Promise<Result<Person>>
  board(opts?: { fresh?: boolean; reconcile?: string[] }): Promise<Result<Board>>
  boards(name: string): Promise<Result<BoardChoice[]>>
}

// The column an agent may move a ticket to: the first one after the last
// to-do column, when all of its statuses mean started.
export function startedColumn(columns: readonly Column[]): Column | undefined {
  let last = -1
  columns.forEach((c, i) => {
    if (c.phase === 'todo') last = i
  })
  const next = columns[last + 1]
  return next?.started ? next : undefined
}

export function handoffFacts(provider: string, site: string, ticket: Ticket, me: Person, board: Board): HandoffFacts {
  const started = startedColumn(board.columns)
  return {
    provider,
    key: ticket.key,
    url: ticket.url,
    site,
    assignee: me,
    unassigned: !ticket.assignee,
    started: started ? { name: started.name, statusIds: started.statusIds } : null,
    board: board.name,
    sprint: board.sprint?.name ?? '',
  }
}

// The facts as the lines the hub puts in the agent's prompt; the
// ticket-work skill reads them by these labels.
export const factLines = (f: HandoffFacts): string[] => [
  `Ticket: ${f.key} (${f.provider})`,
  `Link: ${f.url}`,
  `Site: ${f.site}`,
  `Assign to: account ${f.assignee.id} (${f.assignee.name})`,
  `Unassigned: ${f.unassigned ? 'yes' : 'no'}`,
  f.started ? `Started column: ${f.started.name} (status ids ${f.started.statusIds.join(', ')})` : 'Started column: none found',
  `Board: ${f.board}${f.sprint ? `, ${f.sprint}` : ''}`,
]
