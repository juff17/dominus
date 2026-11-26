// Where an item's agent or tab is now, from the panes tmux lists: what g
// goes to, and what the row says when there's nowhere to go.

import { t } from '../../core/text.ts'
import type { Agent } from '../../agents/model.ts'
import type { Panes, TabPane } from './state.ts'
import type { Item } from './todo.ts'

// The running tab server's start time; '' when tmux didn't say or no tab is open.
export const serverOf = (panes: Panes): string => panes?.values().next().value?.server ?? ''

// Only while it's still the tab it was recorded for: an id recorded under
// another server is a closed tab (see Item's paneServer). A server that wasn't
// recorded, or that tmux didn't say, is taken to be the same.
export function paneAt(panes: Panes, pane: string | undefined, server: string | undefined): TabPane | undefined {
  const at = pane ? panes?.get(pane) : undefined
  return at && (!server || !at.server || at.server === server) ? at : undefined
}

// Says nothing while tmux can't say (`panes` null). `win` is 0 outside a
// layout window.
export function tabOf(pane: string | undefined, panes: Panes, win: number, server?: string): string {
  if (!pane || !panes) return ''
  const at = paneAt(panes, pane, server)
  if (!at) return t('todo.tabs.closed')
  const tab = at.hub ? t('todo.tabs.hub') : t('todo.tabs.tab', { n: at.index })
  return at.win === win || !win ? tab : t('todo.tabs.otherWindow', { win: at.win, tab })
}

// A tab agent is found by its pane, a background one by the name it was
// started with (launch in agents/model.ts). A pane recorded under another
// tab server than `server` is some other tab's.
export function hubAgent(item: Pick<Item, 'handoff'>, agents: readonly Agent[], server = ''): Agent | null {
  const { pane, name, server: was } = item.handoff ?? {}
  if (!pane && !name) return null
  if (pane && was && server && was !== server) return null
  return agents.find(a => (pane ? a.pane?.pane === pane : a.kind === 'bg' && a.title === name)) ?? null
}

export const agentPane = (item: Pick<Item, 'handoff'>, panes: Panes): string =>
  item.handoff?.pane && paneAt(panes, item.handoff.pane, item.handoff.server) ? item.handoff.pane : ''

// '' when ↵ does nothing. With the tabs unread, a tab is taken to be open.
export function goLabel(item: Pick<Item, 'handoff' | 'pane' | 'paneServer'>, panes: Panes, agents: readonly Agent[]): string {
  if (hubAgent(item, agents, serverOf(panes)) || agentPane(item, panes)) return t('todo.keys.goToAgent')
  if (!item.pane) return ''
  return !panes || paneAt(panes, item.pane, item.paneServer) ? t('todo.keys.goToTab') : t('todo.keys.reopen')
}

export const noTabText = (item: Pick<Item, 'handoff' | 'by'>): string =>
  item.handoff?.where === 'bg'
    ? t('todo.go.ranInBackground', { name: item.handoff.name })
    : t(item.by === 'you' ? 'todo.go.addedHere' : 'todo.go.outsideTabs')
