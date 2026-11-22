// Contract: the keys the parts send each other. Ghostty turns tab keys into
// csi:900N~, layout.conf binds them as user-keys, Settings › Keybinds lists what
// each sends, and layout.conf hands the hub \e[910N~ that hub/keys.ts names.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { CONF, HUB } from '../harness.mjs'

const keys = await import(join(HUB, 'keys.ts'))
const { DIAGRAMS_CLOSE_KEY } = await import(join(CONF, 'core/keys.ts'))
const { SECTIONS } = await import(join(CONF, 'settings/settings.ts'))
const { RESERVED, statements, tmuxKey } = await import(join(CONF, 'settings/keybinds.ts'))

const ghostty = readFileSync(join(CONF, 'config.ghostty'), 'utf8')
const layout = readFileSync(join(CONF, 'layout.conf'), 'utf8')
const tray = readFileSync(join(CONF, 'tray/tray.ts'), 'utf8')
const KEY_ROWS = SECTIONS.find(s => s.id === 'keys').rows.filter(r => r.key)

// config.ghostty's keybind = <key>=<action>, in file order.
const ghosttyBinds = [...ghostty.matchAll(/^keybind = (\S+?)=(\S+)$/gm)].map(m => ({ key: m[1], action: m[2] }))
const userKeys = new Map([...layout.matchAll(/^set -s user-keys\[(\d+)\] "\\e\[(\d+)~"$/gm)].map(m => [Number(m[1]), Number(m[2])]))
// layout.conf's `bind -n UserN …` lines, N → the command.
const userBinds = new Map([...layout.matchAll(/^bind -n User(\d+) (.*)$/gm)].map(m => [Number(m[1]), m[2]]))

test('every csi:900N~ Ghostty sends is a layout.conf user-key, and every user-key is bound', () => {
  const csi = ghosttyBinds.filter(b => b.action.startsWith('csi:'))
  assert.deepEqual(
    csi.map(b => `${b.key}=${b.action}`),
    [
      'ctrl+shift+t=csi:9001~',
      'ctrl+shift+x=csi:9002~',
      'ctrl+tab=csi:9003~',
      'ctrl+shift+tab=csi:9004~',
      'ctrl+shift+arrow_right=csi:9003~',
      'ctrl+shift+arrow_left=csi:9004~',
      'ctrl+shift+page_up=csi:9005~',
      'ctrl+shift+page_down=csi:9006~',
      'ctrl+shift+w=csi:9009~',
      'ctrl+shift+a=csi:9007~',
      'ctrl+shift+b=csi:9008~',
    ],
  )
  // user-keys[i] is \e[900(i+1)~.
  assert.deepEqual([...userKeys], [0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => [i, 9001 + i]))
  for (const b of csi) {
    const code = Number(b.action.match(/^csi:(\d+)~$/)[1])
    const index = [...userKeys].find(([, c]) => c === code)?.[0]
    assert.notEqual(index, undefined, `${b.key} sends ${code}, which layout.conf doesn't name`)
  }
  assert.deepEqual([...userBinds.keys()], [...userKeys.keys()])
})

test('each Ghostty tab key does in tmux what its name says', () => {
  const does = {
    9001: /new-window/,
    9003: /next-window/,
    9004: /previous-window/,
    9005: /swap-window .*:-1"'$/,
    9006: /swap-window .*:\+1"'$/,
  }
  // A background agent's session in the hub has no tabs, and its pane names
  // the agent's folder (@peek_bg, hub/peek.ts): there Ctrl+Shift+T opens a
  // terminal in a popup (bin/ghostty-term); anywhere else, a tab.
  // A session opened before the hub named a folder is known by its command.
  const newTab = /^if -F "#\{\|\|:#\{@peek_bg\},#\{m:\*ghostty-hub attach \*,#\{pane_start_command\}\}\}" \{ run-shell -b '"#\{@conf\}\/bin\/ghostty-term" "#\{client_name\}" "#\{pane_id\}"' \} \{ (.*) \}$/.exec(userBinds.get(0))
  assert.ok(newTab, `User0: ${userBinds.get(0)}`)
  const tabCommand = i => (i === 0 ? newTab[1] : userBinds.get(i))
  for (const [code, want] of Object.entries(does)) {
    const i = Number(code) - 9001
    assert.match(tabCommand(i), want, `User${i}`)
    // The tab server as bin/lib/core.sh names it: a test's $AGENT_HUB_TABS_SOCKET moves it.
    assert.match(tabCommand(i), /^run-shell -b 'tmux -L "\$\{AGENT_HUB_TABS_SOCKET:-ghostty\}" /)
  }
  // Inside the terminal, the tab server's popterm table has the keys: Esc
  // closes it, Ctrl+Shift+T (the same \e[9001~) moves it to a tab.
  const tabsConf = readFileSync(join(CONF, 'tmux.conf'), 'utf8')
  assert.match(tabsConf, /^set -s user-keys\[0\] "\\e\[9001~"$/m)
  assert.match(tabsConf, /^bind -T popterm Escape detach-client$/m)
  assert.match(tabsConf, /^bind -T popterm User0 run-shell -b '"#\{@conf\}\/bin\/ghostty-term" --tab "#\{session_name\}"'$/m)
  const term = readFileSync(join(CONF, 'bin', 'ghostty-term'), 'utf8')
  assert.match(term, /^NEW_TAB=\$'\\e\[9001~'$/m)
  assert.match(term, /key-table popterm/)
  // Close goes through ghostty-tabs --close (close_tab in bin/lib/tabs.sh,
  // which finds the tab server as core.sh does), on the same tab session as
  // the rest, keeping the workspace open from anywhere but the work window.
  assert.match(
    userBinds.get(1),
    /^run-shell -b '"#\{@conf\}\/bin\/ghostty-tabs" --close "#\{\?#\{@peek\},peek-#\{s\/%\/\/:pane_id\},#\{s\/\^layout-\/ghostty-\/:session_name\}\}" "" "#\{\?#\{==:#\{window_name\},work\},,keep\}"'$/,
  )
  // Ctrl+Shift+W the workspace; Ctrl+Shift+A the hub, focusing the session
  // open beside its list, else asking the hub to open one (AGENT_VIEW_KEY).
  assert.equal(userBinds.get(8), 'select-window -t :work')
  assert.match(layout, /^bind -n User6 \{\n {2}select-window -t :hub\n {2}if -F -t :hub "#\{@peek_pane\}" \{\n {4}run -C -t :hub 'select-pane -t "#\{@peek_pane\}"'\n {2}\} \{\n {4}run -C -t :hub 'send-keys [^\n]*-l "\\e\[9106~"'\n {2}\}\n\}$/m)
})

test('Settings › Keybinds’ Ghostty rows send what config.ghostty binds their default key to', () => {
  const rows = KEY_ROWS.filter(r => r.kind === 'ghostty')
  assert.deepEqual(
    rows.map(r => [r.key, r.default, r.run]),
    [
      ['keys.workspace', 'ctrl+shift+w', 'csi:9009~'],
      ['keys.hub', 'ctrl+shift+a', 'csi:9007~'],
      ['keys.board', 'ctrl+shift+b', 'csi:9008~'],
      ['keys.newTab', 'ctrl+shift+t', 'csi:9001~'],
      ['keys.closeTab', 'ctrl+shift+x', 'csi:9002~'],
      ['keys.newWindow', 'ctrl+shift+n', 'new_window'],
    ],
  )
  for (const r of rows) {
    const bound = ghosttyBinds.find(b => b.key === r.default)
    // ctrl+shift+n is Ghostty's own default, so config.ghostty doesn't bind it.
    if (r.key === 'keys.newWindow') assert.equal(bound, undefined)
    else assert.equal(bound?.action, r.run, `${r.key}: config.ghostty binds ${r.default}`)
  }
  // Settings writes the moved ones to keys.local.ghostty, which config.ghostty reads last.
  assert.match(ghostty, /^config-file = \?keys\.local\.ghostty$/m)
  assert.ok(ghostty.indexOf('config-file = ?keys.local.ghostty') > ghostty.lastIndexOf('keybind = '))
})

test('Settings › Keybinds’ alt rows are exactly the M-<letter> keys layout.conf binds', () => {
  const alt = KEY_ROWS.filter(r => r.kind === 'alt')
  assert.deepEqual(
    alt.map(r => [r.key, r.default]),
    [
      ['keys.help', 'alt+h'],
      ['keys.todo', 'alt+t'],
      ['keys.settings', 'alt+s'],
      ['keys.diagrams', 'alt+d'],
      ['keys.approvals', 'alt+a'],
      ['keys.viewer', 'alt+v'],
      ['keys.newAgent', 'alt+n'],
      ['keys.editor', 'alt+e'],
      ['keys.monitors', 'alt+m'],
    ],
  )
  const bound = [...statements(layout).keys()]
  assert.deepEqual(bound, ['M-Left', 'M-Right', 'M-s', 'M-a', 'M-m', 'M-n', 'M-d', 'M-v', 'M-h', 'M-t', 'M-e'])
  // No Alt+digit is the layout's: they reach the program in the pane, and a row may take one.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) assert.equal(RESERVED[`alt+${n}`], undefined)
  assert.deepEqual(
    bound.filter(k => /^M-[a-z]$/.test(k)).sort(),
    alt.map(r => tmuxKey(r.default)).sort(),
  )
  // Each alt row's statement runs the bin/ script its name says.
  const runs = {
    'keys.help': 'ghostty-help',
    'keys.todo': 'ghostty-todo-panel',
    'keys.settings': 'ghostty-settings',
    'keys.diagrams': 'ghostty-diagrams',
    'keys.approvals': 'ghostty-approvals',
    'keys.viewer': 'ghostty-viewer-toggle',
    'keys.editor': 'ghostty-editor',
    'keys.monitors': 'ghostty-monitors',
  }
  const all = statements(layout)
  for (const [key, script] of Object.entries(runs)) assert.match(all.get(tmuxKey(alt.find(r => r.key === key).default)), new RegExp(`#\\{@conf\\}/bin/${script}"`))
  assert.match(all.get('M-n'), /\\e\[9100~/)
})

test('the \\e[910N~ sequences layout.conf sends the hub are hub/keys.ts’s constants', () => {
  const sent = [...new Set([...layout.matchAll(/\\e\[(91\d\d)~/g)].map(m => m[1]))].sort()
  assert.deepEqual(sent, ['9100', '9101', '9103', '9104', '9105', '9106'])
  const esc = code => `\x1b[${code}~`
  assert.equal(keys.NEW_AGENT_KEY, esc(9100))
  assert.equal(keys.PEEK_CLOSING_KEY, esc(9101))
  assert.equal(keys.OPEN_AGENT_KEY, esc(9102))
  assert.equal(keys.DIAGRAMS_KEY, esc(9103))
  assert.equal(DIAGRAMS_CLOSE_KEY, esc(9104))
  assert.equal(keys.EDITOR_KEY, esc(9105))
  assert.equal(keys.AGENT_VIEW_KEY, esc(9106))
  const all = statements(layout)
  assert.match(all.get('M-n'), /9100/)
  assert.match(all.get('M-d'), /9103/)
  assert.match(all.get('M-e'), /9105/)
  // In the diagrams window Alt+D sends dv its close key, never M-d itself.
  assert.match(all.get('M-d'), /\{ send-keys -l "\\e\[9104~" \}/)
  assert.doesNotMatch(all.get('M-d'), /send-keys M-d/)
  assert.match(layout, /^bind -n User7 \{[\s\S]*?\\e\[9101~[\s\S]*?^\}$/m)
  assert.match(layout, /^bind -n C-\] if -F "#\{@peek\}" \{\n {2}run -C 'send-keys -t "#\{@hub\}" -l "\\e\[9101~"'/m)
})

test('the tray sends the hub the OPEN_AGENT_KEY core/keys.ts defines, not a copy', () => {
  const navigate = readFileSync(join(CONF, 'tray', 'navigate.ts'), 'utf8')
  assert.match(navigate, /import \{ OPEN_AGENT_KEY \} from '\.\.\/core\/keys\.ts'/)
  assert.doesNotMatch(tray, /const OPEN_AGENT_KEY =/)
  assert.equal(keys.OPEN_AGENT_KEY, '\x1b[9102~')
})

test('Ghostty’s 900N~ and the hub’s 910N~ ranges don’t overlap', () => {
  const ghosttyCodes = ghosttyBinds.map(b => b.action.match(/^csi:(\d+)~$/)?.[1]).filter(Boolean)
  const hubCodes = [keys.NEW_AGENT_KEY, keys.PEEK_CLOSING_KEY, keys.OPEN_AGENT_KEY, keys.DIAGRAMS_KEY].map(k => k.match(/\[(\d+)~/)[1])
  assert.equal(ghosttyCodes.filter(c => hubCodes.includes(c)).length, 0)
})
