// The open session beside the list (the "peek"): a pane in the hub's window
// that attaches to an agent's tmux tab through its own session, grouped
// with the hub's tab session, so looking at a tab here doesn't switch tabs
// in the workspace and a tab opened here stays out of it. A background
// agent opens with `claude attach`. Also the moves that take you to an
// agent's tab elsewhere, and its diagrams.

import { join } from 'node:path'
import { activeWindow, markedPane } from './board.ts'
import type { Tmux } from '../core/tmux.ts'
import type { Agent, Pane } from '../agents/model.ts'
import type { Fields, Logger } from '../core/log.ts'
import type { Runner } from '../core/proc.ts'
import { t } from '../core/text.ts'
import { P, clean } from '../tui/term.ts'

// A note in the hub's footer: `ms` how long it stays.
export type Say = (text: string, color?: string, ms?: number) => void
export type HubLog = Pick<Logger, 'enabled' | 'debug' | 'info' | 'warn'>
// `window` is the tab's window id; null for `claude attach`.
export type Peek = { pane: string; id: string | null; window: string | null }
// An agent to open: one from agentd, or a tab New agent has just made.
export type OpenTarget = Pick<Agent, 'id' | 'title'> &
  Partial<Pick<Agent, 'cwd'>> & {
  pane: Pick<Pane, 'session' | 'window' | 'pane' | 'win' | 'hub'> | null
  jobId?: string | null
}

export type PeekDeps = {
  outer: Tmux
  tabs: Tmux
  probeTabs: Tmux
  run: Runner
  say: Say
  draw: () => void
  // The latest agents from agentd.
  agents: () => Agent[]
  select: (id: string) => void
  focused: () => Agent | null
  cols: () => number
  listCols: () => number
  // HUB_WIN, the Ghostty window; 0 outside a layout.
  win: number
  CONF: string
  claude: string
  markReviewed: (id: string) => void
  log: HubLog
  env?: Record<string, string | undefined>
  // How long the list's selection rests before the open session follows it.
  previewMs?: number
}

export type PeekController = {
  readonly current: Peek | null
  openSession(a: OpenTarget | null): Promise<void>
  preview(): void
  showSelected(): Promise<void>
  showInstead(a: OpenTarget): Promise<void>
  opensHere(a: OpenTarget): boolean
  agentView(): Promise<void>
  showDiagrams(): Promise<void>
  openEditor(): Promise<void>
  paneAlive(id: string): Promise<boolean>
  closePeek(): Promise<void>
  forget(): void
  findPeek(): Promise<void>
  watchPeek(): Promise<void>
  goToTab(a: Agent | null): Promise<void>
}

// The tmux session an open session's pane attaches through.
const peekSession = (pane: string) => `peek-${pane.slice(1)}`

export function peekOf({ outer, tabs, probeTabs, run, say, draw, agents, select, focused, cols, listCols, win: WIN, CONF, claude, markReviewed, log, env = process.env, previewMs = 150 }: PeekDeps): PeekController {
  let peek: Peek | null = null
  let opening = false
  let watching = false
  let previewTimer: ReturnType<typeof setTimeout> | null = null
  // The agent of the session last open, for Ctrl+Shift+A to open again.
  let lastId: string | null = null
  const debug = (message: string, fields: Fields) => log.enabled('debug') && log.debug(message, fields)
  const opened = (a: OpenTarget, fields: Fields) => log.info('session opened', { id: a.id, ...fields })
  const bin = join(CONF, 'bin', 'ghostty-hub')
  // The window names its open session in @peek_pane, for layout.conf's keys
  // (Ctrl+Shift+B closes it from any pane), and while one is open draws a
  // status line over each pane, blue over the focused one (layout.conf's
  // pane-border-format): the divider between list and session borders
  // both, so it can't show which has focus.
  const markPeek = (pane: string) =>
    outer('set', '-w', '-t', pane, '@peek_pane', pane, ';', 'set', '-w', '-t', pane, 'pane-border-status', 'top')
  const unmarkPeek = () => {
    const hub = env.TMUX_PANE ?? ''
    return outer('set', '-wu', '-t', hub, '@peek_pane', ';', 'set', '-wu', '-t', hub, 'pane-border-status')
  }

  async function openSession(a: OpenTarget | null) {
    if (!a || opening) return
    cancelPreview()
    opening = true
    try {
      await open(a)
    } finally {
      opening = false
    }
  }

  // What opens beside the list rather than in the workspace: a hub tab, or a
  // background agent's job.
  const opensHere = (a: OpenTarget) => (a.pane ? Boolean(a.pane.hub) && showsTab(a) : Boolean(a.jobId))

  // Moving through the list beside an open session shows each agent in it
  // as you go, once the selection rests, so a run of j/k doesn't restart
  // the pane for every agent passed. Focus stays in the list. A workspace
  // tab doesn't open in the hub, so the session stays as it was on one.
  function preview() {
    if (!peek) return
    cancelPreview()
    previewTimer = setTimeout(() => {
      previewTimer = null
      void showSelected()
    }, previewMs)
  }

  function cancelPreview() {
    if (previewTimer) clearTimeout(previewTimer)
    previewTimer = null
  }

  async function showSelected() {
    const a = focused()
    if (!peek || !a || a.id === peek.id || !opensHere(a)) return
    if (opening) return preview()
    if (!(await paneAlive(peek.pane))) return
    opening = true
    try {
      await open(a, false)
    } finally {
      opening = false
    }
  }

  // The open session moves to `a`, focus staying where it is: the list, when
  // the agent it showed is closing.
  async function showInstead(a: OpenTarget) {
    if (!peek || opening) return
    cancelPreview()
    opening = true
    try {
      await open(a, false)
    } finally {
      opening = false
    }
  }

  // Ctrl+Shift+A: the session beside the list, with focus in it. layout.conf
  // focuses one that's open itself; with none, the hub opens the last one
  // again, else the selected agent when it opens here.
  async function agentView() {
    if (peek && (await paneAlive(peek.pane))) {
      await outer('select-pane', '-t', peek.pane)
      return
    }
    const last = lastId ? agents().find(a => a.id === lastId) : undefined
    const a = [last, focused()].find((x): x is Agent => Boolean(x && opensHere(x)))
    debug('agent view', { id: a?.id ?? null, last: lastId })
    if (!a) return say(t('hub.notes.nothingToView'))
    await openSession(a)
  }

  // What the pane runs to show `a`: its tab, or `claude attach` for a job.
  function attachCmd(a: OpenTarget): string | null {
    if (showsTab(a)) return `${bin} peek ${a.pane!.win} ${a.pane!.window}`
    if (a.jobId) return `${bin} attach ${a.jobId}`
    return null
  }

  const showsTab = (a: OpenTarget) => Boolean(a.pane?.win && a.pane.window)

  // A background agent has no tab session for Ctrl+Shift+T to add a tab to,
  // so its pane names the agent's folder (@peek_bg), where layout.conf opens
  // a terminal in a popup instead (bin/ghostty-term). A tab's pane names
  // none, so the key opens a tab beside it as usual.
  async function nameFolder(pane: string, a: OpenTarget) {
    if (showsTab(a)) await outer('set', '-pu', '-t', pane, '@peek_bg')
    else await outer('set', '-p', '-t', pane, '@peek_bg', a.cwd || env.HOME || '/')
  }

  // A workspace tab isn't among the hub's tabs, so opening one goes to it in
  // the workspace instead.
  // `focusPane` false keeps focus where it is (the list, as you move in it).
  async function open(a: OpenTarget, focusPane = true) {
    if (a.pane && !a.pane.hub) return toWorkspace(a, a.pane)
    if (!env.TMUX) {
      opened(a, { ok: false, reason: 'not in tmux' })
      return say(t('hub.notes.noTmuxSession'), P.red)
    }
    const cmd = attachCmd(a)
    if (!cmd) {
      opened(a, { ok: false, reason: 'outside the layout' })
      return say(t('hub.notes.outsideLayout', { title: a.title }), P.peach)
    }
    if (a.id && !a.id.startsWith('new:')) markReviewed(a.id)
    if (!peek) await findPeek()
    const shown = peek && (await paneAlive(peek.pane)) ? await reuse(peek, a, cmd, focusPane) : await split(a, cmd, focusPane)
    if (!shown) return
    select(a.id)
    draw()
  }

  // A tab of the session the pane already shows is one tab switch away;
  // anything else (a background agent, another window's tab) restarts it.
  async function reuse(p: Peek, a: OpenTarget, cmd: string, focusPane: boolean): Promise<boolean> {
    const switched = Boolean(a.pane?.window && p.window && (await probeTabs('select-window', '-t', `=${peekSession(p.pane)}:${a.pane.window}`)).ok)
    if (!switched) {
      await outer('respawn-pane', '-k', '-t', p.pane, cmd)
      await nameFolder(p.pane, a)
    }
    if (focusPane) await outer('select-pane', '-t', p.pane)
    p.id = a.id
    p.window = a.pane?.window ?? null
    opened(a, { ok: true, how: switched ? 'switched' : 'respawned', pane: p.pane, focus: focusPane })
    return true
  }

  async function split(a: OpenTarget, cmd: string, focusPane: boolean): Promise<boolean> {
    const size = Math.max(20, cols() - listCols() - 1)
    const made = await outer('split-window', '-h', ...(focusPane ? [] : ['-d']), '-t', env.TMUX_PANE ?? '', '-l', String(size), '-P', '-F', '#{pane_id}', cmd)
    if (!made.ok) {
      opened(a, { ok: false, how: 'split', err: made.err })
      say(t('hub.notes.openFailed', { err: made.err }), P.red)
      return false
    }
    const p: Peek = { pane: made.out.trim(), id: a.id, window: a.pane?.window ?? null }
    peek = p
    await outer('set', '-p', '-t', p.pane, '@peek', '1')
    if (!showsTab(a)) await nameFolder(p.pane, a)
    await markPeek(p.pane)
    opened(a, { ok: true, how: 'split', pane: p.pane })
    return true
  }

  // With a tab open beside the list, the tab it shows, followed as you switch
  // tabs in it; otherwise the open background agent's, else the selected
  // agent's. The diagram mod keeps diagrams per tmux pane, or per job for a
  // background agent; a tab parked on a job draws them in the job.
  async function showDiagrams() {
    if (!WIN) return say(t('hub.notes.noLayoutDiagrams'), P.red)
    const alive = peek !== null && (await paneAlive(peek.pane))
    let args: string[]
    if (alive && peek?.window) args = [peekSession(peek.pane)]
    else {
      const open = alive && peek?.id ? agents().find(a => a.id === peek?.id) : undefined
      const a = open ?? focused()
      if (!a) return say(t('hub.notes.selectForDiagrams'))
      if (a.jobId) args = [`job:${a.jobId}`, a.title]
      else if (a.pane?.pane) args = [a.pane.pane]
      else return say(t('hub.notes.noDiagrams', { title: a.title }), P.peach)
    }
    const from = args[0]
    const cmd = [join(CONF, 'bin', 'ghostty-diagrams'), String(WIN), ...args]
    const shown = await run(cmd)
    log.info('diagrams shown', { from, ok: shown.ok, ...(shown.ok ? {} : { cmd, err: shown.err }) })
    if (!shown.ok) say(t('hub.notes.diagramsFailed', { err: clean(shown.err).slice(0, 120) }), P.red)
  }

  // The open session's agent, else the selected card's, in its own folder
  // as agentd has it: a background agent has no tab whose folder tmux could
  // name. ghostty-editor still finds the repo or worktree from there.
  async function openEditor() {
    const shown = peek?.id ? agents().find(a => a.id === peek?.id) : undefined
    const a = shown ?? focused()
    if (!a) return say(t('hub.notes.selectForEditor'))
    if (!a.cwd) return say(t('hub.notes.noFolderForEditor', { title: a.title }), P.peach)
    const cmd = [join(CONF, 'bin', 'ghostty-editor'), '--dir', a.cwd]
    const opened = await run(cmd)
    log.info('editor opened', { id: a.id, dir: a.cwd, ok: opened.ok, ...(opened.ok ? {} : { cmd, err: opened.err }) })
    if (!opened.ok) say(clean(opened.err).trim().slice(0, 160) || t('hub.notes.editorFailed'), P.red)
  }

  // tmux display exits 0 with empty output for a pane that's gone, so the
  // answer is whether it names the pane.
  async function paneAlive(id: string) {
    return (await outer('display', '-p', '-t', id, '#{pane_id}')).out.trim() === id
  }

  // Lets go of the open session, remembering its agent for Ctrl+Shift+A.
  function drop() {
    cancelPreview()
    if (peek?.id) lastId = peek.id
    peek = null
  }

  async function closePeek() {
    if (!peek) return
    const p = peek.pane
    drop()
    debug('session closed', { pane: p })
    await outer('kill-pane', '-t', p)
    await forgetPeek(p)
    draw()
  }

  // The window stops naming `pane` as its open session (layout.conf's keys
  // read @peek_pane). Not once a newer session has taken its place while
  // the caller waited on tmux: only this hub sets the option, and it sets
  // `peek` first, so a peek on another pane means the option is that one's.
  async function forgetPeek(pane: string) {
    if (peek && peek.pane !== pane) return
    await unmarkPeek()
  }

  // The closing key: the pane is on its way out, so the hub only lets go.
  function forget() {
    if (!peek) return
    const { pane } = peek
    debug('session closing', { pane })
    drop()
    void forgetPeek(pane)
  }

  // The hub restarts in a loop (bin/ghostty-hub), and a new one starts with
  // no open session in mind while the old one's pane may still be beside it.
  // That pane is marked @peek, so the hub takes it back rather than splitting
  // off a second one. With none, the window's @peek_pane can still name one
  // that closed while no hub ran (Ctrl+] kills it, and only the hub unsets
  // the option), which would leave layout.conf's keys aiming at a dead pane.
  async function findPeek() {
    if (peek || !env.TMUX) return
    const rows = (await outer('list-panes', '-t', env.TMUX_PANE ?? '', '-F', '#{pane_id} #{@peek} #{@peek_pane}')).out
    const pane = markedPane(rows)
    if (!pane) {
      // Only when the window still names one (every open would otherwise
      // cost a tmux call), and only while no session was opened during the
      // call above.
      const named = rows.split('\n').some(l => l.split(' ')[2])
      if (named && !peek) await unmarkPeek()
      return
    }
    // The window the pane shows, when it shows a tab; empty for `claude attach`.
    const shown = await probeTabs('list-windows', '-t', `=${peekSession(pane)}`, '-F', '#{window_active} #{window_id}')
    const window = shown.ok ? activeWindow(shown.out) : null
    peek = { pane, id: agentIn(window)?.id ?? null, window }
    debug('session taken back', { pane, window, id: peek.id })
    await markPeek(pane)
  }

  const agentIn = (window: string | null) => (window ? agents().find(a => a.pane?.window === window) : undefined)

  // Drops the open session once its pane is gone, and moves the list's
  // selection to the agent of a tab you switch to in it. A tick runs every
  // 400 ms and tmux can take longer, so one waits for the last.
  async function watchPeek() {
    if (!peek || watching) return
    watching = true
    try {
      await follow(peek)
    } finally {
      watching = false
    }
  }

  async function follow(p: Peek) {
    if (!(await paneAlive(p.pane))) {
      if (peek === p) drop()
      debug('session pane gone', { pane: p.pane })
      await forgetPeek(p.pane)
      return draw()
    }
    // Another session opened while tmux answered: this one's agent is no
    // longer the list's to select.
    if (peek !== p || !p.window) return
    // Its agent by its tab, while agentd hasn't named it yet: one taken back
    // at startup may predate the first state from agentd, and a tab New
    // agent just made opens as `new:<pane>` until agentd sees Claude in it.
    if (!p.id || !agents().some(a => a.id === p.id)) {
      const a = agentIn(p.window)
      if (a) {
        p.id = a.id
        select(a.id)
        draw()
      }
    }
    const name = peekSession(p.pane)
    const [session, win] = (await tabs('display', '-p', '-t', `=${name}:`, '#{session_name} #{window_id}')).out.trim().split(' ')
    if (peek !== p || session !== name || !win || win === p.window) return
    p.window = win
    const a = agentIn(win)
    p.id = a?.id ?? null
    debug('session tab followed', { pane: p.pane, window: win, id: p.id })
    if (a) select(a.id)
    draw()
  }

  async function goToTab(a: Agent | null) {
    if (!a) return
    if (!a.pane && a.jobId) return toTab(a, a.jobId)
    if (!a.pane) return say(t('hub.notes.outsideTabs', { title: a.title }), P.sub)
    // A tab opened from the hub isn't in the workspace, so it opens here.
    if (a.pane.hub) return openSession(a)
    return toWorkspace(a, a.pane)
  }

  async function toWorkspace(a: OpenTarget, pane: NonNullable<OpenTarget['pane']>) {
    // By session as well: a bare window id picks whichever session used it last,
    // which can be the hub's own peek session.
    const r = await tabs('select-window', '-t', `${pane.session}:${pane.window}`)
    log.info('went to tab', { id: a.id, window: pane.window, win: pane.win, ok: r.ok })
    if (pane.win === WIN || !WIN) await outer('select-window', '-t', `layout-${WIN}:work`)
    else say(t('hub.notes.switchedTab', { title: a.title, win: pane.win }), P.sub)
  }

  // A background agent has no tab; o gives it one: a new tab in this window
  // that attaches to it, typed into the tab's shell so the shell stays after.
  async function toTab(a: Agent, jobId: string) {
    if (!WIN) return say(t('hub.notes.noLayout'), P.red)
    const made = await tabs('new-window', '-t', `ghostty-${WIN}:`, '-c', a.cwd, '-P', '-F', '#{pane_id}')
    log.info('tab opened', { id: a.id, ok: made.ok, ...(made.ok ? { pane: made.out.trim() } : { err: made.err }) })
    if (!made.ok) return say(t('hub.notes.tabFailed', { err: made.err }), P.red)
    const pane = made.out.trim()
    await tabs('send-keys', '-t', pane, '-l', `${claude.replace(/[^\w./-]/g, '\\$&')} attach ${jobId}`)
    await tabs('send-keys', '-t', pane, 'Enter')
    await outer('select-window', '-t', `layout-${WIN}:work`)
  }

  return {
    get current() {
      return peek
    },
    openSession,
    preview,
    showSelected,
    showInstead,
    opensHere,
    agentView,
    showDiagrams,
    openEditor,
    paneAlive,
    closePeek,
    forget,
    findPeek,
    watchPeek,
    goToTab,
  }
}
