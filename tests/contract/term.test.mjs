// Contract: Ctrl+Shift+T in a background agent's session (bin/ghostty-term)
// gives each agent one terminal, kept by its job id. It is made once, shown
// again after Esc hides it, and once it's a workspace tab the popup shows
// that tab rather than a new shell. The tab server is a real tmux on the
// sandbox's socket, and the popup's client a real one in a pane there; the
// layout server is a stub that records what it was asked and answers as a
// hub pane running `ghostty-hub attach <job>` would.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { BIN, CONF, sandbox } from '../harness.mjs'
import { stubDir } from '../fixtures/shell/lib.mjs'

const realTmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim()
const skip = realTmux ? false : 'tmux is not installed'

// Only the layout socket is stubbed; every other tmux is the real one.
const TMUX = `#!/bin/sh
if [ "$2" != "$GHOSTTY_LAYOUT_SOCKET" ]; then exec ${realTmux} "$@"; fi
shift 4
echo "$*" >> "$LAYOUT_LOG"
case "$*" in
  *client_session*) echo "layout-$STUB_WIN" ;;
  *pane_start_command*) echo "ghostty-hub attach $STUB_JOB" ;;
esac
exit 0
`

let box, dir, log
const tabs = (...args) => {
  const r = spawnSync(realTmux, ['-L', box.env.AGENT_HUB_TABS_SOCKET, '-f', join(CONF, 'tmux.conf'), ...args], { env: box.env, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}
// "<session> <active>" for each session holding the window.
const windowsOf = id =>
  (tabs('list-windows', '-a', '-F', '#{window_id} #{session_name} #{window_active}') ?? '')
    .split('\n')
    .filter(l => l.startsWith(`${id} `))
    .map(l => l.split(' ').slice(1).join(' '))
    .sort()
const layoutCalls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
function until(what, ok) {
  for (let i = 0; i < 100; i++) {
    if (ok()) return
    sleep(50)
  }
  assert.fail(`timed out waiting for ${what}`)
}

function term(args, win = 1, job = 'job-1') {
  const r = spawnSync('bash', [join(BIN, 'ghostty-term'), ...args], {
    env: { ...box.env, LAYOUT_LOG: log, STUB_WIN: String(win), STUB_JOB: job },
    encoding: 'utf8',
    timeout: 20000,
  })
  const logged = join(box.env.AGENT_HUB_LOG_DIR, 'term.log')
  assert.equal(r.status, 0, `${r.stderr}${existsSync(logged) ? readFileSync(logged, 'utf8') : ''}`)
}
const press = (win, job) => term(['client-1', '%5'], win, job)

// What the popup runs, in a pane of a session of its own, then Esc
// (detach-client). A session made detached needs destroy-unattached off in
// the same command, or the tab server ends it at once.
const attached = name => tabs('display', '-p', '-t', `=${name}:`, '#{session_attached}')
function popup(name, whileOpen = () => {}) {
  const cmd = `env AGENT_HUB_TABS_SOCKET=${box.env.AGENT_HUB_TABS_SOCKET} bash ${join(BIN, 'ghostty-term')} --attach ${name}`
  assert.notEqual(tabs('new-session', '-d', '-s', 'popup', '-x', '100', '-y', '30', cmd, ';', 'set', '-t', '=popup:', 'destroy-unattached', 'off'), null)
  until('the popup to attach', () => attached(name) === '1')
  whileOpen()
  tabs('detach-client', '-s', `=${name}`)
  until('the popup to close', () => tabs('has-session', '-t', '=popup') === null)
}

before(() => {
  if (skip) return
  box = sandbox('term')
  box.env.AGENT_HUB_LOG_DIR = join(box.root, 'logs')
  box.env.SHELL = '/bin/sh'
  log = join(box.root, 'layout.log')
  chmodSync(box.write(join(stubDir(box), 'tmux'), TMUX), 0o755)
  dir = join(box.home, 'repo')
  mkdirSync(dir)
  box.write(join(box.runtime, 'agent-hub', 'state.json'), { agents: [{ jobId: 'job-1', cwd: dir }] })
  // Two windows' workspaces, without the Ghostty window each would have attached.
  for (const n of [1, 2]) tabs('new-session', '-d', '-s', `ghostty-${n}`, ';', 'set', '-t', `=ghostty-${n}:`, 'destroy-unattached', 'off')
})
after(() => box?.cleanup())

let wid
test('the first Ctrl+Shift+T makes the agent’s terminal in its folder, and Esc only hides it', { skip }, () => {
  press()
  wid = tabs('display', '-p', '-t', '=term-job-1:', '#{window_id}')
  assert.match(wid ?? '', /^@\d+$/)
  assert.equal(tabs('display', '-p', '-t', '=term-job-1:', '#{@term_agent}|#{@term_win}|#{session_path}'), `job-1|1|${dir}`)
  assert.equal(tabs('show', '-v', '-t', '=term-job-1:', 'key-table'), 'popterm')
  const calls = layoutCalls()
  assert.match(calls, /display-popup .*-T {2}Terminal · ~\/repo · esc hides it · ctrl\+shift\+t moves it to a new tab .*ghostty-term --attach term-job-1 $/m)
  // Nothing is attached once the popup is gone, so the key is read again.
  assert.match(calls, /^set -su user-keys\[0\]$/m)
  assert.match(calls.trim().split('\n').at(-1), /^set -s user-keys\[0\] /)
  popup('term-job-1')
  assert.deepEqual(windowsOf(wid), ['term-job-1 1'])
  assert.equal(attached('term-job-1'), '0')
})

test('Ctrl+Shift+T on the same agent shows the same terminal, not a new one', { skip }, () => {
  press()
  assert.deepEqual(windowsOf(wid), ['term-job-1 1'])
  assert.equal((tabs('list-sessions', '-F', '#{session_name}') ?? '').split('\n').filter(s => s.startsWith('term-')).length, 1)
})

test('another agent has a terminal of its own', { skip }, () => {
  press(1, 'job-2')
  const other = tabs('display', '-p', '-t', '=term-job-2:', '#{window_id}')
  assert.ok(other && other !== wid)
  tabs('kill-session', '-t', '=term-job-2')
})

test('Ctrl+Shift+T in the popup makes it a tab of this window’s workspace', { skip }, () => {
  term(['--tab', 'term-job-1'])
  assert.deepEqual(windowsOf(wid), ['ghostty-1 1'])
  assert.equal(tabs('has-session', '-t', '=term-job-1'), null)
  assert.match(layoutCalls(), /^select-window -t =layout-1:work$/m)
})

test('once it’s a tab, Ctrl+Shift+T on the agent shows that tab, and closing the popup leaves it there', { skip }, () => {
  press()
  assert.deepEqual(windowsOf(wid), ['ghostty-1 1', 'term-job-1 1'])
  assert.equal(tabs('display', '-p', '-t', '=term-job-1:', '#{session_windows}'), '1')
  assert.match(layoutCalls(), /-T {2}Terminal · ~\/repo · esc hides it · ctrl\+shift\+t goes to its tab /)
  popup('term-job-1', () => assert.equal(tabs('show', '-v', '-t', '=term-job-1:', 'destroy-unattached'), ''))
  until('the link to go', () => tabs('has-session', '-t', '=term-job-1') === null)
  assert.deepEqual(windowsOf(wid), ['ghostty-1 1'])
  // Ctrl+Shift+T in it goes to the tab it already is.
  press()
  tabs('select-window', '-t', '=ghostty-1:1')
  term(['--tab', 'term-job-1'])
  assert.deepEqual(windowsOf(wid), ['ghostty-1 1'])
  assert.equal(tabs('has-session', '-t', '=term-job-1'), null)
})

test('from another window, Ctrl+Shift+T in the popup brings the tab there, keeping its old workspace open', { skip }, () => {
  press(2)
  term(['--tab', 'term-job-1'], 2)
  assert.deepEqual(windowsOf(wid), ['ghostty-2 1'])
  assert.equal(tabs('display', '-p', '-t', '=ghostty-1:', '#{session_windows}'), '1')
  // Now the only tab of window 2: taking it back to window 1 leaves window 2 a new one.
  const first = tabs('list-windows', '-t', '=ghostty-2', '-F', '#{window_id}').split('\n').find(w => w !== wid)
  tabs('kill-window', '-t', first)
  press(1)
  term(['--tab', 'term-job-1'], 1)
  assert.deepEqual(windowsOf(wid), ['ghostty-1 1'])
  assert.equal(tabs('display', '-p', '-t', '=ghostty-2:', '#{session_windows}'), '1')
})
