// What the approvals panel does to the world. approvalEffects() takes the
// world and what Monitors gives it as `io`, so tests can hand it fakes.

import { type SpawnSyncReturns, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent } from '../../agents/model.ts'
import { errorMessage, logger } from '../../core/log.ts'
import { openUrl, runSync } from '../../core/proc.ts'
import { t } from '../../core/text.ts'
import { set as setSetting } from '../../settings/settings.ts'
import { type ApprovalResult, type Proposal, runApproval } from '../../agents/proposals.ts'
import { sessionOf } from '../../tray/approvals.ts'
import type { Shown } from '../../tray/navigate.ts'
import { type DiffFile, parseDiff, parseNameStatus, parseNumstat } from '../diff/diff.ts'
import { type AlwaysSetting, type Approve, type Effect, type State, alwaysSetting, current, edited, openDiff, reload } from './approvals.ts'

const log = logger('approvals')

// err is git's first line of complaint.
export type GitAnswer = { out: string } | { err: string; exit: number | null }

export type ApprovalsWorld = {
  git: (cwd: string, args: string[]) => GitAnswer
  runApproval: (p: Proposal, args: string[]) => Promise<ApprovalResult>
  setSetting: (key: AlwaysSetting[0], value: AlwaysSetting[1]) => void
  spawn: typeof spawn
}

// Monitors' part. emptied closes the panel once the last one shown was
// settled here; outside runs a program on the whole terminal.
export type ApprovalsIo = ApprovalsWorld & {
  proposals: () => Proposal[]
  agents: () => readonly Agent[]
  go: (a: Agent) => Promise<Shown>
  draw: () => void
  quit: () => void
  emptied: () => void
  outside: (cmd: string, args: string[]) => SpawnSyncReturns<Buffer>
}

// A failure is handed back for the caller to log and show.
const git = (cwd: string, args: string[]): GitAnswer => {
  const r = runSync(['git', '-C', cwd, ...args], { maxBuffer: 1 << 26 })
  return r.ok ? { out: r.out } : { err: r.err.split('\n')[0], exit: r.exit }
}

export const world = (): ApprovalsWorld => ({
  git,
  runApproval: (p, args) => runApproval(p, args),
  setSetting: (key, value) => {
    setSetting(key, value)
  },
  spawn,
})

type Verb = 'approve' | 'reject' | 'dismiss'
const SETTLED: Record<Verb, string> = { approve: 'proposal approved', reject: 'proposal rejected', dismiss: 'proposal dismissed' }
const UNSETTLED: Record<Verb, string> = { approve: 'proposal approve failed', reject: 'proposal reject failed', dismiss: 'proposal dismiss failed' }
// The kinds with a busy text of their own.
const BUSY_KINDS = new Set(['reply', 'comment', 'push', 'retry', 'manual'])

export function approvalEffects(s: State, io: ApprovalsIo) {
  let closeAfter = false

  const refresh = (settled = '') => reload(s, io.proposals(), settled)

  // The first close key while a proposal settles closes Monitors once it's
  // done, a second closes it now, without waiting to hear how it went.
  function closeWhenDone() {
    const id = current(s)?.id
    if (closeAfter) {
      log.warn('popup closed while settling', { id })
      io.quit()
      return
    }
    closeAfter = true
    log.info('popup close deferred', { id })
    // So the key doesn't look ignored.
    s.busy = `${s.busy} · ${t('approvals.notes.closesWhenDone')}`
    io.draw()
  }

  // `unsaved` is why A's "always" wasn't saved, which the result's note
  // carries so it isn't lost under it.
  async function settle(p: Proposal, verb: Verb, extra: string[], doing: string, unsaved = '') {
    s.busy = doing
    io.draw()
    const started = performance.now()
    const r = await io.runApproval(p, [verb, p.id, ...extra])
    const fields = { id: p.id, kind: p.kind, ok: r.ok, ms: Math.round(performance.now() - started), drop: extra.filter(a => a === '--drop').length || undefined }
    if (r.ok) log.info(SETTLED[verb], fields)
    else log.warn(UNSETTLED[verb], { ...fields, err: r.message })
    s.busy = ''
    // run() closes it, once approve() has cleaned up after it.
    if (closeAfter) return
    const said = r.message || t(r.ok ? 'approvals.notes.done' : 'approvals.notes.failed')
    s.note = { text: unsaved ? `${said} · ${unsaved}` : said, tone: r.ok && !unsaved ? 'green' : 'red' }
    // Only one that went through went as expected: one that failed because
    // it had gone (re-proposed, or settled from the tray) was replaced.
    refresh(r.ok ? p.id : '')
    if (!s.list.length) io.emptied()
    io.draw()
  }

  // Returns why it wasn't saved, or ''. A kind Settings has no setting for
  // fails as set() fails on a key it doesn't know.
  function saveAlways(p: Proposal): string {
    const setting = alwaysSetting(p)
    const [key, value] = setting ?? [`approvals.${p.kind}`, 'auto']
    try {
      if (!setting) throw new Error(`Not a value for ${key}: ${JSON.stringify(value)}`)
      io.setSetting(setting[0], setting[1])
      log.info('setting changed', { key, value, id: p.id })
      return ''
    } catch (err) {
      log.warn('setting change failed', { key, value, err: errorMessage(err) })
      return t('approvals.notes.settingNotSaved', { err: errorMessage(err) })
    }
  }

  // An edited reply goes to approval.py in a file of its own.
  async function approve(e: Approve) {
    const p = e.p
    const unsaved = e.always ? saveAlways(p) : ''
    const extra: string[] = []
    let dir = ''
    if (e.body !== undefined) {
      dir = mkdtempSync(join(tmpdir(), 'approval-'))
      try {
        writeFileSync(join(dir, 'body.txt'), e.body)
      } catch (err) {
        log.warn('reply not written', { id: p.id, path: dir, err: errorMessage(err) })
        throw err
      }
      extra.push('--body-file', join(dir, 'body.txt'))
    }
    for (const sha of e.drop ?? []) extra.push('--drop', sha)
    const busyAs = p.kind === 'push' && e.drop ? 'handBack' : BUSY_KINDS.has(p.kind) ? p.kind : 'approve'
    await settle(p, 'approve', extra, t(`approvals.busy.${busyAs}`), unsaved)
    if (dir) rmSync(dir, { recursive: true, force: true })
  }

  async function goTo(p: Proposal): Promise<boolean> {
    const a = sessionOf(p, io.agents())
    if (!a) {
      log.warn('session gone', { id: p.id })
      s.note = { text: t('approvals.notes.sessionGone'), tone: 'red' }
      return false
    }
    const r = await io.go(a)
    if (r.ok) {
      log.info('went to session', { id: p.id, agent: a.id })
      io.quit()
      return true
    }
    log.warn('session not opened', { id: p.id, agent: a.id, err: r.message })
    s.note = { text: r.message, tone: 'red' }
    return false
  }

  // Returns the approval when Settings say to post an edit at once.
  function editInEditor(p: Proposal, text: string): Approve | undefined {
    const dir = mkdtempSync(join(tmpdir(), 'approval-'))
    const file = join(dir, 'reply.md')
    writeFileSync(file, `${text}\n`)
    const r = io.outside('sh', ['-c', `${process.env.EDITOR} "$1"`, 'sh', file])
    const after = r.status === 0 ? readFileSync(file, 'utf8').replace(/\n+$/, '') : null
    rmSync(dir, { recursive: true, force: true })
    if (r.status === 0) return edited(s, p, after)
    log.warn('editor failed', { id: p.id, exit: r.status })
    s.note = { text: t('approvals.notes.editorFailed', { exit: String(r.status) }), tone: 'red' }
    return undefined
  }

  function open(p: Proposal, url: string) {
    openUrl(io.spawn, url, err => {
      log.warn('link not opened', { id: p.id, url, err: err.message })
      s.note = { text: t('approvals.notes.noOpener', { url }), tone: 'red' }
      io.draw()
    })
    log.info('link opened', { id: p.id, url })
    s.note = { text: t('approvals.notes.opened', { url }), tone: 'green' }
  }

  // Throws, so a worktree that's gone never reads as no changes.
  function gitOut(p: Proposal, args: string[]): string {
    const cwd = String(p.worktree)
    const r = io.git(cwd, args)
    if ('out' in r) return r.out
    log.error('git failed', { id: p.id, cmd: ['git', '-C', cwd, ...args], exit: r.exit, err: r.err })
    throw new Error(r.err)
  }

  function diffFiles(p: Proposal, from: string, to: string): { files: DiffFile[]; error?: string } {
    try {
      const counts = parseNumstat(gitOut(p, ['diff', '--numstat', '-M', '-z', from, to]))
      const files = parseNameStatus(gitOut(p, ['diff', '--name-status', '-M', '-z', from, to])).map(f => ({ ...f, ...counts.get(f.path) }))
      return { files }
    } catch (err) {
      return { files: [], error: errorMessage(err) }
    }
  }

  function readOpen(p: Proposal | null) {
    const d = s.diff
    const f = d?.files.find(x => x.path === d.open)
    if (!d || !f || !p) return
    try {
      d.rows = parseDiff(gitOut(p, ['diff', '-M', '--no-color', '--no-ext-diff', d.from, d.to, '--', f.path, ...(f.old ? [f.old] : [])]))
      d.error = ''
    } catch (err) {
      d.error = errorMessage(err)
    }
  }

  async function run(e: Effect): Promise<void> {
    switch (e.do) {
      case 'approve':
        await approve(e)
        break
      case 'reject':
      case 'dismiss':
        await settle(e.p, e.do, [], t(`approvals.busy.${e.do}`))
        break
      case 'go':
        if (await goTo(e.p)) return
        break
      case 'editor': {
        const next = editInEditor(e.p, e.text)
        if (next) return run(next)
        break
      }
      case 'open':
        open(e.p, e.url)
        break
      case 'diff':
        openDiff(s, { title: e.title, from: e.from, to: e.to, ...diffFiles(e.p, e.from, e.to) })
        readOpen(e.p)
        break
      case 'diffFile':
        readOpen(current(s))
        break
    }
    if (closeAfter) {
      io.quit()
      return
    }
    io.draw()
  }

  return { run, refresh, closeWhenDone }
}
