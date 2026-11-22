import { existsSync, mkdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Agent } from '../agents/model.ts'
import { OPEN_AGENT_KEY } from '../core/keys.ts'
import { errCode, logger } from '../core/log.ts'
import { LAYOUT_SOCKET, TABS_SOCKET, bin, hubOpen } from '../core/paths.ts'
import { type RunResult, run } from '../core/proc.ts'
import { t } from '../core/text.ts'

const LAYOUT = ['-L', LAYOUT_SOCKET]
const log = logger('tray')

// `raise` asks the widget to bring Ghostty to the front, which only the
// panel can do. `layout` is the layout session whose window it is.
export type Shown = { ok: boolean; message: string; raise?: boolean; layout?: string }
export type Reachable = Pick<Agent, 'id' | 'title' | 'pane' | 'jobId'>

async function tmux(...args: string[]): Promise<RunResult> {
  const r = await run(['tmux', ...LAYOUT, ...args])
  if (!r.ok) log.warn('tmux failed', { cmd: ['tmux', ...LAYOUT, ...args], err: r.err })
  return r
}

// Takes you to the agent, as Enter on the board does. A workspace tab is
// shown in its own Ghostty window's workspace. A hub tab opens in that
// window's hub, beside the board. A background agent (claude attach) has no
// window, so it opens in the hub of `layout` (the todo list passes its own)
// or the one used last.
export async function go(a: Reachable, layout = ''): Promise<Shown> {
  if (!a.pane && !a.jobId) return { ok: false, message: t('tray.go.outside', { title: a.title }) }
  if (a.pane?.win && !a.pane.hub) return goToTab(a, a.pane)
  layout = a.pane?.win ? `layout-${a.pane.win}` : layout || (await layoutSession())
  // The hub of layout-<win> reads hubOpen(<win>) (hub/hub.ts).
  const win = layout.match(/^layout-(\d+)$/)?.[1]
  if (!win) return { ok: false, message: t('tray.go.noWindowFor') }
  const hub = (await tmux('show', '-v', '-t', layout, '@hub')).out.trim()
  if (!hub) return { ok: false, message: t('tray.go.hubDown') }
  // One request at a time per window, each until its hub has taken it: a
  // second Go to the same window would otherwise overwrite the first's id
  // before that hub read it.
  const request = hubOpen(win)
  const release = await hold(`${request}.lock`)
  try {
    writeFileSync(request, a.id)
    const shown = await tmux('select-window', '-t', `${layout}:hub`)
    if (!shown.ok) return { ok: false, message: t('tray.go.hubNotShown', { err: shown.err }) }
    const sent = await tmux('send-keys', '-t', hub, '-l', OPEN_AGENT_KEY)
    if (!sent.ok) return { ok: false, message: t('tray.go.notOpened', { title: a.title, err: sent.err }) }
    // Sent isn't opened: a hub between restarts drops the key. Only once it
    // has taken the request does the caller review the session or drop its
    // note.
    if (!(await taken(request))) return { ok: false, message: t('tray.go.hubDown') }
    return { ok: true, raise: true, layout, message: t('tray.go.inHub', { title: a.title }) }
  } finally {
    clear(request)
    release()
  }
}

// By session as well as window: a bare window id picks whichever session used
// it last.
async function goToTab(a: Reachable, pane: NonNullable<Reachable['pane']>): Promise<Shown> {
  const layout = `layout-${pane.win}`
  const cmd = ['tmux', '-L', TABS_SOCKET, 'select-window', '-t', `${pane.session}:${pane.window}`]
  const tab = await run(cmd)
  if (!tab.ok) {
    log.warn('tmux failed', { cmd, err: tab.err })
    return { ok: false, message: t('tray.go.tabNotShown', { title: a.title, err: tab.err }) }
  }
  const shown = await tmux('select-window', '-t', `${layout}:work`)
  if (!shown.ok) return { ok: false, message: t('tray.go.tabNotShown', { title: a.title, err: shown.err }) }
  log.info('went to tab', { id: a.id, window: pane.window, win: pane.win })
  return { ok: true, raise: true, layout, message: t('tray.go.inTab', { title: a.title }) }
}

const HUB_TAKES_MS = 2000
const LOOK_MS = 50
// A lock held longer than this belongs to a Go that died.
const STALE_LOCK_MS = HUB_TAKES_MS * 3
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function taken(request: string): Promise<boolean> {
  for (let waited = 0; waited < HUB_TAKES_MS; waited += LOOK_MS) {
    if (!existsSync(request)) return true
    await sleep(LOOK_MS)
  }
  if (!existsSync(request)) return true
  log.warn('open request not taken', { path: request, ms: HUB_TAKES_MS })
  return false
}

// So a later key doesn't open a request no hub took.
function clear(request: string): void {
  try {
    unlinkSync(request)
  } catch (err) {
    if (errCode(err) !== 'ENOENT') log.warn('open request not removed', { path: request, err })
  }
}

// The lock is a folder; one left by a Go that died is taken over.
async function hold(lock: string): Promise<() => void> {
  mkdirSync(dirname(lock), { recursive: true })
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (err) {
      if (errCode(err) !== 'EEXIST') throw err
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmdirSync(lock)
    } catch (err) {
      // The other Go let go meanwhile; the next try takes it.
      if (errCode(err) !== 'ENOENT') log.warn('stale lock not removed', { path: lock, err })
    }
    await sleep(LOOK_MS)
  }
  return () => {
    try {
      rmdirSync(lock)
    } catch (err) {
      log.warn('lock not released', { path: lock, err })
    }
  }
}

// Of tmux's `<when> <name> …` lines, the latest one's word at `field`.
const newest = (lines: string, field = 1): string =>
  lines
    .split('\n')
    .filter(Boolean)
    .sort()
    .reverse()
    .map(l => l.split(' ')[field])[0] ?? ''

// The Ghostty window you used last, else one a window is attached to, else
// any.
export async function layoutSession(): Promise<string> {
  const used = newest((await tmux('list-clients', '-F', '#{client_activity} #{client_name} #{client_session}')).out, 2)
  return used || newest((await tmux('list-sessions', '-F', '#{session_attached} #{session_name}')).out)
}

export async function showHub(): Promise<Shown> {
  const layout = await layoutSession()
  if (!layout) return { ok: false, message: t('tray.go.noWindow') }
  const shown = await tmux('select-window', '-t', `${layout}:hub`)
  return shown.ok ? { ok: true, raise: true, layout, message: t('tray.go.hub') } : { ok: false, message: t('tray.go.hubNotShown', { err: shown.err }) }
}

// Opens Monitors' Running list on the monitor the proposal waits under, with
// the approvals panel open on it.
export async function openPopup(pid: string): Promise<Shown> {
  const clients = (await tmux('list-clients', '-F', '#{client_activity} #{client_name} #{client_session}')).out
  const client = newest(clients)
  if (!client) return { ok: false, message: t('tray.go.noWindowFor') }
  const layout = newest(clients, 2)
  const cmd = [bin('ghostty-monitors'), client, layout, '--approval', pid]
  const shown = await run(cmd)
  if (!shown.ok) log.warn('popup not opened', { cmd, err: shown.err })
  return shown.ok ? { ok: true, raise: true, layout, message: t('tray.go.inPopup') } : { ok: false, message: t('tray.go.popupNotOpened', { err: shown.err }) }
}
