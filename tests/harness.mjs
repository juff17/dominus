// The sandbox the contract tests and some unit tests run in: a temp folder
// holding home, the XDG folders, settings and tmux socket names, never your own.
//
//   const box = sandbox('contract-py')   // box.env is the environment to run with
//   box.settings({ ... }); box.write('home/x.json', { ... })
//   box.cleanup()

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = join(HERE, '..')
export const CONF = join(REPO, 'ghostty')
export const HUB = join(CONF, 'hub')
export const VIEWER = join(CONF, 'viewer')
export const BIN = join(CONF, 'bin')

let serial = 0

// `env` points $HOME, the XDG folders, settings, temp files and the tmux
// sockets into a temp folder.
export function sandbox(name = 'test') {
  const root = mkdtempSync(join(tmpdir(), `agent-hub-${name}-`))
  const dir = sub => {
    const p = join(root, sub)
    mkdirSync(p, { recursive: true })
    return p
  }
  const home = dir('home')
  const runtime = dir('runtime')
  const state = dir('state')
  const cache = dir('cache')
  const config = dir('config')
  const claude = dir('claude')
  const tag = `${process.pid}-${++serial}`
  const env = {
    HOME: home,
    XDG_RUNTIME_DIR: runtime,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    CLAUDE_CONFIG_DIR: claude,
    AGENT_HUB_SETTINGS: join(state, 'agent-hub', 'settings.json'),
    AGENT_HUB_TABS_SOCKET: `test-tabs-${tag}`,
    GHOSTTY_LAYOUT_SOCKET: `test-layout-${tag}`,
    TODO_FILE: join(state, 'agent-hub', 'todos.json'),
    GHOSTTY_CONF: CONF,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: 'C.UTF-8',
    PATH: process.env.PATH,
    TZ: 'UTC',
    // Temp files and tmux's sockets too, so a test needs no /tmp of its own.
    TMPDIR: dir('tmp'),
    TMUX_TMPDIR: dir('tmux'),
    // Install's copy of .env.example, never the repo's own .env.
    DOMINUS_ENV_FILE: join(root, '.env'),
  }
  mkdirSync(dirname(env.AGENT_HUB_SETTINGS), { recursive: true })
  mkdirSync(dirname(env.TODO_FILE), { recursive: true })
  return {
    root,
    home,
    runtime,
    state,
    cache,
    config,
    claude,
    env,
    write(path, content) {
      const p = path.startsWith('/') ? path : join(root, path)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
      return p
    },
    settings(values) {
      writeFileSync(env.AGENT_HUB_SETTINGS, `${JSON.stringify(values, null, 2)}\n`)
    },
    cleanup() {
      for (const socket of [env.AGENT_HUB_TABS_SOCKET, env.GHOSTTY_LAYOUT_SOCKET])
        spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
      rmSync(root, { recursive: true, force: true })
    },
  }
}
