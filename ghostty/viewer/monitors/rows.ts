// Running's and PRs & MRs' rows, each matched to the other by the PR's
// address.

import type { Agent, MonitorState, StripMonitor } from '../../agents/model.ts'
import { monitorsOf } from '../../agents/model.ts'
import { type Proposal, sessionOf } from '../../tray/approvals.ts'
import type { ForgeId } from '../../core/forge.ts'
import type { HostResult, Pr } from './forge.ts'
import { HUB_PLUGIN, skillAt } from '../../core/hub-skills.ts'
import { parsePipeTarget, targetLabel } from './pipelines.ts'

// ------------------------------------------------------------ addresses

export const sameUrl = (url: string): string => url.trim().replace(/\/+$/, '').replace(/^http:/i, 'https:').toLowerCase()

export type PrRef = { forge: ForgeId; host: string; repo: string; number: number }

export function parsePrUrl(url: string): PrRef | null {
  const gh = /^https?:\/\/([^/]+)\/([^?#]+?)\/pull\/(\d+)/i.exec(url)
  if (gh) return { forge: 'gh', host: gh[1].toLowerCase(), repo: gh[2], number: Number(gh[3]) }
  const gl = /^https?:\/\/([^/]+)\/([^?#]+?)(?:\/-)?\/merge_requests\/(\d+)/i.exec(url)
  return gl ? { forge: 'gl', host: gl[1].toLowerCase(), repo: gl[2], number: Number(gl[3]) } : null
}

// Your own namespace is left off the repo.
export function refLabel(forge: ForgeId, repo: string, number: number, me = ''): string {
  const shown = me && repo.toLowerCase().startsWith(`${me.toLowerCase()}/`) ? repo.slice(me.length + 1) : repo
  return `${shown} ${forge === 'gh' ? '#' : '!'}${number}`
}

// The PR a pr-babysit monitor watches: watch_pr.py's first argument, else
// the address its session was started with (/dominus:pr-babysit <url>).
const PR_PROMPT = new RegExp(`/(?:${HUB_PLUGIN}:)?pr-babysit\\s+(https?://\\S+)`)
export function monitorUrl(m: Pick<StripMonitor<Agent>, 'kind' | 'command'> & { agent: Pick<Agent, 'prompt'> }): string {
  if (m.kind !== 'pr-babysit') return ''
  const arg = /watch_pr\.py\s+['"]?(https?:\/\/[^\s'"]+)/.exec(m.command)?.[1] ?? PR_PROMPT.exec(m.agent.prompt)?.[1] ?? ''
  return arg.replace(/[.,;]+$/, '')
}

// ------------------------------------------------------------ filtering

export const words = (query: string): string[] => query.toLowerCase().trim().split(/\s+/).filter(Boolean)

// Indexes are code points, not UTF-16 units.
export function hitsIn(text: string, ws: readonly string[]): number[] {
  const low = text.toLowerCase()
  const at = new Set<number>()
  for (const w of ws) {
    const i = low.indexOf(w)
    if (i < 0) continue
    const from = [...low.slice(0, i)].length
    for (let k = 0; k < [...w].length; k++) at.add(from + k)
  }
  return [...at].sort((a, b) => a - b)
}

export const matches = (fields: readonly string[], ws: readonly string[]): boolean => ws.every(w => fields.some(f => f.toLowerCase().includes(w)))

export const filtering = (query: string): boolean => words(query).length > 0

// ------------------------------------------------------------ Running rows

export type RunGroup = 'needs' | 'watching' | 'ended'
export const RUN_GROUPS: readonly RunGroup[] = ['needs', 'watching', 'ended']
export type MonitorKind = 'pr' | 'pipe' | 'logs' | 'other'

// A row for proposals with no monitor to wait under. left: their session's
// monitor ended and left Running, the session still there. gone: their
// session isn't known at all; agentd drops them a minute after it ended
// (agents/orphans.ts).
export type StandIn = 'left' | 'gone'

// `match` holds the names a just-started monitor is found by (matchUrl,
// matchTarget, matchName). A stand-in's monitor is made up from its
// proposals, so the list draws it like the rest.
export type RunRow = {
  key: string
  m: StripMonitor<Agent>
  group: RunGroup
  kind: MonitorKind
  url: string
  forge: ForgeId | ''
  target: string
  pr: Pr | null
  pipeTarget: string
  match: string[]
  hit: number[]
  waits: Proposal[]
  standIn?: StandIn
}

const GROUP: Record<MonitorState, RunGroup> = { action: 'needs', watching: 'watching', stale: 'watching', ended: 'ended' }
// logger is log-watcher's old name, which monitors started before the
// rename still carry.
const KIND: Record<string, MonitorKind> = { 'pr-babysit': 'pr', 'pipeline-watch': 'pipe', 'log-watcher': 'logs', logger: 'logs' }
// For a monitor whose command classify.ts doesn't know.
const SKILL_KIND: [RegExp, MonitorKind][] = [
  [new RegExp(skillAt('pr-babysit')), 'pr'],
  [new RegExp(skillAt('pipeline-watch')), 'pipe'],
  [new RegExp(skillAt('log-watcher|logger')), 'logs'],
]
export const kindOf = (m: Pick<StripMonitor<Agent>, 'kind'> & { agent: Pick<Agent, 'prompt'> }): MonitorKind =>
  KIND[m.kind] ?? SKILL_KIND.find(([re]) => re.test(m.agent.prompt.trim()))?.[1] ?? 'other'

const PIPE_PROMPT = new RegExp(`${skillAt('pipeline-watch')}\\s+(\\S+)`)
export const pipeTargetOf = (prompt: string): string => PIPE_PROMPT.exec(prompt.trim())?.[1] ?? ''

// Names a started monitor is looked for by.
export const matchUrl = (url: string): string => sameUrl(url)
export const matchTarget = (target: string): string => `target:${target.trim().toLowerCase()}`
export const matchName = (name: string): string => `name:${name}`
const RANK: Record<MonitorState, number> = { action: 0, watching: 1, stale: 2, ended: 3 }

export function prIndex(hosts: readonly HostResult[]): Map<string, { pr: Pr; me: string }> {
  return new Map(hosts.flatMap(h => h.prs.map(pr => [sameUrl(pr.url), { pr, me: h.me }] as const)))
}

// ------------------------------------------------------------ proposals

// Of the monitors of the session that wrote it (sessionOf, as the tray
// ties a proposal to its agent), the one watching the proposal's PR, else
// its first pr-babysit one, else its first.
export function monitorFor<M extends StripMonitor<Agent>>(p: Proposal, agents: readonly Agent[], monitors: readonly M[]): M | null {
  const a = sessionOf(p, agents)
  if (!a) return null
  const own = monitors.filter(m => m.agent.id === a.id)
  const url = p.pr?.url ? sameUrl(p.pr.url) : ''
  return own.find(m => url && sameUrl(monitorUrl(m)) === url) ?? own.find(m => m.kind === 'pr-babysit') ?? own[0] ?? null
}

// Gathered by their session when it's known, else by their PR, else each
// on its own.
type Alone = { standIn: StandIn; agent: Agent | null; ps: Proposal[] }

function placeProposals(proposals: readonly Proposal[], agents: readonly Agent[], monitors: readonly StripMonitor<Agent>[]) {
  const waits = new Map<string, Proposal[]>()
  const alone = new Map<string, Alone>()
  for (const p of proposals) {
    const m = monitorFor(p, agents, monitors)
    if (m) {
      waits.set(m.key, [...(waits.get(m.key) ?? []), p])
      continue
    }
    const agent = sessionOf(p, agents) ?? null
    const key = agent ? `left:${agent.id}` : `gone:${p.pr?.url ? sameUrl(p.pr.url) : p.id}`
    const had = alone.get(key)
    if (had) had.ps.push(p)
    else alone.set(key, { standIn: agent ? 'left' : 'gone', agent, ps: [p] })
  }
  return { waits, alone }
}

function unknownSession(p: Proposal, at: number): Agent {
  return {
    id: '',
    pid: 0,
    kind: 'bg',
    title: p.title ?? p.id,
    repo: p.pr?.repo ?? '',
    worktree: '',
    cwd: '',
    branch: '',
    state: 'needs',
    need: null,
    via: '',
    cmd: '',
    since: at,
    stateSince: at,
    prompt: '',
    ctx: 0,
    model: '',
    jobId: null,
    pane: null,
    monitor: false,
    monitors: [],
  }
}

type PrIndex = ReturnType<typeof prIndex>

function prName(ref: PrRef, url: string, index: PrIndex): { target: string; pr: Pr | null } {
  const known = index.get(sameUrl(url))
  if (known) return { target: refLabel(known.pr.forge, known.pr.repo, known.pr.number, known.me), pr: known.pr }
  return { target: refLabel(ref.forge, ref.repo.split('/').at(-1) ?? ref.repo, ref.number), pr: null }
}

function standInRow(key: string, { standIn, agent, ps }: Alone, index: PrIndex): RunRow {
  const first = ps[0]
  const at = Math.max(0, ...ps.map(p => p.at ?? 0))
  const url = first.pr?.url ?? ''
  const ref = url ? parsePrUrl(url) : null
  const named = ref ? prName(ref, url, index) : null
  const target = named?.target || `${first.pr?.repo ?? ''} ${first.pr?.ref ?? ''}`.trim() || (first.title ?? first.id)
  const left = standIn === 'left'
  const m: StripMonitor<Agent> = {
    key,
    task: '',
    description: first.title ?? '',
    kind: 'pr-babysit',
    command: '',
    state: left ? 'ended' : 'action',
    busy: false,
    event: null,
    startedAt: at,
    ended: left ? { reason: '', at } : null,
    agent: agent ?? unknownSession(first, at),
  }
  return { key, m, group: left ? 'ended' : 'needs', kind: 'pr', url, forge: ref?.forge ?? '', target, pr: named?.pr ?? null, pipeTarget: '', match: [], hit: [], waits: ps, standIn }
}

// ------------------------------------------------------------ Running

// A monitor with proposals waiting moves to Needs you unless it ended.
// Proposals with no monitor get a stand-in row, so none is out of reach.
export function runRows(agents: readonly Agent[], hosts: readonly HostResult[], query = '', proposals: readonly Proposal[] = []): RunRow[] {
  const index = prIndex(hosts)
  const ws = words(query)
  const monitors = monitorsOf(agents)
  const { waits, alone } = placeProposals(proposals, agents, monitors)
  const rows: RunRow[] = []
  for (const m of monitors) {
    const kind = kindOf(m)
    const pipeTarget = kind === 'pipe' ? pipeTargetOf(m.agent.prompt) : ''
    const pipe = pipeTarget ? parsePipeTarget(pipeTarget) : null
    const url = pipe ? pipe.url : monitorUrl(m)
    const ref = url && !pipe ? parsePrUrl(url) : null
    const named = ref ? prName(ref, url, index) : null
    const target = pipe ? targetLabel(pipe) : (named?.target ?? m.description)
    const fields = [target, m.description, m.event?.line ?? '', m.agent.repo, named?.pr?.title ?? '']
    if (ws.length && !matches(fields, ws)) continue
    const match = [...(url ? [matchUrl(url)] : []), ...(pipeTarget ? [matchTarget(pipeTarget)] : []), matchName(m.agent.title)]
    const own = waits.get(m.key) ?? []
    const group = own.length && m.state !== 'ended' ? 'needs' : GROUP[m.state]
    rows.push({ key: m.key, m, group, kind, url, forge: ref?.forge ?? pipe?.forge ?? '', target, pr: named?.pr ?? null, pipeTarget, match, hit: hitsIn(target, ws), waits: own })
  }
  for (const [key, a] of alone) {
    const r = standInRow(key, a, index)
    if (ws.length && !matches([r.target, r.m.agent.repo, ...a.ps.map(p => p.title ?? '')], ws)) continue
    rows.push({ ...r, hit: hitsIn(r.target, ws) })
  }
  // Waiting on you ranks with needing you.
  const rank = (r: RunRow): number => (r.waits.length && r.group !== 'ended' ? RANK.action : RANK[r.m.state])
  const order = (r: RunRow): number => RUN_GROUPS.indexOf(r.group) * 10 + rank(r)
  const latest = (r: RunRow): number => Math.max(r.m.event?.at ?? r.m.startedAt, ...r.waits.map(p => p.at ?? 0))
  return rows.sort((a, b) => order(a) - order(b) || latest(b) - latest(a))
}

// A row with proposals waiting counts under approve, not its state, unless
// it ended.
export type RunCounts = Record<MonitorState, number> & { approve: number }

export function groupCounts(rows: readonly RunRow[]): RunCounts {
  const c: RunCounts = { approve: 0, action: 0, watching: 0, stale: 0, ended: 0 }
  for (const r of rows) {
    c.approve += r.waits.length
    if (r.group === 'ended') c.ended++
    else if (!r.waits.length) c[r.m.state]++
  }
  return c
}

// Needing you wins over watching when two monitors watch one PR.
export function watchedPrs(rows: readonly RunRow[]): Map<string, MonitorState> {
  const out = new Map<string, MonitorState>()
  for (const r of rows) {
    if (!r.url || r.kind === 'pipe' || r.m.state === 'ended' || r.standIn) continue
    const key = sameUrl(r.url)
    const had = out.get(key)
    if (!had || RANK[r.m.state] < RANK[had]) out.set(key, r.m.state)
  }
  return out
}

// ------------------------------------------------------------ PRs & MRs

export type Role = 'mine' | 'reviewer'

export type PrRow = { pr: Pr; ref: string; monitor: MonitorState | null; hit: { ref: number[]; title: number[] } }

const inRole = (pr: Pr, role: Role): boolean => (role === 'mine' ? pr.mine : pr.review)

export function rolePrs(hosts: readonly HostResult[], role: Role, drafts: boolean): { pr: Pr; me: string }[] {
  return hosts
    .flatMap(h => h.prs.filter(pr => inRole(pr, role) && (drafts || !pr.draft)).map(pr => ({ pr, me: h.me })))
    .sort((a, b) => Number(a.pr.draft) - Number(b.pr.draft) || b.pr.createdAt - a.pr.createdAt)
}

export const roleCounts = (hosts: readonly HostResult[], drafts: boolean): Record<Role, number> => ({
  mine: rolePrs(hosts, 'mine', drafts).length,
  reviewer: rolePrs(hosts, 'reviewer', drafts).length,
})

export function prRows(hosts: readonly HostResult[], role: Role, drafts: boolean, query: string, watched: ReadonlyMap<string, MonitorState>): { rows: PrRow[]; hidden: number } {
  const ws = words(query)
  const all = rolePrs(hosts, role, drafts)
  const rows: PrRow[] = []
  for (const { pr, me } of all) {
    const ref = refLabel(pr.forge, pr.repo, pr.number, me)
    if (ws.length && !matches([ref, pr.repo, pr.title, pr.head], ws)) continue
    rows.push({ pr, ref, monitor: watched.get(sameUrl(pr.url)) ?? null, hit: { ref: hitsIn(ref, ws), title: hitsIn(pr.title, ws) } })
  }
  return { rows, hidden: all.length - rows.length }
}
