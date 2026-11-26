// agentd's work, one tick at a time, with what it touches passed in so a
// test can run it against a fixture. agentd.ts owns the process: the pid
// file, the loop and when to exit.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger, warnOnce } from '../core/log.ts'
import { AGENTD_BEAT, CLAUDE_DIR, LAYOUT_SOCKET, RUN, TABS_SOCKET, claudeBin } from '../core/paths.ts'
import { load as settings } from '../settings/settings.ts'
import { type Agent, type Alive, type Paired, classify, pairParked } from './classify.ts'
import {
  HUB_SHOWN_FORMAT,
  PANE_FORMAT,
  type Pane,
  aliveIn,
  hubUnlinkArgs,
  paneOf,
  parseHubShown,
  parsePanes,
  pruneReviews,
  review,
  reviews,
  scanProcs as scanAllProcs,
  sessions,
  stoppedTasks,
  tabMarkArgs,
  transcriptReader,
} from './daemon.ts'
import { type Dismiss, orphanSweeper } from './orphans.ts'
import { watches } from './board.ts'
import { parseJobs, stoppedAgent, stoppedJobs } from './stopped.ts'

export const TICK_MS = 1000
const PROC_SCAN_MS = 5000
const PRUNE_MS = 10 * 60 * 1000
const JOBS_SCAN_MS = 5000
const LIST_TIMEOUT_MS = 5000
const RESPAWN_TIMEOUT_MS = 60_000

const log = logger('agentd')

// state.json
export type AgentdState = { at: number; agents: Agent[] }

// null when it failed, which a caller reads as "tmux knows nothing" (no
// server, no such session).
export type Exec = (cmd: string, args: string[]) => Promise<string | null>

export const execStdout: Exec = (cmd, args) =>
  new Promise(resolve =>
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) warnOnce(log, 'command failed', new Error(String(stderr || err.message).trim()), { cmd: [cmd, ...args], exit: err.code })
      resolve(err ? null : stdout)
    }),
  )

const CLAUDE = claudeBin()

// Runs claude with a time limit, so one that hangs can't stop the ticks.
const runClaude = (args: string[], timeout: number): Promise<{ ok: boolean; out: string; err: string }> =>
  new Promise(resolve =>
    execFile(CLAUDE, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: stdout, err: err ? String(stderr || err.message).trim() : '' }),
    ),
  )

// `claude agents --json`, the background sessions Claude Code keeps; null
// when it failed.
async function listJobsDefault(): Promise<string | null> {
  const r = await runClaude(['agents', '--json'], LIST_TIMEOUT_MS)
  if (!r.ok) warnOnce(log, 'command failed', new Error(r.err), { cmd: [CLAUDE, 'agents', '--json'] })
  return r.ok ? r.out : null
}

export type Restart = (jobId: string) => Promise<{ ok: boolean; err: string }>

const restartDefault: Restart = jobId => runClaude(['respawn', jobId], RESPAWN_TIMEOUT_MS)

export type AgentdOptions = {
  exec?: Exec
  now?: () => number
  claudeDir?: string
  run?: string
  tabsSocket?: string
  layoutSocket?: string
  scanProcs?: () => string[] | null
  // How a proposal whose session ended is dropped (orphans.ts).
  dismiss?: Dismiss
  // Names the temp file state.json is written through.
  pid?: number
  listJobs?: () => Promise<string | null>
  restart?: Restart
}

export type Agentd = {
  tick(): Promise<Agent[]>
  // tick, then write state.json and update the tabs.
  step(): Promise<Agent[]>
  write(agents: Agent[]): boolean
  markTabs(agents: Agent[], marked?: Map<string, string>): Promise<void>
  unlinkWorkspaceTabs(): Promise<void>
  clearTabs(): Promise<void>
  scanNow(): void
}

export function createAgentd({
  exec = execStdout,
  now = Date.now,
  claudeDir = CLAUDE_DIR,
  run = RUN,
  tabsSocket = TABS_SOCKET,
  layoutSocket = LAYOUT_SOCKET,
  scanProcs = scanAllProcs,
  dismiss,
  pid = process.pid,
  listJobs = listJobsDefault,
  restart = restartDefault,
}: AgentdOptions = {}): Agentd {
  const SESSIONS = join(claudeDir, 'sessions')
  const REVIEWED = join(run, 'reviewed')
  const STOPPED = join(run, 'stopped')
  // One file per stopped agent agentd has restarted on its own: the runtime
  // folder lasts a login, so each is tried once per login, and one that
  // stops again stays stopped for you to look at.
  const RESTARTED = join(run, 'restarted')
  const orphans = orphanSweeper({ dir: join(run, 'approvals'), sessionsDir: SESSIONS, dismiss })
  const transcripts = transcriptReader(join(claudeDir, 'projects'))
  const tmux = (socket: string, args: string[]) => exec('tmux', ['-L', socket, ...args])

  let marks = new Map<string, string>()
  // A monitor that started after the last scan isn't in it, so the scan
  // can't tell rather than calling it gone.
  let procs: string[] | null = null
  let procsAt = 0
  let prunedAt = Number.NEGATIVE_INFINITY
  const alive: Alive = (cmd, since) => (since > procsAt ? null : aliveIn(procs, cmd))
  let last = ''
  let stopped: Agent[] = []
  let jobsAt = Number.NEGATIVE_INFINITY

  const listPanes = () => tmux(tabsSocket, ['list-panes', '-a', '-F', PANE_FORMAT])

  async function panes() {
    const [text, hub] = await Promise.all([listPanes(), tmux(layoutSocket, ['list-panes', '-a', '-F', HUB_SHOWN_FORMAT])])
    return parsePanes(text, parseHubShown(hub))
  }

  // One tmux call per command: tabMarkArgs says why.
  async function runEach(commands: string[][]) {
    for (const args of commands) await tmux(tabsSocket, args)
  }

  function reviewed(live: Set<string>, at: number): Map<string, number> {
    const seen = reviews(REVIEWED, live)
    if (at - prunedAt >= PRUNE_MS) {
      prunedAt = at
      const removed = pruneReviews(REVIEWED, live, at)
      if (removed) log.info('review marks pruned', { path: REVIEWED, removed })
    }
    return seen
  }

  function agentOf({ session: s, viewer }: Paired, panes: Map<string, Pane>, seen: Map<string, number>, stopped: Map<string, Set<string>>, at: number): Agent {
    const t = transcripts.read(s)
    const subs = s.status === 'waiting' ? transcripts.subagents(s) : []
    const pane = paneOf(viewer ?? s, panes)
    if (pane?.looked) {
      review(REVIEWED, s.sessionId)
      seen.set(s.sessionId, at)
    }
    return classify({ session: s, t, subs, pane, reviewedAt: seen.get(s.sessionId) ?? 0, alive, stopped: stopped.get(s.sessionId), now: at })
  }

  async function refreshStopped(live: Set<string>, at: number): Promise<void> {
    if (at - jobsAt < JOBS_SCAN_MS) return
    jobsAt = at
    const text = await listJobs()
    if (text === null) return
    let jobs: ReturnType<typeof parseJobs> = null
    try {
      jobs = parseJobs(JSON.parse(text))
    } catch (err) {
      warnOnce(log, 'agent list unreadable', err, { cmd: [CLAUDE, 'agents', '--json'] })
      return
    }
    if (!jobs) {
      warnOnce(log, 'agent list unreadable', new Error('not a list'), { cmd: [CLAUDE, 'agents', '--json'] })
      return
    }
    stopped = stoppedJobs(jobs, live).map(j => stoppedAgent(join(claudeDir, 'projects'), j))
    if (settings()['hub.restartStopped']) restartStopped(stopped)
  }

  function restartStopped(agents: Agent[]): void {
    // A monitor's session comes back without its watcher, as tools aren't run
    // again, so only task agents are restarted.
    for (const a of agents.filter(x => !watches(x))) {
      const mark = join(RESTARTED, a.jobId!)
      if (existsSync(mark)) continue
      try {
        mkdirSync(RESTARTED, { recursive: true })
        writeFileSync(mark, '')
      } catch (err) {
        // Without the mark it would be tried again every scan.
        warnOnce(log, 'restart not marked', err, { path: mark })
        continue
      }
      const started = now()
      log.info('agent restarting', { id: a.jobId, title: a.title })
      restart(a.jobId!)
        .then(r => {
          const fields = { id: a.jobId, ms: now() - started }
          if (r.ok) log.info('agent restarted', fields)
          else log.error('agent not restarted', { ...fields, err: r.err })
        })
        .catch(err => log.error('agent not restarted', { id: a.jobId, err }))
    }
  }

  function refreshProcs(agents: Agent[], at: number): void {
    const wanted = agents.some(a => a.monitors.some(m => !m.ended))
    if (!wanted) procs = null
    else if (at - procsAt > PROC_SCAN_MS) {
      procs = scanProcs()
      procsAt = at
    }
  }

  async function tick() {
    const at = now()
    const list = sessions(SESSIONS)
    orphans.sweep(new Set(list.map(s => s.sessionId)), at).catch(err => log.error('orphan sweep failed', { err }))
    const listed = await panes()
    marks = listed.marks
    const pairs = pairParked(list)
    const live = new Set(pairs.map(p => p.session.sessionId))
    const seen = reviewed(live, at)
    const stoppedMonitors = stoppedTasks(STOPPED)
    const agents = pairs.map(p => agentOf(p, listed.panes, seen, stoppedMonitors, at))
    await refreshStopped(live, at)
    agents.push(...stopped.filter(a => !live.has(a.id)))
    transcripts.keep(live)
    refreshProcs(agents, at)
    return agents
  }

  // `last` changes only once the write lands: one that failed (a full
  // runtime folder) is tried again next tick, even if nothing changed.
  function write(agents: Agent[]) {
    const body = JSON.stringify(agents)
    if (body === last) return false
    const tmp = join(run, `state.json.${pid}`)
    const state: AgentdState = { at: now(), agents }
    try {
      writeFileSync(tmp, JSON.stringify(state))
      renameSync(tmp, join(run, 'state.json'))
    } catch (err) {
      log.error('state not written', { path: tmp, err })
      throw err
    }
    last = body
    return true
  }

  // A failed beat only makes the tray say agentd isn't keeping up, so the
  // tick goes on.
  function beat() {
    const path = join(run, AGENTD_BEAT)
    try {
      writeFileSync(path, String(now()))
    } catch (err) {
      warnOnce(log, 'heartbeat not written', err, { path })
    }
  }

  async function markTabs(agents: Agent[], marked = marks) {
    await runEach(tabMarkArgs(agents, marked))
  }

  // A pane list taken now rather than at the start of the tick, so an unlink
  // aims at the index the tab is at now.
  async function unlinkWorkspaceTabs() {
    await runEach(hubUnlinkArgs(await listPanes()))
  }

  async function step() {
    const agents = await tick()
    write(agents)
    beat()
    await markTabs(agents)
    await unlinkWorkspaceTabs()
    return agents
  }

  async function clearTabs() {
    await markTabs([], (await panes()).marks)
  }

  return {
    tick,
    step,
    write,
    markTabs,
    unlinkWorkspaceTabs,
    clearTabs,
    scanNow: () => {
      procs = scanProcs()
      procsAt = now()
    },
  }
}
