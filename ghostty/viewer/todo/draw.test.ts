// frame() for the main states, compared with golden screens
// (tests/golden/todo/) as tmux would capture them.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// No settings file, so every setting reads as its default.
process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'

import type { State } from './state.ts'
import type { Item } from './todo.ts'

type Paths = { alpha: string; beta: string; gamma: string; home: string }
type Todos = (o: Paths & { now?: number; filing?: boolean }) => { items: Item[] }
const fixture = new URL('../../../tests/fixtures/viewer/todo/items.mjs', import.meta.url).href
const { todos }: { todos: Todos } = await import(fixture)
const { TITLE, frame, paint } = await import('./draw.ts')
const { compose, innerSize, overlayBox } = await import('../../tui/overlay.ts')
const { config, createState } = await import('./state.ts')
const ui = await import('./todo-ui.ts')

const GOLDEN = new URL('../../../tests/golden/todo/', import.meta.url)
const golden = (name: string): string => readFileSync(new URL(`${name}.txt`, GOLDEN), 'utf8')

// What tmux's capture-pane would show of these lines: colours dropped,
// \e[nG moving to column n, text past the edge cut, trailing spaces
// trimmed.
function screen(lines: string[], cols: number): string {
  const text = lines.map(line => {
    const row: string[] = []
    let x = 0
    for (const m of line.matchAll(/\x1b\[(\d*)G|\x1b\[[0-9;?]*[A-Za-z]|([\s\S])/gu)) {
      if (m[1] !== undefined) x = Math.max(1, Number(m[1])) - 1
      else if (m[2] !== undefined) {
        const w = ui.cells(m[2])
        if (x + w <= cols) {
          row[x] = m[2]
          if (w === 2) row[x + 1] = ''
        }
        x += w
      }
    }
    return Array.from(row, c => c ?? ' ').join('').replace(/\s+$/, '')
  })
  return `${text.join('\n')}\n`.replace(/\n+$/, '\n').replace(/\b\d\d:\d\d\b/g, 'HH:MM').replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '⠿')
}

// Local 15:00, so the item done a second before is under "done today".
const now = new Date(2026, 10, 7, 15, 0).getTime()
const paths = { alpha: '/p/alpha', beta: '/p/beta', gamma: '/p/gamma', home: '/h' }

// env is the view's environment; the rest goes into the state.
type StateOptions = Partial<State> & { list?: boolean; filing?: boolean; env?: Record<string, string> }
function state({ list = true, filing = false, env = {}, ...set }: StateOptions = {}): State {
  const s = createState(config(env, ['node', 'todo-view.ts'], paths.alpha))
  s.items = list ? todos({ now, ...paths, filing }).items : []
  s.here = { folder: paths.alpha, root: paths.alpha, repo: 'alpha', worktree: '', branch: 'main' }
  return Object.assign(s, set)
}

const draw = (s: State, cols = 100, rows = 30): string => screen(frame(s, cols, rows, { now }).lines, cols)

// At Settings' default 70% × 75%, with nothing behind it.
function drawPopup(s: State, cols = 100, rows = 30): string {
  const size = { cols, rows }
  const b = overlayBox(size, { w: '70%', h: '75%' })
  const inside = innerSize(b)
  const lines = frame(s, inside.cols, inside.rows, { now }).lines
  return screen(compose([], size, b, { title: TITLE, close: 'alt+t' }, lines), cols)
}

test('an empty list says how to add one', () => {
  assert.equal(draw(state({ list: false }), 100, 16), golden('empty'))
})

test('the fixture list: groups by category, the active repo first, the failed filing on top and open', () => {
  assert.equal(draw(state()), golden('list'))
})

test('an open prompt replaces the status row', () => {
  assert.equal(draw(state({ cursorId: 'a1b', prompt: { kind: 'title', text: '' } })), golden('add-title'))
  const edit = state({ cursorId: 'c3d' })
  edit.prompt = ui.editPrompt(edit.items.find(i => i.id === 'c3d')!, [{ repo: 'alpha', root: paths.alpha }])
  assert.equal(draw(edit), golden('edit-title'))
})

test('marks show on their rows and the status row counts them', () => {
  assert.equal(draw(state({ cursorId: 'c3d', marked: new Set(['a1b', 'b2c']) })), golden('marked'))
})

test('a filing Claude is still on spins, with its card', () => {
  assert.equal(draw(state({ filing: true, cursorId: 'j0k' })), golden('filing'))
})

test('the header: the popup’s frame, or the mode tabs in the viewer pane', () => {
  assert.equal(drawPopup(state({ env: { TD_POPUP: '1' } })), golden('popup'))
  assert.equal(draw(state({ env: { GV_MODES: 'Files\tDiff\tTodo\tDiagrams', GV_AT: '2', GV_QUIT: '10' } })), golden('modes'))
})

test('a note said while a prompt is open shows on the row above it', () => {
  const s = state({ cursorId: 'c3d' })
  s.prompt = ui.editPrompt(s.items.find(i => i.id === 'c3d')!)
  s.said = { text: 'A todo needs a title', color: '#fab387', until: now + 1000 }
  const rows = draw(s).trimEnd().split('\n')
  assert.equal(rows.at(-2), 'A todo needs a title')
  assert.match(rows.at(-1)!, /^ EDIT /)
  s.said.until = now
  assert.doesNotMatch(draw(s), /A todo needs a title/, 'gone once its time is up')
})

test('f outside git calls the scope this repo, not none', () => {
  const s = state({ only: true, list: false, here: { folder: '/h/notes', root: '/h/notes', repo: 'none', worktree: '', branch: '' } })
  const shown = draw(s, 100, 16)
  assert.match(shown, /0 open · this repo/)
  assert.match(shown, /No open todos in this repo\./)
})

test('narrow and wide', () => {
  assert.equal(draw(state({ cursorId: 'a1b' }), 40, 24), golden('narrow'))
  assert.equal(draw(state({ cursorId: 'a1b' }), 200, 30), golden('wide'))
})

test('frame changes nothing in the state, and says what the view keeps', () => {
  const s = state({ scroll: 99 })
  const before = JSON.stringify({ ...s, marked: [...s.marked], panes: [...s.panes!] })
  const f = frame(s, 100, 12, { now })
  assert.equal(JSON.stringify({ ...s, marked: [...s.marked], panes: [...s.panes!] }), before)
  assert.equal(f.cursorId, 'i9j', 'the cursor lands on the first item')
  assert.equal(f.lines.length, 12)
  assert.ok(f.scroll < 99, 'scrolled back into range')
  assert.equal(f.body[f.scroll + 1].item?.id, 'i9j', 'the body rows carry their items, for clicks')
})

test('a todo with images says how many on its card, under its note', () => {
  const s = state({ cursorId: 'a1b' })
  const item = s.items.find(i => i.id === 'a1b')!
  item.images = [
    { n: 1, path: '/s/a.png' },
    { n: 2, path: '/s/b.png' },
  ]
  assert.match(draw(s), /2 images attached/)
  assert.doesNotMatch(draw(state({ cursorId: 'a1b' })), /attached/)
})

test('paint writes each line over its row in one synchronized write', () => {
  assert.equal(paint(['a', 'b']), '\x1b[?2026h\x1b[1;1H\x1b[2Ka\x1b[2;1H\x1b[2Kb\x1b[?2026l')
})
