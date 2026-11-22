// node --test ghostty/hub/peek.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type PeekDeps, peekOf } from './peek.ts'
import type { Agent, Pane } from '../agents/model.ts'
import type { Level } from '../core/log.ts'
import type { RunResult } from '../core/proc.ts'
import { P } from '../tui/term.ts'

// Partial agents, with what the peek reads of them. Only a hub tab opens
// beside the list; a workspace tab is gone to in the workspace.
const tabPane = { pane: '%12', session: 'hubtabs-1', win: 1, window: '@12', tab: 2, hub: true } as Pane
const tabAgent = { id: 'a1', title: 'Fix it', cwd: '/p', pane: tabPane } as Agent
const workPane = { pane: '%22', session: 'ghostty-1', win: 1, window: '@22', tab: 3, hub: false } as Pane
const workAgent = { id: 'w1', title: 'Tidy up', cwd: '/p', pane: workPane } as Agent
const bgAgent = { id: 'b1', title: 'Background', cwd: '/p', jobId: 'job1', pane: null } as Agent

type Rule = { kind?: string; has: string[]; r: Partial<RunResult> }
type Logged = { level: Level; message: string; [field: string]: unknown }
// `focused` as a function is the selection as it moves.
type World = { rules?: Rule[]; agents?: Agent[]; focused?: Agent | null | (() => Agent | null) } & Partial<Omit<PeekDeps, 'agents' | 'focused'>>

// A peek controller on a fake tmux: calls are recorded and answered by the
// first rule whose words are all in them, else ok and empty.
function world({ rules = [], agents = [tabAgent, bgAgent], focused = null, ...extra }: World = {}) {
  const calls: unknown[][] = []
  const notes: { text: string; color?: string }[] = []
  const logs: Logged[] = []
  let draws = 0
  let selected: string | null = null
  const answer = (kind: string, args: string[]): RunResult => {
    calls.push([kind, ...args])
    const rule = rules.find(r => (r.kind ?? kind) === kind && r.has.every(w => args.includes(w)))
    // The exit code is left out, as no caller reads it.
    return { ok: true, out: '', err: '', ...rule?.r } as RunResult
  }
  const at = (level: Level) => (message: string, fields: object = {}) => {
    logs.push({ level, message, ...fields })
  }
  const peek = peekOf({
    outer: async (...args) => answer('outer', args),
    tabs: async (...args) => answer('tabs', args),
    probeTabs: async (...args) => answer('tabs', args),
    run: async argv => answer('run', argv),
    say: (text, color) => {
      notes.push({ text, color })
    },
    draw: () => {
      draws++
    },
    agents: () => agents,
    select: id => {
      selected = id
    },
    focused: typeof focused === 'function' ? focused : () => focused,
    cols: () => 200,
    listCols: () => 60,
    win: 1,
    CONF: '/conf',
    claude: '/bin/claude',
    markReviewed: id => {
      calls.push(['reviewed', id])
    },
    log: { enabled: () => true, debug: at('debug'), info: at('info'), warn: at('warn') },
    env: { TMUX: '/tmp/tmux,1,0', TMUX_PANE: '%1' },
    ...extra,
  })
  return { peek, calls, notes, logs, draws: () => draws, selected: () => selected }
}

const alive = (pane: string): Rule => ({ kind: 'outer', has: ['display', '#{pane_id}'], r: { out: `${pane}\n` } })
const opened = (w: ReturnType<typeof world>) => w.logs.filter(l => l.message === 'session opened')

test('a session needs tmux and a tab or a job to open', async () => {
  const noTmux = world({ env: {} })
  await noTmux.peek.openSession(tabAgent)
  const outside = world()
  await outside.peek.openSession({ id: 't1', title: 'Term' } as Agent)
  assert.deepEqual(
    [...noTmux.notes, ...outside.notes],
    [
      { text: 'The hub is not running in tmux, so it has nowhere to open a session', color: P.red },
      { text: "Term runs outside the layout's tabs, so it can't be opened here", color: P.peach },
    ],
  )
  assert.deepEqual(outside.calls, [])
  assert.deepEqual(opened(outside).map(l => l.ok), [false])
})

test('the first session opens in a pane split off beside the list, marked so a restart takes it back', async () => {
  const w = world({ rules: [{ has: ['split-window'], r: { out: '%5\n' } }] })
  await w.peek.openSession(tabAgent)
  assert.deepEqual(w.calls, [
    ['reviewed', 'a1'],
    // No pane to take back and no @peek_pane named, so nothing to let go.
    ['outer', 'list-panes', '-t', '%1', '-F', '#{pane_id} #{@peek} #{@peek_pane}'],
    ['outer', 'split-window', '-h', '-t', '%1', '-l', '139', '-P', '-F', '#{pane_id}', '/conf/bin/ghostty-hub peek 1 @12'],
    ['outer', 'set', '-p', '-t', '%5', '@peek', '1'],
    ['outer', 'set', '-w', '-t', '%5', '@peek_pane', '%5', ';', 'set', '-w', '-t', '%5', 'pane-border-status', 'top'],
  ])
  assert.deepEqual(w.peek.current, { pane: '%5', id: 'a1', window: '@12' })
  assert.equal(w.selected(), 'a1')
  assert.equal(w.draws(), 1)
  assert.deepEqual(opened(w).map(l => [l.ok, l.how]), [[true, 'split']])
})

test('a pane that won’t split says why', async () => {
  const w = world({ rules: [{ has: ['split-window'], r: { ok: false, err: 'no space for new pane' } }] })
  await w.peek.openSession(tabAgent)
  assert.deepEqual(w.notes, [{ text: "Couldn't open the session: no space for new pane", color: P.red }])
  assert.equal(w.peek.current, null)
})

test('with a session open, a tab is one switch away; a background agent restarts the pane', async () => {
  const other = { ...tabAgent, id: 'a2', pane: { ...tabPane, window: '@13' } }
  const w = world({ rules: [{ has: ['split-window'], r: { out: '%5\n' } }, alive('%5')] })
  await w.peek.openSession(tabAgent)
  w.calls.length = 0
  await w.peek.openSession(other)
  assert.deepEqual(w.calls.slice(1), [
    ['outer', 'display', '-p', '-t', '%5', '#{pane_id}'],
    ['tabs', 'select-window', '-t', '=peek-5:@13'],
    ['outer', 'select-pane', '-t', '%5'],
  ])
  w.calls.length = 0
  await w.peek.openSession(bgAgent)
  assert.deepEqual(w.calls, [
    ['reviewed', 'b1'],
    ['outer', 'display', '-p', '-t', '%5', '#{pane_id}'],
    ['outer', 'respawn-pane', '-k', '-t', '%5', '/conf/bin/ghostty-hub attach job1'],
    // No tabs to add one to: Ctrl+Shift+T opens a terminal in its folder.
    ['outer', 'set', '-p', '-t', '%5', '@peek_bg', '/p'],
    ['outer', 'select-pane', '-t', '%5'],
  ])
  assert.deepEqual(w.peek.current, { pane: '%5', id: 'b1', window: null })
  // Back to a tab, the pane names no folder, so the key opens a tab again.
  w.calls.length = 0
  await w.peek.openSession(tabAgent)
  assert.deepEqual(w.calls.slice(2), [
    ['outer', 'respawn-pane', '-k', '-t', '%5', '/conf/bin/ghostty-hub peek 1 @12'],
    ['outer', 'set', '-pu', '-t', '%5', '@peek_bg'],
    ['outer', 'select-pane', '-t', '%5'],
  ])
  assert.deepEqual(opened(w).map(l => l.how), ['split', 'switched', 'respawned', 'respawned'])
})

test('a background agent’s first session names its folder on the pane, for Ctrl+Shift+T’s terminal', async () => {
  const w = world({ rules: [{ has: ['split-window'], r: { out: '%5\n' } }], env: { TMUX: '/tmp/tmux,1,0', TMUX_PANE: '%1', HOME: '/home/u' } })
  await w.peek.openSession(bgAgent)
  assert.deepEqual(w.calls.slice(-3), [
    ['outer', 'set', '-p', '-t', '%5', '@peek', '1'],
    ['outer', 'set', '-p', '-t', '%5', '@peek_bg', '/p'],
    ['outer', 'set', '-w', '-t', '%5', '@peek_pane', '%5', ';', 'set', '-w', '-t', '%5', 'pane-border-status', 'top'],
  ])
  // One agentd has no folder for starts in the home folder.
  const homeless = world({ rules: [{ has: ['split-window'], r: { out: '%6\n' } }], env: { TMUX: '/tmp/tmux,1,0', TMUX_PANE: '%1', HOME: '/home/u' } })
  await homeless.peek.openSession({ ...bgAgent, cwd: '' })
  assert.ok(homeless.calls.some(c => c.join(' ') === 'outer set -p -t %6 @peek_bg /home/u'))
})

test('at start the pane marked @peek is taken back, with the agent of the tab it shows', async () => {
  const w = world({
    rules: [
      { has: ['list-panes'], r: { out: '%1 \n%7 1\n' } },
      { has: ['list-windows'], r: { out: '0 @3\n1 @12\n' } },
    ],
  })
  await w.peek.findPeek()
  assert.deepEqual(w.peek.current, { pane: '%7', id: 'a1', window: '@12' })
  assert.deepEqual(w.calls.at(-1), ['outer', 'set', '-w', '-t', '%7', '@peek_pane', '%7', ';', 'set', '-w', '-t', '%7', 'pane-border-status', 'top'])
})

test('following the session: its pane gone lets it go, a tab switched in it moves the selection', async () => {
  const other = { ...tabAgent, id: 'a2', pane: { ...tabPane, window: '@13' } }
  const rules = [{ has: ['split-window'], r: { out: '%5\n' } }, alive('%5'), { kind: 'tabs', has: ['display'], r: { out: 'peek-5 @13\n' } }]
  const w = world({ rules, agents: [tabAgent, other] })
  await w.peek.openSession(tabAgent)
  await w.peek.watchPeek()
  assert.deepEqual(w.peek.current, { pane: '%5', id: 'a2', window: '@13' })
  assert.equal(w.selected(), 'a2')
  rules.splice(1, 1)
  await w.peek.watchPeek()
  assert.equal(w.peek.current, null)
  assert.deepEqual(w.calls.at(-1), ['outer', 'set', '-wu', '-t', '%1', '@peek_pane', ';', 'set', '-wu', '-t', '%1', 'pane-border-status'])
})

test('a tab New agent made is followed to the agent agentd finds in it', async () => {
  const made = { id: 'new:%30', title: 'do-it', pane: { session: 'ghostty-1', window: '@30', pane: '%30', win: 1, hub: true } }
  const agents: Agent[] = []
  const w = world({ rules: [{ has: ['split-window'], r: { out: '%5\n' } }, alive('%5')], agents })
  await w.peek.openSession(made)
  assert.equal(w.peek.current?.id, 'new:%30')
  // Not reviewed: there is no agent by that id to review.
  assert.ok(!w.calls.some(c => c[0] === 'reviewed'))
  await w.peek.watchPeek()
  assert.equal(w.peek.current?.id, 'new:%30')
  agents.push({ ...tabAgent, id: 'n1', pane: { ...tabPane, pane: '%30', window: '@30' } })
  await w.peek.watchPeek()
  assert.equal(w.peek.current?.id, 'n1')
  assert.equal(w.selected(), 'n1')
})

test('a session found gone lets go of @peek_pane only while no newer one has taken it', async () => {
  const calls: string[][] = []
  // The next display call waits for `release`, as a slow tmux would.
  let held: Promise<void> | null = null
  let release = () => {}
  const outer = async (...args: string[]): Promise<RunResult> => {
    calls.push(args)
    const wait = args[0] === 'display' ? held : null
    if (wait) {
      held = null
      await wait
    }
    const out = args[0] === 'split-window' ? (args.at(-1)?.includes('attach') ? '%6\n' : '%5\n') : ''
    return { ok: true, out, err: '' } as RunResult
  }
  const w = world({ outer })
  await w.peek.openSession(tabAgent)
  held = new Promise(r => {
    release = r
  })
  // The tick asks whether %5 lives and waits; meanwhile %5 has died and a
  // background agent opens in a new pane, %6.
  const tick = w.peek.watchPeek()
  await w.peek.openSession(bgAgent)
  assert.deepEqual(w.peek.current, { pane: '%6', id: 'b1', window: null })
  calls.length = 0
  release()
  await tick
  assert.deepEqual(w.peek.current, { pane: '%6', id: 'b1', window: null })
  assert.deepEqual(calls, [])
})

test('a restarted hub with no session pane lets go of a stale @peek_pane', async () => {
  // The window still names %9, a session pane that closed while no hub ran.
  const w = world({ rules: [{ has: ['list-panes'], r: { out: '%1  %9\n' } }] })
  await w.peek.findPeek()
  assert.equal(w.peek.current, null)
  assert.deepEqual(w.calls, [
    ['outer', 'list-panes', '-t', '%1', '-F', '#{pane_id} #{@peek} #{@peek_pane}'],
    ['outer', 'set', '-wu', '-t', '%1', '@peek_pane', ';', 'set', '-wu', '-t', '%1', 'pane-border-status'],
  ])
  // With none named there is nothing to let go.
  const clean = world({ rules: [{ has: ['list-panes'], r: { out: '%1  \n' } }] })
  await clean.peek.findPeek()
  assert.deepEqual(clean.calls, [['outer', 'list-panes', '-t', '%1', '-F', '#{pane_id} #{@peek} #{@peek_pane}']])
})

test('closing the session kills its pane; the closing key only lets go of it', async () => {
  const w = world({ rules: [{ has: ['split-window'], r: { out: '%5\n' } }] })
  await w.peek.openSession(tabAgent)
  w.calls.length = 0
  await w.peek.closePeek()
  assert.deepEqual(w.calls, [
    ['outer', 'kill-pane', '-t', '%5'],
    ['outer', 'set', '-wu', '-t', '%1', '@peek_pane', ';', 'set', '-wu', '-t', '%1', 'pane-border-status'],
  ])
  await w.peek.openSession(tabAgent)
  w.calls.length = 0
  w.peek.forget()
  assert.equal(w.peek.current, null)
  assert.deepEqual(w.calls, [['outer', 'set', '-wu', '-t', '%1', '@peek_pane', ';', 'set', '-wu', '-t', '%1', 'pane-border-status']])
})

test('opening a workspace tab goes to it in the workspace, never beside the list', async () => {
  const w = world({ rules: [{ has: ['split-window'], r: { out: '%5\n' } }] })
  await w.peek.openSession(workAgent)
  assert.deepEqual(w.calls, [
    ['tabs', 'select-window', '-t', 'ghostty-1:@22'],
    ['outer', 'select-window', '-t', 'layout-1:work'],
  ])
  assert.equal(w.peek.current, null)
  w.calls.length = 0
  await w.peek.openSession({ ...workAgent, pane: { ...workPane, session: 'ghostty-2', win: 2 } })
  assert.deepEqual(w.calls, [['tabs', 'select-window', '-t', 'ghostty-2:@22']])
  assert.deepEqual(w.notes, [{ text: "Switched Tidy up's tab in Ghostty window 2", color: P.sub }])
})

test('o goes to a tab here, says which window for another, opens a hub tab here, and gives a background agent a tab', async () => {
  const w = world({ rules: [{ has: ['new-window'], r: { out: '%40\n' } }, { has: ['split-window'], r: { out: '%5\n' } }] })
  await w.peek.goToTab(workAgent)
  assert.deepEqual(w.calls, [
    ['tabs', 'select-window', '-t', 'ghostty-1:@22'],
    ['outer', 'select-window', '-t', 'layout-1:work'],
  ])
  w.calls.length = 0
  await w.peek.goToTab({ ...workAgent, pane: { ...workPane, win: 2 } })
  assert.deepEqual(w.notes.at(-1), { text: "Switched Tidy up's tab in Ghostty window 2", color: P.sub })
  w.calls.length = 0
  await w.peek.goToTab(bgAgent)
  assert.deepEqual(w.calls, [
    ['tabs', 'new-window', '-t', 'ghostty-1:', '-c', '/p', '-P', '-F', '#{pane_id}'],
    ['tabs', 'send-keys', '-t', '%40', '-l', '/bin/claude attach job1'],
    ['tabs', 'send-keys', '-t', '%40', 'Enter'],
    ['outer', 'select-window', '-t', 'layout-1:work'],
  ])
  await w.peek.goToTab(tabAgent)
  assert.deepEqual(w.peek.current?.id, 'a1')
})

test('Alt+D shows the open session’s tab, else the selected agent’s, and says why it can’t', async () => {
  const termAgent = { id: 't1', title: 'Loose', cwd: '/p', jobId: null, pane: null } as Agent
  const none = world()
  await none.peek.showDiagrams()
  const term = world({ focused: termAgent })
  await term.peek.showDiagrams()
  const noWin = world({ win: 0 })
  await noWin.peek.showDiagrams()
  assert.deepEqual(
    [none, term, noWin].map(w => w.notes[0].text),
    [
      'Select an agent to see its diagrams',
      'Loose runs outside tmux and the background, so it has no diagrams to show',
      'Not in a Ghostty layout window, so there is nowhere to show diagrams',
    ],
  )
  const sel = world({ focused: tabAgent, rules: [{ kind: 'run', has: ['%12'], r: { ok: false, err: 'no diagrams' } }] })
  await sel.peek.showDiagrams()
  assert.deepEqual(sel.calls, [['run', '/conf/bin/ghostty-diagrams', '1', '%12']])
  assert.deepEqual(sel.notes, [{ text: "Couldn't show the diagrams: no diagrams", color: P.red }])
  const open = world({ rules: [{ has: ['split-window'], r: { out: '%5\n' } }, alive('%5')] })
  await open.peek.openSession(tabAgent)
  await open.peek.showDiagrams()
  assert.deepEqual(open.calls.at(-1), ['run', '/conf/bin/ghostty-diagrams', '1', 'peek-5'])
})

test('Alt+D shows a background agent’s diagrams by its job, the open one before the selected one', async () => {
  const bg = world({ focused: bgAgent })
  await bg.peek.showDiagrams()
  assert.deepEqual(bg.calls, [['run', '/conf/bin/ghostty-diagrams', '1', 'job:job1', 'Background']])
  assert.deepEqual(bg.notes, [])
  const open = world({ focused: tabAgent, rules: [{ has: ['split-window'], r: { out: '%5\n' } }, alive('%5')] })
  await open.peek.openSession(bgAgent)
  await open.peek.showDiagrams()
  assert.deepEqual(open.calls.at(-1), ['run', '/conf/bin/ghostty-diagrams', '1', 'job:job1', 'Background'])
})

test('Alt+E opens the open session’s agent in the editor, else the selected one, background agents too', async () => {
  const none = world()
  await none.peek.openEditor()
  assert.deepEqual(none.notes, [{ text: 'Select an agent to open its repo in your editor', color: undefined }])
  assert.deepEqual(none.calls, [])

  const wt = { ...bgAgent, cwd: '/r/dot/.claude/worktrees/fix-x' } as Agent
  const selected = world({ agents: [tabAgent, wt], focused: wt })
  await selected.peek.openEditor()
  assert.deepEqual(selected.calls, [['run', '/conf/bin/ghostty-editor', '--dir', '/r/dot/.claude/worktrees/fix-x']])
  assert.deepEqual(selected.logs.find(l => l.message === 'editor opened'), { level: 'info', message: 'editor opened', id: 'b1', dir: '/r/dot/.claude/worktrees/fix-x', ok: true })

  // The open session's agent wins over the selection.
  const shown = world({ agents: [tabAgent, wt], focused: wt, rules: [{ has: ['split-window'], r: { out: '%5\n' } }] })
  await shown.peek.openSession(tabAgent)
  shown.calls.length = 0
  await shown.peek.openEditor()
  assert.deepEqual(shown.calls, [['run', '/conf/bin/ghostty-editor', '--dir', '/p']])

  const noFolder = world({ focused: { ...bgAgent, cwd: '' } as Agent })
  await noFolder.peek.openEditor()
  assert.equal(noFolder.notes[0].color, P.peach)
  assert.deepEqual(noFolder.calls, [])

  const failing = world({ focused: wt, rules: [{ kind: 'run', has: ['--dir'], r: { ok: false, err: "VS Code (code) isn't installed.\n" } }] })
  await failing.peek.openEditor()
  assert.deepEqual(failing.notes, [{ text: "VS Code (code) isn't installed.", color: P.red }])
})

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('moving through the list shows each agent in the open session once the selection rests, focus staying in the list', async () => {
  const other = { ...tabAgent, id: 'a2', pane: { ...tabPane, window: '@13' } }
  let sel: Agent | null = tabAgent
  const w = world({ rules: [{ has: ['split-window'], r: { out: '%5\n' } }, alive('%5')], agents: [tabAgent, other, bgAgent, workAgent], focused: () => sel, previewMs: 5 })
  await w.peek.openSession(tabAgent)
  w.calls.length = 0
  // A run of moves opens only the one it ends on.
  sel = bgAgent
  w.peek.preview()
  sel = other
  w.peek.preview()
  await tick(20)
  assert.deepEqual(w.calls, [
    ['outer', 'display', '-p', '-t', '%5', '#{pane_id}'],
    ['reviewed', 'a2'],
    ['outer', 'display', '-p', '-t', '%5', '#{pane_id}'],
    ['tabs', 'select-window', '-t', '=peek-5:@13'],
  ])
  assert.deepEqual(w.peek.current, { pane: '%5', id: 'a2', window: '@13' })
  assert.equal(w.selected(), 'a2')
  // A workspace tab doesn't open in the hub, so the session stays as it was.
  w.calls.length = 0
  sel = workAgent
  w.peek.preview()
  await tick(20)
  assert.deepEqual(w.calls, [])
  assert.equal(w.peek.current?.id, 'a2')
})

test('the open session moves to another agent with focus kept in the list, and only when one is open', async () => {
  const other = { ...tabAgent, id: 'a2', pane: { ...tabPane, window: '@13' } }
  const none = world({ agents: [tabAgent, other] })
  await none.peek.showInstead(other)
  assert.deepEqual(none.calls, [])
  const w = world({ rules: [{ has: ['split-window'], r: { out: '%5\n' } }, alive('%5')], agents: [tabAgent, other, bgAgent] })
  await w.peek.openSession(tabAgent)
  w.calls.length = 0
  await w.peek.showInstead(other)
  assert.ok(!w.calls.some(c => c.includes('select-pane')))
  assert.deepEqual(w.peek.current, { pane: '%5', id: 'a2', window: '@13' })
  assert.equal(w.selected(), 'a2')
  // A background agent's job restarts the pane, still not focusing it.
  w.calls.length = 0
  await w.peek.showInstead(bgAgent)
  assert.ok(w.calls.some(c => c.includes('respawn-pane')))
  assert.ok(!w.calls.some(c => c.includes('select-pane')))
  assert.equal(w.peek.current?.id, 'b1')
})

test('only a hub tab or a background job opens beside the list', () => {
  const w = world()
  assert.deepEqual([tabAgent, bgAgent, workAgent].map(a => w.peek.opensHere(a)), [true, true, false])
})

test('with no session open, moving in the list opens nothing', async () => {
  const w = world({ focused: tabAgent, previewMs: 1 })
  w.peek.preview()
  await tick(10)
  assert.deepEqual(w.calls, [])
})

test('the agent view focuses the open session, else opens the last one again, else the selected agent', async () => {
  const w = world({ rules: [{ has: ['split-window'], r: { out: '%5\n' } }, alive('%5')], focused: bgAgent })
  await w.peek.openSession(tabAgent)
  w.calls.length = 0
  await w.peek.agentView()
  assert.deepEqual(w.calls, [
    ['outer', 'display', '-p', '-t', '%5', '#{pane_id}'],
    ['outer', 'select-pane', '-t', '%5'],
  ])
  // Closed, it comes back on the agent it showed, not the selected one.
  await w.peek.closePeek()
  w.calls.length = 0
  await w.peek.agentView()
  assert.ok(w.calls.some(c => c.join(' ').endsWith('/conf/bin/ghostty-hub peek 1 @12')))
  assert.equal(w.peek.current?.id, 'a1')
  // Never open, the selected agent, when it opens here.
  const fresh = world({ rules: [{ has: ['split-window'], r: { out: '%6\n' } }], focused: bgAgent })
  await fresh.peek.agentView()
  assert.equal(fresh.peek.current?.id, 'b1')
  // A workspace tab isn't one: a note says what to do instead.
  const work = world({ focused: workAgent })
  await work.peek.agentView()
  assert.deepEqual(work.notes.map(n => n.text), ['No session to show: select a hub tab or background agent and press Enter'])
  assert.equal(work.peek.current, null)
})
