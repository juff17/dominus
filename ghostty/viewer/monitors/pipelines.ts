// Pipelines from GitLab (glab) and GitHub (gh), and running their gates.
// GitLab's are pipelines with stages of jobs; GitHub's are workflow runs,
// each job a stage of its own.
//
// A gate is a GitLab manual job (y plays it) or a GitHub deployment waiting
// on a protected environment (y approves it). Before either, the job or run
// is read again, and a gate that changed since it was shown is refused.

import type { Logger } from '../../core/log.ts'
import type { Runner } from '../../core/proc.ts'
import { CLI, type ForgeId, type Why, whyFailed } from './forge.ts'

export type Trigger = 'push' | 'tag' | 'schedule' | 'mr' | 'pr' | 'manual' | 'other'
export type StageState = 'passed' | 'failed' | 'running' | 'manual' | 'waiting' | 'canceled' | 'skipped'
export type Stage = { name: string; state: StageState; done: number; total: number }
export type PipeState = 'running' | 'failed' | 'manual' | 'passed' | 'pending' | 'canceled' | 'skipped'

// `id` is the GitLab job's id or the GitHub environment's; `sha` the commit
// it was shown for, which y checks again before acting.
export type GateKind = 'job' | 'deployment'
export type Gate = { id: string; kind: GateKind; name: string; stage: string; env: string; sha: string; url: string }

// `pr` is the address of the PR or MR it's from ('' for your projects'
// own), `prRef` its short name (!128, #77). `failed` names the first
// failed job.
export type Pipe = {
  forge: ForgeId
  host: string
  project: string
  id: number
  url: string
  ref: string
  sha: string
  trigger: Trigger
  state: PipeState
  stages: Stage[]
  gates: Gate[]
  failed: string
  at: number
  pr: string
  prRef: string
}

// A failure keeps the pipes it had.
export type PipeHost = { forge: ForgeId; host: string; at: number; ms: number; pipes: Pipe[] } & ({ ok: true } | { ok: false; why: Why; err: string })

export type ProjectRef = { forge: ForgeId; host: string; project: string }
export type PrSource = ProjectRef & { number: number; url: string }

export type PipeQuery = { forge: ForgeId; host: string; projects: string[]; refs: string[]; prs: PrSource[] }

export type GateResult = { ok: true } | { ok: false; why: 'changed' | 'failed'; err: string }

export type PipelinesClient = {
  fetch: (q: PipeQuery, before?: PipeHost) => Promise<PipeHost>
  run: (pipe: Pipe, gate: Gate) => Promise<GateResult>
}

// ------------------------------------------------------------ names

export const pipeKey = (p: Pick<Pipe, 'forge' | 'host' | 'project' | 'id'>): string => `${p.forge}:${p.host}:${p.project}:${p.id}`.toLowerCase()
export const gateKey = (p: Pick<Pipe, 'forge' | 'host' | 'project' | 'id'>, g: Pick<Gate, 'kind' | 'id'>): string => `${pipeKey(p)}:${g.kind}:${g.id}`
// A skipped gate comes back when this changes: another commit, or the job
// run again (a new id).
export const gateSig = (g: Gate): string => `${g.id}@${g.sha}`

// A pattern is "default branch", or a glob with * and ?.
export function refMatches(ref: string, patterns: readonly string[], defaultBranch: string): boolean {
  return patterns.some(p => {
    if (p === 'default branch') return ref === defaultBranch
    const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
    return re.test(ref)
  })
}

// A pipeline or run address, or [host/]project@ref.
export type PipeTarget = { url: string; forge: ForgeId | ''; host: string; project: string; ref: string; id: number }

export function parsePipeTarget(text: string): PipeTarget | null {
  const s = text.trim()
  const gl = /^https?:\/\/([^/]+)\/([^?#]+?)\/-\/pipelines\/(\d+)/i.exec(s)
  if (gl) return { url: s, forge: 'gl', host: gl[1].toLowerCase(), project: gl[2], ref: '', id: Number(gl[3]) }
  const gh = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/i.exec(s)
  if (gh) return { url: s, forge: 'gh', host: gh[1].toLowerCase(), project: gh[2], ref: '', id: Number(gh[3]) }
  if (/^https?:\/\//i.test(s)) return null
  const at = /^([\w.:-]+\/)?([\w.-]+(?:\/[\w.-]+)+)@(\S+)$/.exec(s)
  if (!at) return null
  // A first part with a dot is a host: gitlab.example.com/platform/api@main.
  const [first, ...rest] = `${at[1] ?? ''}${at[2]}`.split('/')
  const host = first.includes('.') && rest.length >= 2 ? first.toLowerCase() : ''
  const project = host ? rest.join('/') : [first, ...rest].join('/')
  return { url: '', forge: host === 'github.com' ? 'gh' : '', host, project, ref: at[3], id: 0 }
}

export function targetLabel(t: PipeTarget): string {
  const project = t.project.split('/').slice(-2).join('/')
  return t.ref ? `${project} ${t.ref}` : `${project} #${t.id}`
}

// ------------------------------------------------------------ parsing

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const rec = (v: unknown): Json => (isObj(v) ? v : {})
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObj) : [])
const time = (v: unknown): number => Date.parse(str(v)) || 0

// A job's state, the same on both hosts and the same as agent_hub.forge's
// (pipeline-watch, pr-babysit): tests/contract/pipeline-states.test.mjs holds
// the two to one another.
export type JobState = 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual' | 'pending' | 'waiting'

// Created, scheduled, preparing and waiting_for_resource jobs wait on other
// jobs, not a runner.
const GL_JOB: Record<string, JobState> = {
  running: 'running',
  success: 'success',
  failed: 'failed',
  canceled: 'canceled',
  canceling: 'canceled',
  skipped: 'skipped',
  manual: 'manual',
  pending: 'pending',
}
export const gitlabJobState = (status: string): JobState => GL_JOB[status] ?? 'waiting'

// An Actions job's status and conclusion.
const GH_DONE: Record<string, JobState> = { success: 'success', neutral: 'success', skipped: 'skipped', cancelled: 'canceled', stale: 'canceled', action_required: 'manual' }
export function githubJobState(status: string, conclusion: string): JobState {
  if (status === 'in_progress') return 'running'
  if (status === 'waiting') return 'manual'
  if (status !== 'completed') return 'pending'
  return GH_DONE[conclusion] ?? 'failed'
}

// Jobs allowed to fail count only when every job in the stage is.
export function stageOf(jobs: readonly { state: JobState; optional: boolean }[]): StageState {
  const required = jobs.filter(j => !j.optional)
  const counted = required.length ? required : jobs
  const has = (...s: JobState[]) => counted.some(j => s.includes(j.state))
  if (counted.every(j => j.state === 'skipped')) return 'skipped'
  if (has('failed')) return 'failed'
  if (has('running', 'pending')) return 'running'
  if (has('manual')) return 'manual'
  if (has('waiting')) return 'waiting'
  if (has('canceled')) return 'canceled'
  return 'passed'
}

const GL_STATE: Record<string, PipeState> = {
  success: 'passed',
  failed: 'failed',
  running: 'running',
  pending: 'pending',
  created: 'pending',
  preparing: 'pending',
  waiting_for_resource: 'pending',
  scheduled: 'pending',
  manual: 'manual',
  canceled: 'canceled',
  skipped: 'skipped',
}

const GL_TRIGGER: Record<string, Trigger> = { push: 'push', schedule: 'schedule', merge_request_event: 'mr', web: 'manual', api: 'manual', trigger: 'manual' }

// `tag` says the ref is a tag, which GitLab's pipeline list doesn't.
export function gitlabPipe(pipeline: unknown, jobs: unknown, host: string, project: string, { tag = false, pr = '', prRef = '' } = {}): Pipe | null {
  const p = rec(pipeline)
  const id = num(p.id)
  if (!id) return null
  // The API lists the newest job first; stages go in the order they ran.
  const all = list(jobs)
    .map(j => ({ id: num(j.id), name: str(j.name), stage: str(j.stage), status: str(j.status), state: gitlabJobState(str(j.status)), optional: j.allow_failure === true, url: str(j.web_url), sha: str(rec(j.commit).id) }))
    .sort((a, b) => a.id - b.id)
  const names: string[] = []
  for (const j of all) if (!names.includes(j.stage)) names.push(j.stage)
  const stages = names.map(name => {
    const js = all.filter(j => j.stage === name)
    return { name, state: stageOf(js), done: js.filter(j => ['success', 'failed', 'skipped', 'canceled'].includes(j.status)).length, total: js.length }
  })
  const sha = str(p.sha)
  const gates: Gate[] = all.filter(j => j.status === 'manual').map(j => ({ id: String(j.id), kind: 'job', name: j.name, stage: j.stage, env: '', sha: j.sha || sha, url: j.url }))
  const source = str(p.source)
  const trigger: Trigger = pr ? 'mr' : tag || p.tag === true ? 'tag' : (GL_TRIGGER[source] ?? 'other')
  return {
    forge: 'gl',
    host,
    project,
    id,
    url: str(p.web_url),
    ref: str(p.ref),
    sha,
    trigger,
    state: GL_STATE[str(p.status)] ?? 'pending',
    stages,
    gates,
    failed: (all.find(j => j.status === 'failed' && !j.optional) ?? all.find(j => j.status === 'failed'))?.name ?? '',
    at: time(p.created_at) || time(p.updated_at),
    pr,
    prRef,
  }
}

const GH_TRIGGER: Record<string, Trigger> = { push: 'push', schedule: 'schedule', pull_request: 'pr', pull_request_target: 'pr', workflow_dispatch: 'manual', release: 'tag' }

// agent_hub.forge groups a run's jobs by the name before " / " (a reusable
// workflow), since pr-babysit sums up every check on a PR; one run here has
// few jobs, so each is drawn as its own stage.
function githubStage(j: Json): Stage {
  const status = str(j.status)
  const state = stageOf([{ state: githubJobState(status, str(j.conclusion)), optional: false }])
  return { name: str(j.name), state, done: status === 'completed' ? 1 : 0, total: 1 }
}

function githubState(run: Json): PipeState {
  const status = str(run.status)
  if (status === 'waiting') return 'manual'
  if (status === 'in_progress') return 'running'
  if (status !== 'completed') return 'pending'
  const c = str(run.conclusion)
  if (c === 'success') return 'passed'
  if (c === 'cancelled') return 'canceled'
  if (c === 'skipped' || c === 'neutral') return 'skipped'
  return 'failed'
}

// `pending` is the run's pending_deployments; only those you may approve
// become gates.
export function githubPipe(run: unknown, jobs: unknown, pending: unknown, host: string, project: string, { pr = '', prRef = '', tag = false } = {}): Pipe | null {
  const r = rec(run)
  const id = num(r.id)
  if (!id) return null
  const js = list(rec(jobs).jobs)
  const sha = str(r.head_sha)
  const url = str(r.html_url)
  const gates: Gate[] = list(pending)
    .filter(d => d.current_user_can_approve !== false)
    .map((d): Gate => {
      const env = rec(d.environment)
      return { id: String(num(env.id)), kind: 'deployment', name: str(env.name), stage: '', env: str(env.name), sha, url }
    })
    .filter(g => g.id !== '0')
  const failed = js.find(j => ['failure', 'timed_out', 'startup_failure'].includes(str(j.conclusion)))
  return {
    forge: 'gh',
    host,
    project,
    id,
    url,
    ref: str(r.head_branch),
    sha,
    trigger: pr ? 'pr' : tag ? 'tag' : (GH_TRIGGER[str(r.event)] ?? 'other'),
    state: githubState(r),
    stages: js.map(githubStage),
    gates,
    failed: failed ? str(failed.name) : '',
    at: time(r.run_started_at) || time(r.created_at),
    pr,
    prRef,
  }
}

// The newest per key (GitHub keys by ref and workflow), at most `most`.
// Expects items newest first, as the APIs list them.
export function latestPerRef<T extends Json>(items: readonly T[], refOf: (x: T) => string, keyOf: (x: T) => string, keep: (ref: string) => boolean, most = 5): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const x of items) {
    const ref = refOf(x)
    if (!ref || !keep(ref) || seen.has(keyOf(x))) continue
    seen.add(keyOf(x))
    out.push(x)
    if (out.length >= most) break
  }
  return out
}

// ------------------------------------------------------------ the client

export type PipelinesClientOptions = {
  run: Runner
  log: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
  timeoutMs?: number
  now?: () => number
}

class CallFailed extends Error {
  readonly why: Why
  readonly cmd: string[]
  readonly exit: number | null
  constructor(err: string, exit: number | null, cmd: string[]) {
    super(err.split('\n').find(l => l.trim())?.trim().slice(0, 200) || `exit ${exit}`)
    this.why = whyFailed({ err, exit })
    this.cmd = cmd
    this.exit = exit
  }
}

const enc = encodeURIComponent

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

export function pipelinesClient({ run, log, timeoutMs = 30000, now = Date.now }: PipelinesClientOptions): PipelinesClient {
  // `post` (its fields, maybe none) makes it a POST.
  const call = async (forge: ForgeId, host: string, path: string, post?: string[]): Promise<unknown> => {
    const cmd = [CLI[forge], 'api', '--hostname', host, ...(post ? ['-X', 'POST', ...post] : []), path]
    const r = await run(cmd, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
    if (!r.ok) throw new CallFailed(r.err, r.exit, cmd)
    try {
      return r.out.trim() ? JSON.parse(r.out) : {}
    } catch {
      throw new CallFailed('not JSON', r.exit, cmd)
    }
  }
  // One project's or PR's part, which may fail alone (a project you can't
  // see, a PR since merged): logged and left out, unless the CLI can't run
  // or isn't logged in, which fails the whole host.
  const part = async <T>(what: Json, fn: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof CallFailed && err.why !== 'failed') throw err
      log.warn('pipelines part not fetched', { ...what, err: err instanceof Error ? err.message : String(err), ...(err instanceof CallFailed ? { cmd: err.cmd.slice(0, 4), exit: err.exit } : {}) })
      return []
    }
  }

  async function gitlabProject(host: string, project: string, refs: readonly string[]): Promise<Pipe[]> {
    const p = `projects/${enc(project)}`
    const info = rec(await call('gl', host, p))
    const main = str(info.default_branch)
    const recent = list(await call('gl', host, `${p}/pipelines?per_page=30`))
    const tags = refs.some(r => r !== 'default branch') ? new Set(list(await call('gl', host, `${p}/pipelines?scope=tags&per_page=30`)).map(x => num(x.id))) : new Set<number>()
    const kept = latestPerRef(recent, x => str(x.ref), x => str(x.ref), ref => refMatches(ref, refs, main))
    const pipes = await pool(kept, 4, async x => gitlabPipe(x, await call('gl', host, `${p}/pipelines/${num(x.id)}/jobs?per_page=100`), host, project, { tag: tags.has(num(x.id)) }))
    return pipes.filter((x): x is Pipe => x !== null)
  }

  async function gitlabPr(host: string, pr: PrSource): Promise<Pipe[]> {
    const p = `projects/${enc(pr.project)}`
    const [latest] = list(await call('gl', host, `${p}/merge_requests/${pr.number}/pipelines?per_page=1`))
    if (!latest) return []
    const full = await call('gl', host, `${p}/pipelines/${num(latest.id)}`)
    const pipe = gitlabPipe(isObj(full) && full.id ? full : latest, await call('gl', host, `${p}/pipelines/${num(latest.id)}/jobs?per_page=100`), host, pr.project, { pr: pr.url, prRef: `!${pr.number}` })
    return pipe ? [pipe] : []
  }

  async function githubRuns(host: string, project: string, runs: Json[], o: { pr?: string; prRef?: string }): Promise<Pipe[]> {
    const r = `repos/${project}`
    const pipes = await pool(runs, 4, async x => {
      const id = num(x.id)
      const jobs = await call('gh', host, `${r}/actions/runs/${id}/jobs?per_page=100`)
      const pending = str(x.status) === 'waiting' ? await call('gh', host, `${r}/actions/runs/${id}/pending_deployments`) : []
      return githubPipe(x, jobs, pending, host, project, o)
    })
    return pipes.filter((x): x is Pipe => x !== null)
  }

  async function githubProject(host: string, project: string, refs: readonly string[]): Promise<Pipe[]> {
    const r = `repos/${project}`
    const main = str(rec(await call('gh', host, r)).default_branch)
    const runs = list(rec(await call('gh', host, `${r}/actions/runs?per_page=30`)).workflow_runs)
    const kept = latestPerRef(runs, x => str(x.head_branch), x => `${str(x.head_branch)}\t${str(x.name)}`, ref => refMatches(ref, refs, main))
    return githubRuns(host, project, kept, {})
  }

  async function githubPr(host: string, pr: PrSource): Promise<Pipe[]> {
    const r = `repos/${pr.project}`
    const sha = str(rec(rec(await call('gh', host, `${r}/pulls/${pr.number}`)).head).sha)
    if (!sha) return []
    const runs = list(rec(await call('gh', host, `${r}/actions/runs?head_sha=${sha}&per_page=10`)).workflow_runs)
    const kept = latestPerRef(runs, x => str(x.head_branch) || sha, x => str(x.name), () => true)
    return githubRuns(host, pr.project, kept, { pr: pr.url, prRef: `#${pr.number}` })
  }

  async function fetch(q: PipeQuery, before?: PipeHost): Promise<PipeHost> {
    const started = now()
    log.debug('pipelines fetch started', { forge: q.forge, host: q.host, projects: q.projects.length, prs: q.prs.length })
    try {
      const own = await pool(q.projects, 3, project =>
        part({ forge: q.forge, host: q.host, project }, () => (q.forge === 'gl' ? gitlabProject(q.host, project, q.refs) : githubProject(q.host, project, q.refs))),
      )
      const fromPrs = await pool(q.prs, 3, pr => part({ forge: q.forge, host: q.host, id: pr.url }, () => (q.forge === 'gl' ? gitlabPr(q.host, pr) : githubPr(q.host, pr))))
      const pipes = [...own.flat(), ...fromPrs.flat()]
      const ms = now() - started
      log.info('pipelines fetched', { forge: q.forge, host: q.host, ms, pipes: pipes.length, gates: pipes.reduce((n, p) => n + p.gates.length, 0) })
      return { forge: q.forge, host: q.host, at: now(), ms, pipes, ok: true }
    } catch (err) {
      const ms = now() - started
      const failed = err instanceof CallFailed ? err : null
      const why: Why = failed?.why ?? 'failed'
      const message = err instanceof Error ? err.message : String(err)
      log.warn('pipelines not fetched', { forge: q.forge, host: q.host, ms, why, err: message, ...(failed ? { cmd: failed.cmd.slice(0, 4), exit: failed.exit } : {}) })
      return { forge: q.forge, host: q.host, at: before?.at ?? 0, ms, pipes: why === 'failed' ? (before?.pipes ?? []) : [], ok: false, why, err: message }
    }
  }

  // GitLab's job must still be manual on the same commit; GitHub's run must
  // still wait on that environment for the same commit.
  async function runGate(pipe: Pipe, gate: Gate): Promise<GateResult> {
    const ids = { id: gate.id, kind: gate.kind, pipeline: pipe.id, project: pipe.project, host: pipe.host }
    const started = now()
    log.debug('gate run started', ids)
    try {
      if (pipe.forge === 'gl') {
        const p = `projects/${enc(pipe.project)}`
        const job = rec(await call('gl', pipe.host, `${p}/jobs/${gate.id}`))
        const sha = str(rec(job.commit).id)
        if (str(job.status) !== 'manual' || (sha && sha !== gate.sha)) {
          log.info('gate refused', { ...ids, why: 'changed', status: str(job.status), sha: sha.slice(0, 12) })
          return { ok: false, why: 'changed', err: str(job.status) || 'gone' }
        }
        await call('gl', pipe.host, `${p}/jobs/${gate.id}/play`, [])
      } else {
        const r = `repos/${pipe.project}/actions/runs/${pipe.id}`
        const runNow = rec(await call('gh', pipe.host, r))
        const waiting = list(await call('gh', pipe.host, `${r}/pending_deployments`)).some(d => String(num(rec(d.environment).id)) === gate.id)
        if (str(runNow.status) !== 'waiting' || str(runNow.head_sha) !== gate.sha || !waiting) {
          log.info('gate refused', { ...ids, why: 'changed', status: str(runNow.status), sha: str(runNow.head_sha).slice(0, 12) })
          return { ok: false, why: 'changed', err: str(runNow.status) || 'gone' }
        }
        await call('gh', pipe.host, `${r}/pending_deployments`, ['-F', `environment_ids[]=${gate.id}`, '-f', 'state=approved', '-f', 'comment=Approved from Alt+M'])
      }
      log.info('gate ran', { ...ids, ok: true, ms: now() - started })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('gate not run', { ...ids, ms: now() - started, err: message, ...(err instanceof CallFailed ? { cmd: err.cmd.slice(0, 6), exit: err.exit } : {}) })
      return { ok: false, why: 'failed', err: message }
    }
  }

  return { fetch, run: runGate }
}
