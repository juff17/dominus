// node --test ghostty/hub/board.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type Focus,
  type ListItem,
  LANES, LANE_GAP, MIN_LANE_ROWS, shownLanes, minBoardCols, MONITOR_ROWS, activeWindow, boardRows, closeQuestion, keptFocus, laneColumns, listItems, listMode,
  listScroll, listSelection, markedPane, nextAfter, nextLane, pickable, selection, shq, step, stepList, tabFocus, trayWindow, visible, where,
} from './board.ts'
import { type Agent, type Monitor, lanes, monitorsOf } from '../agents/model.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { set } from '../settings/settings.ts'

// Its own settings file, so the defaults hold until a test changes one.
process.env.AGENT_HUB_SETTINGS = join(mkdtempSync(join(tmpdir(), 'hub-board-')), 'settings.json')

// Partial agents and monitors, with what the board reads of them.
const agent = (id: string, extra: object = {}) =>
  ({ id, title: id, repo: 'dotfiles', cmd: 'Thinking…', state: 'working', since: 0, monitors: [], ...extra }) as unknown as Agent
const monitor = (key: string, extra: object = {}) =>
  ({ key, task: key, description: `watch ${key}`, state: 'watching', startedAt: 0, ...extra }) as unknown as Monitor
const byId = (x: { id: string }) => x.id
const filledOnly =
  (...lanes_: Focus[]) =>
  (i: Focus) =>
    lanes_.includes(i)
// An item as a word: - a spacer, #lane:count a header, (lane) an empty
// lane's line, else its id.
const word = (x: ListItem) => ('spacer' in x ? '-' : 'group' in x ? `#${x.group}:${x.count}` : 'empty' in x ? `(${x.empty})` : x.id)

test('the filter matches title, repo, command and monitor descriptions, ignoring case', () => {
  const list = [
    agent('a', { title: 'Fix the rail' }),
    agent('b', { repo: 'jstack' }),
    agent('c', { cmd: 'Bash(npm test)' }),
    agent('d', { monitors: [monitor('m', { description: 'PR #12 pipeline' })] }),
  ]
  assert.equal(visible(list, ''), list)
  assert.deepEqual(visible(list, 'RAIL').map(byId), ['a'])
  assert.deepEqual(visible(list, 'jstack').map(byId), ['b'])
  assert.deepEqual(visible(list, 'npm').map(byId), ['c'])
  assert.deepEqual(visible(list, 'pr #12').map(byId), ['d'])
  assert.deepEqual(visible(list, 'nothing like it'), [])
})

test('where: a tab here, another window\'s tab, a hub tab, background or terminal', () => {
  assert.equal(where(agent('a', { pane: { tab: 2, win: 1 } }), 1), 'tab 2')
  assert.equal(where(agent('a', { pane: { tab: 2, win: 3 } }), 1), 'w3 · tab 2')
  assert.equal(where(agent('a', { pane: { tab: 2 } }), 1), 'tab 2')
  assert.equal(where(agent('a', { pane: { tab: 4, win: 1, hub: true } }), 1), 'hub tab 4')
  assert.equal(where(agent('a', { kind: 'bg' }), 1), 'bg')
  assert.equal(where(agent('a', { kind: 'interactive' }), 1), 'terminal')
  assert.equal(where(agent('a', { kind: 'bg', stopped: true }), 1), 'stopped')
})

test('the list shows beside an open session, and on a screen too narrow for lanes', () => {
  assert.equal(listMode(null, minBoardCols()), false)
  assert.equal(listMode(null, minBoardCols() - 1), true)
  assert.equal(listMode({ pane: '%1' }, 300), true)
})

test('selection stays on its card by id as cards move', () => {
  const sel = selection([agent('a'), agent('b'), agent('c')], byId, 'b')
  assert.equal(sel.i, 1)
  assert.equal(sel.item?.id, 'b')
  assert.equal(sel.id, 'b')
  const moved = selection([agent('c'), agent('b')], byId, 'b')
  assert.equal(moved.i, 1)
})

test('selection falls to the first card when its agent disappears', () => {
  const sel = selection([agent('a'), agent('c')], byId, 'b')
  assert.equal(sel.i, 0)
  assert.equal(sel.item?.id, 'a')
  assert.equal(sel.id, 'a')
  assert.equal(selection([agent('a')], byId, null).id, 'a')
})

test('an empty lane keeps the selected id, so the card is selected again when it comes back', () => {
  const sel = selection([], byId, 'b')
  assert.deepEqual([sel.i, sel.item, sel.id], [-1, null, 'b'])
  assert.equal(selection([agent('a'), agent('b')], byId, sel.id).item?.id, 'b')
})

test('monitors are selected by key, not by their agent', () => {
  const list = [monitor('x'), monitor('y')]
  assert.equal(selection(list, m => m.key, 'y').i, 1)
})

test('j/k step within a lane and stop at the ends', () => {
  const list = ['a', 'b', 'c']
  assert.equal(step(list, 0, 1), 'b')
  assert.equal(step(list, 2, 1), 'c')
  assert.equal(step(list, 0, -1), 'a')
  assert.equal(step(list, 1, -1), 'a')
  assert.equal(step([], -1, 1), undefined)
})

test('h/l skip empty lanes and wrap through the monitors strip', () => {
  // Lanes 0 needs, 1 working, 2 done, 3 idle, 4 the monitors strip.
  assert.equal(nextLane(0, 1, filledOnly(0, 2)), 2)
  assert.equal(nextLane(2, 1, filledOnly(0, 2)), 0)
  assert.equal(nextLane(0, -1, filledOnly(0, 3)), 3)
  assert.equal(nextLane(3, 1, filledOnly(3, 4)), 4)
  assert.equal(nextLane(4, 1, filledOnly(1, 4)), 1)
  assert.equal(nextLane(0, -1, filledOnly(0, 4)), 4)
})

test('h/l stay put when no other lane has cards', () => {
  assert.equal(nextLane(1, 1, filledOnly(1)), 1)
  assert.equal(nextLane(1, -1, filledOnly()), 1)
})

test('focus leaves a lane once it empties, for the next one that has cards', () => {
  assert.equal(keptFocus(1, filledOnly(1, 3)), 1)
  assert.equal(keptFocus(1, filledOnly(3)), 3)
  assert.equal(keptFocus(3, filledOnly(0)), 0)
  assert.equal(keptFocus(4, filledOnly(2)), 2)
  assert.equal(keptFocus(2, filledOnly()), 2)
})

test('tab goes to the monitors strip and back to the first lane', () => {
  assert.equal(tabFocus(0, filledOnly(0, 4)), 4)
  assert.equal(tabFocus(2, filledOnly(2, 4)), 4)
  assert.equal(tabFocus(4, filledOnly(0, 4)), 0)
})

test('tab with no monitors keeps focus on the lane', () => {
  assert.equal(tabFocus(2, filledOnly(0, 2)), 2)
  assert.equal(tabFocus(0, filledOnly(0)), 0)
})

test('the list has a group per lane, then the monitors, with an empty line where there are none', () => {
  const working = agent('w')
  const watcher = agent('m', { state: 'idle', monitor: true, monitors: [monitor('k1')] })
  const items = listItems(lanes([working, watcher]), monitorsOf([working, watcher]))
  assert.deepEqual(
    items.map(word),
    ['#needs:0', '(needs)', '-', '#working:1', 'w', '-', '#done:0', '(done)', '-', '#idle:0', '(idle)', '-', '#monitors:1', 'm:k1'],
  )
  const m = pickable(items).find(x => x.id === 'm:k1')
  assert.equal(m?.agent, watcher)
  assert.equal(m?.monitor?.key, 'k1')
  const w = pickable(items).find(x => x.id === 'w')
  assert.equal(w && 'lane' in w ? w.lane : undefined, 'working')
})

test('j/k in the list skip headers and stop at the ends', () => {
  const items = listItems(lanes([agent('a', { state: 'needs' }), agent('b', { state: 'idle' })]), [])
  assert.equal(stepList(items, 'a', 1), 'b')
  assert.equal(stepList(items, 'b', 1), 'b')
  assert.equal(stepList(items, 'a', -1), 'a')
  // A selection that has gone starts again from the top.
  assert.equal(stepList(items, 'gone', 1), 'a')
  assert.equal(stepList(items, 'gone', -1), 'a')
  assert.equal(stepList(listItems(lanes([]), []), null, 1), null)
})

test('closing an agent shows the next in the list, the first after the last', () => {
  const items = listItems(lanes([agent('1', { state: 'done' }), agent('2', { state: 'done' }), agent('3', { state: 'idle' })]), [])
  const all = () => true
  assert.equal(nextAfter(items, '2', all)?.id, '3')
  assert.equal(nextAfter(items, '3', all)?.id, '1')
  // Past what can't open beside the list.
  assert.equal(nextAfter(items, '1', a => a.id !== '2')?.id, '3')
  assert.equal(nextAfter(items, '1', a => a.id === '1'), null)
  assert.equal(nextAfter(listItems(lanes([agent('1', { state: 'done' })]), []), '1', all), null)
  assert.equal(nextAfter(items, 'gone', all), null)
})

test('closing an agent skips its own monitor rows', () => {
  const watcher = agent('m', { state: 'idle', monitor: true, monitors: [monitor('k1')] })
  const items = listItems(lanes([watcher]), monitorsOf([watcher]))
  assert.equal(nextAfter(items, 'm', () => true), null)
})

test('the list keeps its selection, else the open session\'s agent, else the first item', () => {
  const items = listItems(lanes([agent('a', { state: 'needs' }), agent('b', { state: 'done' }), agent('c', { state: 'idle' })]), [])
  assert.equal(listSelection(items, 'c', 'b'), 'c')
  assert.equal(listSelection(items, 'gone', 'b'), 'b')
  assert.equal(listSelection(items, 'gone', 'also gone'), 'a')
  assert.equal(listSelection(items, null, undefined), 'a')
  assert.equal(listSelection(listItems(lanes([]), []), 'a', 'a'), null)
})

test('the list scrolls by rows to keep the selected item in view', () => {
  // Item rows: a header, two agents of two rows, a spacer, a header, an agent.
  // The monitors group after them is left off.
  const items = listItems(lanes([agent('a', { state: 'needs' }), agent('b', { state: 'needs' }), agent('c', { state: 'working' })]), [], ['needs', 'working']).slice(0, 6)
  const heights = [1, 2, 2, 1, 1, 2]
  assert.equal(listScroll(items, heights, 1, 0, 4), 0)
  assert.equal(listScroll(items, heights, 2, 0, 4), 1)
  assert.equal(listScroll(items, heights, 5, 0, 4), 5)
  assert.equal(listScroll(items, heights, 1, 5, 4), 0, 'back up to the first item, its header comes too')
  assert.equal(listScroll(items, heights, -1, 3, 4), 3)
  // A list that shrank under its scroll comes back to its last screenful,
  // with or without a selection, rather than drawing nothing.
  assert.equal(listScroll(items, heights, -1, 30, 4), 5)
  assert.equal(listScroll(items, heights, 1, 30, 4), 0)
  assert.equal(listScroll(items.slice(0, 3), [1, 1, 1], -1, 30, 4), 0)
})

test('scrolling back up to an item shows the empty lanes and headers above it', () => {
  // Needs you, Nothing needs you, a spacer, Working, Nothing working, a spacer, Done, its agent.
  const items = listItems(lanes([agent('d', { state: 'done' })]), [], ['needs', 'working', 'done'])
  const heights = items.map(it => (it.id === undefined ? 1 : 2))
  const sel = items.findIndex(it => it.id === 'd')
  assert.equal(listScroll(items, heights, sel, 6, 4), 5, 'its own header is all that fits')
  assert.equal(listScroll(items, heights, sel, 6, 20), 0, 'with room, every header above it')
})

test('the tray keeps its minimum rows, grows with monitors to a third of the screen', () => {
  assert.deepEqual(boardRows(40, 0), { stripH: 2 + MONITOR_ROWS, laneH: 40 - 4 - 2 - MONITOR_ROWS })
  assert.equal(boardRows(40, 3).stripH, 2 + MONITOR_ROWS)
  assert.equal(boardRows(60, 9).stripH, 2 + 9)
  // A third of 60 is 20, less its header and the row under it.
  assert.equal(boardRows(60, 40).stripH, 2 + 18)
})

test('on a short screen the lanes keep their rows before the tray does', () => {
  const { stripH, laneH } = boardRows(20, 3)
  assert.equal(laneH, MIN_LANE_ROWS)
  assert.equal(stripH, 2 + 4)
  // However short, the tray keeps a row and the lanes six.
  assert.deepEqual(boardRows(10, 3), { stripH: 3, laneH: 6 })
})

test('the four lanes and their gaps fill the width, the last taking the rest', () => {
  for (const W of [96, 97, 120, 203]) {
    const cols = laneColumns(W)
    assert.equal(cols.length, LANES.length)
    assert.equal(cols.reduce((n, c) => n + c.w, 0) + 3 * LANE_GAP, W)
    cols.forEach((c, i) => i && assert.equal(c.x, cols[i - 1].x + cols[i - 1].w + LANE_GAP))
    assert.equal(cols[0].x, 1)
  }
  assert.deepEqual(laneColumns(97).map(c => c.w), [22, 22, 22, 25])
})

test('the tray shows the selected monitor, keeping a row to say how many it hides', () => {
  assert.deepEqual(trayWindow(3, 5, 0), { top: 0, room: 5 })
  assert.deepEqual(trayWindow(8, 5, 0), { top: 0, room: 4 })
  assert.deepEqual(trayWindow(8, 5, 6), { top: 3, room: 4 })
  assert.deepEqual(trayWindow(8, 5, 7), { top: 4, room: 4 })
  assert.deepEqual(trayWindow(0, 5, -1), { top: 0, room: 5 })
})

test('x refuses working and needs-you agents, and ones outside the layout', () => {
  assert.equal(closeQuestion(agent('a', { state: 'working', pane: {} }), 'tab 1').refuse, 'Only Done and Idle agents close from here')
  assert.equal(closeQuestion(agent('a', { state: 'needs', jobId: 'j' }), 'bg').refuse, 'Only Done and Idle agents close from here')
  assert.equal(closeQuestion(agent('a', { state: 'idle' }), 'terminal').refuse, 'a runs outside the layout; close it where it runs')
})

test('x asks to close a tab, stop a background agent, or both for a parked tab', () => {
  const q = (extra: object, place: string) => closeQuestion(agent('fix', { state: 'done', ...extra }), place)
  assert.deepEqual(q({ pane: { window: '@1' } }, 'tab 2'), { how: 'tab', text: 'Close tab 2 (fix)?' })
  assert.deepEqual(q({ jobId: 'j1' }, 'bg'), { how: 'job', text: 'Stop background agent fix? Its conversation is kept.' })
  assert.deepEqual(q({ pane: { window: '@1' }, jobId: 'j1' }, 'tab 2'), {
    how: 'tab+job',
    text: 'Close tab 2 and stop background agent fix? Its conversation is kept.',
  })
})

test('x says how many live monitors closing ends', () => {
  const q = (monitors: Monitor[]) => closeQuestion(agent('fix', { state: 'idle', pane: {}, monitors }), 'tab 1').text
  assert.equal(q([monitor('a', { state: 'ended' })]), 'Close tab 1 (fix)?')
  assert.equal(q([monitor('a'), monitor('b', { state: 'ended' })]), 'Close tab 1 (fix) and its monitor?')
  assert.equal(q([monitor('a'), monitor('b', { state: 'stale' }), monitor('c', { state: 'action' })]), 'Close tab 1 (fix) and its 3 monitors?')
})

test('the hub takes back the pane marked @peek and the tab it shows', () => {
  assert.equal(markedPane('%1 \n%7 1\n%9 '), '%7')
  assert.equal(markedPane('%1 \n%2 0\n'), undefined)
  assert.equal(activeWindow('0 @3\n1 @5\n'), '@5')
  assert.equal(activeWindow('0 @3\n'), null)
  assert.equal(activeWindow(''), null)
})

test('shq quotes for a shell, single quotes included', () => {
  assert.equal(shq('/a b/newagent.mjs'), "'/a b/newagent.mjs'")
  assert.equal(shq(`{"folder":"it's"}`), `'{"folder":"it'\\''s"}'`)
})

test('the board turns into the list below Settings’ narrowest board', () => {
  set('hub.boardCols', 120)
  assert.equal(listMode(null, 119), true)
  assert.equal(listMode(null, 120), false)
  set('hub.boardCols', 96)
})

test('with the Idle lane off, three lanes fill the width and the list has no idle group', () => {
  set('hub.idleLane', false)
  try {
    assert.deepEqual(shownLanes(), ['needs', 'working', 'done'])
    const cols = laneColumns(97)
    assert.equal(cols.length, 3)
    assert.equal(cols.reduce((n, c) => n + c.w, 0) + 2 * LANE_GAP, 97)
    const items = listItems(lanes([agent('a', { state: 'idle' })]), [])
    assert.ok(!items.some(x => 'group' in x && x.group === 'idle'))
  } finally {
    set('hub.idleLane', true)
  }
})
