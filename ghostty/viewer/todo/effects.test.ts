// With a fake tmux, claude and filer, checking the exact argv each one gets
// (as viewer-todo.test.mjs sees them from the real program).
import assert from 'node:assert/strict'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'todo-effects-'))
process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'
process.env.AGENT_HUB_PROMPTS = '/nonexistent/agent-hub/prompts'
process.env.AGENT_HUB_LOG_DIR = join(root, 'logs')
process.env.TODO_FILE = join(root, 'todos.json')

import type { RunResult } from '../../core/proc.ts'
import type { Settings } from '../../settings/catalog.ts'
import type { Hint } from '../../tui/chrome.ts'
import type { World } from './effects.ts'
import type { Item } from './todo.ts'

type Paths = { alpha: string; beta: string; gamma: string; home: string }
type Todos = (o: Paths & { now?: number; filing?: boolean }) => { items: Item[] }
const fixture = new URL('../../../tests/fixtures/viewer/todo/items.mjs', import.meta.url).href
const { todos }: { todos: Todos } = await import(fixture)
const { LAYOUT_SOCKET } = await import('../../core/paths.ts')
const { todoEffects } = await import('./effects.ts')
const { config, createState } = await import('./state.ts')
const { add, change, load } = await import('./todo.ts')

const TABS = 'tabs-sock'
const LAYOUT = LAYOUT_SOCKET
const paths = { alpha: join(root, 'alpha'), beta: join(root, 'beta'), gamma: join(root, 'gamma'), home: join(root, 'home') }
mkdirSync(join(paths.alpha, '.git'), { recursive: true })
mkdirSync(paths.beta, { recursive: true })

const tick = () => new Promise<void>(r => setImmediate(r))
const logged = () => {
  try {
    return readFileSync(join(root, 'logs', 'todo.log'), 'utf8')
  } catch {
    return ''
  }
}

// A tmux that answers as viewer-todo.test.mjs's stub does: tab 2 (%1) in
// Ghostty window 1, a hub tab (%5); new-window makes %7, @tabs is %3.
function fakeTmux(answers: Record<string, RunResult> = {}) {
  const calls: string[][] = []
  const run = async (argv: string[]): Promise<RunResult> => {
    calls.push(argv)
    const cmd = argv[3]
    if (cmd in answers) return answers[cmd]
    if (cmd === 'list-panes') return { ok: true, out: '%1\tghostty-1\t@1\t2\n%5\thubtabs-1\t@5\t4\n', err: '', exit: 0 }
    if (cmd === 'display') return { ok: true, out: `${paths.alpha}\n`, err: '', exit: 0 }
    if (cmd === 'new-window') return { ok: true, out: '%7\n', err: '', exit: 0 }
    if (cmd === 'show') return { ok: true, out: '%3\n', err: '', exit: 0 }
    return { ok: true, out: '', err: '', exit: 0 }
  }
  // What the view did, without its polling.
  const acted = () => calls.filter(c => !['list-panes', 'display'].includes(c[3]))
  return { run, calls, acted }
}

function fakeSpawn({ out = '', code = 0, error }: { out?: string; code?: number; error?: Error } = {}) {
  const calls: { argv: string[]; opts: SpawnOptions }[] = []
  const spawn = (cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess => {
    calls.push({ argv: [cmd, ...args], opts })
    const stdout = new EventEmitter()
    const child = Object.assign(new EventEmitter(), { stdout, stderr: new EventEmitter(), unref: () => {} })
    setImmediate(() => {
      if (error) return child.emit('error', error)
      if (out) stdout.emit('data', Buffer.from(out))
      child.emit('close', code)
    })
    return child as unknown as ChildProcess
  }
  return { spawn, calls }
}

// In Ghostty window 1, or none without `win`. `said`, `confirms` and `quits`
// record what the view did.
type Setup = { win?: boolean; tmux?: ReturnType<typeof fakeTmux>; spawn?: ReturnType<typeof fakeSpawn>; popup?: boolean } & Partial<Omit<World, 'run' | 'spawn'>>
function setup({ win = true, tmux = fakeTmux(), spawn = fakeSpawn(), popup = false, ...io }: Setup = {}) {
  writeFileSync(process.env.TODO_FILE!, JSON.stringify(todos({ ...paths })))
  const env = { ...(win && { DV_TABS: `${TABS}:ghostty-1` }), ...(popup && { TD_POPUP: '1' }) }
  const s = createState(config(env, ['node', 'todo-view.ts', paths.alpha], root))
  const seen = { said: [] as string[], confirms: [] as { text: string; yes: () => void; key: string; answers: Hint[] }[], quits: [] as number[], draws: 0 }
  const fx = todoEffects(s, {
    run: tmux.run,
    spawn: spawn.spawn,
    kill: () => {},
    isFiler: () => true,
    exists: () => true,
    readFile: () => '/opt/claude bin/claude\n',
    agents: () => [],
    openInHub: async () => ({ ok: true, message: '' }),
    repoOf: async dir => ({ root: dir, repo: 'alpha', worktree: '', branch: 'main' }),
    settings: () => ({ 'todo.handoff.mode': 'auto', 'todo.handoff.effort': 'medium', 'todo.noteSecs': 2 }) as Partial<Settings> as Settings,
    claude: () => '/opt/claude bin/claude',
    node: '/usr/bin/node',
    todoCli: '/conf/bin/ghostty-todo',
    pasteImage: () => ({ image: '/images/todo/pasted.png' }),
    attachFiles: files => files.map(f => ({ image: `/images/todo/${f.split('/').pop()}` })),
    say: text => seen.said.push(text),
    draw: () => seen.draws++,
    confirm: (text, yes, key, answers) => seen.confirms.push({ text, yes, key, answers }),
    quit: code => seen.quits.push(code ?? 0),
    ...io,
  })
  fx.readStore(true)
  s.here = { folder: paths.alpha, root: paths.alpha, repo: 'alpha', worktree: '', branch: 'main' }
  const item = (id: string): Item => s.items.find(i => i.id === id)!
  return { s, fx, seen, tmux, spawn, item }
}

test('↵ on an item whose tab is open goes to it, and to the work window', async () => {
  const { fx, seen, tmux, item } = setup()
  await fx.goTo(item('a1b'))
  assert.deepEqual(tmux.calls[0], ['tmux', '-L', TABS, 'list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{start_time}'])
  assert.deepEqual(tmux.acted(), [
    ['tmux', '-L', TABS, 'select-window', '-t', 'ghostty-1:@1'],
    ['tmux', '-L', TABS, 'select-pane', '-t', '%1'],
    ['tmux', '-L', LAYOUT, 'show', '-t', 'layout-1', '-v', '@tabs'],
    ['tmux', '-L', LAYOUT, 'select-window', '-t', 'layout-1:work'],
    ['tmux', '-L', LAYOUT, 'select-pane', '-t', '%3'],
  ])
  assert.deepEqual(seen.quits, [], 'outside the popup it stays open')
  assert.match(logged(), /INFO todo: went to tab \{"id":"a1b","pane":"%1"\}/)
})

test('in the popup, going to a tab closes it', async () => {
  const { fx, seen, item } = setup({ popup: true })
  await fx.goTo(item('a1b'))
  assert.deepEqual(seen.quits, [0])
})

test('↵ on a closed tab asks, then reopens Claude there, resuming its session', async () => {
  const { fx, seen, tmux, item } = setup()
  await fx.goTo(item('e5f'))
  assert.deepEqual(tmux.acted(), [])
  const [ask] = seen.confirms
  assert.equal(ask.text, 'Its tab is closed. Open Claude in beta, resuming its session?')
  assert.equal(ask.key, '\r')
  assert.deepEqual(ask.answers[0], ['↵', 'open'], 'the key it waits for is the one it shows')
  await fx.reopen(item('e5f'), paths.beta)
  assert.deepEqual(tmux.acted(), [
    ['tmux', '-L', TABS, 'new-window', '-t', 'ghostty-1:', '-c', paths.beta, '-P', '-F', '#{pane_id}'],
    ['tmux', '-L', TABS, 'send-keys', '-t', '%7', '-l', '/opt/claude\\ bin/claude --resume sess-123'],
    ['tmux', '-L', TABS, 'send-keys', '-t', '%7', 'Enter'],
    ['tmux', '-L', LAYOUT, 'show', '-t', 'layout-1', '-v', '@tabs'],
    ['tmux', '-L', LAYOUT, 'select-pane', '-t', '%3'],
    ['tmux', '-L', LAYOUT, 'select-window', '-t', 'layout-1:work'],
  ])
  assert.equal(load().find(i => i.id === 'e5f')!.pane, '%7')
})

test('a tab the hub opened: the hub window, and where to find it', async () => {
  const { fx, seen, tmux, item } = setup()
  await fx.goTo(item('f6g'))
  assert.deepEqual(tmux.acted(), [['tmux', '-L', LAYOUT, 'select-window', '-t', 'layout-1:hub']])
  assert.deepEqual(seen.said, ["It's a tab the hub opened: pick it on the board"])
})

test('outside a layout window there is no tab session to reopen a tab in', async () => {
  const { fx, seen, tmux, item } = setup({ win: false })
  await fx.goTo(item('e5f'))
  assert.deepEqual(tmux.acted(), [])
  assert.deepEqual(seen.said, ['Not in a Ghostty layout window, so there is no tab session to open a tab in'])
})

test('a failed tmux call is logged and the view goes on', async () => {
  const tmux = fakeTmux({ 'select-pane': { ok: false, out: '', err: "can't find pane: %1", exit: 1 } })
  const { fx, seen, item } = setup({ tmux })
  await fx.goTo(item('a1b'))
  assert.equal(seen.said.length, 0)
  assert.match(logged(), /WARN todo: tmux failed \{"cmd":\["tmux","-L","tabs-sock","select-pane","-t","%1"\],"err":"can't find pane: %1"\}/)
})

test('w: claude --bg with the plan’s argv, and the hand-off recorded', async () => {
  const spawn = fakeSpawn({ out: 'bg-1234\n' })
  const { s, fx, seen } = setup({ win: false, spawn })
  s.marked.add('a1b')
  await fx.handOff(['a1b'], s.here, { worktree: false, model: 'sonnet' })
  const [{ argv, opts }] = spawn.calls
  assert.deepEqual(argv.slice(0, 10), ['/opt/claude bin/claude', '--bg', '--name', 'crash-when-saving-an-a1b', '--model', 'sonnet', '--permission-mode', 'auto', '--effort', 'medium'])
  assert.equal(
    argv[10],
    "From the hub: Work on todo a1b from my todo list, a bug in alpha, added on main. Once it's finished, mark it done: ~/.config/ghostty/bin/ghostty-todo done a1b\n\n" +
      'My todo:\nCrash when saving an empty file\n\n' +
      'Seen in the editor pane after a fresh clone; the stack trace points at the writer.',
  )
  assert.equal(argv.length, 11)
  assert.deepEqual(opts, { cwd: paths.alpha, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const handoff = load().find(i => i.id === 'a1b')!.handoff!
  assert.deepEqual({ name: handoff.name, where: handoff.where, pane: handoff.pane }, { name: 'crash-when-saving-an-a1b', where: 'bg', pane: '' })
  assert.equal(seen.said.at(-1), 'Handed to an agent in the background: Crash when saving an empty file')
  assert.equal(s.marked.size, 0, 'its mark goes once it has started')
  await tick()
})

test('claude that fails to start: the hand-off says why, and nothing is recorded', async () => {
  const spawn = fakeSpawn({ out: 'not logged in', code: 1 })
  const { s, fx, seen } = setup({ win: false, spawn })
  await fx.handOff(['a1b'], s.here, { worktree: false, model: 'opus' })
  assert.equal(seen.said.at(-1), "couldn't start Crash when saving an empty file: claude --bg failed: not logged in")
  assert.equal(load().find(i => i.id === 'a1b')!.handoff, undefined)
  assert.match(logged(), /WARN todo: agent not started \{"id":"a1b","err":"claude --bg failed: not logged in"\}/)
  await tick()
})

test('a sends the message to ghostty-todo file, in its own session', () => {
  const spawn = fakeSpawn()
  const { fx, seen } = setup({ spawn })
  fx.file('the docs site is down')
  assert.deepEqual(spawn.calls, [
    { argv: ['/usr/bin/node', '/conf/bin/ghostty-todo', 'file', '--dir', paths.alpha, '--', 'the docs site is down'], opts: { detached: true, stdio: 'ignore' } },
  ])
  assert.deepEqual(seen.said, ['Sent to Claude. It shows here once it’s filed.'])
})

test('a message with images passes each to ghostty-todo file, in order', () => {
  const spawn = fakeSpawn()
  const { fx } = setup({ spawn })
  fx.file('see [Image #1] and [Image #2]', [
    { n: 1, path: '/images/todo/a.png' },
    { n: 2, path: '/images/todo/b.png' },
  ])
  assert.deepEqual(spawn.calls[0].argv.slice(3), ['--dir', paths.alpha, '--image', '/images/todo/a.png', '--image', '/images/todo/b.png', '--', 'see [Image #1] and [Image #2]'])
})

test('Ctrl+V and a pasted image file go into a prompt that takes them; none says why', () => {
  const { s, fx, seen } = setup()
  s.prompt = { kind: 'claude', text: '' }
  fx.pasteImage()
  assert.deepEqual(s.prompt, { kind: 'claude', text: '[Image #1]', images: [{ n: 1, path: '/images/todo/pasted.png' }] })
  assert.equal(fx.pasteFiles(['/tmp/shot.png']), true)
  assert.equal(s.prompt.text, '[Image #1][Image #2]')
  assert.equal(fx.pasteFiles([]), false, 'any other paste is text')
  s.prompt = { kind: 'cat', title: 'x', cat: 'bug' }
  assert.equal(fx.pasteFiles(['/tmp/shot.png']), false)
  const none = setup({ pasteImage: () => ({ error: 'No image on the clipboard' }) })
  none.s.prompt = { kind: 'title', text: 'x' }
  none.fx.pasteImage()
  assert.deepEqual(none.seen.said, ['No image on the clipboard'])
  assert.deepEqual(none.s.prompt, { kind: 'title', text: 'x' })
  assert.equal(seen.said.length, 0)
})

test('a todo added by hand keeps its images; replacing a filing takes the images given', async () => {
  const { fx } = setup()
  const images = [{ n: 1, path: '/images/todo/a.png' }]
  await fx.finishAdd({ title: 'Fix [Image #1]', cat: 'bug', note: '', images })
  assert.deepEqual(load().find(i => i.title === 'Fix [Image #1]')?.images, images)
  await fx.finishAdd({ title: 'plain', cat: 'bug', note: '' })
  assert.equal('images' in (load().find(i => i.title === 'plain') ?? {}), false)
  change('i9j', { images })
  await fx.finishAdd({ title: 'no picture now', cat: 'bug', note: '', replaces: 'i9j' })
  assert.deepEqual(load().find(i => i.id === 'i9j')?.images, [])
})

test('r retries only a failed filing', () => {
  const spawn = fakeSpawn()
  const { fx, item } = setup({ spawn })
  fx.retryFiling(item('a1b'))
  fx.retryFiling(undefined)
  assert.equal(spawn.calls.length, 0)
  fx.retryFiling(item('i9j'))
  assert.deepEqual(spawn.calls[0].argv, ['/usr/bin/node', '/conf/bin/ghostty-todo', 'file', '--retry', 'i9j'])
})

test('dropping a filing stops its filer: its group, else the process, else it logs why', () => {
  const killed: number[] = []
  const kill = (pid: number) => {
    killed.push(pid)
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
  }
  const { s, fx } = setup({ kill })
  // The pid the store has now, which a retry may have changed since the
  // viewer read it.
  change('i9j', { filing: { started: 1, pid: 4321 } })
  const { value } = fx.erase(s.items.find(i => i.id === 'i9j')!)
  assert.equal(value?.id, 'i9j')
  assert.deepEqual(killed, [-4321, 4321])
  assert.equal(load().find(i => i.id === 'i9j'), undefined)
  assert.match(logged(), /INFO todo: filing dropped \{"id":"i9j"\}/)
  assert.match(logged(), /WARN todo: filer not stopped \{"pid":4321,"err":"kill ESRCH","groupErr":"kill ESRCH"\}/)
})

test('a filer that has exited is not signalled: its pid may be another process now', () => {
  const killed: number[] = []
  const { s, fx } = setup({ kill: pid => void killed.push(pid), isFiler: () => false })
  change('i9j', { filing: { started: 1, pid: 4321, error: 'claude exited' } })
  fx.erase(s.items.find(i => i.id === 'i9j')!)
  assert.equal(load().find(i => i.id === 'i9j'), undefined, 'still dropped')
  assert.deepEqual(killed, [])
})

test('a drop of a filing Claude filed meanwhile keeps the todo, and its filer', () => {
  const killed: number[] = []
  const { s, fx } = setup({ kill: pid => void killed.push(pid) })
  const asked = { ...s.items.find(i => i.id === 'i9j')!, filing: { started: 1, pid: 4321 } }
  // The filer's add --filing, after the confirm opened.
  change('i9j', it => ({ ...it, filing: undefined, title: 'Rename the sidebar' }))
  const { value, error } = fx.erase(asked)
  assert.equal(error, undefined)
  assert.equal(value, undefined)
  assert.equal(load().find(i => i.id === 'i9j')?.title, 'Rename the sidebar')
  assert.deepEqual(killed, [])
})

test('x deletes only the item it names, not one whose id starts the same', () => {
  const { s, fx } = setup()
  const gone = { ...s.items.find(i => i.id === 'a1b')!, id: 'a1' }
  assert.equal(fx.erase(gone).value, undefined)
  assert.ok(load().some(i => i.id === 'a1b'))
})

test('Shift+A on a failed filing Claude filed meanwhile replaces that todo, not adds a second', async () => {
  const { fx } = setup()
  change('i9j', it => ({ ...it, filing: undefined, title: 'Rename the sidebar' }))
  const before = load().length
  await fx.finishAdd({ title: 'Rename the sidebar panel', cat: 'bug', note: '', replaces: 'i9j' })
  assert.equal(load().length, before)
  assert.equal(load().find(i => i.id === 'i9j')?.title, 'Rename the sidebar panel')
})

test('r twice before the retry has taken over starts one filer', () => {
  const spawn = fakeSpawn()
  const { fx, seen, item } = setup({ spawn })
  fx.retryFiling(item('i9j'))
  fx.retryFiling(item('i9j'))
  assert.equal(spawn.calls.length, 1)
  assert.deepEqual(seen.said, ['Asked Claude again', 'Asked Claude again'])
})

test('a filer that could not start says so, not that it was sent', () => {
  const spawn = () => {
    throw new Error('spawn EAGAIN')
  }
  const { fx, seen } = setup({ spawn: { spawn, calls: [] } })
  fx.file('the docs site is down')
  assert.deepEqual(seen.said, ["Couldn't run ghostty-todo: spawn EAGAIN"])
})

test('space on a todo the store can’t write keeps the error showing and the cursor still', () => {
  const { s, fx, seen, item } = setup()
  s.cursorId = 'a1b'
  const file = process.env.TODO_FILE!
  rmSync(file)
  mkdirSync(file)
  try {
    fx.setDone(item('a1b'))
  } finally {
    rmdirSync(file)
  }
  assert.equal(seen.said.length, 1)
  assert.doesNotMatch(seen.said[0], /^Done/)
  assert.equal(s.cursorId, 'a1b')
})

test('space on a todo deleted meanwhile says it is gone', () => {
  const { s, fx, seen, item } = setup()
  const was = item('a1b')
  fx.erase(was)
  s.cursorId = 'a1b'
  fx.setDone(was)
  assert.equal(seen.said.at(-1), 'That todo is gone')
})

test('space, c and t write the store and log what changed', () => {
  const { s, fx, seen, item } = setup()
  s.cursorId = 'a1b'
  fx.setDone(item('a1b'))
  assert.equal(typeof load().find(i => i.id === 'a1b')!.done, 'number')
  assert.equal(s.cursorId, 'b2c', 'the cursor moves on')
  assert.equal(seen.said.at(-1), 'Done: Crash when saving an empty file')
  fx.setCategory(item('b2c'))
  fx.setType(item('b2c'))
  assert.deepEqual(
    (({ cat, type }) => ({ cat, type }))(load().find(i => i.id === 'b2c')!),
    { cat: 'feature', type: 'review' },
  )
  assert.match(logged(), /INFO todo: todo done \{"id":"a1b"\}/)
  assert.match(logged(), /INFO todo: todo category changed \{"id":"b2c","cat":"feature"\}/)
  assert.match(logged(), /INFO todo: todo type changed \{"id":"b2c","type":"review"\}/)
})

test('a store that can’t be written: the error on the status row, a warn in the log', () => {
  const { fx, seen } = setup()
  const { error } = fx.attempt(() => {
    throw new Error('disk full')
  })
  assert.equal((error as Error).message, 'disk full')
  assert.deepEqual(seen.said, ['disk full'])
  assert.match(logged(), /WARN todo: store write failed \{"err":"disk full"\}/)
})

test('refresh asks the tab session for its folder and panes; a failing poll warns once', async () => {
  const tmux = fakeTmux()
  const { s, fx, seen } = setup({ tmux })
  await fx.refresh()
  assert.deepEqual(tmux.calls, [
    ['tmux', '-L', TABS, 'display', '-p', '-t', 'ghostty-1:', '#{pane_current_path}'],
    ['tmux', '-L', TABS, 'list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{start_time}'],
  ])
  assert.deepEqual([...s.panes!.keys()], ['%1', '%5'])
  assert.equal(seen.draws, 1)

  const down = fakeTmux({ display: { ok: false, out: '', err: 'no server running', exit: 1 } })
  const broken = setup({ tmux: down })
  const before = logged().split('active tab unreadable').length
  await broken.fx.refresh()
  await broken.fx.refresh()
  assert.equal(broken.s.here.folder, paths.alpha, 'the folder it was given stands in')
  assert.equal(logged().split('active tab unreadable').length - before, 1, 'logged as it starts, not on every poll')
})

test('tabs tmux can’t read are unknown, not closed: ↵ says so instead of offering a reopen', async () => {
  const tmux = fakeTmux({ 'list-panes': { ok: false, out: '', err: 'lost server', exit: 1 } })
  const { s, fx, seen, item } = setup({ tmux })
  await fx.refresh()
  assert.equal(s.panes, null)
  await fx.goTo(item('e5f'))
  assert.deepEqual(seen.confirms, [])
  assert.deepEqual(seen.said, ["Couldn't read the tab session's tabs; try again"])
  assert.deepEqual(tmux.acted(), [])
})

test('no tmux server on the tab socket means no tabs, so a tab is closed', async () => {
  const tmux = fakeTmux({ 'list-panes': { ok: false, out: '', err: 'no server running on /tmp/tmux-1000/tabs-sock', exit: 1 } })
  const { s, fx, seen, item } = setup({ tmux })
  await fx.refresh()
  assert.deepEqual([...s.panes!], [])
  await fx.goTo(item('e5f'))
  assert.equal(seen.confirms.length, 1, 'offers to reopen it')
})

test('a reopened tab tmux couldn’t type into says so and keeps the old pane', async () => {
  const tmux = fakeTmux({ 'send-keys': { ok: false, out: '', err: "can't find pane: %7", exit: 1 } })
  const { fx, seen, item } = setup({ tmux })
  const was = item('e5f').pane
  await fx.reopen(item('e5f'), paths.beta)
  assert.equal(load().find(i => i.id === 'e5f')!.pane, was)
  assert.equal(seen.said.at(-1), "Opened a tab but couldn't start Claude in it: can't find pane: %7")
  assert.match(logged(), /WARN todo: claude not started \{"id":"e5f","pane":"%7","err":"can't find pane: %7"\}/)
})

test('a second w while the first hand-off is starting doesn’t start a second agent', async () => {
  const spawn = fakeSpawn({ out: 'bg-1234\n' })
  const { s, fx, seen } = setup({ win: false, spawn })
  s.marked.add('a1b')
  const how = { worktree: false, model: 'opus' } as const
  const first = fx.handOff(['a1b'], s.here, how)
  assert.ok(s.handingOff.has('a1b'))
  assert.equal(fx.busy(), true, 'quitting waits for it')
  await fx.handOff(['a1b'], s.here, how)
  assert.equal(seen.said[1], seen.said[0], 'the second says the first is still starting')
  await first
  await fx.settled()
  assert.equal(spawn.calls.length, 1)
  assert.equal(s.handingOff.size, 0)
  assert.equal(s.marked.size, 0)
  assert.equal(fx.busy(), false)
  await tick()
})

const SERVER = '1700000500'
const onServer = () => fakeTmux({ 'list-panes': { ok: true, out: `%1\tghostty-1\t@1\t2\t${SERVER}\n`, err: '', exit: 0 } })

test('a pane id from an earlier tab server is a closed tab, not the pane that has that id now', async () => {
  const { fx, seen, tmux, item } = setup({ tmux: onServer() })
  change('a1b', { paneServer: '1600000000' })
  fx.readStore(true)
  await fx.goTo(item('a1b'))
  assert.deepEqual(tmux.acted(), [], 'not to the stranger in %1')
  assert.equal(seen.confirms.length, 1, 'offers to reopen it')
  await fx.reopen(item('a1b'), paths.alpha)
  const reopened = load().find(i => i.id === 'a1b')!
  assert.deepEqual([reopened.pane, reopened.paneServer], ['%7', SERVER])
})

test('a pane recorded under the running tab server is still its tab', async () => {
  const { fx, seen, tmux, item } = setup({ tmux: onServer() })
  change('a1b', { paneServer: SERVER })
  fx.readStore(true)
  await fx.goTo(item('a1b'))
  assert.deepEqual(seen.confirms, [])
  assert.deepEqual(tmux.acted()[0], ['tmux', '-L', TABS, 'select-window', '-t', 'ghostty-1:@1'])
})

test('a refresh stuck on tmux doesn’t hold back what others write to the store', async () => {
  const tmux = fakeTmux()
  // display never answers, as a wedged server wouldn't.
  const run = async (argv: string[]): Promise<RunResult> => (argv[3] === 'display' ? new Promise<RunResult>(() => {}) : tmux.run(argv))
  const { s, fx } = setup({ tmux: { ...tmux, run } })
  void fx.refresh()
  add({ title: 'Added by an agent', root: paths.alpha, repo: 'alpha' })
  await fx.refresh()
  assert.ok(s.items.some(i => i.title === 'Added by an agent'))
})
