#!/usr/bin/env node
// The rail: a few columns down the left of a Ghostty window, as the S3.1
// design draws it, switching the window between the workspace and the agent
// hub, with the agent counts and the New agent, help and settings buttons.
//   rail.ts <work|hub>     which of the two windows this rail sits in
// HUB_WIN is the Ghostty window number. The outer tmux passes clicks on the
// rail through without moving focus to it (layout.conf), so it never takes
// keys meant for the workspace.

import { join } from 'node:path'
import { follow } from '../../agents/client.ts'
import { type Counts, counts } from '../../agents/model.ts'
import { logCrashes } from '../../core/crash.ts'
import { NEW_AGENT_KEY } from '../keys.ts'
import { tmuxOf } from '../tmux.ts'
import { type Pressable, type RailActs, type RailView, frame, pressed } from './railview.ts'
import { load as settings } from '../../settings/settings.ts'
import { enter, leave, paint, tokens } from '../../tui/term.ts'
import { logger } from '../../core/log.ts'
import { conf } from '../../core/paths.ts'
import { run } from '../../core/proc.ts'

const log = logger('rail')
logCrashes(log)

const VIEW: RailView = process.argv[2] === 'hub' ? 'hub' : 'work'
const WIN = Number(process.env.HUB_WIN) || 0
const session = `layout-${WIN}`
let c: Pick<Counts, 'needs' | 'working' | 'done' | 'idle'> = { needs: 0, working: 0, done: 0, idle: 0 }

// Failures are logged (hub/tmux.ts); the rail carries on as if they worked.
const { layout: tmux } = tmuxOf({ log })
const show = (view: RailView) => tmux('select-window', '-t', `${session}:${view}`)

// The hub's pane, to hand it the key that opens New agent (keys.ts).
async function newAgent() {
  await show('hub')
  const { out } = await tmux('list-panes', '-t', `${session}:hub`, '-F', '#{pane_id} #{@hub}')
  const pane = out.split('\n').find(l => l.endsWith(' 1'))?.split(' ')[0]
  if (pane) void tmux('send-keys', '-t', pane, '-l', NEW_AGENT_KEY)
  else log.warn('hub pane not found', { session })
}

// The keys overlay and the settings panel, on this window's client: a click
// doesn't say which client made it, but each outer session has one, its
// Ghostty window.
const BIN = conf('bin')
async function popup(cmd: string, ...args: string[]) {
  const { out } = await tmux('list-clients', '-t', session, '-F', '#{client_name}')
  const client = out.split('\n')[0]
  if (!client) return log.warn('no client for popup', { session, cmd })
  const argv = [join(BIN, cmd), client, ...args]
  const r = await run(argv)
  if (!r.ok) log.warn('popup failed', { cmd: argv, err: r.err })
}
const help = () => popup('ghostty-help', VIEW)

const openSettings = () => popup('ghostty-settings')

const cols = () => process.stdout.columns || 6
const rows = () => process.stdout.rows || 24
type Act = () => unknown
let buttons: Pressable<Act>[] = []

const pressedAs = (button: string, act: Act) => () => {
  log.info('button pressed', { button, view: VIEW })
  return act()
}
const acts: RailActs<Act> = {
  work: pressedAs('work', () => show('work')),
  hub: pressedAs('hub', () => show('hub')),
  newAgent: pressedAs('new', newAgent),
  help: pressedAs('help', help),
  settings: pressedAs('settings', openSettings),
}

function draw() {
  const f = frame(cols(), rows(), VIEW, c, acts)
  buttons = f.buttons
  paint(f.lines)
}

if (!process.stdin.isTTY) {
  console.error('rail.ts needs a terminal.')
  process.exit(1)
}
process.stdin.setRawMode(true)
process.stdin.on('data', data => {
  for (const t of tokens(data)) {
    if (t.mouse) void pressed(buttons, t.mouse)?.act()
  }
})
// tmux shares a resize out between the panes, the rail included, and the
// layout's window-resized hook only reaches the window being resized, so the
// rail puts its own width back. It checks on every update too, so a change in
// Settings shows within a second. On 'resize' rather than SIGWINCH, since a
// SIGWINCH handler can run before the new size is read.
const want = () => Number(process.env.GHOSTTY_RAIL_COLS) || settings()['layout.railCols']
function fit() {
  if (cols() !== want() && process.env.TMUX_PANE) void tmux('resize-pane', '-t', process.env.TMUX_PANE, '-x', String(want()))
}
process.stdout.on('resize', () => {
  fit()
  draw()
})
const bye = () => {
  leave()
  process.exit(0)
}
process.on('SIGTERM', bye)
process.on('SIGHUP', bye)
enter()
follow(s => {
  c = counts(s.agents)
  fit()
  draw()
})
draw()
