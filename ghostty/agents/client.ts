// The clients' side of agentd: start it, stay registered so it keeps
// running, and follow state.json.

import { spawn } from 'node:child_process'
import { type FSWatcher, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { errCode, logger } from '../core/log.ts'
import { RUN, conf } from '../core/paths.ts'
import type { AgentdState } from './tick.ts'
import { warnOnce } from './warn.ts'

export { RUN }

const log = logger('client')

export function alivePid(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errCode(err) === 'EPERM'
  }
}

// A copy started while another is starting finds the pid file taken and exits.
export function ensureDaemon(): void {
  const pidFile = join(RUN, 'agentd.pid')
  let pid = 0
  try {
    pid = Number(readFileSync(pidFile, 'utf8'))
  } catch (err) {
    warnOnce(log, 'agentd pid unreadable', err, { path: pidFile })
  }
  if (alivePid(pid)) return
  const child = spawn(process.execPath, [conf('agents/agentd.ts')], { detached: true, stdio: 'ignore' })
  child.unref()
  log.info('agentd starting', { pid: child.pid, stalePid: pid || undefined })
}

// agentd writes state.json, so only its outline is checked: a file that
// parses to something else is one being replaced by another version.
const isState = (v: unknown): v is AgentdState =>
  typeof v === 'object' && v !== null && 'at' in v && typeof v.at === 'number' && 'agents' in v && Array.isArray(v.agents)

export function readState(): AgentdState | null {
  const path = join(RUN, 'state.json')
  try {
    const state: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (isState(state)) return state
    warnOnce(log, 'state unreadable', new Error('not an agentd state'), { path })
  } catch (err) {
    warnOnce(log, 'state unreadable', err, { path })
  }
  return null
}

// Checks every few seconds that agentd still runs: it exits when it finds no
// clients for a while, and a client can outlive a crash of it. The returned
// stop function is for tests; the hub and the rail follow until they exit.
export function follow(onState: (state: AgentdState) => void): () => void {
  mkdirSync(join(RUN, 'clients'), { recursive: true })
  const me = join(RUN, 'clients', String(process.pid))
  writeFileSync(me, '')
  process.on('exit', () => {
    try {
      unlinkSync(me)
    } catch (err) {
      warnOnce(log, 'client file not removed', err, { path: me })
    }
  })
  ensureDaemon()
  let at = 0
  const check = () => {
    const s = readState()
    if (s && s.at !== at) {
      at = s.at
      onState(s)
    }
  }
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(RUN, (_, name) => name === 'state.json' && check())
  } catch (err) {
    // Without the watch, the three-second check below still follows.
    warnOnce(log, 'state not watched', err, { path: RUN })
  }
  const timer = setInterval(() => {
    writeFileSync(me, '')
    ensureDaemon()
    check()
  }, 3000)
  check()
  return () => {
    clearInterval(timer)
    watcher?.close()
  }
}

// So the monitor leaves the board at once rather than lingering as ended.
// The session sees only that its watcher died and re-arms it; the request
// in stop-requests/ makes the watcher it starts say the user stopped it
// (hub-plugin/lib/py/agent_hub/stops.py).
export function markStopped(sessionId: string, task: string, command: string): void {
  const name = `${sessionId}.${task}`
  for (const [dir, text] of [['stopped', ''], ['stop-requests', command]]) {
    const path = join(RUN, dir, name)
    try {
      mkdirSync(join(RUN, dir), { recursive: true })
      writeFileSync(path, text)
    } catch (err) {
      warnOnce(log, 'stop mark not written', err, { path })
    }
  }
}

export function markReviewed(id: string): void {
  const path = join(RUN, 'reviewed', id)
  try {
    mkdirSync(join(RUN, 'reviewed'), { recursive: true })
    writeFileSync(path, '')
  } catch (err) {
    warnOnce(log, 'review mark not written', err, { path })
  }
}
