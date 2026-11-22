// One agent per Claude session, from its session file
// (~/.claude/sessions/<pid>.json) and its folded transcript (transcript.ts).
// Nothing here touches the world but Settings; the caller passes in the pane,
// the clock and whether a command still runs.

import { basename, relative } from 'node:path'
import * as text from '../core/text.ts'
import { type SettingKey, load as settings } from '../settings/settings.ts'
import type { Pane, Session, Subagent } from './daemon.ts'
import { firstLine, plain, promptLine, short } from './text.ts'
import type { Ended, MonitorEvent, ToolCall, ToolInput, Transcript, TranscriptMonitor } from './transcript.ts'

// tui/palette.ts STATE has a glyph for each.
export type AgentState = 'needs' | 'working' | 'done' | 'idle'
export type Need = 'question' | 'permission' | 'input' | 'monitor'
// term: a session in some other terminal.
export type AgentKind = 'tab' | 'bg' | 'term'
// tui/palette.ts MONITOR has a glyph for each.
export type MonitorState = 'action' | 'watching' | 'stale' | 'ended'

export type Monitor = {
  // <session id>:<task id>
  key: string
  task: string
  description: string
  // pr-babysit, pipeline-watch, log-watcher, or the command's program
  kind: string
  command: string
  state: MonitorState
  // whether its session is busy
  busy: boolean
  event: MonitorEvent | null
  startedAt: number
  ended: Ended | null
}

export type Agent = {
  id: string
  pid: number
  kind: AgentKind
  title: string
  repo: string
  worktree: string
  cwd: string
  branch: string
  state: AgentState
  need: Need | null
  // The subagent asking, by its description, when it isn't the session.
  via: string
  cmd: string
  // When the current tool started, or the state did.
  since: number
  stateSince: number
  prompt: string
  ctx: number
  model: string
  jobId: string | null
  pane: Pane | null
  // Watching something, so it lives in the monitors strip.
  monitor: boolean
  monitors: Monitor[]
  // A background agent with no process (agents/stopped.ts), in Idle until
  // it's restarted.
  stopped?: boolean
}

// null when unknown: a process list from before `since` can't have seen it.
export type Alive = (command: string, since: number) => boolean | null

// A tool call as one line, the way Claude Code prints it: Bash(npm test).
const ARGS: Record<string, (i: ToolInput, path: (p: unknown) => string) => unknown> = {
  Bash: i => firstLine(i.command),
  Read: (i, path) => path(i.file_path),
  Write: (i, path) => path(i.file_path),
  Edit: (i, path) => path(i.file_path),
  NotebookEdit: (i, path) => path(i.notebook_path),
  Grep: i => i.pattern,
  Glob: i => i.pattern,
  WebFetch: i => i.url,
  WebSearch: i => i.query,
  Agent: i => i.description,
  Task: i => i.description,
  Skill: i => i.skill,
  Monitor: i => i.description,
}

export function describeTool(tool: Pick<ToolCall, 'name' | 'input'> | null, cwd = ''): string {
  if (!tool) return ''
  const i = tool.input
  if (tool.name === 'AskUserQuestion') {
    const first: unknown = Array.isArray(i.questions) ? i.questions[0] : undefined
    return `? ${firstLine(typeof first === 'object' && first !== null && 'question' in first ? first.question : undefined)}`
  }
  const path = (p: unknown): string => {
    if (!p || typeof p !== 'string') return ''
    const r = cwd ? relative(cwd, p) : p
    return r.startsWith('..') ? p : r
  }
  const name = tool.name.startsWith('mcp__') ? `${tool.name.split('__').pop()} (MCP)` : tool.name
  const arg = Object.hasOwn(ARGS, tool.name) ? ARGS[tool.name](i, path) : ''
  return arg ? `${name}(${short(firstLine(arg), 120)})` : name
}

// The tool call in an agents.cmd.allow line, without the words round it.
export function permissionTool(cmd: string | null | undefined): string {
  const [before, after = ''] = text.t('agents.cmd.allow').split('{tool}')
  const s = cmd ?? ''
  return s.startsWith(before) && s.endsWith(after) && s.length >= before.length + after.length ? s.slice(before.length, s.length - after.length) : s
}

// The dialog may print a file relative, whole or by its name alone ("make
// this edit to board.ts?"), so only the name counts.
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit'])
// Enough of the argument to tell one call from another, and short enough
// that it's on screen before the dialog cuts a long command off.
const MARK_CHARS = 24
// How far above its first choice a dialog's tool call can be, in non-blank
// lines, and the rule Claude Code draws across the top of the dialog (or the
// corner of its box), above which is the conversation.
const DIALOG_LINES = 15
const DIALOG_TOP = /^\s*(─{8,}\s*$|╭─)/
const squash = (s: string): string => s.replace(/\s+/g, '')

// What of the tool call its dialog surely shows, without whitespace, as the
// dialog wraps and indents it.
function promptMark(cmd: string): string {
  const call = permissionTool(cmd)
  const mcp = call.match(/^(.+) \(MCP\)$/)
  if (mcp) return squash(mcp[1])
  const m = call.match(/^([^(]+)\((.+)\)$/s)
  if (!m) return squash(call)
  // describeTool cut a long one short with an ellipsis the dialog doesn't have.
  const [, name, arg] = m
  const whole = arg.replace(/…$/, '')
  return squash(FILE_TOOLS.has(name) ? basename(whole) : whole).slice(0, MARK_CHARS)
}

// Only when this dialog is on screen does 1 or Esc answer it: otherwise the
// key lands in Claude's input box, or answers another dialog whose first
// choice is Yes too (a plan, a question, or the next prompt, come since the
// row was read). Every allow and deny key checks this before pressing.
export function showsPermission(screen: string, cmd: string): boolean {
  const lines = screen.split('\n').filter(l => l.trim())
  const yes = lines.findLastIndex(l => /❯\s*1\.\s*Yes/.test(l))
  // In the last 15 non-blank lines, so not one scrolled up past output.
  if (yes < 0 || yes < lines.length - 15) return false
  const top = lines.slice(0, yes).findLastIndex(l => DIALOG_TOP.test(l))
  const dialog = lines.slice(Math.max(top + 1, yes - DIALOG_LINES), yes + 1)
  return squash(dialog.join('')).includes(promptMark(cmd))
}

// conflicts, GitLab's word, goes with conflict.
const tagSet = (key: Extract<SettingKey, 'hub.attention' | 'hub.broke'>): Set<string> => {
  const tags = new Set(settings()[key])
  if (tags.has('conflict')) tags.add('conflicts')
  return tags
}
export const attentionTags = (): Set<string> => tagSet('hub.attention')
export const brokeTags = (): Set<string> => tagSet('hub.broke')

export function monitorKind(command: string): string {
  if (/watch_pr\.py/.test(command)) return 'pr-babysit'
  if (/watch_logs\.py/.test(command)) return 'log-watcher'
  // pipeline-watch's watcher; the Monitors popup also knows it by the
  // /pipeline-watch its session started with (viewer/monitors/rows.ts).
  if (/watch_pipelines?\.py/.test(command)) return 'pipeline-watch'
  return basename(command.trim().split(/\s+/).find(w => !/^(python3?|node|bash|sh|-u)$/.test(w)) ?? 'monitor')
}

export type Proc = { pid: number; ppid: number; pgid: number; start: number; cmdline: string }

// Claude runs each monitor as a shell of its own, a child of the session's
// claude process that leads its own process group, as `eval '<command>'` (or
// `-c <command>` at the end, for other shells). The whole command must match:
// a Bash call that only mentions it mustn't be taken for it. The newest wins,
// as the strip shows only the latest monitor of a name.
export function monitorProcess(procs: Proc[], sessionPid: number, command: string | null | undefined): Proc | null {
  const cmd = command ?? ''
  if (!sessionPid || !cmd) return null
  const evald = `eval '${cmd.replaceAll("'", `'"'"'`)}'`
  const runs = (line: string) => line.includes(evald) || line.trimEnd().endsWith(` -c ${cmd}`)
  const mine = procs.filter(p => p.ppid === sessionPid && runs(p.cmdline))
  return mine.sort((a, b) => b.start - a.start)[0] ?? null
}

// A session and the tab it shows in, when that's another session's.
export type Paired = { session: Session; viewer: Session | null }

// A tab can park its conversation in a background job (parkedJobId) and
// then only shows it: its own session file and transcript stop where it
// parked. So the two are one agent: the job's session, with the tab's as
// `viewer`. A tab parked on a job that's gone is idle, not stuck where it
// stopped.
export function pairParked(list: Session[]): Paired[] {
  const jobs = new Set(list.flatMap(s => (s.jobId ? [s.jobId] : [])))
  const viewers = new Map<string, Session>()
  for (const s of list) if (s.parkedJobId && jobs.has(s.parkedJobId)) viewers.set(s.parkedJobId, s)
  return list.flatMap((s): Paired[] => {
    if (!s.parkedJobId) return [{ session: s, viewer: (s.jobId && viewers.get(s.jobId)) || null }]
    if (jobs.has(s.parkedJobId)) return []
    return [{ session: { ...s, status: 'idle' }, viewer: null }]
  })
}

// A worktree session runs in <repo>/.claude/worktrees/<name>.
export function repoOf(cwd: string): { repo: string; worktree: string } {
  const m = cwd.match(/^(.*)\/\.claude\/worktrees\/([^/]+)/)
  return m ? { repo: basename(m[1]), worktree: m[2] } : { repo: basename(cwd), worktree: '' }
}

// The session file's name counts only when it wasn't derived from the folder.
function nameOf(session: Session, t: Transcript): string {
  const given = session.nameSource === 'derived' ? '' : session.name
  const prompt = promptLine(t.prompt?.text)
  return (
    t.names.custom ||
    t.names.agent ||
    given ||
    t.names.ai ||
    (prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt) ||
    text.t('agents.cmd.newSession')
  )
}

// via: the subagent that made the call, '' for the session.
export type Asked = { tool: ToolCall; via: string }

const isAgentCall = (c: ToolCall): boolean => c.name === 'Agent' || c.name === 'Task'

// The tool call a waiting session is asking about, or null when it can't be
// told. A transcript doesn't say which pending call the dialog is for: a call
// that runs without asking (another subagent's, or one made beside it) is
// pending just the same. Naming the wrong one would let a/d answer a dialog
// for a call the card never showed, so only a call pending alone is taken;
// with more, the session reads as waiting for input. A pending Agent call
// counts only when nothing else is pending. A call made before `started`
// went with the last process (a subagent killed mid-call never gets its
// result), so it mustn't make every later prompt unclear.
export function askingAbout(t: Transcript, subs: Subagent[] = [], started = 0): Asked | null {
  const live = (c: ToolCall): boolean => c.at >= started
  const calls: Asked[] = [
    ...t.tools.filter(c => live(c) && !isAgentCall(c)).map(tool => ({ tool, via: '' })),
    ...subs.flatMap(s => s.t.tools.filter(live).map(tool => ({ tool, via: s.description }))),
  ]
  if (calls.length) return calls.length === 1 ? calls[0] : null
  const agents = t.tools.filter(c => live(c) && isAgentCall(c))
  return agents.length === 1 ? { tool: agents[0], via: '' } : null
}

type Status = 'waiting' | 'busy' | 'idle'
const statusOf = (session: Session): Status => (session.status === 'waiting' ? 'waiting' : session.status === 'busy' ? 'busy' : 'idle')

// What the session itself is doing, before its monitors have a say.
type Activity = { state: AgentState; need: Need | null; via: string; cmd: string; since: number }

function waiting(session: Session, t: Transcript, subs: Subagent[], since: number): Activity {
  const asked = askingAbout(t, subs, session.startedAt)
  if (!asked) {
    const what = session.waitingFor ?? text.t('agents.cmd.inputNeeded')
    return { state: 'needs', need: 'input', via: '', cmd: text.t('agents.cmd.waiting', { what }), since }
  }
  if (asked.tool.name === 'AskUserQuestion') return { state: 'needs', need: 'question', via: asked.via, cmd: describeTool(asked.tool), since }
  const cmd = text.t('agents.cmd.allow', { tool: describeTool(asked.tool, session.cwd) })
  return { state: 'needs', need: 'permission', via: asked.via, cmd, since }
}

// Calls made together that change things run one at a time, in order, so
// the oldest still pending is the one running.
function working(session: Session, t: Transcript, since: number): Activity {
  const tool = t.tools[0]
  if (!tool) return { state: 'working', need: null, via: '', cmd: text.t('agents.cmd.thinking'), since }
  return { state: 'working', need: null, via: '', cmd: describeTool(tool, session.cwd), since: tool.at }
}

// A finished turn is done until you review its reply, then idle.
function resting(t: Transcript, reviewedAt: number, since: number): Activity {
  const finished = t.turnEndAt !== 0 && t.turnEndAt >= (t.prompt?.at ?? 0)
  const cmd = plain(t.reply?.text) || (t.prompt ? `> ${promptLine(t.prompt.text)}` : text.t('agents.cmd.newSession'))
  return { state: finished && t.turnEndAt > reviewedAt ? 'done' : 'idle', need: null, via: '', cmd, since: finished ? t.turnEndAt : since }
}

type Shown = { m: TranscriptMonitor; ended: Ended | null }

// One monitor of each description. A running one wins over one that ended,
// newer or not: Claude can arm a monitor again without stopping the first,
// and once the newer one ends, the older one, still running, must show.
function latestMonitors(monitors: Shown[]): Shown[] {
  const latest = new Map<string, Shown>()
  const better = (a: Shown, b: Shown): boolean => (!a.ended && Boolean(b.ended)) || (!a.ended === !b.ended && a.m.at > b.m.at)
  for (const s of monitors) {
    const prev = latest.get(s.m.description)
    if (!prev || better(s, prev)) latest.set(s.m.description, s)
  }
  return [...latest.values()]
}

type MonitorContext = { session: Session; status: Status; state: AgentState; reviewedAt: number; alive: Alive; stopped: Set<string>; now: number }

function monitorState(m: TranscriptMonitor, event: MonitorEvent | null, ended: Ended | null, c: MonitorContext): MonitorState {
  if (ended) return 'ended'
  if (c.state === 'needs') return 'action'
  if (c.status === 'idle' && event && attentionTags().has(event.tag) && event.at > c.reviewedAt) return 'action'
  return c.alive(m.command, m.runningAt) === false ? 'stale' : 'watching'
}

function sessionMonitors(t: Transcript, c: MonitorContext): Monitor[] {
  // A monitor runs inside its session's process, so one armed before this
  // process started went with the last one, even when no notification said
  // so.
  const started = c.session.startedAt ?? 0
  // One you stopped leaves at once; one that ended on its own stays for
  // hub.endedFor minutes, so you see it went. Those that left are dropped
  // before one of each description is picked, so they can't hide another.
  const shown = Object.values(t.monitors).flatMap((m): Shown[] => {
    const ended = m.ended ?? (m.at < started ? { reason: 'restarted', at: started } : null)
    if (c.stopped.has(m.task) || ended?.reason === 'stopped') return []
    if (ended && c.now - ended.at > settings()['hub.endedFor'] * 60 * 1000) return []
    return [{ m, ended }]
  })
  const out: Monitor[] = []
  for (const { m, ended } of latestMonitors(shown)) {
    const event = m.events.at(-1) ?? null
    out.push({
      key: `${c.session.sessionId}:${m.task}`,
      task: m.task,
      description: m.description,
      kind: monitorKind(m.command),
      command: m.command,
      state: monitorState(m, event, ended, c),
      busy: c.status === 'busy',
      event,
      startedAt: m.at,
      ended,
    })
  }
  return out
}

export type ClassifyInput = {
  session: Session
  t: Transcript
  // Unfinished subagents, read only while it waits.
  subs?: Subagent[]
  pane?: Pane | null
  // When you last looked at the session's result.
  reviewedAt?: number
  alive?: Alive
  // Tasks the hub stopped.
  stopped?: Set<string>
  now?: number
}

export function classify({ session, t, subs = [], pane = null, reviewedAt = 0, alive = () => null, stopped = new Set(), now = Date.now() }: ClassifyInput): Agent {
  const { repo, worktree } = repoOf(session.cwd)
  const status = statusOf(session)
  const stateSince = session.statusUpdatedAt ?? session.startedAt ?? 0
  let act =
    status === 'waiting' ? waiting(session, t, subs, stateSince) : status === 'busy' ? working(session, t, stateSince) : resting(t, reviewedAt, stateSince)
  const monitors = sessionMonitors(t, { session, status, state: act.state, reviewedAt, alive, stopped, now })
  // A watching session lives in the monitors strip and shows in a lane only
  // when it needs you, as a monitor needing action makes it.
  const action = monitors.find(m => m.state === 'action')
  if (action && act.state !== 'needs')
    act = { state: 'needs', need: 'monitor', via: act.via, cmd: action.event ? action.event.line : action.description, since: action.event?.at ?? act.since }
  const bg = session.kind === 'bg' || session.kind === 'background'
  return {
    id: session.sessionId,
    pid: session.pid,
    kind: pane ? 'tab' : bg ? 'bg' : 'term',
    title: nameOf(session, t),
    repo,
    worktree,
    cwd: session.cwd,
    branch: t.branch,
    state: act.state,
    need: act.need,
    via: act.via,
    cmd: act.cmd,
    since: act.since,
    stateSince,
    prompt: promptLine(t.prompt?.text),
    ctx: t.ctx,
    model: t.model,
    jobId: session.jobId ?? null,
    pane,
    monitor: monitors.some(m => m.state !== 'ended'),
    monitors,
  }
}
