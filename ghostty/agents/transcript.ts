// Folds a session's transcript (~/.claude/projects/*/<id>.jsonl) one entry
// at a time, as agentd reads the file's new lines (daemon.ts). Nothing here
// touches the world but Settings' hub.maxEvents, read as events arrive.

import { type JsonRecord, isRecord } from '../core/json.ts'
import { load as settings } from '../settings/settings.ts'
import { firstLine } from './text.ts'

export type Said = { text: string; at: number }
export type ToolInput = Record<string, unknown>
export type ToolCall = { id: string; name: string; input: ToolInput; at: number }
export type MonitorEvent = { line: string; tag: string; at: number }
// reason: expired, stopped, restarted, or a notification's summary.
export type Ended = { reason: string; at: number }
// A Monitor call waiting for its result to name its task.
export type Armed = { description: string; command: string; at: number }
// `runningAt` is when its result said it started: a process scan from
// before then can't have seen it.
export type TranscriptMonitor = Armed & { task: string; runningAt: number; events: MonitorEvent[]; ended: Ended | null }
// custom is set with /rename, agent at launch (--name), and ai is the title
// Claude Code makes up itself.
export type Names = { custom: string; agent: string; ai: string }

export type Transcript = {
  prompt: Said | null
  reply: Said | null
  // Calls not yet answered by a result, oldest first. Claude can make several
  // in one turn: one slot for the latest would lose a call still asking for
  // permission behind one that already finished.
  tools: ToolCall[]
  turnEndAt: number
  ctx: number
  model: string
  branch: string
  // by task id
  monitors: Record<string, TranscriptMonitor>
  // Monitor tool_use id -> the call, until its result names the task
  armed: Record<string, Armed>
  // notifications seen queued and not yet delivered
  queued: string[]
  names: Names
}

export type Notification = { id: string; ids: string[]; summary: string; lines: string[] }

export function emptyTranscript(): Transcript {
  return {
    prompt: null,
    reply: null,
    tools: [],
    turnEndAt: 0,
    ctx: 0,
    model: '',
    branch: '',
    monitors: {},
    armed: {},
    queued: [],
    names: { custom: '', agent: '', ai: '' },
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const count = (v: unknown): number => (typeof v === 'number' ? v : 0)

const time = (e: JsonRecord): number => Date.parse(String(e.timestamp)) || 0
const HTML: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" }
const unescapeHtml = (s: string): string => s.replace(/&(lt|gt|amp|quot|#39);/g, (_, n: string) => HTML[n])

// The text a person typed, or null for the wrappers Claude Code puts in the
// user's turn: command output, reminders, task notifications.
function typed(content: unknown): string | null {
  if (Array.isArray(content)) {
    const block: unknown = content.find((b: unknown) => isRecord(b) && b.type === 'text')
    return isRecord(block) && typeof block.text === 'string' ? typed(block.text) : null
  }
  if (typeof content !== 'string') return null
  const command = content.match(/<command-name>([^<]*)<\/command-name>/)
  if (command) {
    const args = content.match(/<command-args>([^<]*)<\/command-args>/)?.[1] ?? ''
    return `${command[1]} ${args}`.trim()
  }
  if (content.startsWith('<') || content.startsWith('[Request interrupted')) return null
  return content
}

// A notification can name several tasks, such as the one a resumed session
// gets for every task its last process left running; `id` is the first.
export function parseNotification(text: string): Notification | null {
  const ids = [...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(m => m[1])
  const id = ids[0]
  if (!id) return null
  const summary = unescapeHtml(text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '')
  const event = text.match(/<event>([\s\S]*?)<\/event>/)?.[1]
  const lines = event === undefined ? [] : unescapeHtml(event).split('\n').map(l => l.trim()).filter(Boolean)
  return { id, ids, summary, lines }
}

// log-watcher's watch_logs.py reports every container or pod change as
// [status], harmless ones beside a service that died or can't start. This
// marks the latter as crash, the tag Settings' hub.broke and hub.attention
// know. Kubernetes reasons are matched in their case, so a lowercase pod name
// can't trip them.
const CRASHED = /\bexit code [1-9]|\bOOM|\brestarted \(\d+ total\)|BackOff\b|\b(?:[A-Z]\w*)?Error\b|\bErr[A-Z]\w*/

export function eventTag(line: string): string {
  const tag = line.match(/^\[([a-z-]+)\]/i)?.[1]?.toLowerCase() ?? ''
  return tag === 'status' && CRASHED.test(line) ? 'crash' : tag
}

// How a [pipeline] line ended, from the word after its tag ("[pipeline]
// failed for 3f2a…"), or '' for any other line.
export const pipelineResult = (line: string): string => line.match(/^\[pipeline\]\s+([a-z]+)/i)?.[1]?.toLowerCase() ?? ''

// A notification that arrives while Claude is busy is written twice: when
// it's queued and again when Claude reads it. The second copy is skipped by
// matching it to the first, so the same event happening twice still counts.
function addNotification(t: Transcript, text: string, at: number, queued = false): void {
  const raw = text.trim()
  if (queued) {
    t.queued.push(raw)
    if (t.queued.length > 50) t.queued.shift()
  } else {
    const i = t.queued.indexOf(raw)
    if (i >= 0) {
      t.queued.splice(i, 1)
      return
    }
  }
  const n = parseNotification(text)
  if (!n) return
  if (!n.summary.startsWith('Monitor event')) {
    // A watcher's last line comes with the notice that its stream ended
    // (pr-babysit's [merged] or [closed]), so it's an event like the others.
    const last = t.monitors[n.id]
    if (last) addEvents(last, n.lines, at)
    for (const id of n.ids) {
      const m = t.monitors[id]
      if (m) m.ended ??= { reason: firstLine(n.summary) || 'ended', at }
    }
    return
  }
  const m = t.monitors[n.id]
  if (m) addEvents(m, n.lines, at)
}

function addEvents(m: TranscriptMonitor, lines: readonly string[], at: number): void {
  for (const line of lines) {
    if (line.startsWith('[Monitor expired')) {
      m.ended = { reason: 'expired', at }
      continue
    }
    m.events.push({ line, tag: eventTag(line), at })
    while (m.events.length > settings()['hub.maxEvents']) m.events.shift()
  }
}

const NAMES: Record<string, [keyof Names, string]> = {
  'custom-title': ['custom', 'customTitle'],
  'agent-name': ['agent', 'agentName'],
  'ai-title': ['ai', 'aiTitle'],
}

function addName(t: Transcript, e: JsonRecord): void {
  if (typeof e.type !== 'string' || !Object.hasOwn(NAMES, e.type)) return
  const [which, field] = NAMES[e.type]
  const name = str(e[field])
  if (name) t.names[which] = name
}

function addToolUse(t: Transcript, b: JsonRecord, at: number): void {
  const input = isRecord(b.input) ? b.input : {}
  const id = str(b.id)
  t.tools = [...t.tools.filter(c => c.id !== id), { id, name: str(b.name), input, at }]
  if (b.name === 'Monitor') t.armed[id] = { description: str(input.description), command: str(input.command), at }
  if (b.name === 'TaskStop') {
    const m = t.monitors[str(input.task_id ?? input.shell_id)]
    if (m) m.ended = { reason: 'stopped', at }
  }
}

function addAssistant(t: Transcript, msg: JsonRecord, at: number): void {
  if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>') t.model = msg.model
  const u = msg.usage
  if (isRecord(u)) t.ctx = count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens)
  const blocks: unknown[] = Array.isArray(msg.content) ? msg.content : []
  for (const b of blocks) {
    if (!isRecord(b)) continue
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) t.reply = { text: b.text, at }
    if (b.type === 'tool_use') addToolUse(t, b, at)
  }
  if (msg.stop_reason === 'end_turn') t.turnEndAt = at
}

// A Monitor's result names the task it runs as.
function addToolResult(t: Transcript, b: JsonRecord, at: number): void {
  const id = str(b.tool_use_id)
  t.tools = t.tools.filter(c => c.id !== id)
  const armed = t.armed[id]
  if (!armed) return
  delete t.armed[id]
  const c = b.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: unknown) => (isRecord(x) ? str(x.text) : '')).join('') : ''
  const task = text.match(/task (\w+)/)?.[1]
  if (task) t.monitors[task] = { task, ...armed, runningAt: at, events: [], ended: null }
}

function addUser(t: Transcript, content: unknown, at: number): void {
  if (typeof content === 'string' && content.startsWith('<task-notification>')) {
    addNotification(t, content, at)
    return
  }
  if (Array.isArray(content)) {
    const results = content.filter((b: unknown): b is JsonRecord => isRecord(b) && b.type === 'tool_result')
    for (const b of results) addToolResult(t, b, at)
    // A tool result can carry text with it (a skill's instructions); that's
    // Claude Code talking, not you.
    if (results.length) return
  }
  const prompt = typed(content)
  if (prompt !== null) t.prompt = { text: prompt, at }
  // A prompt, or an interrupt, ends every call in flight.
  const interrupted = typeof content === 'string' && content.startsWith('[Request interrupted')
  if (prompt !== null || interrupted) t.tools = []
}

// Entries arrive in file order, so the latest of each kind wins.
export function addEntry(t: Transcript, entry: unknown): void {
  if (!isRecord(entry)) return
  const at = time(entry)
  addName(t, entry)
  if (typeof entry.gitBranch === 'string' && entry.gitBranch) t.branch = entry.gitBranch
  if (entry.type === 'queue-operation') {
    const queued = entry.content
    if (entry.operation === 'enqueue' && typeof queued === 'string' && queued.startsWith('<task-notification>')) addNotification(t, queued, at, true)
    return
  }
  const msg = entry.message
  if (!isRecord(msg)) return
  if (entry.type === 'assistant') addAssistant(t, msg, at)
  else if (entry.type === 'user' && !entry.isMeta) addUser(t, msg.content, at)
}
