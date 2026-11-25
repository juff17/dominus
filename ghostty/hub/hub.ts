#!/usr/bin/env node
// The agent hub: every Claude session on the machine, as the H4 design draws
// it, task agents in four lanes and monitors in a strip below. It runs in the
// hub window of the window's outer tmux (layout.conf), next to the rail;
// state comes from agentd through client.ts.
// Drawing is view.ts, the open session peek.ts, and what the keys do to
// the world actions.ts; this file keeps the state and runs the loop.

import { readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Asked, actionsOf, pruneResults } from './actions.ts'
import {
  type Focus,
  LANES,
  type Selected,
  filledOf,
  listItems as itemsOf,
  listMode as isListMode,
  nextAfter,
  nextLane,
  pickable,
  selector,
  shownLanes,
  step,
  stepList,
  tabFocus,
  visible as matching,
  where as whereOf,
} from './board.ts'
import { logCrashes } from '../core/crash.ts'
import { type Action, AGENT_VIEW_KEY, DIAGRAMS_KEY, EDITOR_KEY, NEW_AGENT_KEY, OPEN_AGENT_KEY, PEEK_CLOSING_KEY, answerConfirm, filterKey, hitAt, keyAction, mouseAction, splashAction } from './keys.ts'
import { peekOf } from './peek.ts'
import { tmuxOf } from './tmux.ts'
import { type ClickActs, type Hit, type HubPrefs, type HubUi, type Note, type Scroll, boardFrame, listFrame, quiet } from './view.ts'
import { follow, markReviewed } from '../agents/client.ts'
import { type Agent, attentionTags, brokeTags, lanes, monitorsOf } from '../agents/model.ts'
import { errCode, logger } from '../core/log.ts'
import { RUN, hubOpen } from '../core/paths.ts'
import { run } from '../core/proc.ts'
import { load as settings } from '../settings/settings.ts'
import { recents as recentsOf, remember as rememberIn, storePaths } from '../settings/prefs.ts'
import { BOARD } from '../tui/gear-art.ts'
import { BOARD_ID, type Cell, type GearCells, fit, gearFile, gearRow, sendGear } from '../tui/gear.ts'
import type { Mouse } from '../tui/input.ts'
import { ACCENT, P, enter, leave, out, paint, tokens } from '../tui/term.ts'

const log = logger('hub')
logCrashes(log)

const HERE = dirname(fileURLToPath(import.meta.url))
const CONF = process.env.GHOSTTY_CONF || dirname(HERE)
const WIN = Number(process.env.HUB_WIN) || 0
// Ghostty's own PATH may lack claude; bin/ghostty-hub finds it.
const CLAUDE = process.env.AGENT_HUB_CLAUDE || 'claude'
const HOME = homedir()
const { recents: RECENTS } = storePaths(process.env, HOME)
const listCols = () => settings()['hub.listCols']

// AGENT_HUB_TABS_SOCKET points the hub at another tab server, for tests.
const { outer, tabs, probeTabs } = tmuxOf({ log })

// ------------------------------------------------------------ state

let agents: Agent[] = []
let focus: Focus = 0
const selected: Selected = { needs: null, working: null, done: null, idle: null, monitors: null }
const scroll: Scroll = { needs: 0, working: 0, done: 0, idle: 0, list: 0 }
let filter = ''
let filtering = false
let filterAt: number | undefined // the filter's caret, as tui/line.ts keeps it; none is the end
let listSel: string | null = null // id in the list beside an open session
let confirm: Asked | null = null // skip names the setting that asks it, which answering a turns off
let note: Note | null = null
let hits: Hit[] = []
// Sent ahead of the next frame: the board's gear, when it changes.
let setup = ''

const cols = () => process.stdout.columns || 120
const rows = () => process.stdout.rows || 40

// How long a note stays in the footer: Settings' hub.noteSecs, unless the
// caller asks for longer (a background start says it's starting until done).
const noteMs = () => settings()['hub.noteSecs'] * 1000
function say(text: string, color: string = P.sub, ms = noteMs()) {
  note = { text, color, until: Date.now() + ms }
  draw()
}

const visible = () => matching(agents, filter)
const board = () => lanes(visible())
const strip = () => monitorsOf(visible())
const where = (a: Agent) => whereOf(a, WIN)

const current = () => selector(selected, board(), strip())

const listPicked = () => pickable(listItems()).find(x => x.id === listSel)

function focusedMonitor() {
  if (listMode()) return listPicked()?.monitor ?? null
  return focus === 4 ? current().monitor().item : null
}

function focused(): Agent | null {
  if (listMode()) return listPicked()?.agent ?? null
  if (focus === 4) return current().monitor().item?.agent ?? null
  return current().lane(LANES[focus]).item
}

const listMode = () => isListMode(peek.current, cols())
// The board's gear screen, with nothing to show in its lanes (view.ts quiet).
const splashShown = () => !listMode() && quiet({ agents: visible(), filter }, shownLanes())

const listItems = () => itemsOf(board(), strip())

const peek = peekOf({
  outer,
  tabs,
  probeTabs,
  run,
  say,
  draw,
  agents: () => agents,
  select: id => (listSel = id),
  focused,
  cols,
  listCols,
  win: WIN,
  CONF,
  claude: CLAUDE,
  markReviewed,
  log,
})

const act = actionsOf({
  outer,
  tabs,
  say,
  noteMs,
  openSession: a => peek.openSession(a),
  agents: () => agents,
  focusedFolder: () => focused()?.cwd ?? '',
  recents: () => recentsOf(RECENTS, agents, HOME),
  remember: dir => rememberIn(RECENTS, dir, agents, HOME),
  win: WIN,
  CONF,
  claude: CLAUDE,
  log,
})

// ------------------------------------------------------------ keys

// A click on the board only selects; Enter opens the session.
function pick(laneIndex: Focus, id: string) {
  focus = laneIndex
  selected[LANES[laneIndex]] = id
}

function pickMonitor(key: string) {
  focus = 4
  selected.monitors = key
}

const clicks: ClickActs = {
  newAgent: () => act.newAgent(),
  pick,
  pickMonitor,
  closePeek: () => peek.closePeek(),
  openItem: it => ((listSel = it.id), peek.openSession(it.agent)),
}

const filled = (i: Focus) => filledOf(board(), strip(), shownLanes())(i)
const moveLane = (n: number) => (focus = nextLane(focus, n, filled))

function moveIn(n: number) {
  if (listMode()) {
    listSel = stepList(listItems(), listSel, n)
    // The session beside the list follows the selection.
    peek.preview()
    return
  }
  if (focus === 4) {
    const { list, i } = current().monitor()
    const next = step(list, i, n)
    if (next) selected.monitors = next.key
    return
  }
  const name = LANES[focus]
  const { list, i } = current().lane(name)
  const next = step(list, i, n)
  if (next) selected[name] = next.id
}

// x on a monitor stops it, on an agent closes it; either may ask first, and
// the question waits in the footer for the next key: `key` once more is yes.
function close(key: string) {
  const m = focusedMonitor()
  const a = m ? null : focused()
  const question = m ? act.stopMonitor(m) : act.closeAgent(a, a && where(a), () => a && showNext(a))
  if (question) confirm = { ...question, key }
}

// Closing the agent open beside the list would take its session with it and
// bring the board back, so the next agent in the list (the first, after the
// last) takes its place first. With none to show, the board comes back.
async function showNext(a: Agent) {
  if (peek.current?.id !== a.id || !listMode()) return
  const next = nextAfter(listItems(), a.id, x => peek.opensHere(x))
  log.info('session moved on', { id: a.id, next: next?.agent.id ?? null })
  if (!next) return
  listSel = next.id
  await peek.showInstead(next.agent)
}

const actions: Record<Action, (key: string) => unknown> = {
  laneLeft: () => moveLane(-1),
  laneRight: () => moveLane(1),
  down: () => moveIn(1),
  up: () => moveIn(-1),
  tab: () => (focus = tabFocus(focus, filled)),
  open: () => peek.openSession(focused()),
  allow: () => act.answer(focused(), true),
  deny: () => act.answer(focused(), false),
  reviewed: () => {
    const a = focused()
    if (a?.state === 'done') markReviewed(a.id)
  },
  reviewAll: () => board().done.forEach(a => markReviewed(a.id)),
  goToTab: () => peek.goToTab(focused()),
  close,
  restart: () => act.restart(focused()),
  restartAll: key => {
    const question = act.restartAll()
    if (question) confirm = { ...question, key }
  },
  new: () => act.newAgent(),
  filter: () => ((filtering = true), (filter = ''), (filterAt = undefined)),
  back: () => (peek.current ? peek.closePeek() : outer('select-window', '-t', `layout-${WIN}:work`)),
  workspace: () => outer('select-window', '-t', `layout-${WIN}:work`),
}

function onKey(key: string) {
  if (confirm) {
    const c = confirm
    confirm = null
    const r = answerConfirm(c, key)
    if (r.remember) act.dontAsk(r.remember)
    if (r.yes) void c.yes()
    return
  }
  if (filtering) {
    const f = filterKey(filter, key, filterAt)
    filter = f.filter
    filtering = f.filtering
    filterAt = f.at
    return
  }
  const action = splashShown() ? splashAction(key) : keyAction(key)
  if (action) void actions[action](key)
}

function onMouse(m: Mouse) {
  const act = mouseAction(m)
  if (act?.wheel) {
    // The sidebar list scrolls from the keyboard only: a wheel there skipped
    // past headers it couldn't come back to.
    if (listMode()) return
    const h = hitAt(hits, m.x, m.y, true)
    if (h?.wheel !== undefined) focus = h.wheel
    return moveIn(act.wheel)
  }
  if (act?.click) void hitAt(hits, m.x, m.y)?.act()
}

// The tray asks for an agent's session by writing its id to a file and
// sending OPEN_AGENT_KEY. The file is this window's, so two windows' hubs
// asked at once each open their own.
const REQUEST = hubOpen(WIN)

// An id asked for before agentd's first state reached this hub (one just
// restarted has none yet), or of an agent too new for the state it has: the
// next state is looked in once more.
let wanted: string | null = null

function openRequested() {
  const id = readRequest()
  if (id && !openById(id)) wanted = id
}

function readRequest(): string {
  const path = REQUEST
  let id: string
  try {
    id = readFileSync(path, 'utf8').trim()
  } catch (err) {
    if (errCode(err) === 'ENOENT') log.warn('open request missing', { path })
    else log.warn('open request unreadable', { path, err })
    return ''
  }
  try {
    unlinkSync(path)
  } catch (err) {
    log.warn('open request not removed', { path, err })
  }
  return id
}

// Opens the agent with this id, when the hub has it. A filter that hides it
// is cleared: the list beside it would otherwise leave it out and select
// another, which Enter and Ctrl+X would then act on.
function openById(id: string): boolean {
  const a = agents.find(x => x.id === id)
  if (!a) return false
  if (!visible().includes(a)) clearFilter()
  void peek.openSession(a)
  return true
}

function clearFilter() {
  filter = ''
  filtering = false
  filterAt = undefined
}

// ------------------------------------------------------------ the gear

// With nothing running the board shows the gear (view.ts splashFrame,
// tui/gear.ts), its PNGs shared with every window.
const GEARS = join(RUN, 'gear')
const FOCUS_ON = '\x1b[?1004h'
const FOCUS_OFF = '\x1b[?1004l'
const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'
// Known once tmux has a client to ask; there's no gear until then.
let cell: Cell | null = null
// What was last sent to the terminal, so it's sent again only when the size
// or the theme colour changes, or the hub comes back into view.
let sent = ''

async function readCell() {
  const r = await outer('display', '-p', '#{client_cell_width} #{client_cell_height}')
  const [cw, ch] = r.out.trim().split(' ').map(Number)
  if (!r.ok || !cw || !ch || (cw === cell?.cw && ch === cell?.ch)) return
  cell = { cw, ch }
  draw()
}

// About a quarter of the board's height, in whole multiples of its pixels.
function gear(): GearCells | null {
  const f = cell && fit(BOARD, cell, cols() - 4, Math.floor(rows() / 4))
  if (!cell || !f) return null
  const spec = `${f.scale} ${f.cols} ${f.rows} ${cell.cw} ${cell.ch} ${ACCENT}`
  if (spec !== sent) {
    sent = spec
    try {
      setup = sendGear(BOARD_ID, gearFile(GEARS, 'board', BOARD, f, cell), f)
      log.debug('gear sent', { scale: f.scale, cols: f.cols, rows: f.rows, cw: cell.cw, ch: cell.ch })
    } catch (err) {
      log.warn('gear not drawn', { dir: GEARS, err })
      return null
    }
  }
  return { cols: f.cols, rows: Array.from({ length: f.rows }, (_, r) => gearRow(BOARD_ID, f, r)) }
}

// ------------------------------------------------------------ main

function draw() {
  const started = log.enabled('debug') ? performance.now() : 0
  const list = listMode()
  const s = settings()
  const prefs: HubPrefs = { shown: shownLanes(), doneCards: s['hub.doneCards'], monitorRows: s['hub.monitorRows'], broke: brokeTags(), attention: attentionTags() }
  const ui: HubUi = { agents: visible(), filter, filtering, filterAt, focus, selected, scroll, listSel, peek: peek.current, confirm, note, win: WIN, now: Date.now() }
  if (!list && quiet(ui, prefs.shown)) ui.splash = gear()
  const f = (list ? listFrame : boardFrame)(ui, prefs, { w: cols(), h: rows() }, clicks)
  focus = f.focus
  listSel = f.listSel
  Object.assign(selected, f.selected)
  Object.assign(scroll, f.scroll)
  hits = f.hits
  paint(f.lines, { before: setup })
  setup = ''
  if (started) log.debug('redraw', { list, ms: Math.round((performance.now() - started) * 100) / 100 })
}

if (!process.stdin.isTTY) {
  console.error('hub.ts needs a terminal.')
  process.exit(1)
}
process.stdin.setRawMode(true)
process.stdin.on('data', data => {
  for (const t of tokens(data)) {
    // tmux drops what a hidden pane sends the terminal, so the gear is sent
    // again each time the hub comes into view. Focus reports are never keys.
    if (t.key === FOCUS_IN || t.key === FOCUS_OUT) {
      if (t.key === FOCUS_IN) {
        sent = ''
        void readCell()
      }
      continue
    }
    if (t.key === NEW_AGENT_KEY) {
      confirm = null
      filtering = false
      void act.newAgent()
    } else if (t.key === OPEN_AGENT_KEY) openRequested()
    else if (t.key === DIAGRAMS_KEY) void peek.showDiagrams()
    else if (t.key === EDITOR_KEY) void peek.openEditor()
    else if (t.key === AGENT_VIEW_KEY) {
      confirm = null
      filtering = false
      void peek.agentView()
    }
    else if (t.key === PEEK_CLOSING_KEY) peek.forget()
    else if (t.mouse) onMouse(t.mouse)
    else if (t.key) onKey(t.key)
  }
  draw()
})
// After the new size is read; a SIGWINCH handler can run before that.
// Beside an open session the list keeps its width: tmux shares a window
// resize out between the panes, so the hub puts its own width back, as the
// rail does. Not once the session's pane is gone, when the hub should widen.
process.stdout.on('resize', async () => {
  // A font size change resizes the pane too.
  void readCell()
  draw()
  const p = peek.current
  if (p && cols() !== listCols() && (await peek.paneAlive(p.pane)))
    await outer('resize-pane', '-t', process.env.TMUX_PANE ?? '', '-x', String(listCols()))
})
const bye = (signal: NodeJS.Signals) => {
  log.info('stopped', { signal })
  out(FOCUS_OFF)
  leave()
  process.exit(0)
}
process.on('SIGTERM', bye)
process.on('SIGHUP', bye)
log.info('started', { win: WIN })
pruneResults(RUN, Date.now(), log)
enter({}, FOCUS_ON)
void readCell()
follow(s => {
  agents = s.agents
  if (wanted) {
    const id = wanted
    wanted = null
    if (!openById(id)) log.warn('agent to open not found', { id })
  }
  draw()
})
draw()
void peek.findPeek().then(draw)
setInterval(() => {
  void act.adoptResult()
  draw()
}, 1000)
setInterval(() => void peek.watchPeek(), 400)
