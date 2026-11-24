// What agentd decides, kept apart from its loop so it can be tested. Nothing
// here runs on import; the paths and process lookups it needs are passed in.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../core/json.ts'
import { errCode, logger } from '../core/log.ts'
import { MONITOR, STATE } from '../tui/term.ts'
import type { AgentState } from './classify.ts'
import { type Transcript, addEntry, emptyTranscript } from './transcript.ts'
import { warnOnce } from './warn.ts'

const log = logger('agentd')

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

// ------------------------------------------------------------ /proc

// The fields after a /proc/<pid>/stat's command name, which can hold spaces
// and parens, so it's cut at the last ')'. Index 1 is the parent pid, 19 the
// start time (fields 4 and 22 of the whole line).
const statFields = (stat: string): string[] => stat.slice(stat.lastIndexOf(')') + 2).split(' ')
export const procStart = (stat: string): string => statFields(stat)[19]
export const parentPid = (stat: string): number => Number(statFields(stat)[1])

const readStat = (pid: number): string => readFileSync(`/proc/${pid}/stat`, 'utf8')

// ------------------------------------------------------------ singleton

export function claim(pidFile: string, pid: number, alivePid: (pid: number) => boolean): boolean {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(pidFile, 'wx')
      writeFileSync(fd, String(pid))
      closeSync(fd)
      return true
    } catch (err) {
      // EEXIST is the usual case: some copy holds it, live or not.
      if (errCode(err) !== 'EEXIST') warnOnce(log, 'pid file not created', err, { path: pidFile })
      let held = 0
      let age = Number.POSITIVE_INFINITY
      try {
        held = Number(readFileSync(pidFile, 'utf8')) || 0
        age = Date.now() - statSync(pidFile).mtimeMs
      } catch (err) {
        warnOnce(log, 'pid file unreadable', err, { path: pidFile })
      }
      if (alivePid(held)) return false
      // Empty and new: another copy is between creating it and writing to it.
      if (!held && age < 2000) return false
      try {
        unlinkSync(pidFile)
      } catch (err) {
        warnOnce(log, 'stale pid file not removed', err, { path: pidFile })
      }
    }
  }
  return false
}

// Two copies that both found a stale file can both win claim(): the second
// removes the file the first just made, then makes its own. Checked each
// pass, so the one the file no longer names steps aside.
export function holds(pidFile: string, pid: number, alivePid: (pid: number) => boolean): boolean {
  try {
    return Number(readFileSync(pidFile, 'utf8')) === pid
  } catch (err) {
    if (errCode(err) === 'ENOENT') return claim(pidFile, pid, alivePid)
    // Unreadable says nothing about who holds it: keep running.
    warnOnce(log, 'pid file unreadable', err, { path: pidFile })
    return true
  }
}

export function release(pidFile: string, pid: number): void {
  try {
    if (Number(readFileSync(pidFile, 'utf8')) === pid) unlinkSync(pidFile)
  } catch (err) {
    warnOnce(log, 'pid file not released', err, { path: pidFile })
  }
}

// ------------------------------------------------------------ sessions

// ~/.claude/sessions/<pid>.json, the fields the hub reads.
export type Session = {
  sessionId: string
  pid: number
  cwd: string
  // interactive, or bg or background for a background job
  kind?: string
  // busy, waiting or idle
  status?: string
  statusUpdatedAt?: number
  startedAt?: number
  // The process's start time, from its /proc stat, when the file was written.
  procStart?: string | number
  // In Claude Code's words.
  waitingFor?: string
  name?: string
  // derived when name is only the folder's
  nameSource?: string
  // A background job's id, and the job a tab parked its conversation in.
  jobId?: string
  parkedJobId?: string
  // <session>:<window id>.<pane id> on the tmux server it started in
  tmux?: string
}

// Claude always writes cwd; one without reads as ''.
function toSession(v: unknown): Session | null {
  if (!isRecord(v)) return null
  const { sessionId, pid } = v
  if (typeof sessionId !== 'string' || !sessionId || typeof pid !== 'number' || !pid) return null
  const procStart = typeof v.procStart === 'number' ? v.procStart : str(v.procStart)
  return {
    sessionId,
    pid,
    cwd: str(v.cwd) ?? '',
    kind: str(v.kind),
    status: str(v.status),
    statusUpdatedAt: num(v.statusUpdatedAt),
    startedAt: num(v.startedAt),
    procStart,
    waitingFor: str(v.waitingFor),
    name: str(v.name),
    nameSource: str(v.nameSource),
    jobId: str(v.jobId),
    parkedJobId: str(v.parkedJobId),
    tmux: str(v.tmux),
  }
}

// A session file outlives a crashed process, and a pid can be reused, so the
// process must still be the one that wrote it.
export function sessions(dir: string, stat: (pid: number) => string = readStat): Session[] {
  let names: string[] = []
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.json'))
  } catch (err) {
    warnOnce(log, 'sessions folder unreadable', err, { path: dir })
    return []
  }
  const list: Session[] = []
  for (const name of names) {
    try {
      const s = toSession(JSON.parse(readFileSync(join(dir, name), 'utf8')))
      if (!s) {
        warnOnce(log, 'session file skipped', new Error('not a session object'), { path: join(dir, name) })
        continue
      }
      const start = procStart(stat(s.pid))
      if (s.procStart && String(s.procStart) !== start) continue
      list.push(s)
    } catch (err) {
      // A session whose process is gone has no /proc stat: ENOENT, debug.
      warnOnce(log, 'session file skipped', err, { path: join(dir, name) })
    }
  }
  return list
}

// ------------------------------------------------------------ transcripts

type SessionRef = Pick<Session, 'sessionId' | 'cwd'>

export function findTranscript(projects: string, s: SessionRef): string | null {
  const guess = join(projects, s.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${s.sessionId}.jsonl`)
  if (existsSync(guess)) return guess
  try {
    for (const dir of readdirSync(projects)) {
      const p = join(projects, dir, `${s.sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch (err) {
    warnOnce(log, 'projects folder unreadable', err, { path: projects })
  }
  return null
}

// `rest` is the bytes of a line not yet whole.
type Tail = { path: string; offset: number; rest: Buffer; t: Transcript }
// subs by file name
type SessionTail = Tail & { subs: Map<string, Tail> }

export type Subagent = { description: string; t: Transcript }

export type TranscriptReader = {
  read(s: SessionRef): Transcript
  subagents(s: SessionRef): Subagent[]
  keep(live: Set<string>): void
  cached(): string[]
}

const newTail = (path: string): Tail => ({ path, offset: 0, rest: Buffer.alloc(0), t: emptyTranscript() })

// A chunk at a time, decoding only whole lines: a long session's file can be
// bigger than one string may be, and a character can straddle two reads.
function tail(tr: Tail, chunk: number): Transcript {
  let size: number
  try {
    size = statSync(tr.path).size
  } catch (err) {
    warnOnce(log, 'transcript unreadable', err, { path: tr.path })
    return tr.t
  }
  if (size < tr.offset) Object.assign(tr, { offset: 0, rest: Buffer.alloc(0), t: emptyTranscript() })
  if (size === tr.offset) return tr.t
  const fd = openSync(tr.path, 'r')
  try {
    const buf = Buffer.alloc(chunk)
    while (tr.offset < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - tr.offset), tr.offset)
      if (n <= 0) break
      tr.offset += n
      const data = Buffer.concat([tr.rest, buf.subarray(0, n)])
      const end = data.lastIndexOf(10)
      tr.rest = Buffer.from(end < 0 ? data : data.subarray(end + 1))
      if (end >= 0) readLines(tr.t, data.subarray(0, end).toString('utf8'), tr.path)
    }
  } finally {
    closeSync(fd)
  }
  return tr.t
}

// A background subagent asks for permission in its own transcript,
// subagents/agent-<id>.jsonl beside the session's, while the session's own
// turn may have ended long ago. Their .meta.json says which have finished.
// Kept in tr.subs, so the next wait reads just what was added.
function readSubagents(tr: SessionTail, chunk: number): Subagent[] {
  const dir = join(tr.path.replace(/\.jsonl$/, ''), 'subagents')
  let files: string[] = []
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
  } catch (err) {
    warnOnce(log, 'subagents folder unreadable', err, { path: dir })
    return []
  }
  const out: Subagent[] = []
  for (const f of files) {
    const path = join(dir, f)
    let meta: unknown = {}
    try {
      meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
    } catch (err) {
      warnOnce(log, 'subagent meta unreadable', err, { path })
    }
    if (isRecord(meta) && meta.finished) {
      tr.subs.delete(f)
      continue
    }
    let sub = tr.subs.get(f)
    if (!sub) {
      sub = newTail(path)
      tr.subs.set(f, sub)
    }
    out.push({ description: (isRecord(meta) && str(meta.description)) || '', t: tail(sub, chunk) })
  }
  return out
}

// `chunk` is the read size, a parameter so tests can make lines straddle reads.
export function transcriptReader(projects: string, chunk = 1 << 20): TranscriptReader {
  const transcripts = new Map<string, SessionTail>()
  return {
    read(s) {
      let tr = transcripts.get(s.sessionId)
      if (!tr) {
        const path = findTranscript(projects, s)
        if (!path) return emptyTranscript()
        tr = { ...newTail(path), subs: new Map() }
        transcripts.set(s.sessionId, tr)
      }
      return tail(tr, chunk)
    },
    // Call after read(s).
    subagents(s) {
      const tr = transcripts.get(s.sessionId)
      return tr ? readSubagents(tr, chunk) : []
    },
    // Forgets the sessions that are gone, so a new one with a reused id starts over.
    keep(live) {
      for (const id of transcripts.keys()) if (!live.has(id)) transcripts.delete(id)
    },
    cached: () => [...transcripts.keys()],
  }
}

// Lines that can't matter (the request snapshots, which are most of the file)
// skip JSON parsing.
const WANTED = ['"type":"assistant"', '"type":"user"', '"queue-operation"', '-title"', '"type":"agent-name"']

export function readLines(t: Transcript, text: string, path = ''): void {
  for (const line of text.split('\n')) {
    if (line.startsWith('{"type":"api-request')) continue
    if (!WANTED.some(w => line.includes(w))) continue
    try {
      addEntry(t, JSON.parse(line))
    } catch (err) {
      warnOnce(log, 'transcript line skipped', err, { path })
    }
  }
}

// ------------------------------------------------------------ tmux

export const PANE_FORMAT =
  '#{pane_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{window_active}\t#{session_attached}\t#{@agent} #{@agent_fg}\t#{pane_pid}'
// For list-panes -a on the layout server.
export const HUB_SHOWN_FORMAT = '#{session_name} #{window_name} #{window_active} #{pane_id}'

// `wins`: the Ghostty windows showing their hub or the diagrams window rather
// than their workspace. `panes`: the layout panes in a hub that's in front.
// The hub's open session (peek-N) runs in layout pane %N, so going to the
// workspace leaves the peek attached, out of sight.
export type HubShown = { wins: Set<number>; panes: Set<string> }

export function parseHubShown(text: string | null): HubShown {
  const shown: HubShown = { wins: new Set(), panes: new Set() }
  for (const line of (text ?? '').split('\n')) {
    const [session, name, active, pane] = line.split(' ')
    if (active !== '1' || (name !== 'hub' && name !== 'diagrams')) continue
    shown.wins.add(Number(session.replace(/^layout-/, '')))
    if (name === 'hub' && pane) shown.panes.add(pane)
  }
  return shown
}

export const sessionRank = (name: string): number => (/^ghostty-\d+$/.test(name) ? 2 : /^hubtabs-\d+$/.test(name) ? 1 : 0)

// A tab's pane on the tab server.
export type Pane = {
  // %N
  pane: string
  // The tmux session it belongs to (parsePanes says which).
  session: string
  // N in ghostty-N.
  win: number
  // @N
  window: string
  tab: number
  // The pane's shell.
  pid: number
  // Only the hub's tab session has it.
  hub: boolean
  // In front of an attached session that's in sight (inSight).
  looked: boolean
}

// marks: each window's `<glyph> <color>` as tmux has them now.
export type PaneList = { panes: Map<string, Pane>; marks: Map<string, string> }

// A workspace session is in sight in a window not showing its hub, a peek in
// a hub that shows. Other sessions count as in sight.
function inSight(rank: number, session: string, win: number, hub: HubShown): boolean {
  if (rank === 2) return !hub.wins.has(win)
  const peek = /^peek-(\d+)$/.exec(session)?.[1]
  return peek === undefined || hub.panes.has(`%${peek}`)
}

export function parsePanes(text: string | null, hub: HubShown): PaneList {
  const panes = new Map<string, Pane>()
  const marks = new Map<string, string>()
  for (const line of (text ?? '').split('\n')) {
    const [pane, session, window, index, active, attached, mark, pid] = line.split('\t')
    if (!pane) continue
    if (mark?.trim()) marks.set(window, mark)
    const seen = panes.get(pane)
    // A tab shows in up to three sessions: the workspace's (ghostty-N), the
    // hub's tab session (hubtabs-N), and the peek session grouped with that.
    // The pane belongs to the first of those it's in.
    const rank = sessionRank(session)
    const win = Number(session.match(/^(?:ghostty|hubtabs)-(\d+)$/)?.[1] ?? seen?.win ?? 0)
    const looked = active === '1' && Number(attached) > 0 && inSight(rank, session, win, hub)
    if (!seen || rank > sessionRank(seen.session))
      panes.set(pane, {
        pane,
        session,
        win,
        window,
        tab: Number(index),
        pid: Number(pid),
        hub: rank === 1,
        looked: looked || Boolean(seen?.looked),
      })
    else if (looked) seen.looked = true
  }
  return { panes, marks }
}

// Each window's command goes to tmux on its own: the windows come from a pane
// list taken earlier in the tick, and in a ';' list a window closed since
// then fails its command and skips every one after it. `marked` is what tmux
// has now rather than memory, so a mark that something else cleared (a tab
// server that restarted and reused window ids) is put back.
const RANK: Record<AgentState, number> = { needs: 0, working: 1, done: 2, idle: 3 }

export type MarkedAgent = { state: AgentState; monitor?: boolean; pane?: Pick<Pane, 'window'> | null }

export function tabMarkArgs(agents: readonly MarkedAgent[], marked: Map<string, string> = new Map()): string[][] {
  const want = new Map<string, { rank: number; value: string }>()
  for (const a of agents) {
    if (!a.pane) continue
    const look = a.monitor && a.state !== 'needs' ? MONITOR.watching : STATE[a.state]
    const prev = want.get(a.pane.window)
    if (!prev || RANK[a.state] < prev.rank) want.set(a.pane.window, { rank: RANK[a.state], value: `${look.glyph} ${look.color}` })
  }
  const commands: string[][] = []
  for (const [win, { value }] of want) {
    if (marked.get(win) === value) continue
    const [glyph, color] = value.split(' ')
    commands.push(['set', '-w', '-t', win, '@agent', glyph, ';', 'set', '-w', '-t', win, '@agent_fg', color])
  }
  for (const win of marked.keys()) {
    if (!want.has(win)) commands.push(['set', '-wu', '-t', win, '@agent', ';', 'set', '-wu', '-t', win, '@agent_fg'])
  }
  return commands
}

// The hub's tab session, hubtabs-N, holds the hub's own tabs only: a
// workspace tab (ghostty-N) stays in the workspace, and the hub sends you
// there to see it (hub/peek.ts). Versions before that linked the workspace's
// Claude tabs into hubtabs-N, so a tab server started then still has them:
// each is unlinked, which leaves it in the workspace. One command each, for
// tabMarkArgs' reason, highest index first, as renumber-windows moves the
// tabs after one that goes. Unlinking a session's last tab ends the session.
export function hubUnlinkArgs(text: string | null): string[][] {
  if (text == null) return []
  const work = new Set<string>()
  // `hubtabs-N:index` → window; a window with several panes lists once each.
  const hub = new Map<string, { index: number; window: string }>()
  for (const line of text.split('\n')) {
    const [, session, window, index] = line.split('\t')
    if (!window) continue
    if (/^ghostty-\d+$/.test(session)) work.add(window)
    else if (/^hubtabs-\d+$/.test(session)) hub.set(`=${session}:${index}`, { index: Number(index), window })
  }
  return [...hub]
    .filter(([, tab]) => work.has(tab.window))
    .sort(([, a], [, b]) => b.index - a.index)
    .map(([target]) => ['unlink-window', '-t', target])
}

// Pane ids repeat across tmux servers, so a session's pane only counts when
// the session's own tmux names this server's session and window, and Claude
// runs under the pane's process. Claude records whichever session the pane
// was in when it started, which can be a peek-N or hubtabs-N. Those hold the
// tab session's windows too, so they count, even after the peek is gone. It
// can also be term-<job>, a background agent's terminal popup
// (bin/ghostty-term), whose window Ctrl+Shift+T moves into the workspace
// with Claude still in it.
export function paneOf(s: Pick<Session, 'tmux' | 'pid'>, panes: Map<string, Pane>, parent = (pid: number) => parentPid(readStat(pid))): Pane | null {
  const m = String(s.tmux ?? '').match(/^([^:]+):(@\d+)\.(%\d+)$/)
  const p = m && panes.get(m[3])
  if (!m || !p || (p.session !== m[1] && !/^(?:(?:peek|hubtabs)-\d+|term-[\w-]+)$/.test(m[1])) || p.window !== m[2]) return null
  let pid = s.pid
  for (let i = 0; i < 16 && pid > 1; i++) {
    if (pid === p.pid) return p
    try {
      pid = parent(pid)
    } catch (err) {
      warnOnce(log, 'parent process unreadable', err, { pid })
      return null
    }
  }
  return null
}

// ------------------------------------------------------------ monitors

export function scanProcs(dir = '/proc'): string[] | null {
  const list: string[] = []
  try {
    for (const pid of readdirSync(dir)) {
      if (!/^\d+$/.test(pid)) continue
      try {
        list.push(readFileSync(join(dir, pid, 'cmdline'), 'utf8').replaceAll('\0', ' ').trim())
      } catch (err) {
        warnOnce(log, 'process command line unreadable', err, { pid: Number(pid) })
      }
    }
  } catch (err) {
    warnOnce(log, 'process list unreadable', err, { path: dir })
    return null
  }
  return list
}

// A monitor's command without the redirect or pipe its tool added, which the
// process's own command line doesn't have.
export const coreOf = (cmd: string | undefined): string => String(cmd).replace(/\s*(2>&1|\|.*)\s*$/, '').trim()

// null when it can't tell: no process scan, or nothing left to look for.
export function aliveIn(procs: string[] | null, cmd: string): boolean | null {
  if (!procs) return null
  const core = coreOf(cmd)
  return core ? procs.some(p => p.includes(core)) : null
}

// ------------------------------------------------------------ reviews

// A file per session in reviewed/, touched by the hub, and by agentd while a
// session's tab is in front. Only the live sessions' are read, since the
// folder keeps every session's since boot until pruneReviews.
export function reviews(dir: string, ids: Iterable<string>): Map<string, number> {
  const map = new Map<string, number>()
  for (const id of ids) {
    try {
      map.set(id, statSync(join(dir, id)).mtimeMs)
    } catch (err) {
      if (errCode(err) !== 'ENOENT') warnOnce(log, 'review mark unreadable', err, { path: join(dir, id) })
    }
  }
  return map
}

// Not at once: a session file caught mid-write drops a live session for a
// tick, and a session resumed soon after keeps its mark.
export const REVIEW_KEEP_MS = 24 * 60 * 60 * 1000

export function pruneReviews(dir: string, live: Set<string>, now = Date.now(), keep = REVIEW_KEEP_MS): number {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch (err) {
    warnOnce(log, 'reviewed folder unreadable', err, { path: dir })
    return 0
  }
  let removed = 0
  for (const id of names) {
    if (live.has(id)) continue
    const path = join(dir, id)
    try {
      if (now - statSync(path).mtimeMs < keep) continue
      unlinkSync(path)
      removed++
    } catch (err) {
      warnOnce(log, 'review mark not removed', err, { path })
    }
  }
  return removed
}

export function review(dir: string, id: string): void {
  try {
    writeFileSync(join(dir, id), '')
  } catch (err) {
    warnOnce(log, 'review mark not written', err, { path: join(dir, id) })
  }
}

// Files <session id>.<task id>, written by markStopped (client.ts).
export function stoppedTasks(dir: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  try {
    for (const name of readdirSync(dir)) {
      const [session, task] = name.split('.')
      if (!task) continue
      const tasks = map.get(session) ?? new Set()
      map.set(session, tasks.add(task))
    }
  } catch (err) {
    warnOnce(log, 'stopped folder unreadable', err, { path: dir })
  }
  return map
}

// ------------------------------------------------------------ clients

// A client is a process, named by its pid in clients/, or the tray widget,
// which can't stay registered as a process: it touches clients/tray each
// time it asks for a snapshot (tray.ts), so a fresh file counts.
export const TRAY_FRESH_MS = 15000

function clientAlive(dir: string, name: string, alivePid: (pid: number) => boolean, now: number): boolean {
  const path = join(dir, name)
  if (!/^\d+$/.test(name)) {
    try {
      return now - statSync(path).mtimeMs < TRAY_FRESH_MS
    } catch (err) {
      warnOnce(log, 'client file unreadable', err, { path })
      return false
    }
  }
  if (alivePid(Number(name))) return true
  try {
    unlinkSync(path)
  } catch (err) {
    warnOnce(log, 'dead client file not removed', err, { path })
  }
  return false
}

export function clientsAlive(dir: string, alivePid: (pid: number) => boolean, now = Date.now()): boolean {
  try {
    return readdirSync(dir).some(name => clientAlive(dir, name, alivePid, now))
  } catch (err) {
    warnOnce(log, 'clients folder unreadable', err, { path: dir })
    return false
  }
}
