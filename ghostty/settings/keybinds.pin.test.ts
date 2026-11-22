// Pins keybinds.ts as it is today, past what keybinds.test.ts covers.
//
// Safety: apply() runs tmux source-file on the layout server and sends
// SIGUSR2 to every Ghostty process pgrep finds. Here it runs in a child
// process whose PATH starts with stubs: tmux records its argv, and pgrep
// prints only the pids of two processes this test spawned (one that catches
// SIGUSR2, one that doesn't), so no real tmux or Ghostty is reached. Its
// files go to a temp folder (AGENT_HUB_SETTINGS, XDG_CONFIG_HOME).
//   node --test ghostty/settings/keybinds.pin.test.ts
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { KEY_ROWS, type KeyValues, captured, clash, ghosttyConf, ghosttyFile, layoutConf, statements, tmuxConf, tmuxFile } from './keybinds.ts'
import { row } from './settings.ts'

process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'

const CONF = readFileSync(layoutConf(), 'utf8')
const defaults = () => Object.fromEntries(KEY_ROWS.map(r => [r.key, r.default]))

test('the alt keys layout.conf binds, M-Left and M-Right among them', () => {
  assert.deepEqual(
    [...statements(CONF).keys()].sort(),
    ['M-Left', 'M-Right', 'M-a', 'M-d', 'M-e', 'M-h', 'M-m', 'M-n', 'M-s', 'M-t', 'M-v'],
  )
})

test('for the defaults: a header, every letter and digit unbound, then each alt row bound as layout.conf has it', () => {
  const lines = tmuxConf(defaults(), CONF).split('\n')
  assert.equal(lines[0], '# Written by Settings › Keybinds (settings/keybinds.ts); changes here are overwritten.')
  const unbinds = lines.filter(l => l.startsWith('unbind'))
  // layout.conf binds no Alt+digit, so a server that still has the old tab
  // keys (Alt+1 … Alt+9) loses them too.
  assert.equal(unbinds.length, 36)
  assert.equal(unbinds[0], 'unbind -q -n M-a')
  assert.equal(unbinds.at(-1), 'unbind -q -n M-9')
  const all = statements(CONF)
  const body = lines.slice(37).join('\n')
  assert.equal(body, `${KEY_ROWS.filter(r => r.kind === 'alt').map(r => all.get(`M-${r.default.slice(4)}`)).join('\n')}\n`)
  assert.ok(tmuxConf(defaults(), CONF).endsWith('\n'))
})

test('two rows moved to one key both bind it (clash() is what stops that), the later winning in tmux', () => {
  const text = tmuxConf({ ...defaults(), 'keys.help': 'alt+x', 'keys.todo': 'alt+x' }, CONF)
  assert.equal(text.split('\n').filter(l => l.startsWith('bind -n M-x ')).length, 2)
})

test('a row whose default layout.conf no longer binds binds nothing', () => {
  const text = tmuxConf(defaults(), CONF.replace(/^bind -n M-h .*$/m, ''))
  assert.ok(!text.includes('ghostty-help'))
})

test('Ghostty lines: a moved key unbinds the default and sends the same thing at the new one, every unbind first', () => {
  assert.equal(
    ghosttyConf({ ...defaults(), 'keys.newWindow': 'ctrl+shift+m', 'keys.hub': 'ctrl+shift+y' }),
    [
      '# Written by Settings › Keybinds (settings/keybinds.ts); changes here are overwritten.',
      'keybind = ctrl+shift+a=unbind',
      'keybind = ctrl+shift+n=unbind',
      'keybind = ctrl+shift+y=csi:9007~',
      'keybind = ctrl+shift+m=new_window',
      '',
    ].join('\n'),
  )
  // A value missing from the settings is the default, not a key taken off; '' takes it off.
  assert.equal(ghosttyConf({}), ghosttyConf(defaults()))
  assert.doesNotMatch(ghosttyConf({}), /unbind/)
  assert.match(ghosttyConf({ ...defaults(), 'keys.board': '' }), /^keybind = ctrl\+shift\+b=unbind$/m)
  assert.equal(tmuxConf({}, CONF), tmuxConf(defaults(), CONF))
})

test('the tmux file sits beside the settings file; Ghostty’s under XDG_CONFIG_HOME/ghostty', () => {
  const was = [process.env.AGENT_HUB_SETTINGS, process.env.XDG_CONFIG_HOME]
  try {
    process.env.AGENT_HUB_SETTINGS = '/x/state/agent-hub/settings.json'
    process.env.XDG_CONFIG_HOME = '/x/config'
    assert.equal(tmuxFile(), '/x/state/agent-hub/keys.tmux.conf')
    assert.equal(ghosttyFile(), '/x/config/ghostty/keys.local.ghostty')
  } finally {
    ;[process.env.AGENT_HUB_SETTINGS, process.env.XDG_CONFIG_HOME] = was
  }
})

test('captured: a lone ctrl key on an alt row, and two-byte keys that aren’t alt, name nothing', () => {
  const alt = row('keys.help')
  const gh = row('keys.newTab')
  assert.equal(captured(alt, '\x01'), null)
  assert.equal(captured(gh, '\x01'), 'ctrl+shift+a')
  assert.equal(captured(gh, 'Y'), 'ctrl+shift+y')
  assert.equal(captured(alt, '7'), 'alt+7')
  assert.equal(captured(alt, 'ab'), null)
  assert.equal(captured(gh, '\x1bn'), 'ctrl+shift+n')
})

test('clash: a Ghostty row against another Ghostty row, and a reserved key on any row', () => {
  const v = defaults()
  assert.equal(clash(row('keys.newTab'), 'ctrl+shift+x', v), `ctrl+shift+x is taken by ${row('keys.closeTab').label}`)
  assert.equal(clash(row('keys.newTab'), 'ctrl+shift+w', v), `ctrl+shift+w is taken by ${row('keys.workspace').label}`)
  assert.equal(clash(row('keys.newTab'), 'ctrl+shift+t', v), null)
  assert.equal(clash(row('keys.help'), 'alt+b', v), 'alt+b is taken by the shell (word back)')
  // Rows of the other kind never clash: an alt row is only checked against alt rows.
  assert.equal(clash(row('keys.help'), 'ctrl+shift+a', v), null)
  assert.equal(clash(row('keys.help'), 'alt+t', v), `alt+t is taken by ${row('keys.todo').label}`)
})

test('apply writes both files, sources the tmux one on the layout socket, and signals only Ghosttys that catch SIGUSR2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keybinds-pin-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const got = join(dir, 'got-usr2')
  const catcher = spawn(process.execPath, ['-e', `process.on('SIGUSR2', () => { require('fs').writeFileSync(${JSON.stringify(got)}, 'yes'); process.exit(0) }); setInterval(() => {}, 1000)`], { stdio: 'ignore' })
  const plain = spawn('sleep', ['60'], { stdio: 'ignore' })
  try {
    const caught = (pid: number | undefined) => {
      const m = /^SigCgt:\s*([0-9a-f]+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
      return m && (BigInt(`0x${m[1]}`) >> 11n) & 1n
    }
    for (const end = Date.now() + 3000; !caught(catcher.pid) && Date.now() < end; ) await new Promise(r => setTimeout(r, 20))
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\necho "$@" >> ${join(dir, 'tmux.calls')}\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'pgrep'), `#!/bin/sh\necho "$@" >> ${join(dir, 'pgrep.calls')}\necho ${catcher.pid}\necho ${plain.pid}\n`, { mode: 0o755 })
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      AGENT_HUB_SETTINGS: join(dir, 'state', 'settings.json'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      GHOSTTY_LAYOUT_SOCKET: 'keybinds-pin-layout',
    }
    const keybinds = join(fileURLToPath(new URL('.', import.meta.url)), 'keybinds.ts')
    const apply = (values: KeyValues) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', `(await import(process.argv[1])).apply(JSON.parse(process.argv[2]))`, keybinds, JSON.stringify(values)], {
        env,
        encoding: 'utf8',
      })
    // Only your own Ghosttys: another user's would refuse the signal.
    const pgrepCall = `-u ${process.getuid?.()} -x ghostty\n`
    const moved = { ...defaults(), 'keys.newTab': 'ctrl+shift+y' }
    const r = apply(moved)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(join(dir, 'state', 'keys.tmux.conf'), 'utf8'), tmuxConf(moved, CONF))
    assert.equal(readFileSync(join(dir, 'config', 'ghostty', 'keys.local.ghostty'), 'utf8'), ghosttyConf(moved))
    assert.equal(readFileSync(join(dir, 'tmux.calls'), 'utf8'), `-L keybinds-pin-layout source-file ${join(dir, 'state', 'keys.tmux.conf')}\n`)
    assert.equal(readFileSync(join(dir, 'pgrep.calls'), 'utf8'), pgrepCall)
    for (const end = Date.now() + 3000; !existsSync(got) && Date.now() < end; ) await new Promise(r => setTimeout(r, 20))
    assert.equal(readFileSync(got, 'utf8'), 'yes')
    assert.equal(plain.exitCode, null, 'the one that doesn’t catch SIGUSR2 is left alone')
    // The same values again: the Ghostty file is unchanged, so no pgrep and no signal.
    assert.equal(apply(moved).status, 0)
    assert.equal(readFileSync(join(dir, 'pgrep.calls'), 'utf8'), pgrepCall)
    assert.equal(readFileSync(join(dir, 'tmux.calls'), 'utf8').split('\n').filter(Boolean).length, 2)
  } finally {
    catcher.kill('SIGKILL')
    plain.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply logs a tmux that refuses the file, but not one with no layout server yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keybinds-pin-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  try {
    // pgrep finds no Ghostty, so nothing is signalled.
    writeFileSync(join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const keybinds = join(fileURLToPath(new URL('.', import.meta.url)), 'keybinds.ts')
    const logs = join(dir, 'logs')
    const apply = (stderr: string) => {
      writeFileSync(join(bin, 'tmux'), `#!/bin/sh\necho '${stderr}' >&2\nexit 1\n`, { mode: 0o755 })
      return spawnSync(process.execPath, ['--input-type=module', '-e', `(await import(process.argv[1])).apply({}, { ghostty: false })`, keybinds], {
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, AGENT_HUB_SETTINGS: join(dir, 'state', 'settings.json'), AGENT_HUB_LOG_DIR: logs },
        encoding: 'utf8',
      })
    }
    const sourced = () => (existsSync(join(logs, 'settings.log')) ? readFileSync(join(logs, 'settings.log'), 'utf8') : '')
    assert.equal(apply('no server running on /tmp/tmux-1000/ghostty-layout').status, 0)
    assert.doesNotMatch(sourced(), /keys not sourced/)
    const r = apply('keys.tmux.conf:3: unknown command: bnid')
    assert.equal(r.status, 0, r.stderr)
    assert.match(sourced(), /ERROR settings: keys not sourced \{.*"exit":1.*"err":"keys\.tmux\.conf:3: unknown command: bnid"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
