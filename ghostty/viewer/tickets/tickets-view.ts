#!/usr/bin/env node
// The Alt+J overlay (bin/ghostty-tickets): your team's sprint board in two
// lanes, Unassigned and Mine, and a key to hand a ticket to an agent.
//   tickets-view.ts <client> <layout session>
//
// This file wires the keys, the terminal and the timers; state.ts holds the
// state and what each key does, draw.ts draws it, effects.ts does what
// touches the world.

import { spawnSync } from 'node:child_process'

import { logger } from '../../core/log.ts'
import { tilde } from '../../core/paths.ts'
import { load as settings } from '../../settings/settings.ts'
import { type Overlay, openOverlay } from '../../tui/overlay.ts'
import { enter, leave, tokens } from '../../tui/term.ts'
import { logCrashes } from '../logging.ts'
import { frame } from './draw.ts'
import { prefsOf, setupOf, ticketsEffects, world } from './effects.ts'
import { type Note, mayClose, onKey, onPaste, start } from './state.ts'

const log = logger('tickets')
logCrashes(log)

const [client = '', layout = ''] = process.argv.slice(2)
// agentd writes its state every second.
const AGENTS_MS = 2000
const NOTE_MS = 4000

const w = world()
const s = start(setupOf(w), prefsOf(settings()))

const ov: Overlay = openOverlay({ name: 'tickets', key: 'keys.jira', box: () => ({ w: '90%', h: '85%' }) })

function draw() {
  const f = frame(s, ov.size(), Date.now(), tilde(w.envFile))
  s.firstCol = f.firstCol
  ov.paint(f.lines, f.title)
  expireNote()
}

let shownNote: Note | null = null
let noteTimer: NodeJS.Timeout | undefined
function expireNote() {
  if (s.note === shownNote) return
  shownNote = s.note
  clearTimeout(noteTimer)
  const note = shownNote
  if (!note) return
  noteTimer = setTimeout(() => {
    if (s.note !== note) return
    s.note = null
    draw()
  }, NOTE_MS)
}

// $EDITOR on .env, on the whole terminal.
function outside(cmd: string, args: string[]) {
  leave()
  process.stdin.setRawMode(false)
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  process.stdin.setRawMode(true)
  enter()
  return r
}

const fx = ticketsEffects(s, { ...w, draw, quit: () => ov.quit(), outside }, { client, layout })
fx.load()
log.info('tickets opened', { screen: s.screen, cached: !!s.board })

ov.start(data => {
  for (const tok of tokens(data)) {
    if (tok.paste !== undefined) onPaste(s, tok.paste)
    else if (tok.mouse) {
      if (ov.mouse(tok.mouse) === 'close' && mayClose(s)) ov.quit()
    } else if (ov.closes(tok.key ?? '') && mayClose(s)) ov.quit()
    else void fx.run(onKey(s, tok.key ?? ''))
  }
  draw()
}, draw)

// Deferred so the cached board is on screen first.
setImmediate(() => {
  if (s.screen === 'board') void fx.refresh()
  else void fx.check().then(() => (s.screen === 'board' ? fx.refresh() : undefined))
})
setInterval(() => {
  fx.agents()
  draw()
}, AGENTS_MS)
// Only while it's open, with a little jitter so many popups don't ask at once.
const every = Math.max(30, settings()['tickets.refreshSecs']) * 1000
setInterval(() => {
  if (s.screen === 'board') void fx.refresh()
}, every + Math.round((Math.random() - 0.5) * every * 0.2))
