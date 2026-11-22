import assert from 'node:assert/strict'
import { test } from 'node:test'

import { config, createState, moveCursor, pinEdit } from './state.ts'
import { editPrompt } from './todo-ui.ts'

const argv = (dir?: string): string[] => ['node', 'todo-view.ts', ...(dir ? [dir] : [])]

test('config: the folder, the tab session and its window, and the popup', () => {
  const pane = config({ DV_TABS: 'tabs:ghostty-3' }, argv('/r/dot'), '/cwd')
  assert.deepEqual(
    { dir: pane.dir, tabsSocket: pane.tabsSocket, tabsSession: pane.tabsSession, win: pane.win, popup: pane.popup },
    { dir: '/r/dot', tabsSocket: 'tabs', tabsSession: 'ghostty-3', win: 3, popup: false },
  )
  // Without DV_TABS: the tab socket's own name, no session, no window.
  const alone = config({ AGENT_HUB_TABS_SOCKET: 'sock' }, argv(), '/cwd')
  assert.deepEqual([alone.dir, alone.tabsSocket, alone.tabsSession, alone.win], ['/cwd', 'sock', '', 0])
  assert.equal(config({}, argv(), '/cwd').tabsSocket, 'ghostty')
  // A hub tab session is no layout window.
  assert.equal(config({ DV_TABS: 'tabs:hubtabs-3' }, argv(), '/cwd').win, 0)
})

test('config: the mode tabs in the viewer pane, none in the popup', () => {
  const env = { GV_MODES: 'Files\tTodo', GV_AT: '1', GV_QUIT: '10' }
  const pane = config(env, argv(), '/cwd')
  assert.deepEqual(pane.modes, [{ label: ' Files ', exit: 10 }, { label: ' Todo ', exit: 0 }])
  assert.equal(pane.pane.quit, 10)
  const popup = config({ ...env, TD_POPUP: '1' }, argv(), '/cwd')
  assert.deepEqual(popup.modes, [{ label: ' Todo ', exit: 0 }])
  assert.equal(popup.pane.quit, 0)
})

test('moveCursor walks the list and says whether it moved', () => {
  const s = createState(config({}, argv(), '/cwd'))
  assert.equal(moveCursor(s, 1, []), false)
  const list = [{ id: 'a' }, { id: 'b' }]
  assert.equal(moveCursor(s, 1, list), true)
  assert.equal(s.cursorId, 'b')
  moveCursor(s, -Infinity, list)
  assert.equal(s.cursorId, 'a')
})

test('the edit form keeps the cursor on its item, and closes once the item leaves the list', () => {
  const s = createState(config({}, argv(), '/cwd'))
  const list = [{ id: 'a' }, { id: 'b' }]
  assert.equal(pinEdit(s, list), true, 'nothing to pin with no form open')
  s.prompt = editPrompt({ id: 'b', title: 'b', cat: 'bug', note: '', repo: 'none', root: '' })
  s.cursorId = 'a'
  assert.equal(pinEdit(s, list), true)
  assert.equal(s.cursorId, 'b')
  assert.equal(pinEdit(s, [{ id: 'a' }]), false, 'done or deleted elsewhere')
  assert.equal(s.prompt, null)
})
