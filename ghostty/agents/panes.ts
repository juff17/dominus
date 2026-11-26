// The tab and layout servers' panes as agentd reads them: where each agent's
// tab is, whether you can see it, the glyph each tab carries, and which pane
// a session's Claude runs under.

import { warnOnce } from '../core/log.ts'
import { MONITOR, STATE } from '../tui/term.ts'
import type { AgentState } from './classify.ts'
import { parentPid, readStat } from './procfs.ts'
import { type Session, log } from './daemon.ts'

export const PANE_FORMAT =
  '#{pane_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{window_active}\t#{session_attached}\t#{@agent} #{@agent_fg}\t#{pane_pid}'
// For list-panes -a on the layout server.
export const HUB_SHOWN_FORMAT = '#{session_name} #{window_name} #{window_active} #{pane_id}'

// `wins`: the Ghostty windows showing their hub or the diagrams window rather
// than their workspace. `panes`: the layout panes in a hub that's in front.
// The hub's open session (peek-N) runs in layout pane %N, so going to the
// workspace leaves the peek attached, out of sight.
export type HubShown = { wins: Set<number>; panes: Set<string> }

export function parseHubShown(text: string | null): HubShown {
  const shown: HubShown = { wins: new Set(), panes: new Set() }
  for (const line of (text ?? '').split('\n')) {
    const [session, name, active, pane] = line.split(' ')
    if (active !== '1' || (name !== 'hub' && name !== 'diagrams')) continue
    shown.wins.add(Number(session.replace(/^layout-/, '')))
    if (name === 'hub' && pane) shown.panes.add(pane)
  }
  return shown
}

export const sessionRank = (name: string): number => (/^ghostty-\d+$/.test(name) ? 2 : /^hubtabs-\d+$/.test(name) ? 1 : 0)

// A tab's pane on the tab server.
export type Pane = {
  // %N
  pane: string
  // The tmux session it belongs to (parsePanes says which).
  session: string
  // N in ghostty-N.
  win: number
  // @N
  window: string
  tab: number
  // The pane's shell.
  pid: number
  // Only the hub's tab session has it.
  hub: boolean
  // In front of an attached session that's in sight (inSight).
  looked: boolean
}

// marks: each window's `<glyph> <color>` as tmux has them now.
export type PaneList = { panes: Map<string, Pane>; marks: Map<string, string> }

// A workspace session is in sight in a window not showing its hub, a peek in
// a hub that shows. Other sessions count as in sight.
function inSight(rank: number, session: string, win: number, hub: HubShown): boolean {
  if (rank === 2) return !hub.wins.has(win)
  const peek = /^peek-(\d+)$/.exec(session)?.[1]
  return peek === undefined || hub.panes.has(`%${peek}`)
}

export function parsePanes(text: string | null, hub: HubShown): PaneList {
  const panes = new Map<string, Pane>()
  const marks = new Map<string, string>()
  for (const line of (text ?? '').split('\n')) {
    const [pane, session, window, index, active, attached, mark, pid] = line.split('\t')
    if (!pane) continue
    if (mark?.trim()) marks.set(window, mark)
    const seen = panes.get(pane)
    // A tab shows in up to three sessions: the workspace's (ghostty-N), the
    // hub's tab session (hubtabs-N), and the peek session grouped with that.
    // The pane belongs to the first of those it's in.
    const rank = sessionRank(session)
    const win = Number(session.match(/^(?:ghostty|hubtabs)-(\d+)$/)?.[1] ?? seen?.win ?? 0)
    const looked = active === '1' && Number(attached) > 0 && inSight(rank, session, win, hub)
    if (!seen || rank > sessionRank(seen.session))
      panes.set(pane, {
        pane,
        session,
        win,
        window,
        tab: Number(index),
        pid: Number(pid),
        hub: rank === 1,
        looked: looked || Boolean(seen?.looked),
      })
    else if (looked) seen.looked = true
  }
  return { panes, marks }
}

// Each window's command goes to tmux on its own: the windows come from a pane
// list taken earlier in the tick, and in a ';' list a window closed since
// then fails its command and skips every one after it. `marked` is what tmux
// has now rather than memory, so a mark that something else cleared (a tab
// server that restarted and reused window ids) is put back.
const RANK: Record<AgentState, number> = { needs: 0, working: 1, done: 2, idle: 3 }

export type MarkedAgent = { state: AgentState; monitor?: boolean; pane?: Pick<Pane, 'window'> | null }

export function tabMarkArgs(agents: readonly MarkedAgent[], marked: Map<string, string> = new Map()): string[][] {
  const want = new Map<string, { rank: number; value: string }>()
  for (const a of agents) {
    if (!a.pane) continue
    const look = a.monitor && a.state !== 'needs' ? MONITOR.watching : STATE[a.state]
    const prev = want.get(a.pane.window)
    if (!prev || RANK[a.state] < prev.rank) want.set(a.pane.window, { rank: RANK[a.state], value: `${look.glyph} ${look.color}` })
  }
  const commands: string[][] = []
  for (const [win, { value }] of want) {
    if (marked.get(win) === value) continue
    const [glyph, color] = value.split(' ')
    commands.push(['set', '-w', '-t', win, '@agent', glyph, ';', 'set', '-w', '-t', win, '@agent_fg', color])
  }
  for (const win of marked.keys()) {
    if (!want.has(win)) commands.push(['set', '-wu', '-t', win, '@agent', ';', 'set', '-wu', '-t', win, '@agent_fg'])
  }
  return commands
}

// The hub's tab session, hubtabs-N, holds the hub's own tabs only: a
// workspace tab (ghostty-N) stays in the workspace, and the hub sends you
// there to see it (hub/peek.ts). Versions before that linked the workspace's
// Claude tabs into hubtabs-N, so a tab server started then still has them:
// each is unlinked, which leaves it in the workspace. One command each, for
// tabMarkArgs' reason, highest index first, as renumber-windows moves the
// tabs after one that goes. Unlinking a session's last tab ends the session.
export function hubUnlinkArgs(text: string | null): string[][] {
  if (text == null) return []
  const work = new Set<string>()
  // `hubtabs-N:index` → window; a window with several panes lists once each.
  const hub = new Map<string, { index: number; window: string }>()
  for (const line of text.split('\n')) {
    const [, session, window, index] = line.split('\t')
    if (!window) continue
    if (/^ghostty-\d+$/.test(session)) work.add(window)
    else if (/^hubtabs-\d+$/.test(session)) hub.set(`=${session}:${index}`, { index: Number(index), window })
  }
  return [...hub]
    .filter(([, tab]) => work.has(tab.window))
    .sort(([, a], [, b]) => b.index - a.index)
    .map(([target]) => ['unlink-window', '-t', target])
}

// Pane ids repeat across tmux servers, so a session's pane only counts when
// the session's own tmux names this server's session and window, and Claude
// runs under the pane's process. Claude records whichever session the pane
// was in when it started, which can be a peek-N or hubtabs-N. Those hold the
// tab session's windows too, so they count, even after the peek is gone. It
// can also be term-<job>, a background agent's terminal popup
// (bin/ghostty-term), whose window Ctrl+Shift+T moves into the workspace
// with Claude still in it.
export function paneOf(s: Pick<Session, 'tmux' | 'pid'>, panes: Map<string, Pane>, parent = (pid: number) => parentPid(readStat(pid))): Pane | null {
  const m = String(s.tmux ?? '').match(/^([^:]+):(@\d+)\.(%\d+)$/)
  const p = m && panes.get(m[3])
  if (!m || !p || (p.session !== m[1] && !/^(?:(?:peek|hubtabs)-\d+|term-[\w-]+)$/.test(m[1])) || p.window !== m[2]) return null
  let pid = s.pid
  for (let i = 0; i < 16 && pid > 1; i++) {
    if (pid === p.pid) return p
    try {
      pid = parent(pid)
    } catch (err) {
      warnOnce(log, 'parent process unreadable', err, { pid })
      return null
    }
  }
  return null
}
