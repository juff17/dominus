import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { KEY_ROWS, RESERVED, captured, clash, ghosttyConf, layoutConf, statements, tmuxConf, tmuxKey } from './keybinds.ts'
import { row } from './settings.ts'

const CONF = readFileSync(layoutConf(), 'utf8')
const defaults = () => Object.fromEntries(KEY_ROWS.map(r => [r.key, r.default]))
const bound = (text: string) => text.split('\n').filter(l => l.startsWith('bind -n ')).map(l => l.split(' ')[2])

test('every alt row has its statement in layout.conf, and no default is reserved', () => {
  const all = statements(CONF)
  for (const r of KEY_ROWS.filter(r => r.kind === 'alt')) assert.ok(all.has(tmuxKey(r.default)), r.key)
  for (const r of KEY_ROWS) assert.equal(RESERVED[r.default], undefined, r.key)
})

test('a statement runs over the lines its braces keep open', () => {
  const all = statements('bind -n M-a {\n  one\n  if -F "#{x}" { two }\n}\nbind -n M-b run x\nset -g y')
  assert.equal(all.get('M-a'), 'bind -n M-a {\n  one\n  if -F "#{x}" { two }\n}')
  assert.equal(all.get('M-b'), 'bind -n M-b run x')
})

test('the defaults bind each alt row where layout.conf does', () => {
  assert.deepEqual(bound(tmuxConf(defaults(), CONF)).sort(), KEY_ROWS.filter(r => r.kind === 'alt').map(r => tmuxKey(r.default)).sort())
})

test('a moved key binds the same command at the new key, and an unbound one binds nothing', () => {
  const text = tmuxConf({ ...defaults(), 'keys.help': 'alt+x', 'keys.todo': '' }, CONF)
  const keys = bound(text)
  assert.ok(keys.includes('M-x') && !keys.includes('M-h') && !keys.includes('M-t'))
  assert.match(text, /^bind -n M-x run-shell -b '"#\{@conf\}\/bin\/ghostty-help"/m)
  assert.match(text, /^unbind -q -n M-h$/m)
})

test('an alt key layout.conf binds for something else is never unbound', () => {
  const text = tmuxConf(defaults(), `${CONF}\nbind -n M-q run other\n`)
  assert.doesNotMatch(text, /^unbind -q -n M-q$/m)
  assert.match(text, /^unbind -q -n M-z$/m)
})

test('Ghostty gets lines only for keys moved off their default', () => {
  assert.equal(ghosttyConf(defaults()).split('\n').filter(l => l.startsWith('keybind')).length, 0)
  const lines = ghosttyConf({ ...defaults(), 'keys.newTab': 'ctrl+shift+y', 'keys.closeTab': '' }).split('\n').filter(l => l.startsWith('keybind'))
  assert.deepEqual(lines, ['keybind = ctrl+shift+t=unbind', 'keybind = ctrl+shift+x=unbind', 'keybind = ctrl+shift+y=csi:9001~'])
})

test('a Ghostty row moved onto a default another row gave up stays bound there', () => {
  // Hub comes before New window in KEY_ROWS, so New window's unbind of
  // ctrl+shift+n must not land after Hub's bind of it: in Ghostty the later line wins.
  const lines = ghosttyConf({ ...defaults(), 'keys.newWindow': 'ctrl+shift+m', 'keys.hub': 'ctrl+shift+n' }).split('\n').filter(l => l.startsWith('keybind'))
  const last = (key: string) => lines.findLast(l => l.startsWith(`keybind = ${key}=`))
  assert.equal(last('ctrl+shift+n'), 'keybind = ctrl+shift+n=csi:9007~')
  assert.equal(last('ctrl+shift+m'), 'keybind = ctrl+shift+m=new_window')
  assert.equal(last('ctrl+shift+a'), 'keybind = ctrl+shift+a=unbind')
})

test('a moved key that passes itself through elsewhere passes the new key', () => {
  const text = tmuxConf({ ...defaults(), 'keys.viewer': 'alt+x' }, CONF)
  const viewer = text.slice(text.indexOf('bind -n M-x '))
  assert.match(viewer, /^bind -n M-x if -F "#\{==:#\{window_name\},work\}"/)
  assert.match(viewer, /\{ send-keys M-x \}/)
  assert.doesNotMatch(text, /send-keys M-v\b/)
})

test('a keypress names an alt key with or without alt, and a Ghostty key with or without ctrl', () => {
  const alt = row('keys.help')
  const gh = row('keys.newTab')
  assert.equal(captured(alt, '\x1bx'), 'alt+x')
  assert.equal(captured(alt, 'x'), 'alt+x')
  assert.equal(captured(alt, '\x1bX'), 'alt+x')
  assert.equal(captured(gh, 'y'), 'ctrl+shift+y')
  assert.equal(captured(gh, '\x19'), 'ctrl+shift+y')
  for (const k of ['\x1b[A', '\r', '\t', '-', ' ']) assert.equal(captured(alt, k), null, JSON.stringify(k))
})

test('a key another row or something else has clashes', () => {
  const v = defaults()
  assert.match(clash(row('keys.help'), 'alt+t', v)!, /Todo popup/)
  assert.match(clash(row('keys.help'), 'alt+a', v)!, /Approvals popup/)
  assert.match(clash(row('keys.help'), 'alt+p', v)!, /Claude Code/)
  assert.match(clash(row('keys.newTab'), 'ctrl+shift+c', v)!, /copy/)
  // The layout no longer goes to a tab with Alt+digit, so a row may take one.
  assert.equal(clash(row('keys.help'), 'alt+1', v), null)
  assert.equal(clash(row('keys.help'), 'alt+9', v), null)
  assert.equal(clash(row('keys.help'), 'alt+h', v), null)
  assert.equal(clash(row('keys.help'), 'alt+x', v), null)
  assert.equal(clash(row('keys.help'), '', v), null)
})
