// The Pipelines view's state and keys; state.ts hands it the keys while
// Pipelines is the view.

import { t } from '../../core/text.ts'
import { editField, insertAt, length } from '../../tui/line.ts'
import { type PipeItem, type PipeView, pipeItems } from './pipe-rows.ts'
import { type Gate, type Pipe, type PipeHost, gateKey, gateSig, parsePipeTarget, pipeKey } from './pipelines.ts'

// The + watch field.
export type WatchField = { text: string; at?: number; typing: boolean }

export type PipesState = {
  hosts: PipeHost[]
  refreshing: boolean
  sel: string | null
  scroll: number
  // Pipelines whose gates ↵ hid.
  closed: Set<string>
  // gateKey → gateSig when skipped.
  skipped: Record<string, string>
  dismissed: Set<string>
  undo: string | null
  // 0 keeps a finished pipeline until a newer run replaces it.
  keepMs: number
  fromPrs: boolean
  watch: WatchField
}

export type PipeAct =
  | { do: 'gate'; pipe: Pipe; gate: Gate }
  | { do: 'watchPipe'; target: string }
  | { do: 'fromPrs'; on: boolean }
  | { do: 'savePipes' }
  | { do: 'refreshPipes' }
  | { do: 'browse'; url: string }
  | null

export type Say = (text: string, tone: 'green' | 'red' | 'peach' | 'sub') => void

export const startPipes = (fromPrs = true, keepMs = 0): PipesState => ({
  hosts: [],
  refreshing: false,
  sel: null,
  scroll: 0,
  closed: new Set(),
  skipped: {},
  dismissed: new Set(),
  undo: null,
  keepMs,
  fromPrs,
  watch: { text: '', typing: false },
})

export const pipeView = (p: PipesState, now = Date.now(), query = ''): PipeView => ({
  fromPrs: p.fromPrs,
  closed: p.closed,
  skipped: p.skipped,
  dismissed: p.dismissed,
  keepMs: p.keepMs,
  now,
  query,
})

export const itemsOf = (p: PipesState, watched: ReadonlySet<string>, query = ''): PipeItem[] => pipeItems(p.hosts, pipeView(p, Date.now(), query), watched)

type Pick = Exclude<PipeItem, { kind: 'group' }>
const picks = (items: readonly PipeItem[]): Pick[] => items.filter((i): i is Pick => i.kind !== 'group')

export function selectedItem(p: PipesState, items: readonly PipeItem[]): Pick | null {
  const list = picks(items)
  return list.find(i => i.key === p.sel) ?? list[0] ?? null
}

export function movePipes(p: PipesState, items: readonly PipeItem[], n: number): void {
  const list = picks(items)
  if (!list.length) return
  const at = Math.max(0, list.findIndex(i => i.key === p.sel))
  p.sel = list[Math.max(0, Math.min(list.length - 1, at + n))].key
}

export const watchTarget = (pipe: Pipe): string => pipe.url || `${pipe.host}/${pipe.project}@${pipe.ref}`

// Hidden until the gate changes (gateSig).
function skip(p: PipesState, items: readonly PipeItem[], it: Extract<PipeItem, { kind: 'gate' }>, say: Say): PipeAct {
  const list = picks(items)
  const at = list.findIndex(i => i.key === it.key)
  p.skipped[gateKey(it.pipe, it.gate)] = gateSig(it.gate)
  p.sel = list[at + 1]?.key ?? it.pipeKey
  say(t('monitors.pipes.notes.skipped', { job: it.gate.name }), 'sub')
  return { do: 'savePipes' }
}

// Hidden until a newer run replaces it, as the key is per run.
function dismiss(p: PipesState, items: readonly PipeItem[], it: Pick, say: Say): PipeAct {
  const key = it.kind === 'gate' ? it.pipeKey : it.key
  const rows = picks(items).filter(i => i.kind === 'pipe')
  const at = rows.findIndex(i => i.key === key)
  p.dismissed.add(key)
  p.undo = key
  p.sel = (rows[at + 1] ?? rows[at - 1])?.key ?? null
  say(t('monitors.pipes.notes.dismissed', { project: it.pipe.project.split('/').pop() ?? it.pipe.project, ref: it.pipe.ref }), 'sub')
  return { do: 'savePipes' }
}

function undismiss(p: PipesState, say: Say): PipeAct {
  if (!p.undo || !p.dismissed.delete(p.undo)) {
    say(t('monitors.pipes.notes.nothingToUndo'), 'sub')
    return null
  }
  p.sel = p.undo
  p.undo = null
  say(t('monitors.pipes.notes.undismissed'), 'sub')
  return { do: 'savePipes' }
}

function togglePanel(p: PipesState, it: Pick): void {
  const key = it.kind === 'gate' ? it.pipeKey : it.key
  if (!it.pipe.gates.length) return
  if (p.closed.delete(key)) return
  p.closed.add(key)
  p.sel = key
}

function watchKey(p: PipesState, key: string, say: Say): PipeAct {
  const w = p.watch
  if (key === '\x1b') {
    w.typing = false
    return null
  }
  if (key !== '\r') {
    editField(w, 'text', key)
    return null
  }
  const target = w.text.trim()
  if (!parsePipeTarget(target)) {
    say(t('monitors.pipes.notes.notATarget'), 'peach')
    return null
  }
  p.watch = { text: '', typing: false }
  return { do: 'watchPipe', target }
}

export function pastePipes(p: PipesState, text: string): void {
  if (!p.watch.typing) return
  const r = insertAt(p.watch.text, p.watch.at, text.replace(/\s+/g, ' ').trim())
  p.watch.text = r.text
  if (r.at < length(r.text)) p.watch.at = r.at
  else delete p.watch.at
}

export function pipesKey(p: PipesState, key: string, watched: ReadonlySet<string>, say: Say, query = ''): PipeAct {
  if (p.watch.typing) return watchKey(p, key, say)
  const items = itemsOf(p, watched, query)
  const it = selectedItem(p, items)
  switch (key) {
    case 'y':
      if (it?.kind === 'gate') return { do: 'gate', pipe: it.pipe, gate: it.gate }
      say(t('monitors.pipes.notes.onPrompt'), 'sub')
      return null
    case 'n':
      if (it?.kind === 'gate') return skip(p, items, it, say)
      say(t('monitors.pipes.notes.onPrompt'), 'sub')
      return null
    case 'x':
      return it ? dismiss(p, items, it, say) : null
    case 'u':
      return undismiss(p, say)
    case 'm':
      return it ? { do: 'watchPipe', target: watchTarget(it.pipe) } : null
    case 'o': {
      const url = it?.kind === 'gate' ? it.gate.url || it.pipe.url : it?.pipe.url
      if (url) return { do: 'browse', url }
      say(t('monitors.notes.noLink'), 'sub')
      return null
    }
    case '\r':
      if (it) togglePanel(p, it)
      return null
    case '+':
      p.watch.typing = true
      return null
    case 'P':
      p.fromPrs = !p.fromPrs
      return { do: 'fromPrs', on: p.fromPrs }
    case 'r':
      return { do: 'refreshPipes' }
  }
  return null
}

// Drops skips whose gate is gone or changed, so the cache doesn't grow.
export function keptSkips(hosts: readonly PipeHost[], skipped: Readonly<Record<string, string>>): Record<string, string> {
  const live = new Map(hosts.flatMap(h => h.pipes.flatMap(pipe => pipe.gates.map(g => [gateKey(pipe, g), gateSig(g)] as const))))
  return Object.fromEntries(Object.entries(skipped).filter(([k, sig]) => live.get(k) === sig))
}

// Kept only while a host still lists them, so the set doesn't grow with
// every run.
export function keptDismissed(hosts: readonly PipeHost[], dismissed: ReadonlySet<string>): Set<string> {
  const live = new Set(hosts.flatMap(h => h.pipes.map(pipeKey)))
  return new Set([...dismissed].filter(k => live.has(k)))
}

export { pipeKey }
