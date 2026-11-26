import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import type { RunResult } from '../../core/proc.ts'

const logs = mkdtempSync(join(tmpdir(), 'dv-effects-'))
process.env.AGENT_HUB_LOG_DIR = logs
process.env.AGENT_HUB_SETTINGS = join(logs, 'settings.json')

const { diagramEffects } = await import('./effects.ts')
const { config, createState } = await import('./state.ts')

const logged = () => {
  try {
    return readFileSync(join(logs, 'diagrams.log'), 'utf8')
  } catch {
    return ''
  }
}

const ok = (out: string): RunResult => ({ ok: true, out, err: '', exit: 0 })
const failed = (err: string): RunResult => ({ ok: false, out: '', err, exit: 1 })

const diagram = (title: string) => ({ id: title, title, file: `/png/${title}.png`, width: 800, height: 600 })

// dv with its cache in a temp folder and a fake tmux answering from `answer`.
function setup(t: TestContext, env: NodeJS.ProcessEnv = {}, answer: (args: string[]) => RunResult = () => ok('')) {
  const cache = mkdtempSync(join(tmpdir(), 'dv-cache-'))
  t.after(() => rmSync(cache, { recursive: true, force: true }))
  const s = createState(config({ ...env, XDG_CACHE_HOME: cache }))
  mkdirSync(s.config.panes, { recursive: true })
  const runs: string[][] = []
  const said: string[] = []
  let draws = 0
  const fx = diagramEffects(s, {
    run: args => {
      runs.push(args)
      return answer(args)
    },
    schedule: () => draws++,
    say: text => said.push(text),
  })
  const write = (name: string, json: unknown) => writeFileSync(join(s.config.panes, name), JSON.stringify(json))
  return { s, fx, runs, said, write, draws: () => draws }
}

test('alone, it shows the pane file written last and jumps to its current diagram', t => {
  const { s, fx, write, draws } = setup(t)
  write('a-1.json', { session: 's', diagrams: [diagram('one'), diagram('two')], current: 1 })
  fx.readState()
  assert.equal(s.paneFile, join(s.config.panes, 'a-1.json'))
  assert.equal(s.index, 1)
  assert.deepEqual(s.view, { zoom: 1, cx: 400, cy: 300 })
  assert.equal(draws(), 1)
})

test('DV_TABS asks tmux for the active tab and shows its pane file, titled by it', t => {
  const { s, fx, runs, write } = setup(t, { DV_TABS: 'sock:ghostty-1' }, () => ok('%5\tdotfiles\t2\tzsh\n'))
  write('sock-5.json', { diagrams: [diagram('one')], current: 0 })
  fx.readState()
  assert.deepEqual(runs, [['tmux', '-L', 'sock', 'display', '-p', '-t', 'ghostty-1:', '#{pane_id}\t#{b:pane_current_path}\t#{window_index}\t#{window_name}']])
  assert.equal(s.paneFile, join(s.config.panes, 'sock-5.json'))
  assert.equal(s.tabTitle, 'dotfiles · 2:zsh')
  assert.equal(s.list.diagrams.length, 1)
})

test('DV_JOB shows the background job’s file, titled by DV_TITLE, without asking tmux', t => {
  const { s, fx, runs, write } = setup(t, { DV_JOB: 'ab12cd34', DV_TITLE: 'fix the hub' })
  write('job-ab12cd34.json', { diagrams: [diagram('one')], current: 0 })
  write('sock-5.json', { diagrams: [diagram('two')], current: 0 })
  fx.readState()
  assert.deepEqual(runs, [])
  assert.equal(s.paneFile, join(s.config.panes, 'job-ab12cd34.json'))
  assert.equal(s.tabTitle, 'fix the hub')
  assert.equal(s.gone, false)
  assert.deepEqual(s.list.diagrams.map(d => d.title), ['one'])
})

test('a followed tab tmux can’t find is gone, and the failure is logged once', t => {
  const { s, fx } = setup(t, { DV_PANE: 'lay:%7' }, () => failed("can't find pane: %7"))
  fx.readState()
  fx.readState()
  assert.equal(s.gone, true)
  assert.deepEqual(s.list.diagrams, [])
  assert.equal(logged().split('\n').filter(l => l.includes('followed tab unreadable') && l.includes('%7')).length, 1)
})

test('a pane file that isn’t JSON, or isn’t a pane file, keeps the list it had', t => {
  const { s, fx, write } = setup(t)
  write('a-1.json', { diagrams: [diagram('one')], current: 0 })
  fx.readState()
  writeFileSync(s.paneFile, '{"diagrams": [')
  fx.readState()
  write('a-1.json', { diagrams: [{ title: 'no file' }] })
  fx.readState()
  assert.deepEqual(
    s.list.diagrams.map(d => d.title),
    ['one'],
  )
  assert.match(logged(), /WARN diagrams: pane file unreadable .*not a pane file/)
})

test('closing a tab rewrites the pane file, keeping what dv doesn’t read', t => {
  const { s, fx, write } = setup(t)
  write('a-1.json', { session: 's', diagrams: [diagram('one'), diagram('two')], current: 0 })
  fx.readState()
  fx.closeTab(0)
  const saved = JSON.parse(readFileSync(s.paneFile, 'utf8'))
  assert.deepEqual(saved, { session: 's', diagrams: [diagram('two')], current: 0 })
  assert.equal(s.list.diagrams.length, 1)
})

test('a pane file it can’t write keeps the diagram and says why', t => {
  const { s, fx, write, said } = setup(t)
  write('a-1.json', { diagrams: [diagram('one')], current: 0 })
  fx.readState()
  // Something else holds the name the new file is written under.
  mkdirSync(`${s.paneFile}.${process.pid}.tmp`)
  fx.closeTab(0)
  assert.equal(s.list.diagrams.length, 1)
  assert.equal(said.length, 1)
  assert.match(said[0] ?? '', /EISDIR/)
  assert.match(logged(), /ERROR diagrams: pane file not written/)
})

test('a close keeps a diagram the mod added since dv last read the file', t => {
  const { s, fx, write } = setup(t)
  write('a-1.json', { session: 's', diagrams: [diagram('one'), diagram('two')], current: 1 })
  fx.readState()
  // The mod's write, whose change event hasn't reached dv yet.
  write('a-1.json', { session: 's', diagrams: [diagram('one'), diagram('two'), diagram('three')], current: 2 })
  fx.closeTab(0)
  const saved = JSON.parse(readFileSync(s.paneFile, 'utf8'))
  assert.deepEqual(
    saved.diagrams.map((d: { title: string }) => d.title),
    ['two', 'three'],
  )
  // The one showing stays showing.
  assert.equal(saved.current, 0)
  assert.equal(s.list.diagrams.length, 2)
})

test('a close doesn’t bring back a pane file the mod removed as its session ended', t => {
  const { s, fx, write } = setup(t)
  write('a-1.json', { session: 's', diagrams: [diagram('one'), diagram('two')], current: 0 })
  fx.readState()
  rmSync(s.paneFile)
  fx.closeTab(0)
  assert.equal(existsSync(s.paneFile), false)
  assert.match(logged(), /WARN diagrams: diagram not closed/)
})

test('another tab’s file read half-written shows none, not the last tab’s list, and a close writes nothing', t => {
  let pane = '%1'
  const { s, fx, write } = setup(t, { DV_TABS: 'sock:ghostty-1' }, () => ok(`${pane}\tdir\t1\tzsh\n`))
  write('sock-1.json', { session: 'p', diagrams: [diagram('one')], current: 0 })
  fx.readState()
  pane = '%2'
  writeFileSync(join(s.config.panes, 'sock-2.json'), '{"diagrams": [')
  fx.readState()
  assert.equal(s.paneFile, join(s.config.panes, 'sock-2.json'))
  assert.deepEqual(s.list.diagrams, [])
  fx.closeTab(0)
  assert.equal(readFileSync(s.paneFile, 'utf8'), '{"diagrams": [')
  // Once it reads whole, it's the switch: its current diagram shows.
  write('sock-2.json', { session: 'q', diagrams: [diagram('a'), diagram('b')], current: 1 })
  fx.readState()
  assert.equal(s.index, 1)
})

test('the backdrop is the window’s panes from the layout’s tmux; a failure leaves it blank', t => {
  const answer = (args: string[]) => (args.includes('list-panes') ? ok('%1 0 0 3 1\n%2 4 0 3 1\n') : ok(args.at(-1) === '%1' ? 'abc\n' : 'xyz\n'))
  const { s, fx, runs } = setup(t, { DV_FRAME: '1', OV_UNDER: '@5' }, answer)
  fx.captureBackdrop({ cols: 7, rows: 1 })
  assert.equal(runs.length, 3)
  assert.deepEqual(
    s.backdrop.map(r => r.join('')),
    ['abc│xyz'],
  )
  const down = setup(t, { DV_FRAME: '1', OV_UNDER: '@5' }, () => failed('no window'))
  down.fx.captureBackdrop({ cols: 7, rows: 1 })
  assert.deepEqual(down.s.backdrop, [])
})
