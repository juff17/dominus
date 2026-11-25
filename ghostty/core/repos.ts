// The git repos under a folder, for whatever has to pick one: the monitors'
// clone search and the repo finder (agents/locate.ts).

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    // Gone, or a broken link.
    return false
  }
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
