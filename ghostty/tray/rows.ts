import { basename } from 'node:path'

import type { Agent } from '../agents/model.ts'
import { TABS_SOCKET } from '../core/paths.ts'
import { t } from '../core/text.ts'
import type { Link } from './links.ts'

export type Section = 'you' | 'broke' | 'work' | 'watch' | 'done'

export type Action =
  | 'allow'
  | 'deny'
  | 'go'
  | 'dismiss'
  | 'post'
  | 'push'
  | 'run'
  | 'approve'
  | 'retry'
  | 'move'
  | 'again'
  | 'skip'
  | 'edit'
  | 'review'

// The first action is the usual answer. `id` stays the same while the row is
// about the same thing, so the widget can tell new rows from ones it has
// shown. `agent` is '' when no session is known.
export type Row = {
  section: Section
  glyph: string
  id: string
  agent: string
  title: string
  meta: string
  since: number
  actions: Action[]
}
export type MonitorRow = Row & { link: Link | null }
// `preview` is a pending reply's text; a failed proposal has none.
export type ApprovalRow = Row & { kind: string; approval: string; link: Link | null; preview?: string }

export const row = (
  section: Section,
  glyph: string,
  id: string,
  agent: Pick<Agent, 'id'> | null | undefined,
  title: string,
  meta: string,
  since: number,
  actions: Action[],
): Row => ({ section, glyph, id, agent: agent?.id ?? '', title, meta, since, actions })

export const where = (a: Pick<Agent, 'pane' | 'kind'>): string =>
  a.pane ? t(a.pane.hub ? 'tray.where.hubTab' : 'tray.where.tab', { tab: a.pane.tab }) : t(a.kind === 'bg' ? 'tray.where.background' : 'tray.where.terminal')
export const place = (a: Pick<Agent, 'repo' | 'worktree'>): string => (a.worktree ? `${a.repo} ⑂ ${a.worktree}` : a.repo)
// `via` is the subagent asking, when it isn't the session.
export const asker = (a: Pick<Agent, 'repo' | 'worktree' | 'pane' | 'kind' | 'via'>): string =>
  [place(a), where(a), a.via && t('tray.where.via', { name: a.via })].filter(Boolean).join(' · ')

// Whether $TMUX (the socket's path first) names the tab server. An unknown
// one counts as it: writers from before `tmux` was recorded didn't say.
const onTabs = (tmux: string): boolean => !tmux || basename(tmux.split(',')[0] ?? '') === TABS_SOCKET

// Pane ids are only unique on one tmux server, so a writer that recorded its
// $TMUX is matched by pane only when that is the tab server: a %N from the
// layout server names some unrelated tab.
export const agentOf = <A extends Pick<Agent, 'id' | 'pane'>>(agents: readonly A[], session = '', pane = '', tmux = ''): A | undefined =>
  agents.find(x => session && x.id === session) ?? (onTabs(tmux) ? agents.find(x => pane && x.pane?.pane === pane) : undefined)
