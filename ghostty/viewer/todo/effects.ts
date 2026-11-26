// todoEffects() takes the world (world()) and the view's say, draw, confirm
// and quit as `io`, so tests can hand it fakes.

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { type Image, type Pasted, attachFiles, pasteImage, sweepImages } from '../../core/images.ts'
import { errorMessage, logger } from '../../core/log.ts'
import { t } from '../../core/text.ts'
import { LAYOUT_SOCKET, bin, claudeBin } from '../../core/paths.ts'
import { type RunResult, type Runner, run } from '../../core/proc.ts'
import { readState } from '../../agents/client.ts'
import { type Agent, type LaunchPlan, type TaskSpec, launch } from '../../agents/model.ts'
import { type Settings, defaultFolderSetting, load as loadSettings } from '../../settings/settings.ts'
import type { Hint } from '../../tui/chrome.ts'
import { P } from '../../tui/palette.ts'
import { go as openInHub } from '../../tray/navigate.ts'
import { type Failing, failing } from '../logging.ts'
import { type Panes, type State, type TabPane, selectable } from './state.ts'
import {
  type Here,
  IMAGES_DIR,
  IMAGES_KEPT_MS,
  type Item,
  type RepoPlace,
  add,
  change,
  filerAlive,
  filingState,
  handoffHere,
  handoffPlace,
  handoffSpec,
  imagesOf,
  load,
  removeIf,
  replaceFiling,
  repoOf,
  stamp,
} from './todo.ts'
import * as ui from './todo-ui.ts'
import { startBg } from '../../agents/launch.ts'
import { paneFolderArgs } from '../../core/tmux.ts'

const log = logger('todo')

// The claude to run, as the tab session found it (tmux.conf).

export type World = {
  run: Runner
  spawn: (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess
  kill: (pid: number) => void
  isFiler: (pid: number) => boolean
  exists: (path: string) => boolean
  readFile: (path: string, encoding: 'utf8') => string
  agents: () => Agent[]
  openInHub: typeof openInHub
  repoOf: (dir: string) => Promise<RepoPlace>
  settings: () => Settings
  // Ctrl+V's image, and pasted image files, saved where todos keep them.
  pasteImage: () => Pasted
  attachFiles: (files: readonly string[]) => Pasted[]
  claude: () => string
  node: string
  todoCli: string
}

export type View = {
  say: (text: string, color?: string) => void
  draw: () => void
  confirm: (text: string, yes: () => void, key: string, answers: Hint[]) => void
  quit: (code?: number) => void
}

export type Io = World & View

export const world = (): World => ({
  run,
  spawn,
  kill: pid => process.kill(pid),
  isFiler: pid => filerAlive(pid),
  exists: existsSync,
  readFile: readFileSync,
  agents: () => readState()?.agents ?? [],
  openInHub,
  repoOf,
  settings: loadSettings,
  pasteImage: () => pasteImage(IMAGES_DIR),
  attachFiles: files => attachFiles(files, IMAGES_DIR),
  claude: () => claudeBin(),
  node: process.execPath,
  todoCli: bin('ghostty-todo'),
})

// What tmux says when there's no server on the socket at all.
const NO_SERVER = /no server running|No such file or directory|Connection refused/

type Tmux = (...args: string[]) => Promise<RunResult>

// `refreshing` is when the refresh under way started (0 for none) and
// `refreshRun` counts them, so one that hung can be given up on; `work` is
// what quitting waits for; `retrying` the failed filings r has asked again.
type Ctx = {
  s: State
  io: Io
  tabs: Tmux
  outer: Tmux
  polls: Failing
  refreshing: number
  refreshRun: number
  work: Set<Promise<void>>
  retrying: Map<string, number>
}

// ---- Reading the world ----

// A poll's tmux call gets this long, so a wedged server can't hold every
// later refresh back.
const POLL_TIMEOUT_MS = 5000
// A refresh still running after this is taken to have hung (a git or tmux
// that even a kill doesn't end, on a mount that stopped answering); the
// next one goes ahead and what the hung one finds later is dropped.
const REFRESH_STUCK_MS = 20000

async function activeFolder({ s, io, polls }: Ctx): Promise<string> {
  const { dir, tabsSocket, tabsSession } = s.config
  if (!tabsSession) return dir
  const cmd = ['tmux', '-L', tabsSocket, ...paneFolderArgs(tabsSession)]
  const shown = await io.run(cmd, { timeout: POLL_TIMEOUT_MS })
  if (shown.ok) polls.ok('folder')
  else polls.failed('folder', 'active tab unreadable', { cmd, err: shown.err })
  return (shown.ok && shown.out.trim()) || dir
}

// list-panes' lines as Panes. A window shows in several sessions (the
// hub's too). A workspace tab's own is its window's ghostty-<n>; a tab
// opened from the hub is only in hubtabs-<n> (ghostty-lib.sh hub_tabs), and
// marked hub. The last column is the server's start time.
export function parsePanes(out: string): Map<string, TabPane> {
  const map = new Map<string, TabPane>()
  for (const line of out.split('\n')) {
    const [pane, session = '', window = '', index = '', server = ''] = line.split('\t')
    const [, kind, n] = /^(ghostty|hubtabs)-(\d+)$/.exec(session) ?? []
    if (!pane || !kind || (kind === 'hubtabs' && map.has(pane))) continue
    map.set(pane, { session, window, index, win: Number(n), hub: kind === 'hubtabs', ...(server && { server }) })
  }
  return map
}

// No tab session running means no tabs; null when tmux can't say, which
// isn't the same as every tab being closed.
async function readPanes({ s, io, polls }: Ctx): Promise<Panes> {
  const cmd = ['tmux', '-L', s.config.tabsSocket, 'list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{start_time}']
  const listed = await io.run(cmd, { timeout: POLL_TIMEOUT_MS })
  if (!listed.ok && !NO_SERVER.test(listed.err)) {
    polls.failed('panes', 'tab session unreadable', { cmd, err: listed.err })
    return null
  }
  polls.ok('panes')
  return listed.ok ? parsePanes(listed.out) : new Map()
}

function readStore({ s }: Ctx, force = false): boolean {
  const now = stamp()
  if (!force && now === s.lastStamp) return false
  s.lastStamp = now
  try {
    s.items = load()
    s.loadError = ''
  } catch (error) {
    log.warn('store unreadable', { err: errorMessage(error) })
    s.loadError = errorMessage(error)
  }
  return true
}

async function refresh(c: Ctx): Promise<void> {
  const { s, io } = c
  // The store first, and whatever else is under way: it's a local read, and
  // a slow tmux or git mustn't hold back what the CLI and agents write.
  const changed = readStore(c)
  const started = performance.now()
  if (c.refreshing && started - c.refreshing < REFRESH_STUCK_MS) {
    if (changed) io.draw()
    return
  }
  if (c.refreshing) log.warn('refresh given up', { ms: Math.round(started - c.refreshing) })
  const mine = ++c.refreshRun
  c.refreshing = started
  // A later refresh took over from this one, which hung.
  const stale = (): boolean => mine !== c.refreshRun
  try {
    const folder = await activeFolder(c)
    if (stale()) return
    if (folder !== s.here.folder) {
      const place = await io.repoOf(folder)
      if (stale()) return
      s.here = { folder, ...place }
    }
    const panes = await readPanes(c)
    if (stale()) return
    s.panes = panes
    s.agents = io.agents()
  } finally {
    if (!stale()) {
      c.refreshing = 0
      if (log.enabled('debug')) log.debug('refresh done', { ms: Math.round(performance.now() - started), items: s.items.length })
      io.draw()
    }
  }
}

// ---- Writing the store ----

export type Attempt<T> = { value: T; error?: undefined } | { value?: undefined; error: unknown }

function attempt<T>(c: Ctx, action: () => T): Attempt<T> {
  try {
    return { value: action() }
  } catch (error) {
    log.warn('store write failed', { err: errorMessage(error) })
    c.io.say(errorMessage(error), P.red)
    return { error }
  } finally {
    readStore(c, true)
    c.io.draw()
  }
}

const write = <T>(c: Ctx, action: () => T): T | undefined => attempt(c, action).value

function setDone(c: Ctx, item: Item): void {
  const { s, io } = c
  const next = ui.neighbour(selectable(s), item)
  const { value, error } = attempt(c, () => change(item.id, { done: item.done ? null : Date.now() }))
  // The store's error stays on the status row, and the cursor where it is.
  if (error) return
  if (!value) {
    io.say(t('todo.say.gone'), P.peach)
    return
  }
  log.info(item.done ? 'todo reopened' : 'todo done', { id: item.id })
  // Done leaves the list, so the cursor moves on instead of following it.
  if (!item.done && !s.showDone && next) s.cursorId = next.id
  io.say(t(item.done ? 'todo.say.reopened' : 'todo.say.done', { title: item.title }), item.done ? P.blue : P.green)
}

function setCategory(c: Ctx, item: Item): void {
  const cat = ui.nextCategory(item.cat)
  if (write(c, () => change(item.id, { cat }))) log.info('todo category changed', { id: item.id, cat })
}

function setType(c: Ctx, item: Item): void {
  const type = ui.nextType(item.type)
  if (write(c, () => change(item.id, { type }))) log.info('todo type changed', { id: item.id, type })
}

function save(c: Ctx, { id, fields }: ui.EditSave): Attempt<Item | undefined> {
  const result = attempt(c, () => change(id, fields))
  if (result.value) log.info('todo edited', { id, fields: Object.keys(fields) })
  return result
}

// A filing is dropped only while it's still one: a filer that filed it while
// the question was up has made it a todo, which stays. Its filer is stopped only once the drop is written, by the pid the store
// has now, which a retry may have changed.
function erase(c: Ctx, item: Item): Attempt<Item | undefined> {
  const result = attempt(c, () => removeIf(item.id, i => !item.filing || !!i.filing))
  const gone = result.value
  if (!gone) return result
  log.info(item.filing ? 'filing dropped' : 'todo deleted', { id: item.id })
  if (gone.filing) stopFiler(c, gone)
  return result
}

// A new item goes in under the active tab's repo, but without its pane:
// you added it here, not from that tab. One that replaces a failed filing
// keeps that filing's repo, and replaces the todo the filer made of it if
// it filed it meanwhile.
async function finishAdd(c: Ctx, { title, cat, note, replaces, images }: ui.ByHand): Promise<void> {
  const { s, io } = c
  const folder = s.here.folder || s.config.dir
  const where = await io.repoOf(folder)
  const old = replaces && s.items.find(i => i.id === replaces)
  if (old) stopFiler(c, old)
  // A replaced filing's images were carried into the prompt, so those left
  // out here go.
  const fields = { title, cat, note, by: 'you', ...(images?.length || replaces ? { images: images ?? [] } : {}) } as const
  const item = write(c, () => (replaces && replaceFiling(replaces, fields)) || add({ ...fields, cwd: folder, ...where }))
  if (!item) return
  log.info('todo added', { id: item.id, repo: item.repo, cat: item.cat, replaces })
  s.cursorId = item.id
  io.say(t('todo.say.added', { repo: item.repo, title: item.title }), P.green)
}

// ---- The filer ----

// ghostty-todo file runs Claude and waits for it, so it goes in its own
// session: closing the Alt+T popup doesn't stop it.
// `ended` runs once the filer has exited, or failed to start.
function runFiler({ io }: Ctx, args: string[], ended?: () => void): boolean {
  const cmd = [io.node, io.todoCli, 'file', ...args]
  const failed = (error: unknown): void => {
    log.warn('filer not started', { cmd, err: errorMessage(error) })
    io.say(t('todo.say.filerFailed', { err: errorMessage(error) }), P.red)
    ended?.()
  }
  try {
    const child = io.spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore' })
    child.on('error', failed)
    if (ended) child.on('exit', ended)
    child.unref()
    return true
  } catch (error) {
    failed(error)
    return false
  }
}

// `images` are numbered 1, 2… in order, as --image counts them.
function file(c: Ctx, text: string, images: readonly Image[] = []): void {
  const folder = c.s.here.folder || c.s.config.dir
  // runFiler has said why it didn't start.
  if (!runFiler(c, ['--dir', folder, ...images.flatMap(i => ['--image', i.path]), '--', text])) return
  log.info('todo sent to Claude', { path: folder, chars: text.length, images: images.length })
  c.io.say(t('todo.say.sent'), P.peach)
}

// r on a failed filing. Until the retry's filer has written its own
// filing, the item still reads as failed, and a second r would start a
// second filer over the first; c.retrying holds the filing r saw, by id.
function retryFiling(c: Ctx, item: Item | undefined): void {
  if (!item?.filing || filingState(item) !== 'failed') return
  const { retrying } = c
  const { id } = item
  const seen = item.filing.started
  if (retrying.get(id) === seen) {
    c.io.say(t('todo.say.askedAgain'), P.peach)
    return
  }
  // Over once the filer has exited: it either took the item over, which
  // changes `started`, or failed to.
  const ended = (): void => void (retrying.get(id) === seen && retrying.delete(id))
  if (!runFiler(c, ['--retry', id], ended)) return
  retrying.set(id, seen)
  log.info('filing retried', { id })
  c.io.say(t('todo.say.askedAgain'), P.peach)
}

// Stops the filer, and the claude it started, which share its process group.
// Only while the pid is still a filer: one that failed has exited, and its
// pid may belong to something else by now.
function stopFiler({ io }: Ctx, item: Item): void {
  const pid = item.filing?.pid
  if (!pid || !io.isFiler(pid)) return
  try {
    io.kill(-pid)
  } catch (group) {
    try {
      io.kill(pid)
    } catch (error) {
      log.warn('filer not stopped', { pid, err: errorMessage(error), groupErr: errorMessage(group) })
    }
  }
}

// ---- Images ----

// Ctrl+V in a prompt that takes an image: the clipboard's, saved, or why not.
function pasteImageInto(c: Ctx): void {
  const { s, io } = c
  if (!ui.takesImages(s.prompt)) return
  const r = io.pasteImage()
  if ('error' in r) {
    io.say(r.error, P.peach)
    return
  }
  ui.attachImage(s.prompt, r.image)
  io.draw()
}

// A paste that names image files only, into a prompt that takes them,
// attaches them; false for any other paste, which goes in as text.
function pasteFiles(c: Ctx, files: readonly string[]): boolean {
  const { s, io } = c
  if (!files.length || !ui.takesImages(s.prompt)) return false
  for (const r of io.attachFiles(files)) {
    if ('error' in r) io.say(r.error, P.peach)
    else ui.attachImage(s.prompt, r.image)
  }
  io.draw()
  return true
}

// Images no todo names, older than a day. Not while the store can't be
// read: every image would look unnamed.
function sweep({ s }: Ctx): void {
  if (s.loadError) return
  sweepImages(IMAGES_DIR, new Set(s.items.flatMap(i => imagesOf(i).map(image => image.path))), IMAGES_KEPT_MS)
}

// ---- Starting agents ----

// Typed into the tab's shell, so the shell stays when Claude exits. '', or
// tmux's error when it typed nothing.
async function typeLine({ tabs }: Ctx, pane: string, line: string): Promise<string> {
  const typed = await tabs('send-keys', '-t', pane, '-l', line)
  if (!typed.ok) return typed.err || t('todo.handOff.sendKeysFailed')
  const entered = await tabs('send-keys', '-t', pane, 'Enter')
  return entered.ok ? '' : entered.err || t('todo.handOff.sendKeysFailed')
}

async function handoffAt({ s, io }: Ctx): Promise<Here> {
  const at = await handoffHere(s.here, defaultFolderSetting(io.settings()))
  log.debug('hand-off place', { folder: at.folder, repo: at.repo, default: at !== s.here })
  return at
}

export type HandoffHow = Pick<ui.HandoffPrompt, 'worktree' | 'model'>

// One agent after another, in the order they were marked. Each id is in
// s.handingOff until its agent has started or failed to, and one already there
// is left to the hand-off that has it, so a second w can't start a second
// agent on it.
async function handOff(c: Ctx, ids: readonly string[], at: Here, how: HandoffHow): Promise<void> {
  const { s, io } = c
  const todo = ids.filter(id => !s.handingOff.has(id))
  if (!todo.length) return io.say(t('todo.handOff.starting', { n: s.handingOff.size }), P.peach)
  for (const id of todo) s.handingOff.add(id)
  io.say(t('todo.handOff.starting', { n: todo.length }), P.peach)
  log.info('hand-off started', { ids: todo, worktree: how.worktree, model: how.model })
  const started: Item[] = []
  const failed: string[] = []
  // The store error of a hand-off that started but couldn't be recorded.
  let unrecorded: unknown
  try {
    for (const id of todo) {
      try {
        const item = s.items.find(i => i.id === id)
        if (!item) continue
        const values = io.settings()
        const spec = handoffSpec(handoffPlace(item, at), { ...how, mode: values['todo.handoff.mode'], effort: values['todo.handoff.effort'] })
        const outcome = spec ? await startAgent(c, item, { ...spec, sandbox: values['todo.handoff.sandbox'] }) : { error: t('todo.handOff.repoGone', { repo: item.repo }) }
        if (outcome.error === undefined) {
          started.push(item)
          // Its agent is running, so its mark goes now, not after the rest.
          s.marked.delete(id)
          unrecorded ??= outcome.storeError
          continue
        }
        log.warn('agent not started', { id, err: outcome.error })
        failed.push(`${item.title}: ${outcome.error}`)
      } finally {
        s.handingOff.delete(id)
      }
    }
  } finally {
    // And those it never reached, should one have thrown.
    for (const id of todo) s.handingOff.delete(id)
  }
  void refresh(c)
  const result = ui.handoffResult(started, failed)
  // An agent the store couldn't record would read as never handed off, so
  // the store's error stays showing rather than the green summary.
  if (result.ok && unrecorded) return io.say(errorMessage(unrecorded), P.red)
  io.say(result.text, result.ok ? P.green : P.red)
}

// '' once it's running, else what went wrong.
type Started = { error?: string }

// claude --bg prints its id and returns once the agent is running.
async function startInBackground({ io }: Ctx, cwd: string, plan: LaunchPlan, claude: string): Promise<Started> {
  const { exit, out, error } = await startBg(io.spawn, claude, plan, cwd)
  if (error) return { error: t('todo.handOff.noClaude', { err: error.message }) }
  return exit ? { error: t('todo.handOff.bgFailed', { out: ui.tidy(out).trim().slice(0, 120) }) } : {}
}

// storeError: the agent started but its hand-off couldn't be recorded.
type AgentRun = { error: string } | { error?: undefined; storeError?: unknown }

async function startAgent(c: Ctx, item: Item, spec: TaskSpec): Promise<AgentRun> {
  const plan = launch(spec)
  const claude = c.io.claude()
  const started = await startInBackground(c, spec.cwd, plan, claude)
  if (started.error !== undefined) return { error: started.error }
  const handoff = { name: plan.name, where: 'bg' as const, pane: '', at: Date.now() }
  const { error } = attempt(c, () => change(item.id, { handoff }))
  log.info('agent started', { id: item.id, name: plan.name })
  return { storeError: error }
}

// ---- Going to an item's agent or tab ----

// The popup closes once it has taken you somewhere; the pane stays.
const leave = ({ s, io }: Ctx): void => (s.config.popup ? io.quit() : io.draw())

// The workspace's tab pane in this window's layout session.
const tabsPaneOf = async ({ s, outer }: Ctx): Promise<string> => (await outer('show', '-t', `layout-${s.config.win}`, '-v', '@tabs')).out.trim()

// The agent opened in the hub beside its list, as the tray's Go does: a tab
// agent through a session of its own, so the workspace stays on its tab, a
// background one with claude attach.
async function goToAgent(c: Ctx, item: Item, agent: Agent): Promise<void> {
  const { win } = c.s.config
  const went = await c.io.openInHub(agent, win ? `layout-${win}` : '')
  if (!went.ok) {
    log.warn('agent not opened in the hub', { id: item.id, err: went.message })
    return c.io.say(went.message, P.red)
  }
  log.info('went to agent', { id: item.id, agent: agent.id })
  leave(c)
}

// The hub opens its tabs itself, beside its board, so this only shows the
// hub and says where to find the tab.
async function goToHubTab(c: Ctx, at: TabPane): Promise<void> {
  const { win, popup } = c.s.config
  const here = at.win === win
  if (here && win) await c.outer('select-window', '-t', `layout-${win}:hub`)
  if (popup && here) return c.io.quit()
  c.io.say(here ? t('todo.go.hubTab') : t('todo.go.hubTabElsewhere', { win: at.win }))
}

async function goToTab(c: Ctx, item: Item, pane: string, at: TabPane): Promise<void> {
  const { win } = c.s.config
  await c.tabs('select-window', '-t', `${at.session}:${at.window}`)
  await c.tabs('select-pane', '-t', pane)
  log.info('went to tab', { id: item.id, pane })
  if (at.win !== win && win) return c.io.say(t('todo.go.switched', { n: at.index, win: at.win }))
  if (win) {
    const tabsPane = await tabsPaneOf(c)
    await c.outer('select-window', '-t', `layout-${win}:work`)
    if (tabsPane) await c.outer('select-pane', '-t', tabsPane)
  }
  leave(c)
}

function offerReopen(c: Ctx, item: Item) {
  const { io } = c
  if (!c.s.config.win) return io.say(t('todo.go.noLayout'), P.red)
  const folder = ui.reopenDir(item, io.exists)
  if (!folder) return io.say(t('todo.go.closedAndGone', { repo: item.repo }), P.peach)
  const ask = t(item.session ? 'todo.confirm.reopenResume' : 'todo.confirm.reopen', { folder: basename(folder) })
  io.confirm(ask, () => void track(c, reopen(c, item, folder)), '\r', [
    ['↵', t('hints.open')],
    [t('todo.confirm.otherKeys'), t('hints.cancel')],
  ])
}

async function goTo(c: Ctx, item: Item): Promise<void> {
  const { s, io } = c
  s.panes = await readPanes(c)
  s.agents = io.agents()
  // A prompt opened while tmux answered has the keys now; going anywhere,
  // or asking to reopen, would take them from it.
  if (s.prompt) return log.debug('go dropped for an open prompt', { id: item.id })
  const agent = ui.hubAgent(item, s.agents, ui.serverOf(s.panes))
  if (agent) return goToAgent(c, item, agent)
  const agentTab = ui.agentPane(item, s.panes)
  const pane = agentTab || item.pane
  if (!pane) return io.say(ui.noTabText(item))
  // Unread, an open tab would look closed and be offered for reopening.
  if (!s.panes) return io.say(t('todo.go.tabsUnread'), P.red)
  const at = agentTab ? s.panes.get(agentTab) : ui.paneAt(s.panes, pane, item.paneServer)
  if (at?.hub) return goToHubTab(c, at)
  if (at) return goToTab(c, item, pane, at)
  offerReopen(c, item)
}

async function reopen(c: Ctx, item: Item, folder: string): Promise<void> {
  const { s, io } = c
  const { win, popup } = s.config
  const claude = c.io.claude()
  const made = await c.tabs('new-window', '-t', `ghostty-${win}:`, '-c', folder, '-P', '-F', '#{pane_id}')
  if (!made.ok) return io.say(t('todo.go.noTab', { err: made.err }), P.red)
  const pane = made.out.trim()
  const typed = await typeLine(c, pane, ui.reopenLine(claude, item.session))
  if (typed) {
    log.warn('claude not started', { id: item.id, pane, err: typed })
    return io.say(t('todo.go.noClaude', { err: typed }), P.red)
  }
  // Its server replaces the old pane's, which may have been another's.
  write(c, () => change(item.id, { pane, paneServer: ui.serverOf(s.panes) }))
  log.info('tab reopened', { id: item.id, pane, path: folder })
  const tabsPane = await tabsPaneOf(c)
  if (tabsPane) await c.outer('select-pane', '-t', tabsPane)
  await c.outer('select-window', '-t', `layout-${win}:work`)
  if (popup) return io.quit()
  void refresh(c)
}

// ---- Work in flight ----

// Work that records what it did only at its end (a hand-off, a reopened
// tab, an add by hand), which the view waits for before it quits: quitting
// halfway would leave agents unstarted and what did start unrecorded.
function track(c: Ctx, work: Promise<void>): Promise<void> {
  c.work.add(work)
  const done = (): void => void c.work.delete(work)
  work.then(done, done)
  return work
}

// Includes work started meanwhile.
async function settled(c: Ctx): Promise<void> {
  while (c.work.size) await Promise.allSettled([...c.work])
}

export function todoEffects(s: State, io: Io) {
  const polls = failing(log)
  // Every tmux call but the polls is something you asked for, so each
  // failure is logged.
  const tmux = async (socket: string, args: string[]): Promise<RunResult> => {
    const cmd = ['tmux', '-L', socket, ...args]
    const r = await io.run(cmd)
    if (!r.ok) log.warn('tmux failed', { cmd, err: r.err })
    return r
  }
  const c: Ctx = {
    s,
    io,
    tabs: (...args) => tmux(s.config.tabsSocket, args),
    outer: (...args) => tmux(LAYOUT_SOCKET, args),
    polls,
    refreshing: 0,
    refreshRun: 0,
    work: new Set(),
    retrying: new Map(),
  }
  return {
    readStore: (force?: boolean) => readStore(c, force),
    refresh: () => refresh(c),
    readPanes: () => readPanes(c),
    attempt: <T>(action: () => T) => attempt(c, action),
    write: <T>(action: () => T) => write(c, action),
    setDone: (item: Item) => setDone(c, item),
    setCategory: (item: Item) => setCategory(c, item),
    setType: (item: Item) => setType(c, item),
    save: (edit: ui.EditSave) => save(c, edit),
    erase: (item: Item) => erase(c, item),
    finishAdd: (add: ui.ByHand) => track(c, finishAdd(c, add)),
    file: (text: string, images?: readonly Image[]) => file(c, text, images),
    pasteImage: () => pasteImageInto(c),
    pasteFiles: (files: readonly string[]) => pasteFiles(c, files),
    sweepImages: () => sweep(c),
    retryFiling: (item: Item | undefined) => retryFiling(c, item),
    handoffAt: () => handoffAt(c),
    handOff: (ids: readonly string[], at: Here, how: HandoffHow) => track(c, handOff(c, ids, at, how)),
    goTo: (item: Item) => goTo(c, item),
    reopen: (item: Item, folder: string) => track(c, reopen(c, item, folder)),
    busy: () => c.work.size > 0,
    settled: () => settled(c),
  }
}

export type TodoEffects = ReturnType<typeof todoEffects>
