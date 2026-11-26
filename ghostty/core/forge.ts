// gh and glab: which is which, whether one is installed and logged in, and
// one API call that answers JSON. Monitors' PRs and Pipelines and the
// Settings panel use them; agent_hub/forge.py is Python's own.

import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

import { type Fields, errorMessage } from './log.ts'
import type { RunResult, Runner } from './proc.ts'

export type ForgeId = 'gh' | 'gl'
export const CLI = { gh: 'gh', gl: 'glab' } as const satisfies Record<ForgeId, string>

// missing: CLI not installed; auth: not logged in; failed: anything else
// (a timeout, the network, an answer it couldn't read).
export type Why = 'missing' | 'auth' | 'failed'

// Whether cmd is an executable in one of PATH's folders. An empty entry is
// skipped, not taken as the current folder.
export function onPath(cmd: string, path = process.env.PATH): boolean {
  return (path ?? '').split(delimiter).some(dir => {
    if (!dir) return false
    try {
      accessSync(join(dir, cmd), constants.X_OK)
      return true
    } catch {
      // Not in this folder: try the next.
      return false
    }
  })
}

// The CLI is logged in to the host (gh auth login / glab auth login) when it
// can read the user there. A real call, since a stored login can be expired or
// revoked; only its exit status is kept, so the hub never handles a token.
export const loginArgs = (forge: ForgeId, host: string): string[] => [CLI[forge], 'api', '--hostname', host, 'user']

export async function loggedIn(forge: ForgeId, host: string, run: Runner, timeoutMs = 10000): Promise<boolean> {
  return (await run(loginArgs(forge, host), { timeout: timeoutMs })).ok
}

export function whyFailed(r: Pick<RunResult, 'err' | 'exit'>): Why {
  if (/ENOENT/.test(r.err)) return 'missing'
  if (/auth login|not logged|logged in|401|unauthori[sz]ed|authenticat|no token|bad credentials/i.test(r.err)) return 'auth'
  return 'failed'
}

// A gh or glab call that failed, with why and its first line of stderr.
export class CallFailed extends Error {
  readonly why: Why
  readonly cmd: string[]
  readonly exit: number | null
  constructor(r: Pick<RunResult, 'err' | 'exit'>, cmd: string[]) {
    super(r.err.split('\n').find(l => l.trim())?.trim().slice(0, 200) || `exit ${r.exit}`)
    this.why = whyFailed(r)
    this.cmd = cmd
    this.exit = r.exit
  }
}

// Runs cmd and parses what it printed; an empty answer (a POST's) is {}.
export function jsonCall(run: Runner, timeoutMs: number): (cmd: string[]) => Promise<unknown> {
  return async cmd => {
    const r = await run(cmd, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
    if (!r.ok) throw new CallFailed(r, cmd)
    try {
      return r.out.trim() ? JSON.parse(r.out) : {}
    } catch {
      throw new CallFailed({ err: 'not JSON', exit: r.exit }, cmd)
    }
  }
}

// What a failed fetch says: why, the message, and for a failed call the
// fields its log line adds (the command's start and exit code).
export function failure(err: unknown): { why: Why; err: string; fields: Fields } {
  const failed = err instanceof CallFailed ? err : null
  return { why: failed?.why ?? 'failed', err: errorMessage(err), fields: failed ? { cmd: failed.cmd.slice(0, 4), exit: failed.exit } : {} }
}
