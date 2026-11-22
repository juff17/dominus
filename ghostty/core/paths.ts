// Config files are found from this module rather than from each caller's
// folder, so moving a module never breaks a path. The environment is read once,
// as the module loads.

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const env = process.env

// agentd's state, approvals, notes and the tray's files.
export const RUN = join(env.XDG_RUNTIME_DIR || '/tmp', 'agent-hub')
export const LAYOUT_RUN = `${env.XDG_RUNTIME_DIR || '/tmp'}/ghostty-layout`
// Touched by tmux.conf when the active tab changes; the viewer modes watch it.
export const TAB_CHANGED = `${LAYOUT_RUN}/tab-changed`
// Read by window <win>'s hub on OPEN_AGENT_KEY. One per window, so two hubs
// asked at once each get their own.
export const hubOpen = (win: number | string): string => join(RUN, `hub-open-${win}`)
// Rewritten every tick even when state.json isn't, so the tray can tell an
// idle agentd from one that froze or died.
export const AGENTD_BEAT = 'agentd.beat'
export const CLAUDE_DIR = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
// Where the tab session saved the claude to run (tmux.conf), which
// Ghostty's own PATH may lack.
export const CLAUDE_FILE = join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ghostty-layout', 'claude')
// The tab server (tmux.conf) and the outer layout server (layout.conf).
export const TABS_SOCKET = env.AGENT_HUB_TABS_SOCKET || 'ghostty'
export const LAYOUT_SOCKET = env.GHOSTTY_LAYOUT_SOCKET || 'ghostty-layout'

// ~/.config/ghostty, or this repo's copy.
export const CONF = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const bin = (name: string): string => join(CONF, 'bin', name)

export const conf = (path: string): string => join(CONF, path)

// Keeps the rest as typed, a trailing slash too, which path completion reads.
export const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? homedir() + p.slice(1) : p)
// Only the home folder itself or a path inside it: /home/jo2 next to
// /home/jo would become ~2, which expandHome can't read back.
export const tilde = (p: string): string => {
  const home = homedir()
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p
}
