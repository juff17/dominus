import type { Agent } from '../agents/model.ts'
import { answerKey, promptShown, sessionWaiting } from '../agents/permission.ts'
import { logger } from '../core/log.ts'
import { CLAUDE_DIR, TABS_SOCKET } from '../core/paths.ts'
import { run } from '../core/proc.ts'
import { t } from '../core/text.ts'

const TABS = ['-L', TABS_SOCKET]
const log = logger('tray')

// Presses 1 (Yes) or Esc (No) in the agent's pane, as agents/permission.ts
// allows.
export async function answer(a: Pick<Agent, 'id' | 'pid' | 'title' | 'cmd' | 'pane'>, allow: boolean): Promise<{ ok: boolean; message: string }> {
  if (!a.pane) return { ok: false, message: t('tray.permission.openToAnswer', { title: a.title }) }
  const pane = a.pane.pane
  const tabs = async (...args: string[]) => {
    const r = await run(['tmux', ...TABS, ...args])
    if (!r.ok) log.warn('tmux failed', { id: a.id, pane, cmd: args.slice(0, 1), err: r.err })
    return r
  }
  const { why } = await promptShown(tabs, pane, a.cmd, sessionWaiting(CLAUDE_DIR, a, log))
  if (why) return { ok: false, message: t('tray.permission.notShowing', { title: a.title }) }
  const sent = await tabs('send-keys', '-t', pane, answerKey(allow))
  if (!sent.ok) return { ok: false, message: t('tray.permission.notAnswered', { err: sent.err }) }
  return { ok: true, message: t(allow ? 'tray.permission.allowed' : 'tray.permission.denied', { what: a.cmd.replace(/^Allow |\?$/g, '') }) }
}
