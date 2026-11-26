#!/usr/bin/env node
// The Alt+M overlay (bin/ghostty-monitors): Running with the approvals
// panel, PRs & MRs, Pipelines and Logs.
//   monitors-view.ts <layout session>                      open on Running
//   monitors-view.ts <layout session> --approval <id>      the panel on that proposal (the tray's Review and Edit)
//   monitors-view.ts <layout session> --approvals          the panel on the oldest one waiting (Alt+A)
//
// This file wires the keys, the terminal and the timers; state.ts holds the
// state and what each key does, draw.ts draws it, effects.ts does what
// touches the world.


import { type Pasted, attachFiles, imageFiles, imagesDir, pasteImage } from '../../core/images.ts'
import { logger } from '../../core/log.ts'
import { MODEL_IDS } from '../../settings/models.ts'
import { load as settings } from '../../settings/settings.ts'
import { row } from '../../settings/catalog.ts'
import { type Overlay, closes, openOverlay } from '../../tui/overlay.ts'
import { tokens } from '../../tui/term.ts'
import { mayClose } from '../approvals/approvals.ts'
import { logCrashes } from '../logging.ts'
import { untilOf, watchOf } from './attach.ts'
import { frame } from './draw.ts'
import { monitorsEffects, world } from './effects.ts'
import { attachImage, onKey, openOldest, openOn, paste, start, takesImages } from './state.ts'
import { noteExpiry } from '../../tui/note.ts'
import { outside } from '../../tui/screen.ts'
import { CTRL_V } from '../../tui/input.ts'

const log = logger('monitors')
logCrashes(log)

const [layout = '', how = '', id = ''] = process.argv.slice(2)
// agentd writes its state every second.
const AGENTS_MS = 2000

const v = settings()
const efforts = row('newAgent.pr.effort').choices.map(c => c.value).filter(e => e !== 'default')
const chosen = (value: string, fallback: string): string => (value === 'default' ? fallback : value)
// 0 keeps a finished pipeline forever.
const HOUR = 3600_000
const KEEP: Record<string, number> = { '6h': 6 * HOUR, '24h': 24 * HOUR, '3d': 72 * HOUR, '7d': 168 * HOUR }
const keepMsOf = (value: string): number => KEEP[value] ?? 0
const s = start({
  fromPrs: v['monitors.pipelines.fromPrs'],
  keepMs: keepMsOf(v['monitors.pipelines.keepFinished']),
  logs: {
    envs: v['monitors.logs.envs'],
    levels: row('monitors.logs.level').choices.map(c => c.value),
    fors: row('monitors.logs.for').choices.map(c => c.value),
    models: MODEL_IDS,
    efforts,
    level: v['monitors.logs.level'],
    for: v['monitors.logs.for'],
    model: chosen(v['newAgent.logs.model'], 'haiku'),
    effort: chosen(v['newAgent.logs.effort'], 'low'),
    protect: v['monitors.logs.protected'],
  },
  role: v['monitors.startOn'],
  drafts: v['monitors.drafts'],
  options: {
    models: MODEL_IDS,
    efforts,
    model: chosen(v['newAgent.pr.model'], 'sonnet'),
    effort: chosen(v['newAgent.pr.effort'], 'medium'),
    watch: watchOf(v['monitors.watch']),
    until: untilOf(v['monitors.until']),
    askStop: v['hub.askStopMonitor'],
  },
})

// Typed, so TypeScript knows ov.quit() doesn't come back.
const ov: Overlay = openOverlay({ name: 'monitors', key: 'keys.monitors', box: () => ({ w: '90%', h: '85%' }) })

// Drawing decides the scroll positions and how much of a proposal has been
// seen, so they are written back to the state here.
function draw() {
  const f = frame(s, ov.size())
  if (s.view === 'running') s.run.scroll = f.scroll
  else if (s.view === 'prs') s.prs.scroll = f.scroll
  else if (s.view === 'pipes') s.pipes.scroll = f.scroll
  const ap = s.panel?.ap
  const drawn = f.approvals
  if (ap && drawn) {
    if (ap.diff && drawn.diffScroll !== null) ap.diff.scroll = drawn.diffScroll
    if (drawn.seen) Object.assign(ap, { scroll: drawn.scroll }, drawn.seen)
  }
  ov.paint(f.lines, f.title)
  expireNote()
}

// A footer note goes this long after it first shows, unless a key or a newer
// note has replaced it by then.
const NOTE_MS = 5000
const expireNote = noteExpiry(
  () => s.note,
  () => {
    s.note = null
  },
  draw,
  NOTE_MS,
)

const fx = monitorsEffects(s, { ...world(), draw, quit: () => ov.quit(), outside }, { layout })
fx.load()
if (how === '--approval') openOn(s, id)
else if (how === '--approvals') openOldest(s)
log.info('monitors opened', { hosts: s.hosts.length, agents: s.agents.length, proposals: s.proposals.length, approval: how ? id || 'oldest' : undefined })

// Alt+M closes it, and so does Alt+A, which may have opened it; neither
// while a reply is being edited in the panel, which they'd throw away.
const closing = (key: string): boolean => (ov.closes(key) || closes(key, 'keys.approvals')) && (!s.panel || mayClose(s.panel.ap))


// An image pasted into the brief or Watch for, or why it couldn't be.
function attach(r: Pasted): void {
  if ('error' in r) s.note = { text: r.error, tone: 'peach' }
  else attachImage(s, r.image)
}

ov.start(data => {
  // The tokenizer holds a paste or a character cut between two reads.
  const toks = tokens(data)
  // Keys wait while the panel settles a proposal, all but the closing keys,
  // which close it once that is done.
  if (s.panel?.ap.busy) {
    if (toks.some(tok => tok.key && closing(tok.key))) fx.closeWhenDone()
    return
  }
  for (const tok of toks) {
    if (tok.paste !== undefined) {
      // A paste that names image files only attaches them, as in New agent.
      const files = takesImages(s) ? imageFiles(tok.paste) : []
      if (files.length) for (const r of attachFiles(files, imagesDir('agent'))) attach(r)
      else paste(s, tok.paste)
    } else if (tok.key === CTRL_V && takesImages(s)) attach(pasteImage(imagesDir('agent')))
    else if (tok.mouse) {
      if (ov.mouse(tok.mouse) === 'close' && (!s.panel || mayClose(s.panel.ap))) ov.quit()
    } else if (closing(tok.key ?? '')) ov.quit()
    else {
      const act = onKey(s, tok.key ?? '')
      // What a key asks of the panel waits for it, so the keys after it
      // don't run before it has.
      if (act?.do === 'approval') {
        void fx.run(act)
        return
      }
      void fx.run(act)
    }
  }
  draw()
}, draw)

// Deferred so the list is on screen first. The fetch starts before the clone
// scan, which is slow and blocks.
setImmediate(() => {
  void fx.refresh()
  fx.findClones()
  draw()
  void fx.readLogsWorld()
})
setInterval(() => {
  fx.agents()
  fx.proposals()
  draw()
}, AGENTS_MS)
// Only while it's open: it never refreshes in the background.
setInterval(() => void fx.refresh(), Math.max(15, v['monitors.refreshSecs']) * 1000)
