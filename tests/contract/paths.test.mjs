// Contract: every bin/ script and viewer/hub module that a config file, a
// script, a hub module, the tray widget or a Claude Code hook names is there,
// and the scripts are executable.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'

import { BIN, CONF, REPO, VIEWER } from '../harness.mjs'

const read = f => readFileSync(f, 'utf8')
// Programs only: bin/lib/ holds sourced helpers of its own.
const scripts = readdirSync(BIN, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name).sort()
const libs = readdirSync(join(BIN, 'lib')).filter(f => f.endsWith('.sh')).sort().map(f => `lib/${f}`)
const executable = f => (statSync(f).mode & 0o111) === 0o111
const exists = f => {
  try {
    statSync(f)
    return true
  } catch {
    return false
  }
}
const uniq = list => [...new Set(list)].sort()

// [where it's named, path under CONF]
function references() {
  const refs = []
  const add = (where, rel) => refs.push([where, rel])
  for (const conf of ['layout.conf', 'tmux.conf'])
    for (const m of read(join(CONF, conf)).matchAll(/#\{@conf\}\/(bin\/[\w.-]+)/g)) add(conf, m[1])
  for (const s of [...scripts, ...libs]) {
    const text = read(join(BIN, s))
    for (const m of text.matchAll(/\$(?:GHOSTTY_CONF|\{GHOSTTY_CONF\}|conf)\/((?:bin|viewer|hub|tray|agents|settings|tui|core)(?:\/[\w.-]+)+)/g))
      add(`bin/${s}`, m[1])
    // ghostty-hub's forever <module>: "$GHOSTTY_CONF/hub/$1".
    for (const m of text.matchAll(/^\s*forever ([\w/.-]+\.ts)/gm)) add(`bin/${s}`, `hub/${m[1]}`)
    // lib/core.sh's popup <client> <w> <h> <border> [-d <dir>] <script>: "$GHOSTTY_CONF/bin/$1".
    for (const m of text.matchAll(/^\s*popup "\$\w+" \S+ \S+ "#[0-9a-f]{6}" (?:-d "\$\w+" )?([\w.-]+)/gm)) add(`bin/${s}`, `bin/${m[1]}`)
    // A file sourced by the path of the script itself.
    for (const m of text.matchAll(/source "\$\(dirname "\$\(readlink -f "\$0"\)"\)\/([\w./-]+)"/g)) add(`bin/${s}`, `bin/${m[1]}`)
  }
  const modules = readdirSync(CONF, { recursive: true })
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('bin/'))
    .map(f => [dirname(f), basename(f)])
  for (const [dir, f] of modules) {
      const text = read(join(CONF, dir, f))
      // core/paths.ts: bin('x') and conf('path').
      for (const m of text.matchAll(/\bbin\('([\w.-]+)'\)/g)) add(`${dir}/${f}`, `bin/${m[1]}`)
      for (const m of text.matchAll(/\bconf\('([\w./-]+)'\)/g)) add(`${dir}/${f}`, m[1])
      for (const m of text.matchAll(/join\((?:CONF|HERE), (?:'\.\.', )?'bin', '([\w.-]+)'\)/g)) add(`${dir}/${f}`, `bin/${m[1]}`)
      for (const m of text.matchAll(/\bpopup\('([\w.-]+)'/g)) add(`${dir}/${f}`, `bin/${m[1]}`)
      for (const m of text.matchAll(/'\.\.\/bin\/([\w.-]+)'/g)) add(`${dir}/${f}`, `bin/${m[1]}`)
      for (const m of text.matchAll(/'\.config\/ghostty\/(bin\/[\w.-]+)'/g)) add(`${dir}/${f}`, m[1])
    }
  for (const m of read(join(CONF, 'config.ghostty')).matchAll(/~\/\.config\/ghostty\/(bin\/[\w.-]+)/g)) add('config.ghostty', m[1])
  const qml = join(REPO, 'plasmoid', 'dev.dotfiles.agents', 'contents', 'ui', 'main.qml')
  for (const m of read(qml).matchAll(/\$HOME\/\.config\/ghostty\/(bin\/[\w.-]+)/g)) add('plasmoid main.qml', m[1])
  const hooks = join(REPO, 'hub-plugin', 'hooks', 'hooks.json')
  for (const m of read(hooks).matchAll(/\$HOME\/\.config\/ghostty\/(bin\/[\w.-]+)/g)) add('hub-plugin hooks.json', m[1])
  return refs
}

const REFS = references()

test('the references found are the ones there are today', () => {
  // If this changes, the scan below still checks the new ones; update the list on purpose.
  assert.deepEqual(uniq(REFS.map(r => r[1])), [
    'agents/agentd.ts',
    'bin',
    'bin/ghostty-approvals',
    'bin/ghostty-backdrop',
    'bin/ghostty-claude-ping',
    'bin/ghostty-claude-start',
    'bin/ghostty-diagrams',
    'bin/ghostty-editor',
    'bin/ghostty-help',
    'bin/ghostty-hub',
    'bin/ghostty-keys',
    'bin/ghostty-lib.sh',
    'bin/ghostty-monitors',
    'bin/ghostty-settings',
    'bin/ghostty-surface',
    'bin/ghostty-tabs',
    'bin/ghostty-term',
    'bin/ghostty-tickets',
    'bin/ghostty-todo',
    'bin/ghostty-todo-panel',
    'bin/ghostty-viewer',
    'bin/ghostty-viewer-toggle',
    'bin/lib/core.sh',
    'bin/lib/layout.sh',
    'bin/lib/log.sh',
    'bin/lib/tabs.sh',
    'core/text.ts',
    'hub/hub.ts',
    'hub/newagent/newagent.ts',
    'hub/rail/rail.ts',
    'settings/keybinds.ts',
    'settings/settings.ts',
    'tray/tray.ts',
    'viewer/diagrams/diagram-view.ts',
    'viewer/diff/diff-view.ts',
    'viewer/help/help-view.ts',
    'viewer/modes.ts',
    'viewer/monitors/monitors-view.ts',
    'viewer/settings/settings-view.ts',
    'viewer/tickets/tickets-view.ts',
    'viewer/todo/todo-view.ts',
  ])
})

test('every referenced file exists, and every referenced bin/ program is executable', () => {
  for (const [where, rel] of REFS) {
    const file = join(CONF, rel)
    assert.ok(exists(file), `${where} names ${rel}, which isn't there`)
    if (rel.startsWith('bin/') && !rel.endsWith('.sh')) assert.ok(executable(file), `${rel} (named in ${where}) isn't executable`)
  }
})

test('every program in bin/ is executable and named somewhere; ghostty-lib.sh is only sourced', () => {
  const named = new Set(REFS.map(r => r[1]))
  for (const s of scripts) {
    assert.ok(named.has(`bin/${s}`), `nothing names bin/${s}`)
    if (s === 'ghostty-lib.sh') assert.equal(executable(join(BIN, s)), false)
    else assert.ok(executable(join(BIN, s)), `bin/${s}`)
  }
})

test('every bin/ script that sources ghostty-lib.sh finds it beside its own real path', () => {
  const sourcing = scripts.filter(s => read(join(BIN, s)).includes('ghostty-lib.sh"'))
  assert.deepEqual(sourcing, [
    'ghostty-approvals',
    'ghostty-backdrop',
    'ghostty-claude-start',
    'ghostty-diagrams',
    'ghostty-editor',
    'ghostty-help',
    'ghostty-hub',
    'ghostty-keys',
    'ghostty-monitors',
    'ghostty-settings',
    'ghostty-surface',
    'ghostty-tabs',
    'ghostty-term',
    'ghostty-tickets',
    'ghostty-todo-panel',
    'ghostty-viewer',
    'ghostty-viewer-toggle',
  ])
  for (const s of sourcing) assert.match(read(join(BIN, s)), /^source "\$\(dirname "\$\(readlink -f "\$0"\)"\)\/ghostty-lib\.sh"$/m)
})

test('the functions the scripts’ node -e calls import are exported', async () => {
  // lib/core.sh's setting: (await import(settings.ts)).get(key)
  assert.equal(typeof (await import(join(CONF, 'settings/settings.ts'))).get, 'function')
  // ghostty-keys: (await import(keybinds.ts)).apply(undefined, { ghostty })
  assert.equal(typeof (await import(join(CONF, 'settings/keybinds.ts'))).apply, 'function')
  assert.match(read(join(BIN, 'lib', 'core.sh')),/\(await import\(process\.argv\[1\]\)\)\.get\(process\.argv\[2\]\)/)
  assert.match(read(join(BIN, 'ghostty-keys')), /\(await import\(process\.argv\[1\]\)\)\.apply\(undefined, \{ ghostty: process\.argv\[2\] !== '--tmux' \}\)/)
  assert.ok(exists(join(VIEWER, 'modes.ts')))
  assert.ok(exists(join(CONF, 'agents/agentd.ts')), 'tray.ts starts agentd.ts beside it')
})
