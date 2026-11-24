// node --test ghostty/hub/view.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LANES } from './board.ts'
import { hitAt } from './keys.ts'
import { type ClickActs, type HubFrame, type HubPrefs, type HubUi, boardFrame, footer, listFrame } from './view.ts'
import type { Agent, Monitor } from '../agents/model.ts'
import type { Hint } from '../tui/chrome.ts'
import { P, fg, width } from '../tui/term.ts'

const NOW = 1_800_000_000_000
const MIN = 60_000
const text = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '')
// No-break spaces hold a key to its label; as plain spaces, for matching.
const plain = (line: string) => text(line).replaceAll('\u00a0', ' ')
const screen = (f: HubFrame) => f.lines.map(plain).join('\n')

// A partial agent, with what the frames read of one.
const agent = (id: string, extra: object = {}) =>
  ({
  id,
  title: id,
  repo: 'dotfiles',
  cmd: 'Thinking…',
  state: 'working',
  since: NOW - 5 * MIN,
  stateSince: NOW - 5 * MIN,
  monitors: [],
  branch: 'main',
  worktree: '',
  kind: 'tab',
  pane: { pane: '%10', session: 'ghostty-1', win: 1, window: '@10', tab: 1 },
  ...extra,
  }) as unknown as Agent
const monitor = (key: string, extra: object = {}) =>
  ({ key, task: key, description: `watch ${key}`, state: 'watching', kind: 'logger', startedAt: NOW - 9 * MIN, ...extra }) as Monitor

const PREFS: HubPrefs = { shown: LANES, doneCards: 2, monitorRows: 5, broke: new Set(['failed']), attention: new Set(['manual']) }

function ui(extra: Partial<HubUi> = {}): HubUi {
  return {
    agents: [],
    filter: '',
    filtering: false,
    filterAt: undefined,
    focus: 0,
    selected: { needs: null, working: null, done: null, idle: null, monitors: null },
    scroll: { needs: 0, working: 0, done: 0, idle: 0, list: 0 },
    listSel: null,
    peek: null,
    confirm: null,
    note: null,
    win: 1,
    now: NOW,
    ...extra,
  }
}

function recorder() {
  const calls: unknown[][] = []
  const acts: ClickActs = {
    newAgent: () => calls.push(['newAgent']),
    pick: (lane, id) => {
      calls.push(['pick', lane, id])
    },
    pickMonitor: key => {
      calls.push(['pickMonitor', key])
    },
    closePeek: () => calls.push(['closePeek']),
    openItem: it => calls.push(['openItem', it.id]),
  }
  return { calls, acts }
}

const WORLD = [
  agent('perm', { state: 'needs', need: 'permission', cmd: 'Allow Bash(npm test)?', title: 'Fix the build' }),
  agent('busy', { state: 'working', cmd: 'Bash(make)', ctx: 84_000, title: 'Build it' }),
  agent('fin', { state: 'done', cmd: 'All green.', title: 'Run the suite' }),
  agent('nap', { state: 'idle', cmd: '', title: 'Old chat', pane: { pane: '%12', session: 'ghostty-3', win: 3, window: '@12', tab: 4 } }),
  agent('mon', { state: 'working', title: 'Babysit', monitors: [monitor('m1', { event: { at: NOW - MIN, tag: 'failed', line: '[failed] unit' } })] }),
]

test('the board fills the screen exactly, every line as wide as it', () => {
  for (const [w, h] of [[140, 40], [200, 50], [120, 30]]) {
    const f = boardFrame(ui({ agents: WORLD }), PREFS, { w, h }, recorder().acts)
    assert.equal(f.lines.length, h)
    for (const l of f.lines) assert.equal(width(text(l)), w)
  }
})

// Stand-ins for the board gear's placeholder rows.
const GEAR = { cols: 8, rows: ['<g1>', '<g2>', '<g3>', '<g4>'] }

test('with nothing running the board shows the gear, the name and a New agent button, in place of the lanes', () => {
  const r = recorder()
  const f = boardFrame(ui({ splash: GEAR }), PREFS, { w: 100, h: 30 }, r.acts)
  assert.equal(f.lines.length, 30)
  const at = f.lines.findIndex(l => l.includes('<g1>'))
  assert.ok(at > 1, 'the gear is drawn')
  assert.deepEqual(
    f.lines.slice(at, at + 4).map(l => l.includes(`\x1b[47G`) && l.match(/<g\d>/)?.[0]),
    ['<g1>', '<g2>', '<g3>', '<g4>'],
  )
  const words = f.lines.slice(at + 4, at + 9).map(l => plain(l).trim())
  assert.deepEqual(words, ['', 'D O M I N U S', '', 'All quiet. No agent is running.', ''])
  assert.match(plain(f.lines[at + 9]), /\+ New agent alt\+n .* or {3}q back to the workspace/)
  const s = screen(f)
  assert.ok(!s.includes('Needs you'), 'no lanes')
  assert.match(plain(f.lines[0]), /^ 0 tasks · 0 monitors/)
  assert.match(plain(f.lines.at(-1) ?? ''), /n new +q workspace/)
  // The New agent under the words, as well as the summary's.
  const button = f.hits.find(h => h.y1 === at + 10)
  assert.ok(button)
  assert.ok(plain(f.lines[at + 9]).slice(button.x1 - 1, button.x2).includes('+ New agent alt+n'))
  button.act()
  assert.deepEqual(r.calls, [['newAgent']])
})

test('without the gear, or too short for it, the board still says nothing is running', () => {
  for (const [splash, h] of [[null, 30], [GEAR, 12]] as const) {
    const f = boardFrame(ui({ splash }), PREFS, { w: 100, h }, recorder().acts)
    assert.equal(f.lines.length, h)
    assert.ok(!f.lines.some(l => l.includes('<g1>')))
    assert.ok(screen(f).includes('All quiet. No agent is running.'))
  }
})

test('a filter that hides every agent, or any agent at all, keeps the lanes', () => {
  for (const extra of [{ filter: 'zzz' }, { agents: [agent('a')] }]) {
    const s = screen(boardFrame(ui({ splash: GEAR, ...extra }), PREFS, { w: 140, h: 40 }, recorder().acts))
    assert.ok(!s.includes('All quiet'))
    assert.ok(s.includes('Needs you'))
  }
})

test('the summary counts the lanes and monitors, and its New agent button opens the dialog', () => {
  const r = recorder()
  const f = boardFrame(ui({ agents: WORLD }), PREFS, { w: 140, h: 40 }, r.acts)
  assert.match(text(f.lines[0]), /^ 5 tasks · 1 monitor {3}▲ 1 need you {2}✻ 2 working {2}✓ 1 done {2}○ 1 idle {2}◉ 1 watching/)
  assert.ok(text(f.lines[0]).includes('+ New agent alt+n'))
  const button = f.hits.find(h => h.y1 === 1)
  assert.equal(button?.x2, 140)
  button?.act()
  assert.deepEqual(r.calls, [['newAgent']])
})

test('cards: where the agent runs and how long, the keys that answer it, its context size', () => {
  const s = screen(boardFrame(ui({ agents: WORLD }), PREFS, { w: 200, h: 40 }, recorder().acts))
  assert.match(s, /╭─ dotfiles ⎇ main ─+ tab 1 · 5m ─╮/)
  assert.match(s, /a allow {2}d deny {2}↵ open/)
  assert.match(s, /ctx 84k/)
  // Another Ghostty window's tab says which window.
  assert.match(s, /w3 · tab 4 · 5m/)
})

test('a click on a card picks it, with its lane for the wheel', () => {
  const r = recorder()
  const f = boardFrame(ui({ agents: WORLD }), PREFS, { w: 140, h: 40 }, r.acts)
  const cards = f.hits.filter(h => h.wheel !== undefined && h.wheel < 4)
  assert.deepEqual(cards.map(h => h.wheel), [0, 1, 1, 2, 3])
  for (const h of cards) h.act()
  assert.deepEqual(r.calls, [['pick', 0, 'perm'], ['pick', 1, 'busy'], ['pick', 1, 'mon'], ['pick', 2, 'fin'], ['pick', 3, 'nap']])
  assert.equal(cards[0].y1, 5)
  assert.equal(cards[0].y2, 8)
})

test('focus leaves an empty lane, and the selection falls to the first card, without touching the state passed in', () => {
  const state = ui({ agents: WORLD.filter(a => a.state !== 'needs'), focus: 0, selected: { needs: 'gone', working: 'gone', done: null, idle: null, monitors: null } })
  const before = structuredClone({ selected: state.selected, scroll: state.scroll })
  const f = boardFrame(state, PREFS, { w: 140, h: 40 }, recorder().acts)
  assert.equal(f.focus, 1)
  assert.equal(f.selected.working, 'busy')
  // An empty lane keeps its id, so the card is selected again if it comes back.
  assert.equal(f.selected.needs, 'gone')
  assert.deepEqual({ selected: state.selected, scroll: state.scroll }, before)
})

test('a lane too short for its cards says how many it hides, and scrolls to the selected one', () => {
  const many = Array.from({ length: 12 }, (_, i) => agent(`n${i}`, { state: 'needs', need: 'question', since: NOW - (20 - i) * MIN }))
  const top = boardFrame(ui({ agents: many }), PREFS, { w: 140, h: 40 }, recorder().acts)
  assert.match(screen(top), /▾ \d+ more/)
  assert.equal(top.scroll.needs, 0)
  const down = boardFrame(ui({ agents: many, selected: { ...ui().selected, needs: 'n11' } }), PREFS, { w: 140, h: 40 }, recorder().acts)
  assert.ok(down.scroll.needs > 0)
  assert.match(screen(down), /▴ \d+ above/)
})

test('the monitors strip: a row per monitor that picks it, broke events in red', () => {
  const r = recorder()
  const f = boardFrame(ui({ agents: WORLD, focus: 4 }), PREFS, { w: 140, h: 40 }, r.acts)
  const row = f.lines.findIndex(l => text(l).includes('watch m1'))
  assert.ok(row > 0)
  assert.ok(f.lines[row].includes(`${fg(P.red)}[failed] unit`))
  const hit = f.hits.find(h => h.y1 === row + 1)
  hit?.act()
  assert.deepEqual(r.calls, [['pickMonitor', 'm1']])
  assert.equal(f.selected.monitors, 'm1')
  assert.match(plain(f.lines.slice(-2).join(' ')), /x stop monitor/)
  // The wheel over the strip, on a row or off one, scrolls the strip.
  assert.equal(hitAt(f.hits, 5, row + 1, true)?.wheel, 4)
  const head = f.lines.findIndex(l => text(l).includes('◉ Monitors'))
  assert.equal(hitAt(f.hits, 5, head + 1, true)?.wheel, 4)
  assert.equal(hitAt(f.hits, 5, head + 1)?.act(), undefined)
  assert.equal(r.calls.length, 1)
})

test('with no monitors, the wheel over the strip leaves focus where it is', () => {
  const f = boardFrame(ui({ agents: [agent('a')] }), PREFS, { w: 140, h: 40 }, recorder().acts)
  const head = f.lines.findIndex(l => text(l).includes('◉ Monitors'))
  assert.equal(hitAt(f.hits, 5, head + 1, true), undefined)
})

test('with no monitors the strip says how to start one', () => {
  const s = screen(boardFrame(ui({ agents: [agent('a')] }), PREFS, { w: 140, h: 40 }, recorder().acts))
  assert.match(s, /Nothing being monitored · n → Monitor a PR or logs/)
  assert.match(s, /Nothing needs you/)
})

test('a stopped background agent sits in Idle marked ■ stopped, and r/R shows only while one does', () => {
  const stopped = agent('gone', { state: 'idle', kind: 'bg', pane: null, stopped: true, jobId: 'stop1', title: 'Nightly fix', since: NOW - 60 * MIN })
  const s = screen(boardFrame(ui({ agents: [...WORLD, stopped] }), PREFS, { w: 200, h: 40 }, recorder().acts))
  assert.match(s, /■ dotfiles Nightly fix +stopped · 1h/)
  assert.match(s, /r\/R restart/)
  assert.doesNotMatch(screen(boardFrame(ui({ agents: WORLD }), PREFS, { w: 200, h: 40 }, recorder().acts)), /r\/R restart/)
  const list = screen(listFrame(ui({ agents: [...WORLD, stopped] }), PREFS, { w: 60, h: 40 }, recorder().acts))
  assert.match(list, / ■ Nightly fix/)
  assert.match(list, /r\/R restart/)
})

test('Idle turned off in Settings leaves three lanes', () => {
  const s = screen(boardFrame(ui({ agents: WORLD }), { ...PREFS, shown: LANES.slice(0, 3) }, { w: 140, h: 40 }, recorder().acts))
  assert.doesNotMatch(s, /○ Idle/)
  assert.match(s, /✓ Done/)
})

test('the filter shows in the summary, with its caret while typing', () => {
  const typing = boardFrame(ui({ agents: WORLD, filter: 'dot', filtering: true, filterAt: 1 }), PREFS, { w: 140, h: 40 }, recorder().acts)
  // The caret is a block on the character it's before.
  assert.match(text(typing.lines[0]), /\/dot {3}/)
  assert.ok(typing.lines[0].includes('\x1b[7mo'))
  const kept = boardFrame(ui({ agents: WORLD, filter: 'dot' }), PREFS, { w: 140, h: 40 }, recorder().acts)
  assert.match(text(kept.lines[0]), /\/dot {2}/)
})

test('the footer: a question first, then a live note, else the keys', () => {
  const keys: Hint[] = [['↵', 'open']]
  const ask = footer({ confirm: { text: 'Stop it?', skip: 'hub.askStopMonitor', key: 'x' }, note: null, now: NOW }, keys, 80).map(text)
  assert.deepEqual(ask, [" Stop it?  x yes  other keys no  a yes, don't ask again".padEnd(80)])
  const plain = footer({ confirm: { text: 'Close it?', key: '\x18' }, note: null, now: NOW }, keys, 80).map(text)
  assert.match(plain[0], /Close it\? {2}ctrl\+x.yes {2}other.keys.no/)
  assert.doesNotMatch(plain[0], /don't/)
  const note = { text: 'Allowed it', color: P.green, until: NOW + 1 }
  assert.equal(text(footer({ confirm: null, note, now: NOW }, keys, 40)[0]).trim(), 'Allowed it')
  assert.equal(text(footer({ confirm: null, note, now: NOW + 1 }, keys, 40)[0]).trim(), '↵ open')
  // A long question wraps rather than being cut.
  assert.equal(footer({ confirm: { text: 'word '.repeat(30), key: 'x' }, note: null, now: NOW }, keys, 40).length, 4)
})

test('the list beside an open session: groups, the open agent marked, its clicks', () => {
  const r = recorder()
  const peek = { pane: '%5', id: 'busy', window: '@10' }
  const f = listFrame(ui({ agents: WORLD, peek }), PREFS, { w: 60, h: 40 }, r.acts)
  assert.equal(f.lines.length, 40)
  for (const l of f.lines) assert.equal(width(text(l)), 60)
  const s = screen(f)
  assert.match(s, /◂ Board ctrl\+shift\+b/)
  assert.match(s, / ▶ Build it/)
  for (const name of ['▲ Needs you', '✻ Working', '✓ Done', '○ Idle', '◉ Monitors']) assert.ok(s.includes(name), name)
  // With nothing selected yet, the open session's agent is.
  assert.equal(f.listSel, 'busy')
  // The Board button, its rounded ends included.
  f.hits.find(h => h.x2 === 25)?.act()
  const items = f.hits.filter(h => h.y1 > 2)
  for (const h of items) h.act()
  assert.deepEqual(r.calls[0], ['closePeek'])
  // An agent's two rows both open it.
  assert.deepEqual(r.calls.slice(1, 3), [['openItem', 'perm'], ['openItem', 'perm']])
  assert.deepEqual(r.calls.at(-1), ['openItem', 'm:m1'])
})

test('the list without a session: back to the workspace, and ctrl+x stops a selected monitor', () => {
  const agentSel = listFrame(ui({ agents: WORLD }), PREFS, { w: 60, h: 40 }, recorder().acts)
  assert.match(text(agentSel.lines[0]), /^ agents/)
  assert.equal(agentSel.listSel, 'perm')
  assert.match(plain(agentSel.lines.at(-1) ?? ''), /esc workspace {2}ctrl\+x close/)
  const monSel = listFrame(ui({ agents: WORLD, listSel: 'm:m1' }), PREFS, { w: 60, h: 40 }, recorder().acts)
  assert.match(plain(monSel.lines.at(-1) ?? ''), /ctrl\+x stop monitor/)
})

test('the list shows the filter it is narrowed by, and the field while typing', () => {
  const peek = { pane: '%5', id: 'busy', window: '@10' }
  const kept = listFrame(ui({ agents: WORLD.filter(a => a.id === 'busy'), filter: 'build', peek }), PREFS, { w: 60, h: 40 }, recorder().acts)
  assert.match(text(kept.lines[0]), /\/build {2}.*\+ New/)
  const typing = listFrame(ui({ agents: WORLD, filtering: true }), PREFS, { w: 60, h: 40 }, recorder().acts)
  assert.match(text(typing.lines[0]), /\/ {3}.*\+ New/)
  const none = listFrame(ui({ agents: WORLD }), PREFS, { w: 60, h: 40 }, recorder().acts)
  assert.doesNotMatch(text(none.lines[0]), /\//)
})

test('a list that empties under its scroll still draws its groups', () => {
  const many = Array.from({ length: 30 }, (_, i) => agent(`w${i}`, { since: NOW - i * MIN }))
  const deep = listFrame(ui({ agents: many, listSel: 'w29' }), PREFS, { w: 60, h: 20 }, recorder().acts)
  const emptied = listFrame(ui({ agents: [], scroll: deep.scroll }), PREFS, { w: 60, h: 20 }, recorder().acts)
  assert.equal(emptied.scroll.list, 0)
  assert.match(screen(emptied), /Nothing needs you/)
})

test('the list scrolls to keep its selection in view', () => {
  const many = Array.from({ length: 30 }, (_, i) => agent(`w${i}`, { since: NOW - i * MIN }))
  const f = listFrame(ui({ agents: many, listSel: 'w29' }), PREFS, { w: 60, h: 20 }, recorder().acts)
  assert.ok(f.scroll.list > 0)
  assert.match(screen(f), /w29/)
})
