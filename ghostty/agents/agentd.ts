#!/usr/bin/env node
// agentd: the one process that watches every Claude session, so a hub and a
// rail in each window cost no more than one. Each tick (tick.ts) writes
// state.json, which the hub and the rails read (client.ts); this is the
// process around it. It exits once no client is registered in clients/, and a
// second copy exits at once, so starting it is safe.
//   agentd.ts [--once]   --once prints one state to stdout and exits

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../core/log.ts'
import { RUN, alivePid } from './client.ts'
import { claim, clientsAlive, holds, release } from './daemon.ts'
import { type Agentd, TICK_MS, createAgentd } from './tick.ts'

const IDLE_EXIT_MS = 15000
const ONCE = process.argv.includes('--once')

const PID_FILE = join(RUN, 'agentd.pid')
const CLIENTS = join(RUN, 'clients')
const REVIEWED = join(RUN, 'reviewed')
const STOPPED = join(RUN, 'stopped')

const log = logger('agentd')

// A signal ends the loop after the tick in hand, so the tab glyphs are
// cleared on the way out; a second one, for a tmux that hangs, exits at once.
function signals(): { signal: () => NodeJS.Signals | null; sleep: (ms: number) => Promise<void> } {
  let signal: NodeJS.Signals | null = null
  let wake = () => {}
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
    process.on(sig, () => {
      if (signal) {
        log.warn('stopped before tabs cleared', { pid: process.pid, signal: sig })
        process.exit(0)
      }
      signal = sig
      wake()
    })
  const sleep = (ms: number) =>
    new Promise<void>(resolve => {
      const t = setTimeout(resolve, ms)
      wake = () => {
        clearTimeout(t)
        resolve()
      }
    })
  return { signal: () => signal, sleep }
}

async function step(agentd: Agentd): Promise<void> {
  const started = performance.now()
  try {
    const agents = await agentd.step()
    if (log.enabled('debug')) log.debug('tick', { ms: Math.round(performance.now() - started), agents: agents.length })
  } catch (err) {
    log.error('tick failed', { ms: Math.round(performance.now() - started), err })
    process.stderr.write(`agentd: ${err instanceof Error ? (err.stack ?? err) : err}\n`)
  }
}

async function loop(agentd: Agentd, { signal, sleep }: ReturnType<typeof signals>): Promise<'replaced' | null> {
  let lonelySince = 0
  while (!signal()) {
    if (!holds(PID_FILE, process.pid, alivePid)) return 'replaced'
    await step(agentd)
    if (clientsAlive(CLIENTS, alivePid)) lonelySince = 0
    else if (!lonelySince) lonelySince = Date.now()
    else if (Date.now() - lonelySince > IDLE_EXIT_MS) return null
    if (signal()) return null
    await sleep(TICK_MS)
  }
  return null
}

async function main(): Promise<void> {
  const agentd = createAgentd()
  if (ONCE) {
    agentd.scanNow()
    process.stdout.write(`${JSON.stringify(await agentd.tick(), null, 2)}\n`)
    return
  }
  for (const dir of [CLIENTS, REVIEWED, STOPPED]) mkdirSync(dir, { recursive: true })
  if (!claim(PID_FILE, process.pid, alivePid)) {
    log.debug('already running', { pid: process.pid })
    return
  }
  log.info('started', { pid: process.pid })
  process.on('exit', () => release(PID_FILE, process.pid))
  const stop = signals()
  if ((await loop(agentd, stop)) === 'replaced') {
    // The copy that holds the pid file keeps the glyphs; clearing them would
    // only make them blink.
    log.warn('stopped for another copy', { pid: process.pid })
    return
  }
  await agentd.clearTabs()
  const signal = stop.signal()
  log.info('stopped', { pid: process.pid, ...(signal ? { signal } : { reason: 'no clients' }) })
}

if (import.meta.main) await main()
