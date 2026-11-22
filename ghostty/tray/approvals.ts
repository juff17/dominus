import type { Agent } from '../agents/model.ts'
import type { Proposal, ProposalCommit } from '../agents/proposals.ts'
import { t } from '../core/text.ts'
import { proposalLink } from './links.ts'
import { type Action, type ApprovalRow, agentOf, row } from './rows.ts'

// The files themselves are agents/proposals.ts's; the apps take them from
// here, the one tray module they may import.
export * from '../agents/proposals.ts'

export const APPROVE = { reply: 'post', push: 'push', manual: 'run', deploy: 'approve', retry: 'retry', move: 'move' } as const satisfies Record<string, Action>
// approval.py may write a kind the tray doesn't know yet.
export type ProposalKind = keyof typeof APPROVE
const isKind = (kind: string): kind is ProposalKind => Object.hasOwn(APPROVE, kind)
export const APPROVE_ACTIONS: ReadonlySet<string> = new Set<Action>([...Object.values(APPROVE), 'again'])
const GLYPH: Record<ProposalKind, string> = { reply: '↩', push: '↑', manual: '▶', deploy: '▶', retry: '✗', move: '⇅' }
export const glyphOf = (kind: string): string => (isKind(kind) ? GLYPH[kind] : '▲')
// The longest reply the inbox's three-line preview shows whole.
export const PREVIEW_MOST = 200

export const sessionOf = <A extends Pick<Agent, 'id' | 'pane'>>(p: Pick<Proposal, 'claude_session' | 'pane' | 'tmux'>, agents: readonly A[]): A | undefined =>
  agentOf(agents, p.claude_session, p.pane, p.tmux)

const lines = (commits: readonly ProposalCommit[] = [], key: 'added' | 'removed') => commits.reduce((n, c) => n + (c[key] ?? 0), 0)

const DETAIL: Record<ProposalKind, (p: Proposal) => string[]> = {
  reply: () => [t('tray.approval.reply')],
  push: p => [`${p.local} → ${p.branch}`, `+${lines(p.commits, 'added')} −${lines(p.commits, 'removed')}`],
  manual: p => [p.job?.stage ? t('tray.approval.stage', { stage: p.job.stage }) : t('tray.approval.manualJob')],
  deploy: () => [t('tray.approval.deployment')],
  retry: p => [p.job?.reason || t('tray.approval.flaky')],
  move: p => [t('tray.approval.onto', { sha: String(p.onto ?? '').slice(0, 7) })],
}

const OWN_ACTIONS: Record<ProposalKind, Action[]> = {
  reply: ['post', 'edit', 'skip'],
  push: ['push', 'review', 'go'],
  retry: ['retry', 'go'],
  manual: [APPROVE.manual, 'skip'],
  deploy: [APPROVE.deploy, 'skip'],
  move: [APPROVE.move, 'skip'],
}

// The tray approves only what it shows whole: a reply short enough for its
// preview, and a push that takes nothing off the branch. Anything else opens
// in Monitors' approvals panel first.
function ownActions(p: Proposal, buttons: boolean): Action[] {
  if (!buttons) return ['review', 'go']
  const whole = String(p.body ?? '').length <= PREVIEW_MOST && !/\n/.test(p.body ?? '')
  if (p.kind === 'reply' && !whole) return ['review', 'skip']
  if (p.kind === 'push' && p.removes?.length) return ['review', 'go']
  return isKind(p.kind) ? [...OWN_ACTIONS[p.kind]] : ['review', 'skip']
}

const actionsOf = (p: Proposal, hasSession: boolean, buttons: boolean): Action[] => ownActions(p, buttons).filter(x => hasSession || x !== 'go')

export function approvalRow(p: Proposal, agents: readonly Agent[], buttons = true): ApprovalRow {
  const a = sessionOf(p, agents)
  const where = `${p.pr?.repo ?? ''} ${p.pr?.ref ?? ''}`.trim()
  const base = { kind: p.kind, approval: p.id, link: proposalLink(p) }
  if (p.status === 'failed') {
    const actions: Action[] = [...(buttons ? (['again'] as const) : []), ...(a ? (['go'] as const) : []), 'dismiss']
    const title = t('tray.approval.failed', { title: p.title ?? '' })
    return { ...row('broke', '✗', `af:${p.id}`, a, title, `${where} · ${p.result?.message ?? ''}`, p.result?.at ?? p.at ?? 0, actions), ...base }
  }
  const detail = isKind(p.kind) ? DETAIL[p.kind](p) : []
  if (p.removes?.length) detail.push(t('tray.approval.replaces', { n: p.removes.length }))
  const title = p.kind === 'retry' ? t('tray.approval.retryTitle', { name: p.job?.name ?? '' }) : (p.title ?? '')
  const glyph = glyphOf(p.kind)
  return {
    ...row(p.kind === 'retry' ? 'broke' : 'you', glyph, `a:${p.id}`, a, title, [where, ...detail].join(' · '), p.at ?? 0, actionsOf(p, Boolean(a), buttons)),
    ...base,
    preview: p.kind === 'reply' ? (p.body ?? '') : '',
  }
}
