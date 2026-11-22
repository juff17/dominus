// run() never throws: it resolves to what happened, so a caller decides what
// a failure means.

import { type ExecFileOptions, execFile, spawnSync } from 'node:child_process'

// err is stderr, else the error's message. exit is null when it didn't run or
// a signal ended it.
export type RunResult = { ok: boolean; out: string; err: string; exit: number | null }
export type Runner = (args: string[], opts?: ExecFileOptions) => Promise<RunResult>
export type SyncOptions = { maxBuffer?: number }
export type SyncRunner = (args: string[], opts?: SyncOptions) => RunResult

// stdin is closed and stderr piped so neither reaches the terminal the screen
// draws on.
export const runSync: SyncRunner = ([cmd = '', ...args], { maxBuffer } = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer })
  return {
    ok: !r.error && r.status === 0,
    out: r.stdout ?? '',
    err: (r.stderr || r.error?.message || '').trim(),
    exit: r.status,
  }
}

export const run: Runner = (args, opts = {}) =>
  new Promise(resolve =>
    execFile(args[0], args.slice(1), { ...opts, encoding: 'utf8' }, (err, out, errOut) =>
      resolve({
        ok: !err,
        out: out ?? '',
        err: (errOut || err?.message || '').trim(),
        exit: err ? (typeof err.code === 'number' ? err.code : null) : 0,
      }),
    ),
  )
