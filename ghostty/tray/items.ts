import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, } from 'node:fs'
import { dirname, join } from 'node:path'

import { lanes, monitorsOf } from '../agents/board.ts'
import { brokeTags } from '../agents/classify.ts'
import type { Agent, Monitor } from '../agents/model.ts'
import { errCode, logger, warnOnce } from '../core/log.ts'
import { RUN } from '../core/paths.ts'
import { t } from '../core/text.ts'
import { load as settings } from '../settings/settings.ts'
import { ago } from '../tui/term.ts'
import { type Proposal, approvalRow } from './approvals.ts'
import { monitorLink } from './links.ts'
import { type ApprovalRow, type MonitorRow, type Row, type Section, agentOf, asker, place, row, where } from './rows.ts'
import { writeAtomic } from '../core/json.ts'

// The tray's memory of its rows, one list of ids each: seen (no longer new),
// dismissed (hidden while their session lives) and notified (a widget has
// already popped it up).
export const TRAY = join(RUN, 'tray.json')
export type TrayList = 'seen' | 'dismissed' | 'notified'
const NOTES = join(RUN, 'notes')

const log = logger('tray')

// Written by pr-babysit's notify.sh, one JSON file each in notes/. `tmux` is
// the writer's $TMUX, which says which tmux server its pane is on.
export type Note = { file: string; title: string; message: string; session: string; pane: string; tmux?: string; at: number }

// It's new until `seen` records it.
export type TrayItem = Row & Partial<Omit<ApprovalRow, keyof Row>> & { new: boolean; age: string; notified?: boolean }
export type TrayItems = {
  counts: Record<Section, number>
  // The ring: anything new but work. The flash: something new that needs you.
  unseen: boolean
  alert: boolean
  items: TrayItem[]
}

// An alert (m:) and the same event in Watch (mw:) are different rows: seeing
// or dismissing one in Watch mustn't silence it when it turns into an alert,
// and dismissing the alert mustn't hide the monitor from Watch.
const monitorRow = (section: Section, glyph: string, m: Monitor, a: Agent, title: string, meta: string, since: number): MonitorRow => ({
  ...row(section, glyph, `${section === 'watch' ? 'mw' : 'm'}:${m.key}:${m.event?.at ?? 0}`, a, title, meta, since, ['go']),
  link: monitorLink(m),
})

// Claude Code can ask the next question without its status leaving waiting,
// so the time alone would let a click meant for one prompt answer the next.
const promptKey = (a: Pick<Agent, 'via' | 'cmd'>): string => createHash('sha1').update(`${a.via}\n${a.cmd}`).digest('hex').slice(0, 8)

function needsRows(a: Agent, brokeSet: ReadonlySet<string>, repeats: (m: Monitor) => boolean): Row[] {
  const raised = a.need === 'monitor' ? a.monitors.filter(m => m.state === 'action') : []
  if (raised.length)
    return raised
      .filter(m => !repeats(m))
      .map(m => {
        const broke = brokeSet.has(m.event?.tag ?? '')
        const title = m.event?.line ?? m.description
        return monitorRow(broke ? 'broke' : 'you', broke ? '✗' : '▲', m, a, title, `${place(a)} · ${m.description}`, m.event?.at ?? a.since)
      })
  if (a.need === 'permission') return [row('you', '▲', `p:${a.id}:${promptKey(a)}:${a.since}`, a, a.cmd, asker(a), a.since, ['allow', 'deny', 'go'])]
  if (a.need === 'question') return [row('you', '?', `q:${a.id}:${a.since}`, a, a.cmd, asker(a), a.since, ['go'])]
  return [row('you', '▲', `i:${a.id}:${a.since}`, a, a.cmd, `${place(a)} · ${where(a)}`, a.since, ['go'])]
}

// A monitor's Watch row counts as seen when its alert was: going to the alert
// puts the monitor back in Watch, which is no news.
const wasSeen = (seen: ReadonlySet<string>, id: string): boolean => seen.has(id) || (id.startsWith('mw:') && seen.has(`m:${id.slice(3)}`))

// Keeps each alert seen before whose monitor is back in Watch: its session
// going busy and idle again raises the same event once more, which is no
// news. `shown` is the rows the inbox drew, so one that came in after it drew
// stays news.
export const seenIds = (listed: readonly string[], was: ReadonlySet<string>, shown?: ReadonlySet<string>): string[] => {
  const ids = shown ? listed.filter(id => shown.has(id) || wasSeen(was, id)) : listed
  return [...ids, ...ids.filter(id => id.startsWith('mw:') && was.has(`m:${id.slice(3)}`)).map(id => `m:${id.slice(3)}`)]
}

function noteRow(n: Note, agents: readonly Agent[]): Row {
  const a = agentOf(agents, n.session, n.pane, n.tmux)
  const meta = [n.title, a && place(a), a && where(a)].filter(Boolean).join(' · ')
  return row('you', '▲', `n:${n.file}`, a, n.message, meta, n.at, a ? ['go', 'dismiss'] : ['dismiss'])
}

export function trayItems(
  agents: readonly Agent[],
  seen: ReadonlySet<string> = new Set(),
  dismissed: ReadonlySet<string> = new Set(),
  notes: readonly Note[] = [],
  approvals: readonly Proposal[] = [],
  now = Date.now(),
): TrayItems {
  const l = lanes(agents)
  const brokeSet = brokeTags()
  const buttons = settings()['approvals.trayButtons']
  // A job a proposal is about shows once, as the proposal: the watcher's
  // own line about it (`id=<job>`) would only repeat it without buttons.
  const proposed = new Set(approvals.map(p => String(p.job?.id ?? '')).filter(Boolean))
  const repeats = (m: Monitor) => proposed.has(m.event?.line?.match(/\bid=(\S+)/)?.[1] ?? '')
  const watched = monitorsOf(agents).filter(m => m.state !== 'action' && m.state !== 'ended')
  const rows: (Row | MonitorRow | ApprovalRow)[] = [
    ...approvals.map(p => approvalRow(p, agents, buttons)),
    ...l.needs.flatMap(a => needsRows(a, brokeSet, repeats)),
    ...notes.map(n => noteRow(n, agents)),
    // By its working spell, so dismissing it lasts only until the next one.
    ...l.working.map(a => row('work', '✻', `w:${a.id}:${a.stateSince}`, a, a.title, `${place(a)} · ${a.cmd}`, a.stateSince, ['go'])),
    ...watched.map(m => {
      const stale = m.state === 'stale'
      const meta = `${place(m.agent)} · ${m.description}${stale ? ` · ${t('tray.where.goneQuiet')}` : ''}`
      return monitorRow('watch', stale ? '◌' : '◉', m, m.agent, m.event?.line ?? m.description, meta, m.event?.at ?? m.startedAt)
    }),
    ...l.done.map(a => row('done', '✓', `d:${a.id}:${a.since}`, a, a.title, `${place(a)} · ${a.cmd}`, a.since, ['go'])),
  ]
  const items = rows.filter(it => !dismissed.has(it.id)).map(it => ({ ...it, new: it.section !== 'work' && !wasSeen(seen, it.id), age: ago(it.since, now) }))
  const count = (s: Section) => items.filter(it => it.section === s).length
  return {
    counts: { you: count('you'), broke: count('broke'), work: count('work'), watch: count('watch'), done: count('done') },
    unseen: items.some(it => it.new),
    alert: items.some(it => it.new && (it.section === 'you' || it.section === 'broke')),
    items,
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// Notes older than tray.noteHours are deleted as they're read.
export function readNotes(now = Date.now()): Note[] {
  let files: string[] = []
  try {
    files = readdirSync(NOTES).filter(f => f.endsWith('.json'))
  } catch (err) {
    warnOnce(log, 'notes folder unreadable', err, { path: NOTES })
    return []
  }
  const notes: Note[] = []
  const most = settings()['tray.noteHours'] * 60 * 60 * 1000
  for (const file of files.sort()) {
    const path = join(NOTES, file)
    try {
      const n: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof n !== 'object' || n === null) throw new Error('not a note')
      const { title, message, session, pane, tmux, at }: Partial<Record<keyof Note, unknown>> = n
      const when = Number(at) || 0
      if (now - when > most) unlinkSync(path)
      else
        notes.push({
          file: file.replace(/\.json$/, ''),
          title: str(title),
          message: str(message),
          session: str(session),
          pane: str(pane),
          ...(typeof tmux === 'string' ? { tmux } : {}),
          at: when,
        })
    } catch (err) {
      warnOnce(log, 'note skipped', err, { path })
    }
  }
  return notes
}

export const dropNote = (item: Pick<Row, 'id'>): void => {
  try {
    if (item.id.startsWith('n:')) unlinkSync(join(NOTES, `${item.id.slice(2)}.json`))
  } catch (err) {
    warnOnce(log, 'note not removed', err, { id: item.id })
  }
}

function readLists(path: string): Partial<Record<TrayList, unknown>> {
  try {
    const lists: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof lists !== 'object' || lists === null || Array.isArray(lists)) throw new Error('not an object')
    return lists
  } catch (err) {
    warnOnce(log, 'tray lists unreadable', err, { path })
    return {}
  }
}

function idsIn(lists: Partial<Record<TrayList, unknown>>, list: TrayList): Set<string> {
  const ids = lists[list]
  return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [])
}

export const readSet = (list: TrayList, path = TRAY): Set<string> => idsIn(readLists(path), list)

const pause = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
// A lock held longer than this belongs to a `tray act` that died.
const STALE_LOCK_MS = 5000

// Every click in the inbox is its own `tray act`, and the widgets' snapshots
// and `tray seen` write the same file, so without the lock two writers would
// both read the old lists and the second lose the first one's change. The
// file is written whole through a rename, so a snapshot never reads half of
// it: an empty seen would ring and flash every row, an empty dismissed bring
// every dismissed one back.
export function updateSet(list: TrayList, change: (ids: Set<string>) => Iterable<string>, path = TRAY): void {
  mkdirSync(dirname(path), { recursive: true })
  const lock = `${path}.lock`
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock)
      break
    } catch (err) {
      if (errCode(err) !== 'EEXIST') throw err
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmdirSync(lock)
    } catch (err) {
      // The other one let go meanwhile; the next try takes it.
      if (errCode(err) !== 'ENOENT') log.warn('stale lock not removed', { path: lock, err })
    }
    if (tries > 250) throw new Error(`${lock} is held`)
    pause(20)
  }
  try {
    const lists = readLists(path)
    const next = { ...lists, [list]: [...change(idsIn(lists, list))] }
    writeAtomic(path, JSON.stringify(next))
  } finally {
    rmdirSync(lock)
  }
}

// The first snapshot to list a new row claims it in NOTIFIED, so of two
// widgets (one on each of two panels) only the first pops up a notification
// and plays the sound; the other only flashes. A claim that fails leaves the
// rows unmarked: a second notification is better than none.
export function notified(items: readonly TrayItem[], path = TRAY): TrayItem[] {
  const fresh = items.filter(it => it.new).map(it => it.id)
  const listed = new Set(items.map(it => it.id))
  let told = readSet('notified', path)
  const changes = fresh.some(id => !told.has(id)) || [...told].some(id => !listed.has(id))
  try {
    if (changes)
      updateSet(
        'notified',
        ids => {
          told = ids
          return [...new Set([...[...ids].filter(id => listed.has(id)), ...fresh])]
        },
        path,
      )
  } catch (err) {
    warnOnce(log, 'notified not recorded', err, { path })
    return [...items]
  }
  return items.map(it => (it.new ? { ...it, notified: told.has(it.id) } : it))
}
