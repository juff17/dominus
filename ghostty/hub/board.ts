// The hub's decisions, apart from its terminal and tmux: what's shown, what's
// selected and where it moves, how the board divides the screen, and what
// x asks before closing. hub.ts keeps the state and draws; these only
// compute, so they can be tested (board.test.ts).

import type { Agent, Lane, Lanes, StripMonitor } from '../agents/model.ts'
import { t } from '../core/text.ts'
import { load as settings } from '../settings/settings.ts'

export const LANES: readonly Lane[] = ['needs', 'working', 'done', 'idle']
// What has focus: 0–3 a lane by its index in LANES, 4 the monitors strip.
export type Focus = number
export type Filled = (focus: Focus) => boolean
export type Group = Lane | 'monitors'
export type Monitored = StripMonitor<Agent>

// The lanes the board draws: Idle is last, so turning it off in Settings
// leaves every other lane at its index.
export const shownLanes = (): readonly Lane[] => (settings()['hub.idleLane'] ? LANES : LANES.slice(0, 3))
// Below this width (Settings' hub.boardCols) the lanes get too narrow to
// read, so the hub draws the list it shows beside an open session.
export const minBoardCols = (): number => settings()['hub.boardCols']
// Rows the monitors tray keeps even when few or none run, so the board
// doesn't jump as monitors come and go; Settings' hub.monitorRows changes it.
export const MONITOR_ROWS = 5
// The fewest rows the lanes keep on a short screen, before the tray gives up
// its minimum.
export const MIN_LANE_ROWS = 10
export const LANE_GAP = 2

export function visible(agents: Agent[], filter: string): Agent[] {
  if (!filter) return agents
  const f = filter.toLowerCase()
  return agents.filter(a => `${a.title} ${a.repo} ${a.cmd} ${a.monitors.map(m => m.description).join(' ')}`.toLowerCase().includes(f))
}

// Where an agent runs, as its card says. `win` is this hub's window.
export function where(a: Pick<Agent, 'pane' | 'kind' | 'stopped'>, win: number): string {
  if (a.stopped) return t('hub.where.stopped')
  if (a.pane) {
    const tab = t(a.pane.hub ? 'hub.where.hubTab' : 'hub.where.tab', { n: a.pane.tab })
    return a.pane.win === win || !a.pane.win ? tab : t('hub.where.otherWindow', { win: a.pane.win, tab })
  }
  return t(a.kind === 'bg' ? 'hub.where.bg' : 'hub.where.terminal')
}

export const listMode = (peek: object | null, cols: number): boolean => Boolean(peek) || cols < minBoardCols()

// The selected item of a lane, kept by id so it stays put as cards move.
// When the id is gone the first item takes over; an empty lane keeps the id,
// so the card is selected again if it comes back.
export type Selection<T> = { list: T[]; i: number; item: T | null; id: string | null }

export function selection<T>(list: T[], key: (x: T) => string, id: string | null): Selection<T> {
  let i = list.findIndex(x => key(x) === id)
  if (i < 0 && list.length) {
    i = 0
    id = key(list[0])
  }
  return { list, i, item: list[i] ?? null, id }
}

// By id (a monitor's key); null before anything is selected.
export type Selected = Record<Group, string | null>

// Writes each lane's new selection back into `selected`.
export function selector(selected: Selected, l: Lanes<Agent>, strip: Monitored[]) {
  const keep = <T>(name: Group, list: T[], key: (x: T) => string): Selection<T> => {
    const sel = selection(list, key, selected[name])
    selected[name] = sel.id
    return sel
  }
  return {
    lane: (name: Lane) => keep(name, l[name], a => a.id),
    monitor: () => keep('monitors', strip, m => m.key),
  }
}

// A lane not `shown` has nothing to select.
export const filledOf =
  (l: Lanes<Agent>, strip: Monitored[], shown: readonly Lane[]): Filled =>
  i =>
    (i === 4 ? strip : i < shown.length ? l[LANES[i]] : []).length > 0

// The item n steps from i, held at the ends rather than wrapping.
export const step = <T>(list: readonly T[], i: number, n: number): T | undefined => list[Math.min(list.length - 1, Math.max(0, i + n))]

// h/l and the arrows step to the next lane with cards in it, skipping empty
// ones, where nothing would show as selected; lanes wrap, the monitors strip
// (4) counting as the fifth. Stays put when no other lane has anything.
export function nextLane(focus: Focus, n: number, filled: Filled): Focus {
  for (let s = 1; s < 5; s++) {
    const next = (((focus + n * s) % 5) + 5) % 5
    if (filled(next)) return next
  }
  return focus
}

export function keptFocus(focus: Focus, filled: Filled): Focus {
  if (filled(focus)) return focus
  for (let s = 1; s < 5; s++) {
    const next = (focus + s) % 5
    if (filled(next)) return next
  }
  return focus
}

// Tab goes between the lanes and the monitors strip; with no monitors it
// stays put, since the empty strip would only hand focus to another lane.
export const tabFocus = (focus: Focus, filled: Filled): Focus => (focus === 4 ? 0 : filled(4) ? 4 : focus)

// The board as one column, beside an open session. Only an agent or a
// monitor has an id, and only those can be selected.
export type ListItem =
  | { spacer: true; id?: undefined }
  | { group: Group; count: number; id?: undefined }
  | { empty: Group; id?: undefined }
  | { id: string; agent: Agent; lane: Lane; monitor?: undefined }
  | { id: string; agent: Agent; monitor: Monitored }
export type Pickable = Extract<ListItem, { id: string }>

export const pickable = (items: ListItem[]): Pickable[] => items.filter((x): x is Pickable => x.id !== undefined)

export function listItems(l: Lanes<Agent>, monitors: Monitored[], shown: readonly Lane[] = shownLanes()): ListItem[] {
  const items: ListItem[] = []
  const group = <T>(name: Group, list: T[], toItem: (x: T) => ListItem) => {
    if (items.length) items.push({ spacer: true })
    items.push({ group: name, count: list.length })
    if (!list.length) items.push({ empty: name })
    for (const x of list) items.push(toItem(x))
  }
  for (const name of shown) group(name, l[name], a => ({ id: a.id, agent: a, lane: name }))
  group('monitors', monitors, m => ({ id: `m:${m.key}`, agent: m.agent, monitor: m }))
  return items
}

export function stepList(items: ListItem[], sel: string | null, n: number): string | null {
  const list = pickable(items)
  const i = list.findIndex(x => x.id === sel)
  return step(list, i, n)?.id ?? null
}

// The item to show once `id`'s agent closes: the next one in the list, the
// first after the last, skipping the closing agent's other rows (its
// monitors) and any `shows` can't open beside the list.
export function nextAfter(items: ListItem[], id: string, shows: (a: Agent) => boolean): Pickable | null {
  const list = pickable(items)
  const i = list.findIndex(x => x.agent.id === id)
  if (i < 0) return null
  const after = [...list.slice(i + 1), ...list.slice(0, i)]
  return after.find(x => x.agent.id !== id && shows(x.agent)) ?? null
}

export function listSelection(items: ListItem[], sel: string | null, peekId: string | null | undefined): string | null {
  const list = pickable(items)
  if (list.some(x => x.id === sel)) return sel
  return (list.find(x => x.agent.id === peekId) ?? list[0])?.id ?? null
}

// The list's first row so the selected item is in view, with the headers,
// spacers and empty lines right above it: nothing can select those, so
// scrolling up to them is only ever done by selecting what's under them.
// Never past the list's last screenful: a list that shrank under an old
// scroll, with nothing left to select, would otherwise draw no rows at all,
// its headers included.
export function listScroll(items: readonly ListItem[], heights: number[], sel: number, top: number, room: number): number {
  const total = heights.reduce((n, h) => n + h, 0)
  if (sel >= 0) {
    let from = sel
    while (from > 0 && items[from - 1].id === undefined) from--
    const first = heights.slice(0, from).reduce((n, h) => n + h, 0)
    const last = heights.slice(0, sel + 1).reduce((n, h) => n + h, 0)
    if (first < top) top = first
    if (last > top + room) top = last - room
  }
  return Math.max(0, Math.min(top, total - room))
}

// The rows the lanes and the monitors tray get on a screen H rows high,
// with `mons` monitors. The tray is its header and the row under it, then
// its rows: at least `kept`, more with more monitors, up to about a third
// of the screen; on a short screen the lanes keep MIN_LANE_ROWS first.
export function boardRows(H: number, mons: number, kept = MONITOR_ROWS): { stripH: number; laneH: number } {
  const most = Math.max(kept, Math.floor(H / 3) - 2)
  const fit = Math.max(1, H - 4 - MIN_LANE_ROWS - 2)
  const stripH = 2 + Math.min(Math.min(Math.max(mons, kept), most), fit)
  const laneH = Math.max(6, H - 2 - stripH - 2)
  return { stripH, laneH }
}

// Equal lanes, the last taking what's left over.
export function laneColumns(W: number, n = shownLanes().length): { w: number; x: number }[] {
  const w = Math.floor((W - (n - 1) * LANE_GAP) / n)
  return Array.from({ length: n }, (_, i) => ({ w: i === n - 1 ? W - (n - 1) * (w + LANE_GAP) : w, x: 1 + i * (w + LANE_GAP) }))
}

// The tray's first monitor and how many it shows in `space` rows: a full
// tray keeps a row to say how many it hides.
export function trayWindow(n: number, space: number, sel: number): { top: number; room: number } {
  const room = n > space ? space - 1 : space
  const top = Math.max(0, Math.min(sel - room + 1, n - room))
  return { top, room }
}

// What x asks before closing a done or idle agent, or why it won't. A tab
// parked on a background job is one agent with it, so both go. Closing a
// session ends every monitor it armed, so the question says how many.
export type CloseHow = 'tab+job' | 'tab' | 'job'
export type CloseQuestion = { refuse: string; how?: undefined; text?: undefined } | { how: CloseHow; text: string; refuse?: undefined }

export function closeQuestion(a: Pick<Agent, 'state' | 'monitors' | 'title' | 'pane' | 'jobId'>, place: string): CloseQuestion {
  if (a.state === 'working' || a.state === 'needs') return { refuse: t('hub.close.refuseBusy') }
  const live = a.monitors.filter(m => m.state !== 'ended').length
  const words = { place, title: a.title, also: live ? t('hub.close.alsoMonitors', { n: live }) : '' }
  if (a.pane && a.jobId) return { how: 'tab+job', text: t('hub.close.tabJob', words) }
  if (a.pane) return { how: 'tab', text: t('hub.close.tab', words) }
  if (a.jobId) return { how: 'job', text: t('hub.close.job', words) }
  return { refuse: t('hub.close.outside', words) }
}

// The pane marked @peek in `list-panes -F '#{pane_id} #{@peek}'` output.
export const markedPane = (list: string): string | undefined => list.split('\n').map(l => l.split(' ')).find(([, mark]) => mark === '1')?.[0]

// The active window in `list-windows -F '#{window_active} #{window_id}'` output.
export const activeWindow = (out: string): string | null => out.split('\n').find(l => l.startsWith('1 '))?.slice(2) ?? null

export const shq = (s: unknown): string => `'${String(s).replace(/'/g, `'\\''`)}'`
