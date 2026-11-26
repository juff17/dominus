// Ending the monitor's own process group leaves its session and the
// session's other monitors running. It's marked stopped so it leaves the
// board at once.

import { readFileSync, readdirSync } from 'node:fs'
import { type Fields, errCode, errorMessage } from '../core/log.ts'
import { t } from '../core/text.ts'
import { type Agent, type Monitor, type Proc, monitorProcess } from './classify.ts'
import { markStopped } from './client.ts'
import { readCmdline, statFields } from './procfs.ts'

export type StopWorld = {
  processes: () => Proc[]
  kill: (pid: number, signal: NodeJS.Signals) => unknown
  markStopped: (sessionId: string, task: string, command: string) => void
}

export type StopTarget = Pick<Monitor, 'task' | 'command'> & { agent: Pick<Agent, 'id' | 'pid'> }

// `unreadable` is why /proc couldn't be read, which the caller logs.
export type StopResult =
  | { ok: true; pid: number; group: boolean; unreadable?: unknown }
  | { ok: false; reason: 'no process'; unreadable?: unknown }
  | { ok: false; reason: 'kill failed'; pid: number; err: unknown; unreadable?: unknown }

export function processes(): Proc[] {
  const list: Proc[] = []
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const f = statFields(readFileSync(`/proc/${pid}/stat`, 'utf8'))
      list.push({ pid: Number(pid), ppid: Number(f[1]), pgid: Number(f[2]), start: Number(f[19]), cmdline: readCmdline(pid) })
    } catch (err) {
      // It ended between the listing and the read: not one to stop.
      if (errCode(err) !== 'ENOENT' && errCode(err) !== 'ESRCH') throw err
    }
  }
  return list
}

export const stopWorld = (): StopWorld => ({ processes, kill: (pid, signal) => process.kill(pid, signal), markStopped })

export function stopMonitor(m: StopTarget, w: StopWorld): StopResult {
  let p: Proc | null = null
  let unreadable: unknown
  try {
    p = monitorProcess(w.processes(), m.agent.pid, m.command)
  } catch (err) {
    unreadable = err
  }
  const why = unreadable === undefined ? {} : { unreadable }
  if (!p) return { ok: false, reason: 'no process', ...why }
  try {
    // A group of its own: the whole pipeline goes (tail, sleep, grep).
    w.kill(p.pgid === p.pid ? -p.pid : p.pid, 'SIGTERM')
    w.markStopped(m.agent.id, m.task, m.command)
    return { ok: true, pid: p.pid, group: p.pgid === p.pid, ...why }
  } catch (err) {
    return { ok: false, reason: 'kill failed', pid: p.pid, err, ...why }
  }
}

// What a stop tells the user and the log, the same from the hub and from
// Monitors: the footer's words and whether it went (ok), there was nothing
// to stop (gone) or it failed. `words` name the monitor and its session.
export type StopTold = { tone: 'ok' | 'gone' | 'failed'; text: string; level: 'info' | 'error'; message: string; fields: Fields }
export function describeStop(r: StopResult, m: Pick<StopTarget, 'task' | 'agent'>, words: { name: string; title: string }): StopTold {
  const ids = { id: m.agent.id, task: m.task }
  if (r.ok) return { tone: 'ok', text: t('hub.notes.monitorStopped', words), level: 'info', message: 'monitor stopped', fields: { ...ids, ok: true, pid: r.pid, group: r.group } }
  if (r.reason === 'no process') return { tone: 'gone', text: t('hub.notes.monitorNoProcess', words), level: 'info', message: 'monitor stopped', fields: { ...ids, ok: false, reason: 'no process' } }
  const err = String(errCode(r.err) ?? errorMessage(r.err))
  return { tone: 'failed', text: t('hub.notes.monitorStopFailed', { ...words, err }), level: 'error', message: 'monitor not stopped', fields: { ...ids, pid: r.pid, err: errorMessage(r.err) } }
}
