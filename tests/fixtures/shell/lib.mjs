// Paths and helpers the contract tests share for running the shell, Python
// and Node sides inside a sandbox (harness.mjs).

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO } from '../../harness.mjs'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const SCRIPTS = join(REPO, 'hub-plugin', 'skills', 'pr-babysit', 'scripts')
export const LOGGER = join(REPO, 'hub-plugin', 'skills', 'log-watcher', 'scripts')
export const PLASMOID = join(REPO, 'plasmoid', 'dev.dotfiles.agents', 'contents', 'ui')

export const stubDir = box => {
  const bin = join(box.root, 'stub-bin')
  mkdirSync(bin, { recursive: true })
  if (!box.env.PATH.startsWith(`${bin}:`)) box.env.PATH = `${bin}:${box.env.PATH}`
  return bin
}

// A node of its own, since modules like tray.ts read XDG_RUNTIME_DIR as they load.
export function nodeJson(box, code, env = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...box.env, ...env }, encoding: 'utf8', timeout: 15000 })
  if (r.status !== 0) throw new Error(`node failed (${r.status}): ${r.stderr}`)
  return JSON.parse(r.stdout)
}
