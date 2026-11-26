// What agentd decides, kept apart from its loop so it can be tested. Nothing
// here runs on import; the paths and process lookups it needs are passed in.

import { closeSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../core/json.ts'
import { errCode, logger, warnOnce } from '../core/log.ts'
import { procStart, readStat, readCmdline } from './procfs.ts'

export const log = logger('agentd')

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

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

// ------------------------------------------------------------ monitors

export function scanProcs(dir = '/proc'): string[] | null {
  const list: string[] = []
  try {
    for (const pid of readdirSync(dir)) {
      if (!/^\d+$/.test(pid)) continue
      try {
        list.push(readCmdline(pid, dir).trim())
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
