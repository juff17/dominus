// The Logs view's form state and keys; state.ts hands it the keys while
// Logs is the view.

import { t } from '../../core/text.ts'
import { type Image, keptImages } from '../../core/images.ts'
import { editField, insertAt, length } from '../../tui/line.ts'
import { type Blocked, LOCAL, REMOTES, type Source, matchesAny } from './sources.ts'

export type LogsField = 'env' | 'source' | 'task' | 'level' | 'for' | 'model' | 'effort'
export const LOGS_FIELDS: readonly LogsField[] = ['env', 'source', 'task', 'level', 'for', 'model', 'effort']
type Stepped = Extract<LogsField, 'level' | 'for' | 'model' | 'effort'>

// From Settings › Monitors › Logs.
export type LogsOptions = {
  envs: readonly string[]
  levels: readonly string[]
  fors: readonly string[]
  models: readonly string[]
  efforts: readonly string[]
  level: string
  for: string
  model: string
  effort: string
  protect: readonly string[]
}

// `blocked` is null until the sources have been checked; `confirm` is set
// while a protected env asks; `images` were pasted into Watch for (`task`).
export type LogsState = Record<Stepped, string> & {
  field: LogsField
  blocked: Blocked | null
  folder: string
  env: string
  source: Source
  task: string
  at?: number
  confirm: boolean
  options: LogsOptions
  images?: Image[]
}

// `images` were pasted into Watch for, which names each [Image #n].
export type LogsSpec = { env: string; source: Source; folder: string; level: string; for: string; watchFor: string; model: string; effort: string; protected: boolean; images?: Image[] }
export type LogsAct = { do: 'logs'; spec: LogsSpec } | null

export const DEFAULT_LOGS: LogsOptions = {
  envs: [LOCAL, 'qa', 'stage', 'eu', 'ca', 'us'],
  levels: ['warn', 'error', 'info'],
  fors: ['30m', '1h', '2h', '4h', '8h', '24h'],
  models: ['haiku'],
  efforts: ['low'],
  level: 'warn',
  for: '2h',
  model: 'haiku',
  effort: 'low',
  protect: [],
}

export const startLogs = (options: Partial<LogsOptions> = {}): LogsState => {
  const o = { ...DEFAULT_LOGS, ...options }
  return { field: 'env', blocked: null, folder: '', env: LOCAL, source: 'docker', task: '', confirm: false, level: o.level, for: o.for, model: o.model, effort: o.effort, options: o }
}

// local first, whatever Settings' list says.
export const envsOf = (l: LogsState): string[] => [LOCAL, ...l.options.envs.filter(e => e !== LOCAL)]

// local watches Docker; the rest what isn't blocked, none until checked.
export const sourcesFor = (l: LogsState, env: string): Source[] => (env === LOCAL ? ['docker'] : REMOTES.filter(r => l.blocked && !l.blocked[r]))
export const envOpen = (l: LogsState, env: string): boolean => sourcesFor(l, env).length > 0
export const isProtected = (l: LogsState, env: string): boolean => matchesAny(env, l.options.protect)

// Keeps the source when the env has it, else its first.
function pickEnv(l: LogsState, env: string): void {
  l.env = env
  const can = sourcesFor(l, env)
  if (!can.includes(l.source)) l.source = can[0] ?? 'docker'
}

export function setWorld(l: LogsState, blocked: Blocked, folder: string): void {
  l.blocked = blocked
  l.folder = folder
  pickEnv(l, envsOf(l).includes(l.env) && envOpen(l, l.env) ? l.env : LOCAL)
}

// What the log-watcher is told after its first line (/dominus:log-watcher watch).
export const logsLines = (s: LogsSpec): string[] => [
  `Environment: ${s.env}`,
  `Source: ${s.source}`,
  `Folder: ${s.folder}`,
  `Level: ${s.level}`,
  `For: ${s.for}`,
]
// What to watch for goes last in the prompt, as typed, under this label.
export const WATCH_FOR_LABEL = 'Watch for:'

// Running finds the new session by this name.
export const logsName = (env: string): string => `logs ${env}`

const around = <T>(list: readonly T[], v: T, dir: -1 | 1): T => list[(Math.max(0, list.indexOf(v)) + dir + list.length) % list.length]

// env and source skip what's grayed out.
function change(l: LogsState, dir: -1 | 1): void {
  if (l.field === 'env') {
    const envs = envsOf(l)
    const at = envs.indexOf(l.env)
    for (let i = at + dir; i >= 0 && i < envs.length; i += dir) {
      if (envOpen(l, envs[i])) {
        pickEnv(l, envs[i])
        return
      }
    }
    return
  }
  if (l.field === 'source') {
    const can = sourcesFor(l, l.env)
    const next = can[can.indexOf(l.source) + dir]
    if (next) l.source = next
    return
  }
  const lists: Record<Stepped, readonly string[]> = { level: l.options.levels, for: l.options.fors, model: l.options.models, effort: l.options.efforts }
  if (l.field !== 'task') l[l.field] = around(lists[l.field], l[l.field], dir)
}

const moveField = (l: LogsState, dir: -1 | 1): void => {
  const i = LOGS_FIELDS.indexOf(l.field)
  l.field = LOGS_FIELDS[Math.max(0, Math.min(LOGS_FIELDS.length - 1, i + dir))]
}

export type Note = (text: string, tone: 'green' | 'red' | 'peach' | 'sub') => void

function submit(l: LogsState, say: Note, sure = false): LogsAct {
  if (!envOpen(l, l.env)) {
    l.field = 'env'
    say(t('monitors.logs.notes.noEnv'), 'peach')
    return null
  }
  if (!l.task.trim()) {
    l.field = 'task'
    say(t('monitors.logs.notes.noTask'), 'peach')
    return null
  }
  const prot = isProtected(l, l.env)
  if (prot && !sure) {
    l.confirm = true
    return null
  }
  l.confirm = false
  return {
    do: 'logs',
    spec: { env: l.env, source: l.source, folder: l.folder, level: l.level, for: l.for, watchFor: l.task, model: l.model, effort: l.effort, protected: prot, ...withImages(keptImages(l.images ?? [], l.task)) },
  }
}

const withImages = (images: Image[]): { images?: Image[] } => (images.length ? { images } : {})

const CTRL_S = '\x13'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'

// tab, shift+tab and esc are state.ts's.
export function logsKey(l: LogsState, key: string, say: Note): LogsAct {
  if (l.confirm) {
    l.confirm = false
    return key === 'y' ? submit(l, say, true) : null
  }
  if (key === CTRL_S) return submit(l, say)
  if (key === UP || key === DOWN) {
    moveField(l, key === UP ? -1 : 1)
    return null
  }
  if (l.field === 'task') {
    if (key === '\r') typeTask(l, '\n')
    else editField(l, 'task', key)
    return null
  }
  const moves: Record<string, () => void> = {
    j: () => moveField(l, 1),
    k: () => moveField(l, -1),
    '\r': () => moveField(l, 1),
    h: () => change(l, -1),
    l: () => change(l, 1),
    [LEFT]: () => change(l, -1),
    [RIGHT]: () => change(l, 1),
    ' ': () => change(l, 1),
  }
  if (Object.hasOwn(moves, key)) moves[key]()
  return null
}

// Unlike the other fields, Watch for keeps line breaks.
export function typeTask(l: LogsState, text: string): void {
  const r = insertAt(l.task, l.at, text.replace(/\r\n?/g, '\n').replace(/\t/g, ' '))
  l.task = r.text
  if (r.at < length(r.text)) l.at = r.at
  else delete l.at
}

export function pasteLogs(l: LogsState, text: string): void {
  if (l.field === 'task') typeTask(l, text)
}
