// Babysit proposals as files: pr-babysit's approval.py writes them and runs
// them, and every part reads them here (agentd too, to drop the ones whose
// session ended: orphans.ts). The rows and buttons made of them are the
// tray's (tray/approvals.ts).

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { errCode, logger, warnOnce } from '../core/log.ts'
import { RUN } from '../core/paths.ts'
import type { RunResult, Runner } from '../core/proc.ts'
import { t } from '../core/text.ts'

// Logged as the tray's, whichever program runs it, as it always was.
const log = logger('tray')

// Written by pr-babysit's approval.py, one JSON file each. A failed one stays
// until it's tried again, proposed again or dismissed, or until its session
// has ended (orphans.ts).
export const APPROVALS = join(RUN, 'approvals')

// Which fields a proposal has depends on its kind; id, kind and status are
// all readApprovals checks.
export type ProposalStatus = 'pending' | 'failed'
export type ProposalPr = { url?: string; project?: string; forge?: string; repo?: string; ref?: string }
// GitHub's job ids are numbers in some places and strings in others, and a
// deployment's is `run:<run id>`.
export type ProposalJob = { id?: string | number; run_id?: string | number; name?: string; stage?: string; reason?: string }
export type ProposalThread = { url?: string; where?: string; id?: string | number; author?: string; body?: string }
export type ProposalCommit = { sha: string; subject?: string; note?: string; added?: number; removed?: number }
export type ProposalCheck = { ok: boolean; name: string }
export type Proposal = {
  id: string
  kind: string
  status: ProposalStatus
  at?: number
  title?: string
  // The approval.py that wrote it, which is the one that settles it.
  script?: string
  claude_session?: string
  pane?: string
  // The writer's $TMUX, which says which tmux server `pane` is on.
  tmux?: string
  pr?: ProposalPr
  // A reply's. `briefing` says why it needs the user's call.
  thread?: ProposalThread
  body?: string
  briefing?: string
  commit?: ProposalCommit
  // A push's. `removes` are the commits it takes off the remote.
  commits?: ProposalCommit[]
  removes?: ProposalCommit[]
  local?: string
  remote?: string
  branch?: string
  worktree?: string
  lease?: string
  head?: string
  remote_head?: string
  checks?: ProposalCheck[]
  command?: string
  // A move's: the commit it rebases onto.
  onto?: string
  // For retry, manual and deploy.
  job?: ProposalJob
  // What the last try said, on a failed one.
  result?: { message?: string; at?: number }
}

const isProposal = (v: unknown): v is Proposal =>
  typeof v === 'object' &&
  v !== null &&
  'id' in v &&
  typeof v.id === 'string' &&
  'kind' in v &&
  typeof v.kind === 'string' &&
  'status' in v &&
  (v.status === 'pending' || v.status === 'failed')

export function readApprovals(dir = APPROVALS): Proposal[] {
  let files: string[] = []
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'))
  } catch (err) {
    warnOnce(log, 'approvals folder unreadable', err, { path: dir })
    return []
  }
  const out: Proposal[] = []
  for (const f of files.sort()) {
    try {
      const p: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      if (isProposal(p)) out.push(p)
    } catch (err) {
      warnOnce(log, 'approval skipped', err, { path: join(dir, f) })
    }
  }
  return out
}

// Longer than approval.py's own slowest step (a git push it gives two
// minutes), so only a hung one is cut off.
export const APPROVAL_MS = 180_000
const KILL_AFTER_MS = 5000

// Like core's run(), but in a process group of its own that a timeout stops
// whole. approval.py does its work in git and gh children; stopping only
// python would leave a push or a POST to land after the tray said it was
// stopped, with the proposal still pending, so a retry would do it twice.
export const runGroup: Runner = (args, opts = {}) =>
  new Promise(resolve => {
    const child = spawn(args[0] ?? '', args.slice(1), { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
    const stop = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch (e) {
        // ESRCH: the group was gone already.
        if (errCode(e) !== 'ESRCH') log.warn('approval not stopped', { cmd: args, signal, err: e })
      }
    }
    const timers: NodeJS.Timeout[] = []
    const timeUp = () => {
      stop('SIGTERM')
      timers.push(setTimeout(() => stop('SIGKILL'), KILL_AFTER_MS))
    }
    if (opts.timeout) timers.push(setTimeout(timeUp, opts.timeout))
    const done = (r: RunResult) => {
      for (const timer of timers) clearTimeout(timer)
      resolve(r)
    }
    child.on('error', e => done({ ok: false, out, err: (err || e.message).trim(), exit: null }))
    child.on('close', code => done({ ok: code === 0, out, err: err.trim(), exit: code }))
  })

export type ApprovalResult = { ok: boolean; message: string }

// approval.py's answer: JSON on stdout's last line, or, for a refusal it
// raises (SystemExit), on stderr, as JSON or as plain text. A traceback
// gives its last line.
const lastLine = (text: string): string => (text.trim().split('\n').pop() ?? '').trim()
function answerIn(text: string): ApprovalResult | null {
  let out: unknown
  try {
    out = JSON.parse(lastLine(text))
  } catch {
    // Not JSON: the caller shows the line as text instead.
    return null
  }
  if (typeof out !== 'object' || out === null || Array.isArray(out)) return null
  const answer: { ok?: unknown; message?: unknown } = out
  return { ok: Boolean(answer.ok), message: String(answer.message ?? '') }
}

const failure = (r: RunResult, timedOut: boolean): string =>
  timedOut ? t('tray.approval.scriptSlow') : lastLine(r.err) || lastLine(r.out) || t('tray.approval.scriptFailed')

export type ApprovalScript = Partial<Pick<Proposal, 'id' | 'kind' | 'script'>>

// Runs the approval.py that wrote the proposal, so a babysit from a
// worktree's skill is approved by the same code. Under zsh, so what ~/.zshenv
// sets (PATH, or a token exported in place of a gh/glab login) reaches it: the
// panel that runs this didn't load it.
export async function runApproval(p: ApprovalScript | null | undefined, args: string[], exec: Runner = runGroup, timeout = APPROVAL_MS): Promise<ApprovalResult> {
  if (!p?.script || !/\/approval\.py$/.test(p.script) || !existsSync(p.script)) {
    log.error('approval script gone', { id: p?.id, kind: p?.kind, path: p?.script, args })
    return { ok: false, message: t('tray.approval.scriptGone') }
  }
  const cmd = ['python3', p.script, ...args]
  const argv = existsSync('/bin/zsh') || existsSync('/usr/bin/zsh') ? ['zsh', '-c', 'exec "$@"', 'approval', ...cmd] : cmd
  const started = performance.now()
  const r = await exec(argv, { timeout })
  const ms = Math.round(performance.now() - started)
  const answer = answerIn(r.out) ?? answerIn(r.err)
  const timedOut = !answer && r.exit === null && ms >= timeout
  const result = answer ?? { ok: false, message: failure(r, timedOut) }
  const fields = { id: p.id, kind: p.kind, ok: result.ok, exit: r.exit, ms }
  if (result.ok) log.info('approval ran', fields)
  else
    log.error('approval ran', {
      ...fields,
      cmd: argv,
      message: result.message,
      timedOut,
      stderr: r.err,
      // No JSON answer: what it printed instead.
      ...(answer ? {} : { stdout: r.out }),
    })
  return result
}
