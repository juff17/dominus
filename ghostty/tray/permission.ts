import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Agent, showsPermission } from '../agents/model.ts'
import { warnOnce } from '../agents/warn.ts'
import { logger } from '../core/log.ts'
import { CLAUDE_DIR, TABS_SOCKET } from '../core/paths.ts'
import { run } from '../core/proc.ts'
import { t } from '../core/text.ts'

const TABS = ['-L', TABS_SOCKET]
const log = logger('tray')

// Presses 1 (Yes) or Esc (No) in the agent's pane, only while Claude says it
// is waiting and the dialog on screen is the row's own tool call, so a key
// never lands in the input box or cancels a turn the inbox was behind on.
export async function answer(a: Pick<Agent, 'id' | 'pid' | 'title' | 'cmd' | 'pane'>, allow: boolean): Promise<{ ok: boolean; message: string }> {
  if (!a.pane) return { ok: false, message: t('tray.permission.openToAnswer', { title: a.title }) }
  let waiting = false
  const file = join(CLAUDE_DIR, 'sessions', `${a.pid}.json`)
  try {
    const session: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof session !== 'object' || session === null) throw new Error('not a session object')
    waiting = 'status' in session && session.status === 'waiting'
  } catch (err) {
    warnOnce(log, 'session file unreadable', err, { id: a.id, path: file })
  }
  const pane = a.pane.pane
  const screen = await run(['tmux', ...TABS, 'capture-pane', '-p', '-t', pane])
  if (!screen.ok) log.warn('pane not captured', { id: a.id, pane, err: screen.err })
  if (!waiting || !showsPermission(screen.out, a.cmd)) return { ok: false, message: t('tray.permission.notShowing', { title: a.title }) }
  const sent = await run(['tmux', ...TABS, 'send-keys', '-t', pane, allow ? '1' : 'Escape'])
  if (!sent.ok) return { ok: false, message: t('tray.permission.notAnswered', { err: sent.err }) }
  return { ok: true, message: t(allow ? 'tray.permission.allowed' : 'tray.permission.denied', { what: a.cmd.replace(/^Allow |\?$/g, '') }) }
}
