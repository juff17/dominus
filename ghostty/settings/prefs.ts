// The folders New agent offers as recent. Questions you said not to ask
// again are settings now; settings.ts reads the old prefs.json they were
// kept in. The file is passed in, so tests can use their own.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import { errorMessage, logger } from '../core/log.ts'
import { load as settings } from './settings.ts'

const log = logger('prefs')

export type StorePaths = { recents: string }
export type AgentFolder = { cwd: string }

// Recents are a cache, so they live under XDG's cache folder.
export function storePaths(env: Record<string, string | undefined> = process.env, home = homedir()): StorePaths {
  return { recents: join(env.XDG_CACHE_HOME || join(home, '.cache'), 'agent-hub', 'recents.json') }
}

// A broken file reads as none; remember writes a new one.
function savedRecents(file: string): string[] {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(v) ? v.filter((p: unknown): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

// A worktree counts as its repo. Only whole paths: a relative one, which
// older forms could save, means nothing out of the folder it was typed in,
// so it's dropped and the next save loses it.
function lastUsed(file: string, agents: readonly AgentFolder[], home: string): string[] {
  const roots = agents.map(a => a.cwd.match(/^(.*)\/\.claude\/worktrees\//)?.[1] ?? a.cwd)
  return [...new Set([...savedRecents(file), ...roots])].filter(p => p && p !== home && isAbsolute(p))
}

// z.sh's ranks from ~/.z (path|rank|time a line), aged the way z.sh ages
// them, so a folder you cd into often and lately scores highest.
export function frecency(home: string, now = Date.now() / 1000, file = process.env._Z_DATA || join(home, '.z')): Map<string, number> {
  const scores = new Map<string, number>()
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // No z.sh data: nothing ranks.
    return scores
  }
  for (const line of text.split('\n')) {
    const [path, rank, time] = line.split('|')
    if (!path || !rank || !time || !Number.isFinite(+rank) || !Number.isFinite(+time)) continue
    const age = now - +time
    const weight = age < 3600 ? 4 : age < 86400 ? 2 : age < 604800 ? 0.5 : 0.25
    scores.set(path, +rank * weight)
  }
  return scores
}

// A worktree's repo is its main repo.
export function repoRoot(dir: string): string | null {
  for (let d = dir; d && d !== '/'; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d.replace(/\/\.claude\/worktrees\/[^/]+$/, '')
    // dirname('.') is '.': a relative path stops where it can't go up,
    // rather than looping for ever.
    if (dirname(d) === d) break
  }
  return null
}

// The folder you last started an agent in stays first, and z's top folders
// are added.
function byFrecency(list: string[], scores: Map<string, number>, home: string): string[] {
  if (!scores.size) return list
  const top = [...scores]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([p]) => p)
  const [first, ...rest] = [...new Set([...list, ...top])].filter(p => p !== home)
  const score = (p: string) => scores.get(p) ?? 0
  // Stable for ties, so folders z doesn't know keep their last-used order.
  rest.sort((a, b) => score(b) - score(a))
  return first ? [first, ...rest] : []
}

export function recents(file: string, agents: readonly AgentFolder[], home: string): string[] {
  const s = settings()
  let list = lastUsed(file, agents, home)
  if (s['newAgent.rankBy'] === 'frecency') list = byFrecency(list, frecency(home), home)
  if (s['newAgent.gitOnly']) list = [...new Set(list.map(repoRoot).filter((p): p is string => Boolean(p)))].filter(p => p !== home)
  return list.slice(0, s['newAgent.recent'])
}

// A failed write only loses the ordering.
export function remember(file: string, dir: string, agents: readonly AgentFolder[], home: string): void {
  const list = [...(isAbsolute(dir) ? [dir] : []), ...lastUsed(file, agents, home).filter(d => d !== dir)].slice(0, 12)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(list))
  } catch (e) {
    log.warn('recents not saved', { path: file, err: errorMessage(e) })
  }
}
