// The Diff mode's logic, apart from the terminal so it can be tested.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { errorMessage, logger } from '../../core/log.ts'
import { t } from '../../core/text.ts'
import { load as settings } from '../../settings/settings.ts'
import { type ModeTab, tabAt } from '../../tui/chrome.ts'
import { type Tokenizer, tokenizer } from '../../tui/input.ts'
import { head, tail } from '../../tui/line.ts'
import { clampScroll, keepInView } from '../../tui/list.ts'
import { width as cells } from '../../tui/term.ts'
import { tidy } from '../../tui/text.ts'

export { clampScroll }

const log = logger('diff')

// status is git's letter, '?' when untracked; old is the path before a
// rename or copy.
export type DiffFile = {
  path: string
  old?: string
  status: string
  untracked: boolean
  add: number
  del: number
  binary: boolean
}
export type Counts = { add: number; del: number; binary: boolean }
export type LineCount = Omit<Counts, 'del'>
export type DiffRow = { kind: 'hunk' | 'note'; text: string } | { kind: 'add' | 'del' | 'ctx'; num: number; text: string }
// gap is the blank row after the open file's diff.
export type BodyRow = { kind: 'file'; i: number } | { kind: 'diff'; row: DiffRow } | { kind: 'gap' }
export type KeyAction = readonly ['quit'] | readonly ['next'] | readonly ['toggle'] | readonly ['move', number] | readonly ['scroll', number]

export const scrollLines = (): number => settings()['viewer.scrollLines']

// Untracked files past this size aren't read to count their lines.
export const MAX_COUNT_BYTES = 2 * 1024 * 1024

// `git status -z` entries: `XY path`, and for a rename `XY new` then `old`.
// A rename can be in either column: unstaged ones come from `git add -N`.
export function parseStatus(text: string): DiffFile[] {
  const parts = text.split('\0')
  const list: DiffFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    const old = 'RC'.includes(x) || 'RC'.includes(y) ? parts[++i] : undefined
    const untracked = x === '?'
    const status = untracked ? '?' : x === 'U' || y === 'U' ? 'U' : x !== ' ' ? x : y
    list.push({ path, old, status, untracked, add: 0, del: 0, binary: false })
  }
  return list.sort((a, b) => a.path.localeCompare(b.path))
}

// `git diff --name-status -z <from> <to>`: a status letter (R and C with a
// score after it) then the path, or for a rename the old path then the new.
export function parseNameStatus(text: string): DiffFile[] {
  const parts = text.split('\0')
  const list: DiffFile[] = []
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i][0]
    if (!status) continue
    const old = 'RC'.includes(status) ? parts[++i] : undefined
    list.push({ path: parts[++i], old, status, untracked: false, add: 0, del: 0, binary: false })
  }
  return list.filter(f => f.path).sort((a, b) => a.path.localeCompare(b.path))
}

// `git diff --numstat -z`: `add\tdel\tpath`, or for a rename `add\tdel\t`
// then `old` and `new`; a binary file counts `-`.
export function parseNumstat(text: string): Map<string, Counts> {
  const counts = new Map<string, Counts>()
  const parts = text.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const [add, del, path] = parts[i].split('\t')
    if (del === undefined) continue
    const key = path || (i++, parts[++i])
    counts.set(key, { add: Number(add) || 0, del: Number(del) || 0, binary: add === '-' })
  }
  return counts
}

// Untracked files counted per refresh, at most. Each one is a stat every
// second, and a read when it changed, on the event loop: a tree git lists in
// the tens of thousands (node_modules before its .gitignore) would freeze the
// pane. The files past this show no count.
export const MAX_COUNTED = 2000

// One entry a file, replaced when it changes, so a file rewritten every
// second doesn't pile up entries.
export type CachedCount = LineCount & { size: number; mtimeMs: number }

export function countLines(root: string, path: string, cache: Map<string, CachedCount>): LineCount {
  try {
    const full = join(root, path)
    const { size, mtimeMs } = statSync(full)
    const cached = cache.get(path)
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return { add: cached.add, binary: cached.binary }
    if (size > MAX_COUNT_BYTES) {
      cache.delete(path)
      return { add: 0, binary: true }
    }
    const data = readFileSync(full)
    const binary = data.includes(0)
    let lines = 0
    if (!binary) for (const byte of data) if (byte === 10) lines++
    if (!binary && size > 0 && data[size - 1] !== 10) lines++
    cache.set(path, { add: lines, binary, size, mtimeMs })
    return { add: lines, binary }
  } catch (err) {
    // Gone or unreadable since git listed it: it counts nothing until the
    // next status. Asked every second, so only at debug.
    if (log.enabled('debug')) log.debug('line count unread', { path, err: errorMessage(err) })
    return { add: 0, binary: false }
  }
}

export function countUntracked(root: string, files: readonly DiffFile[], cache: Map<string, CachedCount>): void {
  const counted = new Set<string>()
  for (const file of files) {
    if (!file.untracked || counted.size >= MAX_COUNTED) continue
    Object.assign(file, { del: 0, ...countLines(root, file.path, cache) })
    counted.add(file.path)
  }
  for (const path of cache.keys()) if (!counted.has(path)) cache.delete(path)
}

// Lines are numbered as in the new file, or the old one for a removed line.
// A rename git no longer matches comes back as two files, so each file's
// headers end the hunk before them.
export function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of text.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line)
    if (line.startsWith('diff --git ')) {
      inHunk = false
    } else if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      rows.push({ kind: 'hunk', text: line })
    } else if (!inHunk) {
      if (line.startsWith('Binary files')) rows.push({ kind: 'note', text: t('diff.binaryChanged') })
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', num: newLine++, text: line.slice(1) })
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', num: oldLine++, text: line.slice(1) })
    } else if (line.startsWith(' ')) {
      oldLine++
      rows.push({ kind: 'ctx', num: newLine++, text: line.slice(1) })
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'note', text: line.slice(2) })
    }
  }
  return rows
}

// After a new status, the cursor stays on the file it was on, or where it was
// when that file went.
export const keepCursor = (files: readonly Pick<DiffFile, 'path'>[], cursorPath: string | undefined, cursor: number): number => {
  const keep = files.findIndex(f => f.path === cursorPath)
  return keep >= 0 ? keep : Math.min(cursor, Math.max(0, files.length - 1))
}

// The open one stays while it's listed, under its new path when a staged
// rename moved it. The first file opens when the list fills from empty (the
// pane's first look at a repo, or new changes after a commit); otherwise
// none stays none after you closed it.
export function openAfter(openPath: string, before: readonly unknown[], files: readonly Pick<DiffFile, 'path' | 'old'>[]): string {
  // Its own path first: a copy (C) names it as `old` while it's listed too.
  const kept = openPath ? (files.find(f => f.path === openPath) ?? files.find(f => f.old === openPath)) : undefined
  if (kept) return kept.path
  return !before.length && files.length ? files[0].path : ''
}

export function bodyRows(files: readonly Pick<DiffFile, 'path'>[], openPath: string, openRows: readonly DiffRow[]): BodyRow[] {
  const rows: BodyRow[] = []
  files.forEach((file, i) => {
    rows.push({ kind: 'file', i })
    if (file.path === openPath) {
      for (const row of openRows) rows.push({ kind: 'diff', row })
      rows.push({ kind: 'gap' })
    }
  })
  return rows
}

export function followCursor(rows: readonly BodyRow[], cursor: number, scroll: number, height: number): number {
  const at = rows.findIndex(r => r.kind === 'file' && r.i === cursor)
  return at < 0 ? scroll : keepInView(scroll, at, at, height)
}

export function changeWords(files: readonly Pick<DiffFile, 'status'>[]): string {
  const kinds = { modified: 0, new: 0, deleted: 0, renamed: 0, conflicted: 0 }
  for (const f of files) {
    if (f.status === '?' || f.status === 'A') kinds.new++
    else if (f.status === 'D') kinds.deleted++
    else if (f.status === 'R' || f.status === 'C') kinds.renamed++
    else if (f.status === 'U') kinds.conflicted++
    else kinds.modified++
  }
  return Object.entries(kinds)
    .filter(([, n]) => n)
    .map(([kind, n]) => t(`diff.kinds.${kind}`, { n }))
    .join(', ')
}

// inner is never below zero, so a pane narrower than the card draws its
// corners and nothing between rather than throwing.
export const cardSize = (cols: number): { w: number; inner: number } => {
  const w = Math.max(2, cols - 2)
  return { w, inner: Math.max(0, w - 4) }
}

export const addShare = (add: number, del: number, cells: number): number => (add + del ? Math.round((cells * add) / (add + del)) : 0)

// Bars share one scale, square-rooted so one big file doesn't flatten the
// rest: `most` is the square root of the biggest file's change.
export function changeCells(file: Pick<DiffFile, 'add' | 'del'>, most: number, bar: number): [added: number, removed: number, empty: number] {
  const total = file.add + file.del
  const cells = total ? Math.max(1, Math.round((bar * Math.sqrt(total)) / most)) : 0
  const green = addShare(file.add, file.del, cells)
  return [green, cells - green, bar - cells]
}

// The name keeps its end, and the folder goes before the name does.
export function fitPath(path: string, room: number): { dir: string; name: string } {
  const cut = path.lastIndexOf('/') + 1
  let dir = path.slice(0, cut)
  let name = path.slice(cut)
  if (cells(name) > room) name = `…${tail(name, room - 1)}`
  if (cells(dir) + cells(name) > room) dir = dir.length ? `…${tail(dir, room - cells(name) - 1)}` : ''
  return { dir, name }
}

// Exactly w cells, padded or cut. A wide character that would straddle the
// edge goes, and a space fills its place.
export const fit = (text: string, w: number): string => {
  const shown = head(tidy(text), w)
  return shown + ' '.repeat(Math.max(0, w - cells(shown)))
}

// col is counted from 1; -1 when no tab is there.
export const modeAt = (modes: readonly ModeTab[], col: number): number => tabAt(modes, col)

// `quit` goes to Files. `page` is half a screen.
export function keyAction(key: string, page: number): KeyAction | undefined {
  const actions: Record<string, KeyAction> = {
    q: ['quit'],
    '\x03': ['quit'],
    '\t': ['next'],
    j: ['move', 1],
    k: ['move', -1],
    '\x1b[B': ['move', 1],
    '\x1b[A': ['move', -1],
    '\r': ['toggle'],
    o: ['toggle'],
    J: ['scroll', scrollLines()],
    K: ['scroll', -scrollLines()],
    ' ': ['scroll', page],
    '\x04': ['scroll', page],
    '\x15': ['scroll', -page],
    '\x1b[6~': ['scroll', page],
    '\x1b[5~': ['scroll', -page],
    g: ['scroll', -Infinity],
    G: ['scroll', Infinity],
  }
  return Object.hasOwn(actions, key) ? actions[key] : undefined
}

// ESC and the key after it are one key (Alt+key), which Diff doesn't bind,
// so Alt+Q can't quit as q does.
export const parseInput: Tokenizer = tokenizer({ alt: 'any', release: 'released' })
