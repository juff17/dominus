// The hub's tmux servers: the window's own (bare `tmux`, which TMUX points
// at), the tab server, and the layout server by its socket, so the rail
// reaches a test's GHOSTTY_LAYOUT_SOCKET as the bin scripts do. Calls never
// throw. A failure is logged at warn, at most once a minute per command since
// some are polled; `probe` calls fail as a matter of course, so theirs go to
// debug.

import type { Logger } from '../core/log.ts'
import { LAYOUT_SOCKET, TABS_SOCKET } from '../core/paths.ts'
import { type RunResult, type Runner, run as runProc } from '../core/proc.ts'

const REPEAT_MS = 60_000

// One tmux command's arguments, after `tmux` and the socket.
export type Tmux = (...args: string[]) => Promise<RunResult>
export type HubTmux = { outer: Tmux; tabs: Tmux; layout: Tmux; probeOuter: Tmux; probeTabs: Tmux }
export type TmuxOptions = {
  log: Pick<Logger, 'enabled' | 'warn' | 'debug'>
  run?: Runner
  socket?: string
  layoutSocket?: string
  now?: () => number
}

export function tmuxOf({ log, run = runProc, socket = TABS_SOCKET, layoutSocket = LAYOUT_SOCKET, now = Date.now }: TmuxOptions): HubTmux {
  const logged = new Map<string, number>()
  const call = async (cmd: string[], level: 'warn' | 'debug' = 'warn'): Promise<RunResult> => {
    const r = await run(cmd)
    if (!r.ok && log.enabled(level)) {
      const key = cmd.join(' ')
      const t = now()
      if (t - (logged.get(key) ?? -REPEAT_MS) >= REPEAT_MS) {
        if (logged.size > 100) logged.clear()
        logged.set(key, t)
        log[level]('tmux failed', { cmd, err: r.err })
      }
    }
    return r
  }
  const tabs = (args: string[]) => ['tmux', '-L', socket, ...args]
  return {
    outer: (...args) => call(['tmux', ...args]),
    tabs: (...args) => call(tabs(args)),
    layout: (...args) => call(['tmux', '-L', layoutSocket, ...args]),
    probeOuter: (...args) => call(['tmux', ...args], 'debug'),
    probeTabs: (...args) => call(tabs(args), 'debug'),
  }
}
