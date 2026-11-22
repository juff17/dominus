// PRs & MRs from GitHub (gh) and GitLab (glab), read-only.
//
// GitHub is one GraphQL call per host. GitLab's GraphQL differs between
// versions, so it's REST: the user, two lists, then several calls per MR.

import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

import { type JsonRecord, isRecord } from '../../core/json.ts'
import type { Logger } from '../../core/log.ts'
import type { RunResult, Runner } from '../../core/proc.ts'

export type ForgeId = 'gh' | 'gl'
export const CLI = { gh: 'gh', gl: 'glab' } as const satisfies Record<ForgeId, string>

export type PipelineState = 'passed' | 'failed' | 'running' | 'pending' | 'manual' | 'canceled' | 'none'
// `job` names the failed or manual job.
export type Pipeline = { state: PipelineState; job: string; done: number; total: number }
// `required` is 0 when the host doesn't say; `waiting` is a review still
// required; `reviewers` is everyone asked or who reviewed.
export type Reviews = { approvedBy: string[]; required: number; changes: boolean; waiting: boolean; threads: number; reviewers: string[] }
export type BranchState = 'ok' | 'behind' | 'conflict' | 'unknown'
// GitHub doesn't say how far behind.
export type Branch = { state: BranchState; behind: number | null }

// `repo` is the full path (owner/name, group/sub/name); `review` is set when
// you're asked to review it or did.
export type Pr = {
  forge: ForgeId
  host: string
  repo: string
  number: number
  url: string
  title: string
  draft: boolean
  author: string
  head: string
  base: string
  createdAt: number
  pipeline: Pipeline
  reviews: Reviews
  branch: Branch
  mine: boolean
  review: boolean
}

// missing: CLI not installed; auth: not logged in; failed: anything else
// (a timeout, the network, an answer it couldn't read).
export type Why = 'missing' | 'auth' | 'failed'
// A failure keeps the PRs it had before, which the popup still shows.
export type HostResult = { forge: ForgeId; host: string; me: string; at: number; ms: number; prs: Pr[] } & ({ ok: true } | { ok: false; why: Why; err: string })

export type ForgeClient = { fetch: (forge: ForgeId, host: string, before?: HostResult) => Promise<HostResult> }

// ------------------------------------------------------------ ready

export function onPath(cmd: string, path = process.env.PATH ?? ''): boolean {
  return path.split(delimiter).some(dir => {
    if (!dir) return false
    try {
      accessSync(join(dir, cmd), constants.X_OK)
      return true
    } catch {
      // Not in this folder: try the next.
      return false
    }
  })
}

// The CLI is logged in to the host (gh auth login / glab auth login) when it
// can read the user there. A real call, since a stored login can be expired or
// revoked; only its exit status is kept, so the hub never handles a token.
export const loginArgs = (forge: ForgeId, host: string): string[] => [CLI[forge], 'api', '--hostname', host, 'user']

export async function loggedIn(forge: ForgeId, host: string, run: Runner, timeoutMs = 10000): Promise<boolean> {
  return (await run(loginArgs(forge, host), { timeout: timeoutMs })).ok
}

// ------------------------------------------------------------ parsing

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const rec = (v: unknown): JsonRecord => (isRecord(v) ? v : {})
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const nodes = (v: unknown): JsonRecord[] => list(rec(v).nodes).filter(isRecord)
const time = (v: unknown): number => Date.parse(str(v)) || 0

const NO_PIPELINE: Pipeline = { state: 'none', job: '', done: 0, total: 0 }

// A failure wins, then a run waiting for a person (a deployment), then
// whatever still runs, then all passed.
type Check = { name: string; done: boolean; bad: boolean; waiting: boolean; canceled: boolean }

function githubCheck(n: JsonRecord): Check {
  if (n.__typename === 'StatusContext' || 'context' in n) {
    const state = str(n.state)
    return { name: str(n.context), done: state !== 'PENDING' && state !== 'EXPECTED', bad: state === 'FAILURE' || state === 'ERROR', waiting: false, canceled: false }
  }
  const status = str(n.status)
  const conclusion = str(n.conclusion)
  return {
    name: str(n.name),
    done: status === 'COMPLETED',
    bad: ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(conclusion),
    waiting: status === 'WAITING' || conclusion === 'ACTION_REQUIRED',
    canceled: conclusion === 'CANCELLED',
  }
}

export function githubPipeline(rollup: unknown): Pipeline {
  if (!isRecord(rollup)) return NO_PIPELINE
  const checks = nodes(rollup.contexts).map(githubCheck)
  const total = checks.length
  const done = checks.filter(c => c.done).length
  const failed = checks.find(c => c.bad)
  if (failed) return { state: 'failed', job: failed.name, done, total }
  const waiting = checks.find(c => c.waiting)
  if (waiting) return { state: 'manual', job: waiting.name, done, total }
  if (done < total) return { state: 'running', job: '', done, total }
  if (total && checks.every(c => c.canceled || !c.done)) return { state: 'canceled', job: '', done, total }
  if (total) return { state: 'passed', job: '', done, total }
  return str(rollup.state) === 'PENDING' ? { state: 'pending', job: '', done, total } : NO_PIPELINE
}

function githubBranch(pr: JsonRecord): Branch {
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return { state: 'conflict', behind: null }
  if (pr.mergeStateStatus === 'BEHIND') return { state: 'behind', behind: null }
  if (pr.mergeable === 'MERGEABLE') return { state: 'ok', behind: null }
  return { state: 'unknown', behind: null }
}

function githubReviews(pr: JsonRecord): Reviews {
  const reviews = nodes(pr.latestOpinionatedReviews).map(r => ({ state: str(r.state), who: str(rec(r.author).login) }))
  const asked = nodes(pr.reviewRequests).map(r => {
    const who = rec(r.requestedReviewer)
    return str(who.login) || str(who.slug)
  })
  const approvedBy = reviews.filter(r => r.state === 'APPROVED').map(r => r.who)
  return {
    approvedBy,
    required: 0,
    changes: pr.reviewDecision === 'CHANGES_REQUESTED' || reviews.some(r => r.state === 'CHANGES_REQUESTED'),
    waiting: pr.reviewDecision === 'REVIEW_REQUIRED',
    threads: nodes(pr.reviewThreads).filter(t => t.isResolved === false).length,
    reviewers: [...new Set([...asked, ...reviews.map(r => r.who)].filter(Boolean))],
  }
}

function githubPr(n: JsonRecord, host: string): Pr | null {
  const number = num(n.number)
  const url = str(n.url)
  if (!number || !url) return null
  const commit = rec(rec(nodes(n.commits)[0]).commit)
  return {
    forge: 'gh',
    host,
    repo: str(rec(n.repository).nameWithOwner),
    number,
    url,
    title: str(n.title),
    draft: n.isDraft === true,
    author: str(rec(n.author).login),
    head: str(n.headRefName),
    base: str(n.baseRefName),
    createdAt: time(n.createdAt),
    pipeline: githubPipeline(commit.statusCheckRollup),
    reviews: githubReviews(n),
    branch: githubBranch(n),
    mine: false,
    review: false,
  }
}

// A PR can come back from more than one search.
function merge(into: Map<string, Pr>, prs: (Pr | null)[], flag: 'mine' | 'review'): void {
  for (const pr of prs) {
    if (!pr) continue
    const had = into.get(pr.url) ?? pr
    had[flag] = true
    into.set(pr.url, had)
  }
}

export function parseGithub(json: unknown, host: string): { me: string; prs: Pr[] } | null {
  const data = rec(rec(json).data)
  if (!isRecord(data.viewer)) return null
  const out = new Map<string, Pr>()
  merge(out, nodes(data.mine).map(n => githubPr(n, host)), 'mine')
  merge(out, nodes(data.review).map(n => githubPr(n, host)), 'review')
  merge(out, nodes(data.reviewed).map(n => githubPr(n, host)), 'review')
  return { me: str(data.viewer.login), prs: [...out.values()] }
}

const GL_RUNNING = new Set(['running', 'pending', 'created', 'preparing', 'waiting_for_resource', 'scheduled'])
const GL_DONE = new Set(['success', 'failed', 'canceled'])

export function gitlabPipeline(pipeline: unknown, jobs: unknown): Pipeline {
  if (!isRecord(pipeline)) return NO_PIPELINE
  const status = str(pipeline.status)
  const all = list(jobs)
    .filter(isRecord)
    .map(j => ({ name: str(j.name), status: str(j.status), optional: j.allow_failure === true }))
  const counted = all.filter(j => j.status !== 'manual' && j.status !== 'skipped')
  const done = counted.filter(j => GL_DONE.has(j.status)).length
  const total = counted.length
  if (status === 'success') return { state: 'passed', job: '', done, total }
  if (status === 'failed') {
    const job = all.find(j => j.status === 'failed' && !j.optional) ?? all.find(j => j.status === 'failed')
    return { state: 'failed', job: job?.name ?? '', done, total }
  }
  if (status === 'canceled') return { state: 'canceled', job: '', done, total }
  const manual = all.find(j => j.status === 'manual')
  if (status === 'manual' || (manual && !all.some(j => j.status === 'running'))) return { state: 'manual', job: manual?.name ?? '', done, total }
  if (status === 'running') return { state: 'running', job: '', done, total }
  if (GL_RUNNING.has(status)) return { state: 'pending', job: '', done, total }
  return NO_PIPELINE
}

// Each part is null when its call failed, which leaves that part unknown
// rather than the MR out.
export type GitlabDetail = { mr: unknown; approvals: unknown; discussions: unknown; jobs: unknown }

const unresolved = (discussions: unknown): number =>
  list(discussions).filter(d => list(rec(d).notes).some(n => isRecord(n) && n.resolvable === true && n.resolved === false)).length

function gitlabBranch(mr: JsonRecord, detail: JsonRecord): Branch {
  const conflicts = detail.has_conflicts ?? mr.has_conflicts
  const status = str(detail.detailed_merge_status || mr.detailed_merge_status)
  if (conflicts === true || status === 'conflict') return { state: 'conflict', behind: null }
  const behind = typeof detail.diverged_commits_count === 'number' ? detail.diverged_commits_count : null
  if ((behind ?? 0) > 0 || status === 'need_rebase') return { state: 'behind', behind }
  return behind === 0 || status === 'mergeable' ? { state: 'ok', behind: 0 } : { state: 'unknown', behind }
}

export function gitlabPr(item: unknown, more: GitlabDetail, host: string): Pr | null {
  const mr = rec(item)
  const number = num(mr.iid)
  const url = str(mr.web_url)
  if (!number || !url) return null
  const detail = rec(more.mr)
  const approvals = rec(more.approvals)
  const full = str(rec(mr.references).full)
  const repo = full.includes('!') ? full.slice(0, full.lastIndexOf('!')) : (url.match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\//)?.[1] ?? '')
  const approvedBy = list(approvals.approved_by).map(a => str(rec(rec(a).user).username)).filter(Boolean)
  const status = str(detail.detailed_merge_status || mr.detailed_merge_status)
  return {
    forge: 'gl',
    host,
    repo,
    number,
    url,
    title: str(mr.title),
    draft: mr.draft === true || mr.work_in_progress === true,
    author: str(rec(mr.author).username),
    head: str(mr.source_branch),
    base: str(mr.target_branch),
    createdAt: time(mr.created_at),
    pipeline: gitlabPipeline(detail.head_pipeline ?? null, more.jobs),
    reviews: {
      approvedBy,
      required: num(approvals.approvals_required),
      changes: status === 'requested_changes',
      waiting: num(approvals.approvals_left) > 0,
      threads: unresolved(more.discussions),
      reviewers: [...new Set([...list(mr.reviewers).map(r => str(rec(r).username)), ...approvedBy].filter(Boolean))],
    },
    branch: gitlabBranch(mr, detail),
    mine: false,
    review: false,
  }
}

// ------------------------------------------------------------ fetching

const GITHUB_QUERY = `query($mine: String!, $review: String!, $reviewed: String!) {
  viewer { login }
  mine: search(query: $mine, type: ISSUE, first: 50) { nodes { ...pr } }
  review: search(query: $review, type: ISSUE, first: 50) { nodes { ...pr } }
  reviewed: search(query: $reviewed, type: ISSUE, first: 50) { nodes { ...pr } }
}
fragment pr on PullRequest {
  number title url isDraft createdAt headRefName baseRefName
  author { login }
  repository { nameWithOwner }
  mergeable mergeStateStatus reviewDecision
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
  latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion }
    ... on StatusContext { context state }
  } } } } } }
}`

const SEARCHES = {
  mine: 'is:pr is:open archived:false author:@me',
  review: 'is:pr is:open archived:false review-requested:@me',
  reviewed: 'is:pr is:open archived:false reviewed-by:@me -author:@me',
}

export const githubArgs = (host: string): string[] => [
  'api',
  'graphql',
  '--hostname',
  host,
  // mergeStateStatus was a preview; the header is harmless where it isn't.
  '-H',
  'Accept: application/vnd.github.merge-info-preview+json',
  '-f',
  `query=${GITHUB_QUERY}`,
  ...Object.entries(SEARCHES).flatMap(([k, q]) => ['-f', `${k}=${q}`]),
]

export const gitlabArgs = (host: string, path: string): string[] => ['api', '--hostname', host, path]

export function whyFailed(r: Pick<RunResult, 'err' | 'exit'>): Why {
  if (/ENOENT/.test(r.err)) return 'missing'
  if (/auth login|not logged|logged in|401|unauthori[sz]ed|authenticat|no token|bad credentials/i.test(r.err)) return 'auth'
  return 'failed'
}

const firstLine = (s: string): string => s.split('\n').find(l => l.trim())?.trim().slice(0, 200) ?? ''

async function pool<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

export type ForgeClientOptions = {
  run: Runner
  log: Pick<Logger, 'debug' | 'info' | 'warn'>
  // Per call; one that takes longer fails the host.
  timeoutMs?: number
  now?: () => number
}

class CallFailed extends Error {
  readonly why: Why
  readonly cmd: string[]
  readonly exit: number | null
  constructor(r: RunResult, cmd: string[]) {
    super(firstLine(r.err) || `exit ${r.exit}`)
    this.why = whyFailed(r)
    this.cmd = cmd
    this.exit = r.exit
  }
}

export function forgeClient({ run, log, timeoutMs = 30000, now = Date.now }: ForgeClientOptions): ForgeClient {
  const json = async (cmd: string[]): Promise<unknown> => {
    const r = await run(cmd, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
    if (!r.ok) throw new CallFailed(r, cmd)
    try {
      return JSON.parse(r.out)
    } catch {
      throw new CallFailed({ ...r, err: 'not JSON' }, cmd)
    }
  }
  // A part of an MR may fail on its own (approvals need a licence on some
  // GitLabs) without failing the host.
  const maybe = async (cmd: string[]): Promise<unknown> => {
    try {
      return await json(cmd)
    } catch (err) {
      log.debug('mr part not fetched', { cmd, err: err instanceof Error ? err.message : String(err) })
      return null
    }
  }

  async function github(host: string): Promise<{ me: string; prs: Pr[] }> {
    const cmd = [CLI.gh, ...githubArgs(host)]
    const parsed = parseGithub(await json(cmd), host)
    if (!parsed) throw new CallFailed({ ok: false, out: '', err: 'not a GraphQL answer', exit: 0 }, cmd)
    return parsed
  }

  async function gitlab(host: string): Promise<{ me: string; prs: Pr[] }> {
    const api = (path: string) => [CLI.gl, ...gitlabArgs(host, path)]
    const me = str(rec(await json(api('user'))).username)
    const mine = list(await json(api('merge_requests?scope=created_by_me&state=opened&per_page=50')))
    const asked = me ? list(await json(api(`merge_requests?scope=all&state=opened&reviewer_username=${encodeURIComponent(me)}&per_page=50`))) : []
    const flags = new Map<string, { item: unknown; mine: boolean; review: boolean }>()
    for (const [items, flag] of [
      [mine, 'mine'],
      [asked, 'review'],
    ] as const)
      for (const item of items) {
        const key = `${num(rec(item).project_id)}!${num(rec(item).iid)}`
        const had = flags.get(key) ?? { item, mine: false, review: false }
        had[flag] = true
        flags.set(key, had)
      }
    const prs = await pool([...flags.values()], 4, async ({ item, mine, review }) => {
      const base = `projects/${num(rec(item).project_id)}/merge_requests/${num(rec(item).iid)}`
      const [mr, approvals, discussions] = await Promise.all([
        maybe(api(`${base}?include_diverged_commits_count=true`)),
        maybe(api(`${base}/approvals`)),
        maybe(api(`${base}/discussions?per_page=100`)),
      ])
      const pipeline = rec(rec(mr).head_pipeline)
      const green = !pipeline.id || pipeline.status === 'success'
      const jobs = green ? null : await maybe(api(`projects/${num(rec(item).project_id)}/pipelines/${num(pipeline.id)}/jobs?per_page=100`))
      const pr = gitlabPr(item, { mr, approvals, discussions, jobs }, host)
      return pr && { ...pr, mine, review }
    })
    return { me, prs: prs.filter((p): p is Pr => p !== null) }
  }

  return {
    async fetch(forge, host, before) {
      const started = now()
      log.debug('prs fetch started', { forge, host })
      try {
        const { me, prs } = forge === 'gh' ? await github(host) : await gitlab(host)
        const ms = now() - started
        log.info('prs fetched', { forge, host, ms, prs: prs.length, mine: prs.filter(p => p.mine).length, review: prs.filter(p => p.review).length })
        return { forge, host, me, at: now(), ms, prs, ok: true }
      } catch (err) {
        const ms = now() - started
        const failed = err instanceof CallFailed ? err : null
        const why: Why = failed?.why ?? 'failed'
        const message = err instanceof Error ? err.message : String(err)
        log.warn('prs not fetched', { forge, host, ms, why, err: message, ...(failed ? { cmd: failed.cmd.slice(0, 4), exit: failed.exit } : {}) })
        // Missing or auth shows no rows; any other failure keeps the old ones.
        const prs = why === 'failed' ? (before?.prs ?? []) : []
        return { forge, host, me: before?.me ?? '', at: before?.at ?? 0, ms, prs, ok: false, why, err: message }
      }
    },
  }
}
