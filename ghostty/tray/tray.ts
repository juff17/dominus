#!/usr/bin/env node
// The tray's view of agentd, as JSON for the panel widget.
//   tray.ts snapshot           print the items once; keeps agentd running
//   tray.ts seen [<id>…]       mark those items as seen, or every current item
//   tray.ts act <action> <id>  run a row's button; prints the result
//   tray.ts hub                show the hub; prints the result
//   tray.ts text               text.json's widget section, as JSON
//   tray.ts watch              print a snapshot on every change, for testing
// The widget runs `snapshot` every two seconds, a cold start each time, so
// what only an action needs (tmux, the popup, answering a prompt) loads
// only when one runs.

import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureDaemon, follow, markReviewed, readState } from '../agents/client.ts'
import type { Agent } from '../agents/model.ts'
import type { AgentdState } from '../agents/tick.ts'
import { errCode, logger } from '../core/log.ts'
import { AGENTD_BEAT, RUN } from '../core/paths.ts'
import { t, text } from '../core/text.ts'
import { type Settings, expandHome, row as settingRow, load as settings } from '../settings/settings.ts'
import { APPROVE_ACTIONS, readApprovals, runApproval } from './approvals.ts'
import { type TrayItem, type TrayItems, dropNote, notified, readNotes, readSet, seenIds, trayItems, updateSet } from './items.ts'
import type { Row } from './rows.ts'

// What other modules and the tests took from here before it was split.
export { hubOpen } from '../core/paths.ts'
export { APPROVALS, APPROVE, PREVIEW_MOST, approvalRow, readApprovals, runApproval } from './approvals.ts'
export { readNotes, trayItems } from './items.ts'
export { monitorLink, proposalLink } from './links.ts'
type Navigate = typeof import('./navigate.ts')
export const go = async (...args: Parameters<Navigate['go']>) => (await import('./navigate.ts')).go(...args)
export const showHub = async () => (await import('./navigate.ts')).showHub()

const log = logger('tray')

// agentd keeps running while a client file was touched in the last few
// seconds (agentd.ts).
export const TRAY_CLIENT = 'tray'

function keepAlive() {
  mkdirSync(join(RUN, 'clients'), { recursive: true })
  const me = join(RUN, 'clients', TRAY_CLIENT)
  writeFileSync(me, '')
  const now = new Date()
  utimesSync(me, now, now)
  ensureDaemon()
}

// Read by main.qml's setting().
export type WidgetSettings = {
  count: Settings['tray.count']
  ring: boolean
  desktop: boolean
  soundYou: boolean
  soundBroke: boolean
  sound: Settings['tray.sound']
  soundFile: string
  quiet: boolean
  flashMs: number
  foldDone: boolean
  messageMs: number
  pollMs: number
  inboxWidth: number
  inboxHeight: number
}

// Read by the widget's reply.js and main.qml. `stale` is why the rows may be
// out of date, which the widget says while it still shows them.
export type Snapshot = { at: number } & TrayItems & { stale?: string; settings: WidgetSettings }

export type ActResult = { ok: boolean; message: string; raise?: boolean; layout?: string }

// The widget has no settings of its own; it takes the tray's from here.
export function widgetSettings(): WidgetSettings {
  const s = settings()
  return {
    count: s['tray.count'],
    ring: s['tray.ring'],
    desktop: s['tray.desktop'],
    soundYou: s['tray.soundYou'],
    soundBroke: s['tray.soundBroke'],
    // A custom sound with no file set plays the default one.
    ...(s['tray.sound'] === 'custom'
      ? { sound: settingRow('tray.sound').default, soundFile: s['tray.soundFile'] && expandHome(s['tray.soundFile']) }
      : { sound: s['tray.sound'], soundFile: '' }),
    quiet: s['tray.quiet'],
    flashMs: s['tray.flash'] * 1000,
    foldDone: s['tray.foldDone'],
    messageMs: s['tray.messageSecs'] * 1000,
    pollMs: s['tray.pollSecs'] * 1000,
    inboxWidth: s['tray.inboxWidth'],
    inboxHeight: s['tray.inboxHeight'],
  }
}

// How old agentd's heartbeat can be before the rows count as stale: a few
// ticks, so one slow tick (a tmux call that hung a while) doesn't.
const BEAT_STALE_MS = 10_000

// Why agentd isn't keeping the rows current, or ''. It reads the heartbeat
// because state.json is written only when something changed.
export function staleness(now = Date.now(), path = join(RUN, AGENTD_BEAT)): string {
  let beat: string
  try {
    beat = readFileSync(path, 'utf8').trim()
  } catch (err) {
    if (errCode(err) !== 'ENOENT') log.warn('heartbeat unreadable', { path, err })
    return t('tray.stale.notRunning')
  }
  // Read while agentd rewrote it: the next snapshot reads it whole.
  if (!beat) return ''
  const behind = now - Number(beat)
  return behind > BEAT_STALE_MS ? t('tray.stale.behind', { secs: Math.round(behind / 1000) }) : ''
}

function snapshot(state: AgentdState | null): Snapshot {
  const { items, ...rest } = trayItems(state?.agents ?? [], readSet('seen'), readSet('dismissed'), readNotes(), readApprovals())
  const stale = staleness()
  return { at: state?.at ?? 0, ...rest, items: notified(items), ...(stale ? { stale } : {}), settings: widgetSettings() }
}

// ------------------------------------------------------------ actions

const fail = (message: string): ActResult => ({ ok: false, message })
const unknownAction = (action: string): ActResult => fail(t('tray.act.unknownAction', { action }))
const dismissedOk = (): ActResult => ({ ok: true, message: t('tray.act.dismissed') })
const offers = (it: Row, action: string): boolean => it.actions.some(x => x === action)
const isNote = (it: Row): boolean => it.id.startsWith('n:')

async function actOnApproval(action: string, it: Row, approval: string): Promise<ActResult> {
  const p = readApprovals().find(x => x.id === approval)
  if (!p) return fail(t('tray.act.approvalGone'))
  if (action === 'edit' || action === 'review') return (await import('./navigate.ts')).openPopup(p.id)
  // x on a waiting proposal turns it down, so its session hears of it.
  if (action === 'skip' || (action === 'dismiss' && p.status === 'pending')) return runApproval(p, ['reject', p.id])
  if (action === 'dismiss') return runApproval(p, ['dismiss', p.id])
  if (!APPROVE_ACTIONS.has(action)) return unknownAction(action)
  // Only the row's own approve button approves it: the row leaves one out
  // when the tray can't show the proposal whole, and that must hold however
  // the action was asked for.
  if (!offers(it, action)) return fail(t('tray.act.noButton', { action }))
  return runApproval(p, ['approve', p.id])
}

async function answer(it: Row, a: Agent, allow: boolean): Promise<ActResult> {
  if (!offers(it, allow ? 'allow' : 'deny')) return fail(t('tray.act.notPermission'))
  return (await import('./permission.ts')).answer(a, allow)
}

// A monitor's alert row; its Watch row is mw:.
const isAlert = (it: Row): boolean => it.id.startsWith('m:')

// The review mark is one per session, and agentd reads it for the Done row
// and for every one of the session's monitor alerts, so only the last thing
// to see there writes it: a Done row, or the session's only alert still
// listed. Any other row is only hidden.
const reviews = (it: TrayItem, items: readonly TrayItem[]): boolean =>
  it.section === 'done' || (isAlert(it) && !items.some(x => x.id !== it.id && x.agent === it.agent && isAlert(x)))

type Acting = { it: TrayItem; a: Agent; agents: readonly Agent[]; items: readonly TrayItem[] }
const ACTS: Record<string, (x: Acting) => Promise<ActResult> | ActResult> = {
  dismiss: ({ it, a, agents, items }) => {
    // Every id here is an agent's row, <kind>:<session id>:…, kept while its
    // session lives: a row only hidden for now (a monitor behind a prompt)
    // must stay dismissed when it's back, and the file still stays small.
    const sessions = new Set(agents.map(x => x.id))
    updateSet('dismissed', ids => [...[...ids].filter(x => sessions.has(x.split(':')[1] ?? '')), it.id])
    if (reviews(it, items)) markReviewed(a.id)
    return dismissedOk()
  },
  allow: ({ it, a }) => answer(it, a, true),
  deny: ({ it, a }) => answer(it, a, false),
  go: async ({ it, a }) => {
    // Reviewed only once you're there: a Go that went nowhere leaves it as it was.
    const r = await go(a)
    if (r.ok && isNote(it)) dropNote(it)
    if (r.ok && it.section !== 'work') markReviewed(a.id)
    return r
  },
}

export async function act(action: string, id: string, agents: readonly Agent[] = readState()?.agents ?? []): Promise<ActResult> {
  const started = performance.now()
  try {
    const r = await actOn(action, id, agents)
    log.info('action ran', { action, id, ok: r.ok, message: r.message, ms: Math.round(performance.now() - started) })
    return r
  } catch (err) {
    log.error('action failed', { action, id, ms: Math.round(performance.now() - started), err })
    throw err
  }
}

async function actOn(action: string, id: string, agents: readonly Agent[]): Promise<ActResult> {
  const dismissed = readSet('dismissed')
  const items = trayItems(agents, new Set(), dismissed, readNotes(), readApprovals()).items
  const it = items.find(i => i.id === id)
  if (!it) return fail(dismissed.has(id) ? t('tray.act.itemGone') : gone(id, items, agents))
  if (it.approval && action !== 'go') return actOnApproval(action, it, it.approval)
  if (isNote(it) && action === 'dismiss') {
    dropNote(it)
    return dismissedOk()
  }
  const a = agents.find(x => x.id === it.agent)
  if (!a) return action === 'dismiss' ? dismissedOk() : fail(t('tray.act.sessionGone'))
  return Object.hasOwn(ACTS, action) ? ACTS[action]({ it, a, agents, items }) : unknownAction(action)
}

// Most ids end in the time their row's state began, so a click that lands
// after the agent moved on misses its row: say that, rather than that it's
// gone.
function gone(id: string, items: readonly TrayItem[], agents: readonly Agent[]): string {
  const stem = id.replace(/:\d+$/, '')
  if (stem === id) return t('tray.act.itemGone')
  if (items.some(i => i.id.replace(/:\d+$/, '') === stem)) return t('tray.act.changed')
  const a = agents.find(x => x.id === stem.split(':')[1])
  return a ? t('tray.act.movedOn', { title: a.title }) : t('tray.act.itemGone')
}

// ------------------------------------------------------------ the command

const print = (value: unknown, indent?: number) => process.stdout.write(`${JSON.stringify(value, null, indent)}\n`)

const COMMANDS: Record<string, () => unknown> = {
  snapshot: () =>
    log.span(
      'snapshot',
      {},
      () => {
        keepAlive()
        print(snapshot(readState()))
      },
      { level: 'debug' },
    ),
  seen: () => {
    const listed = trayItems(readState()?.agents ?? [], new Set(), readSet('dismissed'), readNotes(), readApprovals()).items.map(it => it.id)
    // The widget names the rows it drew; the CLI names none, for all of them.
    const shown = process.argv.slice(3)
    // Worked out under the lock, so another widget's seen written meanwhile isn't lost.
    let count = 0
    updateSet('seen', before => {
      const ids = seenIds(listed, before, shown.length ? new Set(shown) : undefined)
      count = ids.length
      return ids
    })
    log.info('items seen', { count, shown: shown.length || undefined })
  },
  act: () => act(process.argv[3] ?? '', process.argv[4] ?? '').then(r => print(r)),
  hub: () =>
    showHub().then(r => {
      log.info('hub shown', { ok: r.ok, message: r.message })
      print(r)
    }),
  text: () => print(text('widget')),
  watch: () => follow(state => print(snapshot(state), 2)),
}

if (import.meta.main) {
  const cmd = process.argv[2] ?? ''
  if (Object.hasOwn(COMMANDS, cmd)) COMMANDS[cmd]()
  else {
    process.stderr.write('tray.ts snapshot | seen | act <allow|deny|go|dismiss> <id> | hub | text | watch\n')
    process.exit(1)
  }
}
