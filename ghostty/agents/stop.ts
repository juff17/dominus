// Ending the monitor's own process group leaves its session and the
// session's other monitors running. It's marked stopped so it leaves the
// board at once.

import { readFileSync, readdirSync } from 'node:fs'
import { errCode } from '../core/log.ts'
import { type Agent, type Monitor, type Proc, monitorProcess } from './classify.ts'
import { markStopped } from './client.ts'

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

// Fields are read after the last ')' in /proc/<pid>/stat, since the command
// name can itself hold spaces and parentheses.
export function processes(): Proc[] {
  const list: Proc[] = []
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
      list.push({ pid: Number(pid), ppid: Number(f[1]), pgid: Number(f[2]), start: Number(f[19]), cmdline })
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
