// Babysit proposals left behind by a Claude session that has ended. Nothing
// is left to hear how one went (the session's watch_pr.py ended with it), so
// it would wait in Monitors and the tray forever as a "the session that
// proposed these is gone" row. agentd drops it once the session has been
// gone for ORPHAN_GRACE_MS, which a session file caught half written, or a
// quick `claude --resume`, gets through.

import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { errorMessage, logger } from '../core/log.ts'
import { type ApprovalResult, type Proposal, readApprovals, runApproval } from './proposals.ts'

const log = logger('agentd')

export const ORPHAN_GRACE_MS = 60_000
const SWEEP_MS = 10_000

// approval.py's dismiss, which takes the proposal's lock, so one being
// approved right now is left alone and tried again on the next sweep.
export type Dismiss = (p: Proposal) => Promise<ApprovalResult>
const dismissWithScript: Dismiss = p => runApproval(p, ['dismiss', p.id])

export type OrphanOptions = {
  // The approvals folder.
  dir: string
  // Claude Code's sessions folder. While it can't be read, every session
  // would look gone, so nothing is dropped.
  sessionsDir: string
  dismiss?: Dismiss
}

export type Orphans = {
  // `live`: the ids of the Claude sessions running now. agentd doesn't
  // wait for it, so a slow approval.py can't hold up a tick; a sweep while
  // one is still going does nothing.
  sweep(live: ReadonlySet<string>, at: number): Promise<void>
}

export function orphanSweeper({ dir, sessionsDir, dismiss = dismissWithScript }: OrphanOptions): Orphans {
  const goneSince = new Map<string, number>()
  let sweptAt = Number.NEGATIVE_INFINITY
  let busy = false

  // With no approval.py left (its worktree removed), nothing can be
  // approving it either, so the file goes without the lock.
  // The id is checked as approval.py's path_of checks it, so one written by
  // hand can't name a file outside the folder.
  async function drop(p: Proposal): Promise<boolean> {
    if (p.script && existsSync(p.script)) {
      const r = await dismiss(p)
      return r.ok
    }
    if (!/^[A-Za-z0-9_-]+$/.test(p.id)) throw new Error('not an approval id')
    unlinkSync(join(dir, `${p.id}.json`))
    return true
  }

  async function sweep(live: ReadonlySet<string>, at: number): Promise<void> {
    if (busy || at - sweptAt < SWEEP_MS || !existsSync(sessionsDir)) return
    sweptAt = at
    busy = true
    try {
      await dropOrphans(live, at)
    } finally {
      busy = false
    }
  }

  async function dropOrphans(live: ReadonlySet<string>, at: number): Promise<void> {
    const orphans = readApprovals(dir).filter(p => p.claude_session && !live.has(p.claude_session))
    const ids = new Set(orphans.map(p => p.id))
    for (const id of goneSince.keys()) if (!ids.has(id)) goneSince.delete(id)
    for (const p of orphans) {
      const since = goneSince.get(p.id) ?? at
      goneSince.set(p.id, since)
      if (at - since < ORPHAN_GRACE_MS) continue
      const started = performance.now()
      const fields = { id: p.id, kind: p.kind, status: p.status, session: p.claude_session }
      try {
        const ok = await drop(p)
        const ms = Math.round(performance.now() - started)
        if (ok) {
          goneSince.delete(p.id)
          log.info('orphan proposal dropped', { ...fields, ms })
        } else log.warn('orphan proposal kept', { ...fields, ms })
      } catch (err) {
        log.warn('orphan proposal kept', { ...fields, ms: Math.round(performance.now() - started), err: errorMessage(err) })
      }
    }
  }

  return { sweep }
}
