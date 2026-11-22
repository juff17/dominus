// Pins client.ts's ensureDaemon, which client.test.ts keeps from running.
//
// Safety: follow() runs in a child process whose environment is a temp
// sandbox: XDG_RUNTIME_DIR (where agentd.pid and state.json live),
// CLAUDE_CONFIG_DIR (an empty one, so the agentd it starts sees no
// sessions), private tmux socket names, and a tmux stub first on PATH. The
// agentd it starts inherits that, which the test checks from
// /proc/<pid>/environ before it stops that agentd and only that one.
//   node --test ghostty/agents/client.pin.test.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLIENT = join(fileURLToPath(new URL('.', import.meta.url)), 'client.ts')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function box() {
  const root = mkdtempSync(join(tmpdir(), 'client-pin-'))
  const bin = join(root, 'bin')
  for (const d of ['bin', 'runtime', 'claude', 'state']) mkdirSync(join(root, d))
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\necho "$@" >> ${join(root, 'tmux.calls')}\n`, { mode: 0o755 })
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    XDG_STATE_HOME: join(root, 'state'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    AGENT_HUB_SETTINGS: join(root, 'state', 'settings.json'),
    AGENT_HUB_TABS_SOCKET: `client-pin-tabs-${process.pid}`,
    GHOSTTY_LAYOUT_SOCKET: `client-pin-layout-${process.pid}`,
  }
  const run = join(root, 'runtime', 'agent-hub')
  // A client that follows for a moment and exits, printing its pid.
  const follow = () =>
    spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `const c = await import(process.argv[1]); c.follow(() => {}); console.log(process.pid); setTimeout(() => process.exit(0), 300)`, CLIENT],
      { env, encoding: 'utf8', timeout: 5000 },
    )
  return { root, env, run, follow, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const environ = (pid: number) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
  } catch {
    return []
  }
}

async function stopAgentd(b: ReturnType<typeof box>, pid: number) {
  if (pid && environ(pid).includes(`XDG_RUNTIME_DIR=${b.env.XDG_RUNTIME_DIR}`)) {
    process.kill(pid, 'SIGTERM')
    for (const end = Date.now() + 3000; environ(pid).length && Date.now() < end; ) await sleep(50)
  }
}

test('a live agentd.pid: follow registers, starts nothing, and its file goes when it exits', async () => {
  const b = box()
  try {
    mkdirSync(b.run, { recursive: true })
    writeFileSync(join(b.run, 'agentd.pid'), String(process.pid))
    const r = b.follow()
    assert.equal(r.status, 0, r.stderr)
    await sleep(500)
    // agentd makes reviewed/ and stopped/ before it even checks the pid file; neither is here.
    assert.deepEqual(readdirSync(b.run).sort(), ['agentd.pid', 'clients'])
    assert.deepEqual(readdirSync(join(b.run, 'clients')), [], 'the client removed its own file')
    assert.equal(readFileSync(join(b.run, 'agentd.pid'), 'utf8'), String(process.pid))
  } finally {
    b.cleanup()
  }
})

const STARTS: [name: string, pidFile: (() => string) | null][] = [
  ['no agentd.pid', null],
  ['a dead pid in agentd.pid', () => String(spawnSync('true').pid)],
]

for (const [name, pidFile] of STARTS) {
  test(`${name}: follow starts agentd, and that agentd is the sandbox’s`, async () => {
    const b = box()
    let pid = 0
    try {
      if (pidFile) {
        mkdirSync(b.run, { recursive: true })
        writeFileSync(join(b.run, 'agentd.pid'), pidFile())
      }
      const before = pidFile ? readFileSync(join(b.run, 'agentd.pid'), 'utf8') : ''
      const r = b.follow()
      assert.equal(r.status, 0, r.stderr)
      for (const end = Date.now() + 5000; Date.now() < end; await sleep(50)) {
        try {
          const now = readFileSync(join(b.run, 'agentd.pid'), 'utf8')
          if (now && now !== before) {
            pid = Number(now)
            break
          }
        } catch {}
      }
      assert.ok(pid > 0, 'agentd took the pid file')
      const env = environ(pid)
      assert.ok(env.includes(`XDG_RUNTIME_DIR=${b.env.XDG_RUNTIME_DIR}`))
      assert.ok(env.includes(`CLAUDE_CONFIG_DIR=${b.env.CLAUDE_CONFIG_DIR}`))
      assert.match(readFileSync(`/proc/${pid}/cmdline`, 'utf8'), /agents\/agentd\.ts/)
      for (const end = Date.now() + 3000; !existsSync(join(b.run, 'state.json')) && Date.now() < end; ) await sleep(50)
      assert.deepEqual(JSON.parse(readFileSync(join(b.run, 'state.json'), 'utf8')).agents, [])
      const calls = readFileSync(join(b.root, 'tmux.calls'), 'utf8').split('\n').filter(Boolean)
      assert.ok(calls.length > 0)
      for (const c of calls) assert.match(c, /^-L client-pin-(tabs|layout)-\d+ /)
    } finally {
      await stopAgentd(b, pid)
      b.cleanup()
    }
  })
}
