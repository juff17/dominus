// The only code that knows Jira. It reads, never writes: agents make the
// two writes a ticket gets (assign, one move) through the Atlassian MCP.
//
// A scoped token works only through the api.atlassian.com gateway, which
// needs the site's cloud id; a classic one works on the site itself. Every
// value the token touches stays in this module: it goes in a header and is
// never logged, thrown or returned.

import { isRecord } from '../../core/json.ts'
import { errorMessage, type Logger } from '../../core/log.ts'
import type { Board, BoardChoice, Column, Failure, Person, Phase, Sprint, Ticket, Tracker, Why } from './tracker.ts'

export type JiraConfig = {
  site: string
  email: string
  token: string
  kind: 'scoped' | 'classic'
  // '' until tenant_info is asked once.
  cloudId: string
  boardId: string
  // A Team field UUID, for a board several teams share; '' for none.
  teamId: string
}

// The part of fetch this uses, so tests pass their own.
export type FetchLike = (
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>

export type JiraOptions = {
  config: JiraConfig
  fetch: FetchLike
  log: Pick<Logger, 'debug' | 'info' | 'warn'>
  timeoutMs?: number
  now?: () => number
  // How long the board's columns and sprint are kept before asking again.
  metaMs?: number
  // Called once tenant_info has answered, so the cloud id can be saved.
  onCloudId?: (id: string) => void
}

class JiraFailed extends Error {
  readonly why: Why
  readonly status?: number
  readonly retryAfter?: number
  constructor(why: Why, message: string, status?: number, retryAfter?: number) {
    super(message)
    this.why = why
    this.status = status
    this.retryAfter = retryAfter
  }
}

const fail = (e: unknown): Failure =>
  e instanceof JiraFailed ? { ok: false, why: e.why, err: e.message, status: e.status, retryAfter: e.retryAfter } : { ok: false, why: 'failed', err: errorMessage(e) }

const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {})
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

export const trimSite = (site: string): string => site.trim().replace(/\/+$/, '')
export const browseUrl = (site: string, key: string): string => `${trimSite(site)}/browse/${encodeURIComponent(key)}`

// Jira's three status categories, as the popup's phases.
const PHASE: Record<string, Phase> = { new: 'todo', indeterminate: 'doing', done: 'done' }

// A column's phase from its statuses' categories; with none known, from
// where it sits (first is to do, last is done).
export function columnPhase(categories: string[], index: number, count: number): { phase: Phase; started: boolean } {
  const known = categories.filter(c => c in PHASE)
  if (known.length) {
    const all = (c: string) => known.every(k => k === c)
    const phase: Phase = all('new') ? 'todo' : all('done') ? 'done' : 'doing'
    return { phase, started: known.length === categories.length && all('indeterminate') }
  }
  const phase: Phase = index === 0 ? 'todo' : index === count - 1 ? 'done' : 'doing'
  return { phase, started: false }
}

export type BoardMeta = { name: string; columns: Column[]; pointsField: string }

// The board's configuration and every status's category, as columns.
export function parseMeta(config: unknown, statuses: unknown): BoardMeta {
  const cat = new Map<string, string>()
  for (const s of list(statuses)) cat.set(str(rec(s).id), str(rec(rec(s).statusCategory).key))
  const cols = list(rec(rec(config).columnConfig).columns)
  const columns = cols.map((c, i): Column => {
    const statusIds = list(rec(c).statuses).map(s => str(rec(s).id)).filter(Boolean)
    const { phase, started } = columnPhase(
      statusIds.map(id => cat.get(id) ?? ''),
      i,
      cols.length,
    )
    return { id: String(i), name: str(rec(c).name) || '?', phase, statusIds, started }
  })
  return { name: str(rec(config).name), columns, pointsField: str(rec(rec(rec(config).estimation).field).fieldId) }
}

const sprintOf = (s: unknown): Sprint => ({ id: str(rec(s).id), name: str(rec(s).name), ends: str(rec(s).endDate) || undefined, starts: str(rec(s).startDate) || undefined })

// The newest active sprint, the names of any others running beside it, and
// the next planned one.
export function pickSprint(values: unknown): { sprint: Sprint | null; others: string[]; next?: Sprint } {
  const all = list(values).map(s => ({ s: sprintOf(s), state: str(rec(s).state) }))
  const active = all
    .filter(x => x.state === 'active')
    .map(x => x.s)
    .sort((a, b) => (b.starts ?? '').localeCompare(a.starts ?? ''))
  const future = all
    .filter(x => x.state === 'future')
    .map(x => x.s)
    .sort((a, b) => (a.starts ?? '9').localeCompare(b.starts ?? '9'))
  return { sprint: active[0] ?? null, others: active.slice(1).map(s => s.name), next: future[0] }
}

export function parseTicket(issue: unknown, site: string, columns: readonly Column[], pointsField: string): Ticket | null {
  const i = rec(issue)
  const f = rec(i.fields)
  const key = str(i.key)
  const statusId = str(rec(f.status).id)
  const column = columns.find(c => c.statusIds.includes(statusId))
  // A status in no column is hidden on Jira's board, so here too.
  if (!key || !column) return null
  const a = rec(f.assignee)
  const points = pointsField ? f[pointsField] : undefined
  return {
    key,
    title: str(f.summary),
    url: browseUrl(site, key),
    column: column.id,
    type: str(rec(f.issuetype).name).toLowerCase(),
    priority: str(rec(f.priority).name) || undefined,
    points: typeof points === 'number' ? points : undefined,
    parent: str(rec(rec(f.parent).fields).summary) || undefined,
    assignee: str(a.accountId) ? { id: str(a.accountId), name: str(a.displayName) } : undefined,
    updated: str(f.updated),
  }
}

// A description in Atlassian Document Format as plain text: each block on a
// line of its own, a mention or link as the text it shows.
const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'tableRow', 'rule'])
export function adfText(node: unknown): string {
  if (typeof node === 'string') return node.trim()
  const out: string[] = []
  const walk = (n: unknown): void => {
    const r = rec(n)
    const type = str(r.type)
    if (type === 'text') out.push(str(r.text))
    else if (type === 'hardBreak') out.push('\n')
    else if (type === 'mention' || type === 'emoji') out.push(str(rec(r.attrs).text))
    else if (type === 'inlineCard' || type === 'blockCard') out.push(str(rec(r.attrs).url))
    for (const c of list(r.content)) walk(c)
    if (BLOCKS.has(type)) out.push('\n')
  }
  walk(node)
  return out.join('').replace(/\n{3,}/g, '\n\n').trim()
}

// The scout reads the description, so a long one is cut rather than sent whole.
export const DESCRIPTION_MAX = 6000

export const ISSUE_FIELDS = ['summary', 'status', 'assignee', 'priority', 'issuetype', 'updated', 'parent']

export function sprintJql(teamId: string): string {
  const who = '(assignee is EMPTY OR assignee = currentUser())'
  return teamId ? `${who} AND "Team[Team]" = ${teamId}` : who
}

const basic = (email: string, token: string): string => `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`

export function jiraClient({ config, fetch, log, timeoutMs = 10000, now = Date.now, metaMs = 15 * 60 * 1000, onCloudId }: JiraOptions): Tracker & {
  base(): Promise<string>
} {
  const site = trimSite(config.site)
  let cloudId = config.cloudId
  let me: Person | null = null
  let meta: { at: number; value: BoardMeta & ReturnType<typeof pickSprint> } | null = null

  async function call(url: string, auth = true): Promise<unknown> {
    const signal = AbortSignal.timeout(timeoutMs)
    const path = url.replace(/^https:\/\/[^/]+/, '')
    let r: Awaited<ReturnType<FetchLike>>
    try {
      r = await fetch(url, { headers: { Accept: 'application/json', ...(auth ? { Authorization: basic(config.email, config.token) } : {}) }, signal })
    } catch (e) {
      throw new JiraFailed('failed', e instanceof Error && e.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000} s` : errorMessage(e))
    }
    if (r.status === 401 || r.status === 403) throw new JiraFailed('auth', `HTTP ${r.status} on ${path.split('?')[0]}`, r.status)
    if (r.status === 429) {
      const after = Number(r.headers.get('Retry-After'))
      throw new JiraFailed('limited', 'HTTP 429', 429, Number.isFinite(after) && after > 0 ? after : 30)
    }
    if (!r.ok) throw new JiraFailed('failed', `HTTP ${r.status} on ${path.split('?')[0]}`, r.status)
    const body = await r.text()
    try {
      return body ? JSON.parse(body) : null
    } catch {
      throw new JiraFailed('failed', `not JSON from ${path.split('?')[0]}`, r.status)
    }
  }

  // Calls made at once share the one tenant_info lookup; a failed one is
  // asked again next time.
  let asking: Promise<string> | null = null
  async function base(): Promise<string> {
    if (config.kind === 'classic') return site
    if (!cloudId) {
      asking ??= call(`${site}/_edge/tenant_info`, false).then(v => {
        const id = str(rec(v).cloudId)
        if (!id) throw new JiraFailed('failed', 'no cloud id from tenant_info')
        cloudId = id
        onCloudId?.(id)
        return id
      })
      try {
        await asking
      } finally {
        asking = null
      }
    }
    return `https://api.atlassian.com/ex/jira/${cloudId}`
  }

  const missing = (): Failure | null => {
    const gone = [!site && 'JIRA_SITE', !config.email && 'JIRA_EMAIL', !config.token && 'JIRA_API_TOKEN'].filter(Boolean)
    return gone.length ? { ok: false, why: 'missing', err: gone.join(', ') } : null
  }

  async function whoami(): Promise<Person> {
    if (me) return me
    const v = rec(await call(`${await base()}/rest/api/3/myself`))
    me = { id: str(v.accountId), name: str(v.displayName) }
    return me
  }

  async function boardMeta(fresh: boolean) {
    if (!fresh && meta && now() - meta.at < metaMs) return meta.value
    const b = await base()
    const id = encodeURIComponent(config.boardId)
    const [conf, statuses, sprints] = await Promise.all([
      call(`${b}/rest/agile/1.0/board/${id}/configuration`),
      // Without categories a column's phase falls back to where it sits.
      call(`${b}/rest/api/3/status`).catch((e: unknown) => {
        log.debug('statuses not fetched', { err: errorMessage(e) })
        return []
      }),
      call(`${b}/rest/agile/1.0/board/${id}/sprint?state=active,future&maxResults=50`),
    ])
    const value = { ...parseMeta(conf, statuses), ...pickSprint(rec(sprints).values) }
    meta = { at: now(), value }
    return value
  }

  // The new paged endpoint, or the agile one where a site doesn't have it yet.
  async function sprintIssues(sprintId: string, fields: string[], reconcile: string[]): Promise<unknown[]> {
    const b = await base()
    const q = (extra: Record<string, string>) =>
      new URLSearchParams({ jql: sprintJql(config.teamId), fields: fields.join(','), maxResults: '100', ...(reconcile.length ? { reconcileIssues: reconcile.join(',') } : {}), ...extra }).toString()
    const path = `board/${encodeURIComponent(config.boardId)}/sprint/${encodeURIComponent(sprintId)}/issue`
    const out: unknown[] = []
    try {
      let token = ''
      for (let page = 0; page < 20; page++) {
        const v = rec(await call(`${b}/rest/software/1.0/${path}?${q(token ? { nextPageToken: token } : {})}`))
        out.push(...list(v.issues))
        token = str(v.nextPageToken)
        if (!token || v.isLast === true) return out
      }
      return out
    } catch (e) {
      if (!(e instanceof JiraFailed && e.status === 404)) throw e
      log.debug('software endpoint missing', { path })
    }
    out.length = 0
    for (let at = 0, page = 0; page < 20; page++) {
      const v = rec(await call(`${b}/rest/agile/1.0/${path}?${q({ startAt: String(at) })}`))
      const issues = list(v.issues)
      out.push(...issues)
      at += issues.length
      if (!issues.length || at >= Number(v.total ?? 0)) break
    }
    return out
  }

  return {
    id: 'jira',
    base,
    async me() {
      const gone = missing()
      if (gone) return gone
      try {
        return { ok: true, value: await whoami() }
      } catch (e) {
        log.warn('me not fetched', { err: errorMessage(e) })
        return fail(e)
      }
    },
    async details(key) {
      const gone = missing()
      if (gone) return gone
      try {
        const v = rec(await call(`${await base()}/rest/api/3/issue/${encodeURIComponent(key)}?fields=description,components,labels`))
        const f = rec(v.fields)
        return {
          ok: true,
          value: {
            description: adfText(f.description).slice(0, DESCRIPTION_MAX),
            components: list(f.components).map(c => str(rec(c).name)).filter(Boolean),
            labels: list(f.labels).map(str).filter(Boolean),
          },
        }
      } catch (e) {
        const f = fail(e)
        log.warn('ticket details not fetched', { id: key, why: f.why, err: f.err })
        return f
      }
    },
    async boards(name) {
      const gone = missing()
      if (gone) return gone
      try {
        const q = new URLSearchParams({ type: 'scrum', maxResults: '50', ...(name.trim() ? { name: name.trim() } : {}) })
        const v = rec(await call(`${await base()}/rest/agile/1.0/board?${q}`))
        const value: BoardChoice[] = list(v.values).map(x => ({ id: str(rec(x).id), name: str(rec(x).name), project: str(rec(rec(x).location).projectKey) }))
        log.info('boards found', { n: value.length })
        return { ok: true, value }
      } catch (e) {
        log.warn('boards not found', { err: errorMessage(e) })
        return fail(e)
      }
    },
    async board({ fresh = false, reconcile = [] } = {}) {
      const gone = missing() ?? (config.boardId ? null : { ok: false as const, why: 'missing' as const, err: 'board' })
      if (gone) return gone
      const started = now()
      log.debug('board fetch start', { board: config.boardId, fresh })
      try {
        const [who, m] = await Promise.all([whoami(), boardMeta(fresh)])
        const fields = [...ISSUE_FIELDS, ...(m.pointsField ? [m.pointsField] : [])]
        const issues = m.sprint ? await sprintIssues(m.sprint.id, fields, reconcile) : []
        const tickets = issues.map(i => parseTicket(i, site, m.columns, m.pointsField)).filter((x): x is Ticket => x !== null)
        const board: Board = {
          id: config.boardId,
          name: m.name,
          sprint: m.sprint,
          next: m.next,
          others: m.others,
          columns: m.columns,
          unassigned: tickets.filter(x => !x.assignee),
          mine: tickets.filter(x => x.assignee?.id === who.id),
        }
        log.info('board fetched', { ms: now() - started, n: tickets.length, sprint: m.sprint?.name ?? '' })
        return { ok: true, value: board }
      } catch (e) {
        const f = fail(e)
        log.warn('board not fetched', { ms: now() - started, why: f.why, err: f.err })
        return f
      }
    },
  }
}
