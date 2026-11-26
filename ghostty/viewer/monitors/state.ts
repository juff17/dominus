// The Monitors popup's state and keys, apart from the terminal so it can be
// tested. Pipelines and Logs keep theirs in pipe-state.ts and logs-state.ts.
// Keys that need the world come back as an Act for effects.ts to carry out.

import type { Agent } from '../../agents/model.ts'
import { t } from '../../core/text.ts'
import type { Proposal } from '../../tray/approvals.ts'
import { type Image, keptImages, nextNumber, placeholder } from '../../core/images.ts'
import { editField, oneLine, pasteField } from '../../tui/line.ts'
import {
  type Effect as ApprovalEffect,
  type State as ApprovalsState,
  onKey as approvalsKey,
  paste as pasteApprovals,
  reload as reloadApprovals,
  start as startApprovals,
} from '../approvals/approvals.ts'
import { type AttachOptions, type Attached, DEFAULT_WATCH, UNTILS, type Until, WATCH_KEYS, type Watch } from './attach.ts'
import type { HostResult, Pr } from './forge.ts'
import { type LogsAct, type LogsOptions, type LogsState, logsKey, pasteLogs, startLogs, typeTask } from './logs-state.ts'
import { watchedPipes } from './pipe-rows.ts'
import { type PipeAct, type PipesState, itemsOf, movePipes, pastePipes, pipesKey, startPipes } from './pipe-state.ts'
import { type PrRow, type Role, type RunRow, matchUrl, prRows, runRows, sameUrl, watchedPrs } from './rows.ts'
import { CTRL_S } from '../../tui/input.ts'

export type View = 'running' | 'prs' | 'pipes' | 'logs'
export const VIEWS: readonly View[] = ['running', 'prs', 'pipes', 'logs']
const FILTERED: readonly View[] = ['running', 'prs', 'pipes']

// `at` is the caret (tui/line.ts); none is the end.
export type Filter = { open: boolean; typing: boolean; query: string; at?: number }

export type Focus = 'list' | 'brief' | 'until' | 'model' | 'effort'
export const CHOICES: readonly Focus[] = ['until', 'model', 'effort']

// `at` is the brief's caret; `more` is whether the choices `m` opens show;
// `images` those pasted into the brief (Ctrl+V), each its [Image #n] there.
export type Drawer = AttachOptions & { at?: number; more: boolean; focus: Focus; images?: Image[] }

// A line the footer says until the next key.
export type Note = { text: string; tone: 'green' | 'red' | 'peach' | 'sub' }
export type Ask = { key: string; name: string; title: string }
// Stops the selected monitor, and once more when it asks first.
export const STOP_KEY = 'x'

// sel is a monitor's key or a PR's address; drawing sets scroll to fit the
// cursor.
export type Cursor = { sel: string | null; scroll: number }

// target is the row's name as the panel opened.
export type Panel = { key: string; target: string; ap: ApprovalsState }

export type Options = { models: readonly string[]; efforts: readonly string[]; model: string; effort: string; watch: Watch; until: Until; askStop: boolean }

export type MonitorsState = {
  view: View
  agents: Agent[]
  proposals: Proposal[]
  panel: Panel | null
  hosts: HostResult[]
  refreshing: boolean
  role: Role
  drafts: boolean
  run: Cursor & { want: string[] }
  prs: Cursor & { marked: Set<string> }
  filters: Record<View, Filter>
  drawer: Drawer | null
  ask: Ask | null
  note: Note | null
  attached: Attached
  // checkout.ts repoKey → folder.
  checkouts: Map<string, string>
  options: Options
  pipes: PipesState
  logs: LogsState
}

export type Act =
  | { do: 'quit' }
  | { do: 'open'; key: string }
  | { do: 'approval'; e: ApprovalEffect }
  | { do: 'stop'; key: string; remember: boolean }
  | { do: 'browse'; url: string }
  | { do: 'refresh' }
  | { do: 'start'; prs: Pr[]; options: AttachOptions; images: Image[] }
  | Exclude<PipeAct, null>
  | Exclude<LogsAct, null>
  | null

export type StartOptions = { view?: View; role?: Role; drafts?: boolean; options?: Partial<Options>; fromPrs?: boolean; keepMs?: number; logs?: Partial<LogsOptions> }

const closedFilter = (): Filter => ({ open: false, typing: false, query: '' })

export function start({ view = 'running', role = 'mine', drafts = true, options = {}, fromPrs = true, keepMs = 0, logs = {} }: StartOptions = {}): MonitorsState {
  return {
    view,
    agents: [],
    proposals: [],
    panel: null,
    hosts: [],
    refreshing: false,
    role,
    drafts,
    run: { sel: null, scroll: 0, want: [] },
    prs: { sel: null, scroll: 0, marked: new Set() },
    filters: { running: closedFilter(), prs: closedFilter(), pipes: closedFilter(), logs: closedFilter() },
    drawer: null,
    ask: null,
    note: null,
    attached: {},
    checkouts: new Map(),
    options: { models: ['sonnet'], efforts: ['medium'], model: 'sonnet', effort: 'medium', watch: { ...DEFAULT_WATCH }, until: 'merged', askStop: true, ...options },
    pipes: startPipes(fromPrs, keepMs),
    logs: startLogs(logs),
  }
}

// ------------------------------------------------------------ what's shown

export const runningRows = (s: Pick<MonitorsState, 'agents' | 'hosts' | 'filters' | 'proposals'>): RunRow[] => runRows(s.agents, s.hosts, s.filters.running.query, s.proposals)
export const allRunning = (s: Pick<MonitorsState, 'agents' | 'hosts' | 'proposals'>): RunRow[] => runRows(s.agents, s.hosts, '', s.proposals)

export function prList(s: Pick<MonitorsState, 'agents' | 'hosts' | 'role' | 'drafts' | 'filters' | 'proposals'>): { rows: PrRow[]; hidden: number } {
  return prRows(s.hosts, s.role, s.drafts, s.filters.prs.query, watchedPrs(allRunning(s)))
}

const indexOf = (keys: readonly string[], sel: string | null): number => Math.max(0, sel === null ? 0 : keys.indexOf(sel))

export function selectedRun(s: MonitorsState): RunRow | null {
  const rows = runningRows(s)
  return rows[indexOf(rows.map(r => r.key), s.run.sel)] ?? null
}

export function selectedPr(s: MonitorsState): PrRow | null {
  const { rows } = prList(s)
  return rows[indexOf(rows.map(r => sameUrl(r.pr.url)), s.prs.sel)] ?? null
}

// The marked PRs, else the one under the cursor. Marked ones the filter
// hides still count.
export function targets(s: MonitorsState): Pr[] {
  const all = prRows(s.hosts, s.role, s.drafts, '', new Map()).rows.map(r => r.pr)
  const marked = all.filter(pr => s.prs.marked.has(sameUrl(pr.url)))
  if (marked.length) return marked
  const one = selectedPr(s)
  return one ? [one.pr] : []
}

// ------------------------------------------------------------ data in

export const watchedSet = (s: Pick<MonitorsState, 'agents' | 'hosts' | 'proposals'>): Set<string> => watchedPipes(allRunning(s))

// A monitor just started is selected once it shows (rows.ts match).
export function setAgents(s: MonitorsState, agents: Agent[]): void {
  s.agents = agents
  if (!s.run.want.length) return
  const hit = allRunning(s).find(r => r.match.some(k => s.run.want.includes(k)))
  if (!hit) return
  s.run.sel = hit.key
  s.run.want = []
}

export const setHosts = (s: MonitorsState, hosts: HostResult[]): void => {
  s.hosts = hosts
}

// The panel isn't reloaded while it settles a proposal or edits a reply,
// so what you're doing stays as it is.
export function setProposals(s: MonitorsState, list: Proposal[]): void {
  s.proposals = list
  const ap = s.panel?.ap
  if (!ap || ap.busy || ap.editing) return
  reloadApprovals(ap, panelRow(s)?.waits ?? [])
}

// ------------------------------------------------------------ moving

function moveIn(c: Cursor, keys: readonly string[], n: number): void {
  if (!keys.length) return
  const i = Math.max(0, Math.min(keys.length - 1, indexOf(keys, c.sel) + n))
  c.sel = keys[i]
}

const runKeys = (s: MonitorsState): string[] => runningRows(s).map(r => r.key)
const prKeys = (s: MonitorsState): string[] => prList(s).rows.map(r => sameUrl(r.pr.url))

export const pipeItemsOf = (s: MonitorsState) => itemsOf(s.pipes, watchedSet(s), s.filters.pipes.query)

export function move(s: MonitorsState, n: number): void {
  if (s.view === 'running') moveIn(s.run, runKeys(s), n)
  else if (s.view === 'prs') moveIn(s.prs, prKeys(s), n)
  else if (s.view === 'pipes') movePipes(s.pipes, pipeItemsOf(s), n)
}

export function setView(s: MonitorsState, view: View): void {
  s.view = view
  s.ask = null
  if (view !== 'running') s.panel = null
}

const cycleView = (s: MonitorsState, dir: 1 | -1): void => setView(s, VIEWS[(VIEWS.indexOf(s.view) + dir + VIEWS.length) % VIEWS.length])

// ------------------------------------------------------------ marking

export function toggleMark(s: MonitorsState): void {
  const pr = selectedPr(s)
  if (!pr) return
  const key = sameUrl(pr.pr.url)
  if (!s.prs.marked.delete(key)) s.prs.marked.add(key)
  move(s, 1)
}

// Unmarks them all when every one is marked.
export function markAll(s: MonitorsState): void {
  const keys = prKeys(s)
  const all = keys.length > 0 && keys.every(k => s.prs.marked.has(k))
  for (const k of keys) {
    if (all) s.prs.marked.delete(k)
    else s.prs.marked.add(k)
  }
}

// ------------------------------------------------------------ filter

export function openFilter(s: MonitorsState): void {
  const f = s.filters[s.view]
  f.open = true
  f.typing = true
}

export const clearFilter = (s: MonitorsState): void => {
  s.filters[s.view] = closedFilter()
}

function filterKey(s: MonitorsState, f: Filter, key: string): void {
  if (key === '\r') {
    f.typing = false
    if (!f.query.trim()) clearFilter(s)
    return
  }
  if (key === '\x1b') clearFilter(s)
  else if (key === '\x1b[A' || key === '\x1b[B') move(s, key === '\x1b[A' ? -1 : 1)
  else editField(f, 'query', key)
}

// Both fields are single-line.
function insertInto<K extends 'brief' | 'query'>(into: Record<K, string> & { at?: number }, field: K, text: string): void {
  pasteField(into, field, oneLine(text))
}

// The text an image pasted now goes in: the attach drawer's brief, or Logs'
// Watch for, the two fields whose words reach a monitor's agent.
function imageField(s: MonitorsState): 'brief' | 'task' | null {
  if (s.panel?.ap.editing) return null
  if (s.view === 'prs' && s.drawer?.focus === 'brief') return 'brief'
  if (s.view === 'logs' && s.logs.field === 'task' && !s.logs.confirm) return 'task'
  return null
}

export const takesImages = (s: MonitorsState): boolean => imageField(s) !== null

// The image goes in at the caret as its placeholder. False when the field in
// focus doesn't take one.
export function attachImage(s: MonitorsState, path: string): boolean {
  const field = imageField(s)
  const into = field === 'brief' ? s.drawer : field === 'task' ? s.logs : null
  if (!into) return false
  const n = nextNumber(into.images ?? [])
  into.images = [...(into.images ?? []), { n, path }]
  if (field === 'brief' && s.drawer) insertInto(s.drawer, 'brief', placeholder(n))
  else typeTask(s.logs, placeholder(n))
  return true
}

export function paste(s: MonitorsState, text: string): void {
  const f = s.filters[s.view]
  if (s.panel?.ap.editing) pasteApprovals(s.panel.ap, text)
  else if (s.view === 'pipes' && !f.typing) pastePipes(s.pipes, text)
  else if (s.view === 'logs') pasteLogs(s.logs, text)
  else if (s.view === 'prs' && s.drawer?.focus === 'brief') insertInto(s.drawer, 'brief', text)
  else if (f.typing) insertInto(f, 'query', text)
}

// ------------------------------------------------------------ the drawer

export function openDrawer(s: MonitorsState): void {
  if (!targets(s).length) return
  const o = s.options
  s.drawer = { watch: { ...o.watch }, until: o.until, model: o.model, effort: o.effort, brief: '', more: false, focus: 'list' }
}

const around = <T>(list: readonly T[], v: T, dir: -1 | 1): T => list[(Math.max(0, list.indexOf(v)) + dir + list.length) % list.length]

function changeChoice(s: MonitorsState, d: Drawer, dir: -1 | 1): void {
  if (d.focus === 'until') d.until = around<Until>(UNTILS, d.until, dir)
  if (d.focus === 'model') d.model = around(s.options.models, d.model, dir)
  if (d.focus === 'effort') d.effort = around(s.options.efforts, d.effort, dir)
}

function nextFocus(d: Drawer, dir: 1 | -1): void {
  const order: Focus[] = ['list', 'brief', ...(d.more ? CHOICES : [])]
  d.focus = around(order, d.focus, dir)
}

const toggleWatch = (d: Drawer, i: number): void => {
  const k = WATCH_KEYS[i]
  d.watch = { ...d.watch, [k]: !d.watch[k] } satisfies Watch
}

export const startAct = (s: MonitorsState, d: Drawer): Act => ({
  do: 'start',
  prs: targets(s),
  options: { watch: d.watch, until: d.until, model: d.model, effort: d.effort, brief: d.brief.trim() },
  images: keptImages(d.images ?? [], d.brief),
})

export function started(s: MonitorsState, urls: readonly string[]): void {
  s.drawer = null
  s.prs.marked.clear()
  s.run.want = urls.map(matchUrl)
  setView(s, 'running')
}

// `want` is a rows.ts matchTarget or matchName.
export function startedOne(s: MonitorsState, want: string): void {
  s.run.want = [want]
  setView(s, 'running')
}


function drawerKey(s: MonitorsState, d: Drawer, key: string): Act {
  if (key === CTRL_S) return startAct(s, d)
  if (key === '\t' || key === '\x1b[Z') {
    nextFocus(d, key === '\t' ? 1 : -1)
    return null
  }
  if (d.focus === 'brief') {
    if (key === '\r' || key === '\x1b') d.focus = 'list'
    else if (key === '\x1b[A' || key === '\x1b[B') move(s, key === '\x1b[A' ? -1 : 1)
    else editField(d, 'brief', key)
    return null
  }
  if (key === '\x1b') {
    if (d.focus === 'list') s.drawer = null
    else d.focus = 'list'
    return null
  }
  const choice = CHOICES.includes(d.focus)
  const keys: Record<string, () => void> = {
    j: () => move(s, 1),
    k: () => move(s, -1),
    '\x1b[B': () => move(s, 1),
    '\x1b[A': () => move(s, -1),
    ' ': () => toggleMark(s),
    '*': () => markAll(s),
    '1': () => toggleWatch(d, 0),
    '2': () => toggleWatch(d, 1),
    '3': () => toggleWatch(d, 2),
    '4': () => toggleWatch(d, 3),
    m: () => {
      d.more = !d.more
      d.focus = d.more ? 'until' : 'list'
    },
    '/': () => (d.focus = 'brief'),
    '\r': () => (d.focus = 'brief'),
    ...(choice && {
      h: () => changeChoice(s, d, -1),
      l: () => changeChoice(s, d, 1),
      '\x1b[D': () => changeChoice(s, d, -1),
      '\x1b[C': () => changeChoice(s, d, 1),
    }),
  }
  if (Object.hasOwn(keys, key)) keys[key]()
  return null
}

// ------------------------------------------------------------ the approvals panel

export const panelRow = (s: MonitorsState): RunRow | null => (s.panel ? (allRunning(s).find(r => r.key === s.panel?.key) ?? null) : null)

// Hidden until drawn, so an `a` read with the key that opened it approves
// nothing.
function showPanel(s: MonitorsState, r: RunRow, focus = ''): void {
  const ap = startApprovals([...r.waits], focus)
  ap.hidden = true
  s.panel = { key: r.key, target: r.target, ap }
}

function selectRun(s: MonitorsState, key: string): void {
  setView(s, 'running')
  s.filters.running = closedFilter()
  s.run.sel = key
}

export function openPanel(s: MonitorsState): void {
  const r = selectedRun(s)
  if (!r) return
  if (r.waits.length) showPanel(s, r)
  else s.note = { text: t('monitors.approvals.nothingWaits', { target: r.target }), tone: 'sub' }
}

// The tray's Review and Edit.
export function openOn(s: MonitorsState, id: string): void {
  const r = allRunning(s).find(x => x.waits.some(p => p.id === id))
  if (!r) {
    s.note = { text: t('monitors.approvals.gone'), tone: 'peach' }
    return
  }
  selectRun(s, r.key)
  showPanel(s, r, id)
}

// Alt+A.
export function openOldest(s: MonitorsState): void {
  const all = allRunning(s).flatMap(r => r.waits.map(p => ({ r, p })))
  const first = all.sort((a, b) => (a.p.at ?? 0) - (b.p.at ?? 0))[0]
  if (!first) {
    s.note = { text: t('monitors.approvals.noneWaiting'), tone: 'sub' }
    return
  }
  selectRun(s, first.r.key)
  showPanel(s, first.r, first.p.id)
}

// The last proposal shown was settled here.
export function panelEmptied(s: MonitorsState): void {
  const panel = s.panel
  if (!panel) return
  const said = panel.ap.note
  const target = panel.target
  s.panel = null
  s.note = said ? { text: t('monitors.approvals.settledLast', { said: said.text, target }), tone: said.tone } : { text: t('monitors.approvals.nothingLeft', { target }), tone: 'green' }
}

// j and k move between monitors, the panel following; every other key is
// the panel's. While a diff shows or a reply is edited, all of them are.
function panelKey(s: MonitorsState, panel: Panel, key: string): Act {
  const ap = panel.ap
  if (!ap.diff && !ap.editing && (key === 'j' || key === 'k')) {
    move(s, key === 'j' ? 1 : -1)
    const r = selectedRun(s)
    if (r && r.key !== panel.key) showPanel(s, r)
    return null
  }
  const e = approvalsKey(ap, key)
  if (e === 'close') s.panel = null
  return e && e !== 'close' ? { do: 'approval', e } : null
}

// ------------------------------------------------------------ the keys

// An ended monitor or a stand-in has nothing to stop.
function stop(s: MonitorsState): Act {
  const r = selectedRun(s)
  if (!r) return null
  if (r.m.state === 'ended' || r.standIn) {
    s.note = { text: t('monitors.notes.ended', { name: r.target }), tone: 'sub' }
    return null
  }
  if (!s.options.askStop) return { do: 'stop', key: r.key, remember: false }
  s.ask = { key: r.key, name: r.m.description, title: r.m.agent.title }
  return null
}

// x once more stops it; a stops it and stops asking from then on.
function answer(s: MonitorsState, ask: Ask, key: string): Act {
  s.ask = null
  if (key === STOP_KEY) return { do: 'stop', key: ask.key, remember: false }
  if (key === 'a') return { do: 'stop', key: ask.key, remember: true }
  return null
}

function browse(url: string | undefined, s: MonitorsState): Act {
  if (url) return { do: 'browse', url }
  s.note = { text: t('monitors.notes.noLink'), tone: 'sub' }
  return null
}

function goToMonitor(s: MonitorsState): void {
  const pr = selectedPr(s)
  if (!pr) return
  const row = allRunning(s).find(r => r.url && sameUrl(r.url) === sameUrl(pr.pr.url) && r.m.state !== 'ended' && !r.standIn)
  if (!row) {
    s.note = { text: t('monitors.notes.noMonitor', { ref: pr.ref }), tone: 'sub' }
    return
  }
  s.filters.running = closedFilter()
  s.run.sel = row.key
  setView(s, 'running')
}

function runningKey(s: MonitorsState, key: string): Act {
  const r = selectedRun(s)
  switch (key) {
    case '\r':
      if (r?.standIn === 'gone') {
        s.note = { text: t('approvals.notes.sessionGone'), tone: 'red' }
        return null
      }
      return r ? { do: 'open', key: r.key } : null
    case 'a':
      openPanel(s)
      return null
    case STOP_KEY:
      return stop(s)
    case 'o':
      return r ? browse(r.url, s) : null
  }
  return null
}

function prsKey(s: MonitorsState, key: string): Act {
  const keys: Record<string, () => Act> = {
    ' ': () => (toggleMark(s), null),
    '*': () => (markAll(s), null),
    '\r': () => (openDrawer(s), null),
    g: () => (goToMonitor(s), null),
    o: () => browse(selectedPr(s)?.pr.url, s),
    w: () => ((s.role = s.role === 'mine' ? 'reviewer' : 'mine'), null),
    r: () => ({ do: 'refresh' }),
  }
  return Object.hasOwn(keys, key) ? keys[key]() : null
}

const MOVES: Record<string, number> = { j: 1, k: -1, '\x1b[B': 1, '\x1b[A': -1, '\x1b[6~': 10, '\x1b[5~': -10 }

// The overlay's own key and Ctrl+C never get here (tui/overlay.ts).
export function onKey(s: MonitorsState, key: string): Act {
  s.note = null
  if (s.ask) return answer(s, s.ask, key)
  if (s.view === 'running' && s.panel) return panelKey(s, s.panel, key)
  const f = s.filters[s.view]
  const say = (text: string, tone: Note['tone']): void => {
    s.note = { text, tone }
  }
  if (s.view === 'prs' && s.drawer) return drawerKey(s, s.drawer, key)
  if (s.view === 'logs') return formKey(s, key, say)
  if (s.view === 'pipes' && s.pipes.watch.typing) return pipesKey(s.pipes, key, watchedSet(s), say, f.query)
  if (f.typing) {
    filterKey(s, f, key)
    return null
  }
  if (Object.hasOwn(MOVES, key)) {
    move(s, MOVES[key])
    return null
  }
  switch (key) {
    case 'q':
      return { do: 'quit' }
    case '\x1b':
      if (!f.open) return { do: 'quit' }
      clearFilter(s)
      return null
    case '\t':
    case '\x1b[Z':
      cycleView(s, key === '\t' ? 1 : -1)
      return null
    case '/':
      if (FILTERED.includes(s.view)) openFilter(s)
      return null
  }
  if (s.view === 'pipes') return pipesKey(s.pipes, key, watchedSet(s), say, f.query)
  return s.view === 'running' ? runningKey(s, key) : prsKey(s, key)
}

// The Logs form takes every key but tab, shift+tab and esc, which closes
// the popup (or, while it asks, says no).
function formKey(s: MonitorsState, key: string, say: (text: string, tone: Note['tone']) => void): Act {
  if (key === '\t' || key === '\x1b[Z') {
    s.logs.confirm = false
    cycleView(s, key === '\t' ? 1 : -1)
    return null
  }
  if (key === '\x1b') {
    if (!s.logs.confirm) return { do: 'quit' }
    s.logs.confirm = false
    return null
  }
  return logsKey(s.logs, key, say)
}
