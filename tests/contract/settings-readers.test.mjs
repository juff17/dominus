// Contract: every Settings key read outside Node (the bin/ scripts' `setting`,
// popup_opens, the hooks' jq, the tray widget) exists in settings/settings.ts
// with the type and values its reader expects. A script's fallback is used when
// Node can't answer, so it should be the default.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { BIN, CONF, sandbox } from '../harness.mjs'
import { PLASMOID, nodeJson } from '../fixtures/shell/lib.mjs'

const settings = await import(join(CONF, 'settings/settings.ts'))
const read = f => readFileSync(f, 'utf8')
const scripts = readdirSync(BIN).filter(f => statSync(join(BIN, f)).isFile())
const libs = readdirSync(join(BIN, 'lib')).filter(f => f.endsWith('.sh')).sort().map(f => `lib/${f}`)

// [script, key, env var or '', fallback], from lines that aren't comments.
const calls = [...scripts, ...libs].flatMap(s =>
  read(join(BIN, s))
    .split('\n')
    .filter(l => !/^\s*#/.test(l))
    .flatMap(l => [...l.matchAll(/\bsetting ([\w.]+) (''|\w+) ([\w.+-]+)/g)].map(m => [s, m[1], m[2] === "''" ? '' : m[2], m[3]])),
)

test('the shell’s setting calls are these', () => {
  assert.deepEqual(
    calls.map(c => c.join(' ')),
    [
      'ghostty-editor editor.app  code',
      'ghostty-editor editor.window  default',
      'ghostty-editor editor.open  root',
      'ghostty-surface layout.header  true',
      'ghostty-surface layout.sidePanel  true',
      'ghostty-surface workspace.viewerShown  hidden',
      'ghostty-term keys.newTab  ctrl+shift+t',
      'ghostty-viewer-toggle layout.sidePanel  true',
      'lib/layout.sh layout.viewerPercent GHOSTTY_VIEWER_SHARE 30',
      'lib/layout.sh layout.railCols GHOSTTY_RAIL_COLS 6',
      'lib/layout.sh layout.topRows GHOSTTY_TOP_ROWS 10',
    ],
  )
})

const ONOFF = new Set(['layout.header', 'layout.sidePanel'])

test('each key a script reads exists, with the type it uses and its fallback as the default', () => {
  for (const [script, key, , fallback] of calls) {
    const r = settings.row(key)
    assert.ok(r, `${script} reads ${key}, which settings.ts doesn't have`)
    // Sizes go into tmux as numbers (-w N%, -l N), the layout's on/off
    // parts are compared with false, a key is shown as its label, and the
    // rest are compared as words.
    const type = ONOFF.has(key) ? 'bool' : key.startsWith('layout.') ? 'number' : key.startsWith('keys.') ? 'key' : 'choice'
    assert.equal(r.type, type, key)
    assert.equal(String(r.default), fallback, `${script}: ${key}'s fallback`)
  }
})

test('the values the scripts compare a choice with are its choices', () => {
  const values = key => settings.row(key).choices.map(c => c.value)
  const editor = read(join(BIN, 'ghostty-editor'))
  const named = [...editor.matchAll(/\b(\w+)\) name=/g)].map(m => m[1])
  assert.deepEqual(named, ['code', 'zed'])
  assert.deepEqual(values('editor.app'), named)
  assert.match(editor, /^ {2}new\) args=\(-n\) ;;$/m)
  assert.match(editor, /^ {2}reuse\) /m)
  assert.deepEqual(values('editor.window'), ['default', 'new', 'reuse'])
  assert.match(editor, /\[\[ \$open == root \]\]/)
  assert.deepEqual(values('editor.open'), ['root', 'folder'])
  assert.match(read(join(BIN, 'ghostty-surface')), /== shown \]\]/)
  assert.deepEqual(values('workspace.viewerShown'), ['hidden', 'shown'])
})

test('popup_opens is asked about built-in mode ids only', () => {
  const ids = scripts.flatMap(s => [...read(join(BIN, s)).matchAll(/popup_opens (\w+)/g)].map(m => m[1]))
  assert.deepEqual(ids.sort(), ['diagrams', 'todo'])
  for (const id of ids) assert.ok(settings.BUILTIN_MODES.some(m => m.id === id))
})

test('ghostty-claude-ping’s jq reads tray.tabBell with the same default', () => {
  const ping = read(join(BIN, 'ghostty-claude-ping'))
  assert.match(ping, /if has\("tray\.tabBell"\) then \."tray\.tabBell" else true end/)
  assert.equal(settings.row('tray.tabBell').type, 'bool')
  assert.equal(settings.row('tray.tabBell').default, true)
  // The file it reads is settings.ts's.
  assert.match(ping, /settings=\$\{AGENT_HUB_SETTINGS:-\$\{XDG_STATE_HOME:-\$HOME\/\.local\/state\}\/agent-hub\/settings\.json\}/)
})

test('the fetch-before-worktree hook’s jq reads worktree.fetch with the same default', () => {
  const hook = read(join(CONF, '../hub-plugin/hooks/fetch-before-worktree.sh'))
  assert.match(hook, /if has\("worktree\.fetch"\) then \."worktree\.fetch" else true end/)
  assert.equal(settings.row('worktree.fetch').type, 'bool')
  assert.equal(settings.row('worktree.fetch').default, true)
  assert.match(hook, /settings=\$\{AGENT_HUB_SETTINGS:-\$\{XDG_STATE_HOME:-\$HOME\/\.local\/state\}\/agent-hub\/settings\.json\}/)
})

test('tray.ts’s widgetSettings reads keys settings.ts has', () => {
  const tray = read(join(CONF, 'tray/tray.ts'))
  const body = tray.slice(tray.indexOf('export function widgetSettings'), tray.indexOf('const snapshot'))
  const keys = [...new Set([...body.matchAll(/s\['([\w.]+)'\]/g)].map(m => m[1]))]
  assert.ok(keys.length >= 14)
  for (const k of keys) assert.ok(settings.row(k), k)
})

test('every setting("…", fallback) the widget reads is in widgetSettings, with the fallback as its default', () => {
  const qml = readdirSync(PLASMOID)
    .filter(f => f.endsWith('.qml'))
    .flatMap(f => [...read(join(PLASMOID, f)).matchAll(/\bsetting\("(\w+)", ([^)]*?)\)/g)].map(m => [m[1], JSON.parse(m[2])]))
  const box = sandbox('contract-widget')
  let defaults
  try {
    defaults = nodeJson(box, `const t = await import(${JSON.stringify(join(CONF, 'tray/tray.ts'))}); console.log(JSON.stringify(t.widgetSettings()))`)
  } finally {
    box.cleanup()
  }
  assert.deepEqual([...new Set(qml.map(([k]) => k))].sort(), [
    'count',
    'desktop',
    'flashMs',
    'foldDone',
    'inboxHeight',
    'inboxWidth',
    'messageMs',
    'pollMs',
    'quiet',
    'ring',
    'sound',
    'soundBroke',
    'soundFile',
    'soundYou',
  ])
  for (const [k, fallback] of qml) {
    assert.ok(k in defaults, `the widget reads ${k}, which widgetSettings doesn't give`)
    assert.deepEqual(fallback, defaults[k], `${k}: the widget's fallback`)
  }
})
