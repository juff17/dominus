import type { MonitorEvent } from '../agents/model.ts'
import { t } from '../core/text.ts'
import type { Proposal } from '../agents/proposals.ts'

export type Link = { url: string; label: string }

// Only http(s) addresses, since the widget hands them to the browser.
const web = (u: unknown): string => (typeof u === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(u) ? u : '')
const prLabel = (url: string): string => t(/\/merge_requests\//.test(url) ? 'tray.links.mr' : 'tray.links.pr')
const digits = (s: string): boolean => /^\d+$/.test(s)

export type LinkedProposal = Pick<Proposal, 'kind' | 'pr' | 'thread' | 'job'>

const JOB_KINDS = new Set(['retry', 'manual', 'deploy'])

// GitHub's job page is inside its run (`run:<id>` names only the run). A
// deployment opens the run itself, where its Review deployments button is.
function jobLink(p: LinkedProposal, base: string): Link | null {
  const id = String(p.job?.id ?? '')
  if (p.pr?.forge === 'gitlab') return digits(id) ? { url: `${base}/-/jobs/${id}`, label: t('tray.links.job') } : null
  const run = String(p.job?.run_id ?? (id.startsWith('run:') ? id.slice(4) : ''))
  if (p.kind !== 'deploy' && digits(id) && digits(run)) return { url: `${base}/actions/runs/${run}/job/${id}`, label: t('tray.links.job') }
  return digits(run) ? { url: `${base}/actions/runs/${run}`, label: t('tray.links.run') } : null
}

// A push's commits aren't on the host until it runs, so it opens the PR.
export function proposalLink(p: LinkedProposal): Link | null {
  const pr = web(p.pr?.url)
  const thread = web(p.thread?.url)
  if (p.kind === 'reply' && thread) return { url: thread, label: t('tray.links.comment') }
  const base = pr && p.pr?.project ? `${new URL(pr).origin}/${p.pr.project}` : ''
  const job = base && JOB_KINDS.has(p.kind) ? jobLink(p, base) : null
  return job ?? (pr ? { url: pr, label: prLabel(pr) } : null)
}

const NAMED: [RegExp, string][] = [
  [/#(discussion_r|note_|issuecomment-|pullrequestreview-)/, 'tray.links.comment'],
  [/\/jobs?\/\d+/, 'tray.links.job'],
  [/\/runs\/\d+/, 'tray.links.run'],
]

export type LinkedMonitor = { event?: Pick<MonitorEvent, 'line'> | null; command?: string }

// watch_pr.py's failed, manual and stuck lines carry the job's address; else
// it opens the PR the command watches.
export function monitorLink(m: LinkedMonitor): Link | null {
  const named = web(m.event?.line?.match(/https?:\/\/[^\s"'<>]+/)?.[0])
  if (named) {
    const label = NAMED.find(([pattern]) => pattern.test(named))?.[1]
    return { url: named, label: label ? t(label) : prLabel(named) }
  }
  const watched = web(String(m.command ?? '').match(/https?:\/\/[^\s"'<>]+\/(?:pull|-\/merge_requests)\/\d+/)?.[0])
  return watched ? { url: watched, label: prLabel(watched) } : null
}
