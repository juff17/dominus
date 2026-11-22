// Where a PR's repo is checked out, found from each clone's remotes, since
// pr-babysit runs from the user's clone and makes its worktree there. It
// reads git's config files and folder listings only; it never runs git.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

// github.com/jl/dotfiles: no user, port, scheme or .git, from a URL or
// scp-style remote.
export function remoteKey(url: string): string | null {
  const u = url.trim()
  const scheme = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u)
  const scp = scheme ? null : /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(u)
  const m = scheme ?? scp
  if (!m) return null
  const path = m[2].replace(/\/+$/, '').replace(/\.git$/, '')
  return path ? `${m[1]}/${path}`.toLowerCase() : null
}

// Matches remoteKey's form.
export const repoKey = (host: string, repo: string): string => `${host.replace(/:\d+$/, '')}/${repo}`.toLowerCase()

export const remotesIn = (config: string): string[] => [...config.matchAll(/^\s*url\s*=\s*(.+?)\s*$/gm)].map(m => m[1])

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    // Not there, or not readable: not a clone this can use.
    return null
  }
}
const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    // Gone, or a broken link.
    return false
  }
}

// In a worktree .git is a file naming its git dir, whose commondir leads to
// the main repo's config.
export function gitConfigOf(dir: string): string | null {
  const dotGit = join(dir, '.git')
  if (isDir(dotGit)) return join(dotGit, 'config')
  const pointer = readText(dotGit)?.match(/^gitdir:\s*(.+)$/m)?.[1]
  if (!pointer) return null
  const gitDir = resolve(dir, pointer)
  const common = readText(join(gitDir, 'commondir'))?.trim()
  return join(common ? (isAbsolute(common) ? common : resolve(gitDir, common)) : gitDir, 'config')
}

// A .claude/worktrees/<name> worktree maps to its main repo.
export function repoRootOf(dir: string): string | null {
  for (let d = dir; d && d !== '/'; d = dirname(d)) if (readText(join(d, '.git')) !== null || isDir(join(d, '.git'))) return d.replace(/\/\.claude\/worktrees\/[^/]+$/, '')
  return null
}

const SKIP = new Set(['node_modules', '.git', '.claude', '.cache', 'vendor', 'target', 'dist', 'build'])

// Doesn't descend into a repo (its subfolders aren't other clones). At
// most `limit` folders are read, so a huge tree can't stall the popup.
export function reposUnder(root: string, depth = 3, limit = 4000): string[] {
  const out: string[] = []
  let read = 0
  const walk = (dir: string, left: number): void => {
    if (read++ > limit) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      // Unreadable: skip it.
      return
    }
    if (names.includes('.git')) {
      out.push(dir)
      return
    }
    if (left <= 0) return
    for (const name of names) if (!name.startsWith('.') && !SKIP.has(name) && isDir(join(dir, name))) walk(join(dir, name), left - 1)
  }
  walk(root, depth)
  return out
}

// The clones in `known` win, in their order, then those under ~/projects,
// ~/src, ~/code and ~/work and beside the known ones. A repo cloned twice
// keeps the first.
export function findCheckouts(known: readonly string[], home: string): Map<string, string> {
  const roots = ['projects', 'src', 'code', 'work'].map(d => join(home, d)).filter(isDir)
  const repos = [...new Set(known.map(repoRootOf).filter((d): d is string => Boolean(d)))]
  const beside = [...new Set(repos.map(d => dirname(d)))].filter(d => d !== home && d !== '/')
  const all = [...new Set([...repos, ...roots.flatMap(r => reposUnder(r)), ...beside.flatMap(d => reposUnder(d, 1))])]
  const map = new Map<string, string>()
  for (const dir of all) {
    const config = gitConfigOf(dir)
    const text = config && readText(config)
    if (!text) continue
    for (const url of remotesIn(text)) {
      const key = remoteKey(url)
      if (key && !map.has(key)) map.set(key, dir)
    }
  }
  return map
}

// Must match pr-babysit's SKILL.md.
export const babysitBranch = (n: number): string => `babysit/${n}`
