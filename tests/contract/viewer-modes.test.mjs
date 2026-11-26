// Contract: bin/ghostty-viewer and viewer/modes.ts agree on how a mode asks to
// switch (exit FIRST_EXIT + i for mode i), the env a mode gets (GV_MODES, GV_AT,
// GV_QUIT), the mode ids and order, and what `modes.ts list | start | popup` print.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { BIN, CONF, VIEWER, sandbox } from '../harness.mjs'

const modes = await import(join(VIEWER, 'modes.ts'))
const settings = await import(join(CONF, 'settings/catalog.ts'))
const viewer = readFileSync(join(BIN, 'ghostty-viewer'), 'utf8')
const yaziInit = readFileSync(join(CONF, 'yazi', 'init.lua'), 'utf8')

test('ghostty-viewer’s FIRST_EXIT is modes.ts’s', () => {
  assert.equal(modes.FIRST_EXIT, 10)
  assert.equal(Number(viewer.match(/^FIRST_EXIT=(\d+)$/m)?.[1]), modes.FIRST_EXIT)
})

test('the built-in modes, in order, and a case arm in ghostty-viewer for each', () => {
  assert.deepEqual(
    settings.BUILTIN_MODES.map(m => [m.id, m.name]),
    [
      ['files', 'Files'],
      ['diff', 'Diff'],
      ['todo', 'Todo'],
      ['diagrams', 'Diagrams'],
    ],
  )
  const loop = viewer.slice(viewer.indexOf('  case $mode in\n    files)\n      rm -f'))
  const arms = [...loop.matchAll(/^ {4}([a-z*]+)\)$/gm)].map(m => m[1])
  assert.deepEqual(arms, ['files', 'diff', 'todo', 'diagrams', '*'])
  assert.match(viewer, /^gv="\$conf\/viewer\/diff\/diff-view\.ts"$/m)
  assert.match(viewer, /^tv="\$conf\/viewer\/todo\/todo-view\.ts"$/m)
  assert.match(viewer, /^dv="\$conf\/viewer\/diagrams\/diagram-view\.ts"$/m)
  assert.deepEqual(
    settings.row('workspace.startMode').choices.map(c => c.value),
    ['first', ...settings.BUILTIN_MODES.map(m => m.id)],
  )
})

test('ghostty-viewer’s next_code and paneModes’ next agree for every count and position', () => {
  assert.match(viewer, /next_code=\$\(\(count > 1 \? FIRST_EXIT \+ \(at \+ 1\) % count : 0\)\)/)
  for (let count = 1; count <= 5; count++)
    for (let at = 0; at < count; at++) {
      const names = Array.from({ length: count }, (_, i) => `M${i}`)
      const pane = modes.paneModes('x', { GV_MODES: names.join('\t'), GV_AT: String(at), GV_QUIT: '0' })
      const nextCode = count > 1 ? modes.FIRST_EXIT + ((at + 1) % count) : 0
      assert.equal(pane.next, nextCode, `count ${count} at ${at}`)
      for (let i = 0; i < count; i++) assert.equal(pane.exitOf(i), i === at ? 0 : modes.FIRST_EXIT + i)
    }
  // Out of range or missing: the view runs alone and switches nowhere.
  assert.equal(modes.paneModes('Diff', { GV_MODES: 'Files\tDiff', GV_AT: '2' }).alone, true)
  assert.equal(modes.paneModes('Diff', {}).alone, true)
})

test('ghostty-viewer exports GV_MODES (names joined by tabs), GV_AT and GV_QUIT; yazi reads GV_MODES, GV_AT and GV_NEXT_MARK', () => {
  assert.match(viewer, /export GV_MODES GV_AT=\$at GV_QUIT=\$quit_code/)
  assert.match(viewer, /IFS=\$'\\t'\n\s+echo "\$\{names\[\*\]\}"/)
  assert.match(viewer, /GV_NEXT_MARK="\$next_mark" yazi/)
  assert.match(viewer, /code=\$\(\(FIRST_EXIT \+ \$\(<"\$next_mark"\)\)\)/)
  assert.match(yaziInit, /os\.getenv\("GV_AT"\)/)
  assert.match(yaziInit, /string\.gmatch\(os\.getenv\("GV_MODES"\) or "Files", "\[\^\\t\]\+"\)/)
  // yazi leaves the 0-based index of the tab clicked.
  assert.match(yaziInit, /os\.getenv\("GV_NEXT_MARK"\)[\s\S]*f:write\(tostring\(i - 1\)\)/)
  // Tab clears that index before it quits, so a click whose quit was called
  // off can't steer a later Tab.
  const keymap = readFileSync(join(CONF, 'yazi', 'keymap.toml'), 'utf8')
  assert.match(keymap, /on = "<Tab>"\nrun = "plugin gv-next"/)
  const next = readFileSync(join(CONF, 'yazi', 'plugins', 'gv-next.yazi', 'main.lua'), 'utf8')
  assert.match(next, /os\.getenv\("GV_NEXT_MARK"\)[\s\S]*os\.remove\(mark\)[\s\S]*ya\.emit\("quit", \{\}\)/)
})

const cli = (box, ...args) => spawnSync(process.execPath, [join(VIEWER, 'modes.ts'), ...args], { env: box.env, encoding: 'utf8' })

test('modes.ts list | start | popup print what ghostty-viewer and ghostty-lib.sh read', () => {
  const box = sandbox('contract-modes')
  try {
    assert.equal(cli(box, 'list').stdout, 'files\tFiles\t\ndiff\tDiff\t\ntodo\tTodo\t\ndiagrams\tDiagrams\t\n')
    assert.equal(cli(box, 'start').stdout, 'files\n')
    assert.equal(cli(box, 'popup', 'todo').stdout, 'on\n')
    box.settings({
      'workspace.modes': [
        { id: 'diagrams', on: true },
        { id: 'x-logs', on: true, name: 'Logs', cmd: 'tail -f log' },
        { id: 'files', on: false },
        { id: 'diff', on: true },
        { id: 'todo', on: false },
      ],
      'workspace.startMode': 'files',
      'workspace.popupsWhenOff': 'off',
    })
    // ghostty-viewer reads these with IFS=$'\t' read -r id name cmd.
    assert.equal(cli(box, 'list').stdout, 'diagrams\tDiagrams\t\nx-logs\tLogs\ttail -f log\ndiff\tDiff\t\n')
    // Files is off, so the first one on.
    assert.equal(cli(box, 'start').stdout, 'diagrams\n')
    // popup_opens reads a plain "off" as off and anything else, a crash too, as on.
    assert.equal(cli(box, 'popup', 'todo').stdout, 'off\n')
    assert.equal(cli(box, 'popup', 'todo').status, 0)
    assert.equal(cli(box, 'popup', 'diagrams').stdout, 'on\n')
    const bad = cli(box, 'nonsense')
    assert.equal(bad.status, 2)
  } finally {
    box.cleanup()
  }
})
