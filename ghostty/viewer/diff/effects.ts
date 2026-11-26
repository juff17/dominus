// What the Diff mode reads from tmux and git. The runners come in through
// `io`, so tests can hand it fakes.

import { execFile } from 'node:child_process'

import { logger } from '../../core/log.ts'
import { type Runner, run } from '../../core/proc.ts'
import { t } from '../../core/text.ts'
import { type Failing, failing } from '../logging.ts'
import { type CachedCount, type DiffFile, type DiffRow, countUntracked, keepCursor, openAfter, parseDiff, parseNumstat, parseStatus } from './diff.ts'
import { paneFolderArgs } from '../../core/tmux.ts'

const log = logger('diff')

// The empty tree, to diff against in a repository with no commits yet.
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export type GitResult = { code: number; stdout: string; err: string }
export type Git = (args: string[], cwd: string) => Promise<GitResult>
export type DiffWorld = { git: Git; run: Runner }
export type DiffIo = DiffWorld & { draw: () => void }
// The tab session is DV_TABS's socket and session; '' outside the layout.
export type Where = { dir: string; tabsSocket: string; tabsSession: string }

export type DiffState = {
  folder: string
  root: string
  // The repository the list, cursor and open file belong to: another one
  // starts them over, another folder in this one (a cd, another pane) doesn't.
  repo: string
  branch: string
  files: DiffFile[]
  // The list the last status that worked gave. A failed refresh empties
  // files but not this, so coming back from it keeps the cursor on its file
  // and a closed file closed, rather than reading as a first look.
  listed: DiffFile[]
  cursor: number
  // By path so it stays open across refreshes; '' for none.
  openPath: string
  openRows: DiffRow[]
  scroll: number
  // Whether the scroll keeps the cursor on screen; a scroll by hand stops it.
  follow: boolean
  // Shown in place of the list: reading, clean, or why git failed.
  message: string
  // git's last answers, so an unchanged one isn't parsed again.
  lastStatus: string
  lastDiff: string
  lineCounts: Map<string, CachedCount>
}

export type DiffEffects = { refresh: () => Promise<void>; activeFolder: () => Promise<string> }

// No optional locks: a git status every second, hidden pane or not, would
// otherwise take .git/index.lock to refresh the index, and an agent's or the
// user's add, commit or rebase that ran then would fail on the held lock.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }

export const git: Git = (args, cwd) =>
  new Promise(resolve => {
    execFile('git', args, { cwd, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '', err: (stderr ?? '').trim() })
    })
  })

export const world = (): DiffWorld => ({ git, run })

const NOT_A_REPO = /not a git repository/i

// Outside a repository it says so; otherwise git's own first line (a held
// index.lock, a folder safe.directory doesn't trust), so a failure never
// passes for a clean tree.
export const gitTrouble = (err: string): string => {
  const line = (err.split('\n')[0] ?? '').replace(/^(fatal|error): /, '')
  if (NOT_A_REPO.test(line)) return t('diff.notRepo')
  return line ? t('diff.gitFailedWith', { err: line }) : t('diff.gitFailed')
}

export function createState(): DiffState {
  return {
    folder: '',
    root: '',
    repo: '',
    branch: '',
    files: [],
    listed: [],
    cursor: 0,
    openPath: '',
    openRows: [],
    scroll: 0,
    follow: true,
    message: t('diff.reading'),
    lastStatus: '',
    lastDiff: '',
    lineCounts: new Map(),
  }
}

function startOver(s: DiffState): void {
  Object.assign(s, { repo: s.root, files: [], listed: [], cursor: 0, openPath: '', openRows: [], scroll: 0, lastStatus: '', lastDiff: '' })
  s.lineCounts.clear()
}

// The list empties rather than going stale, with the message saying why;
// the next status that works fills it again.
function emptyList(s: DiffState, message: string): void {
  Object.assign(s, { files: [], openRows: [], lastStatus: '', lastDiff: '', message })
}

function takeStatus(s: DiffState, status: string): void {
  // After a failure files is emptied apart from listed: a clean status then
  // still reads as new, so listed stops naming files that are gone, and the
  // next changes open the first file as after a commit.
  if (status === s.lastStatus && s.files === s.listed) return
  const before = s.listed
  const cursorPath = before[s.cursor]?.path
  s.lastStatus = status
  s.files = parseStatus(status)
  s.listed = s.files
  s.cursor = keepCursor(s.files, cursorPath, s.cursor)
  s.openPath = openAfter(s.openPath, before, s.files)
  // A list filling from empty is a new one: draw keeps the scroll while a
  // message shows, so it starts at the top as a clean tree used to leave it.
  if (!before.length) s.scroll = 0
}

// git runs in the repository's root unless told otherwise.
type Reader = {
  s: DiffState
  git: (args: string[], cwd?: string) => Promise<GitResult>
  polls: Failing
}

// A git whose failure leaves the list as if nothing had changed.
async function checked(r: Reader, key: string, args: string[]): Promise<GitResult> {
  const res = await r.git(args)
  if (res.code === 0) r.polls.ok(key)
  else r.polls.failed(key, 'git failed', { cmd: ['git', ...args], path: r.s.root, exit: res.code, err: res.err })
  return res
}

async function readRoot(r: Reader): Promise<boolean> {
  const { s } = r
  const args = ['rev-parse', '--show-toplevel']
  const top = await r.git(args, s.folder)
  if (top.code === 0) {
    r.polls.ok('toplevel')
    s.root = top.stdout.trim()
    return true
  }
  const message = gitTrouble(top.err)
  if (message === t('diff.notRepo')) r.polls.ok('toplevel')
  else r.polls.failed('toplevel', 'git failed', { cmd: ['git', ...args], path: s.folder, exit: top.code, err: top.err })
  s.root = ''
  emptyList(s, message)
  return false
}

const readBranch = async (r: Reader): Promise<string> =>
  (await r.git(['branch', '--show-current'])).stdout.trim() || (await r.git(['rev-parse', '--short', 'HEAD'])).stdout.trim()

const readBase = async (r: Reader): Promise<string> =>
  (await r.git(['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0 ? 'HEAD' : EMPTY_TREE

async function readFiles(r: Reader, base: string): Promise<boolean> {
  const { s } = r
  const listed = await checked(r, 'status', ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (listed.code !== 0) {
    emptyList(s, gitTrouble(listed.err))
    return false
  }
  const numstat = await checked(r, 'numstat', ['diff', base, '--numstat', '-M', '-z'])
  const counts = parseNumstat(numstat.stdout)
  // A tracked file numstat leaves out has no line changed against base: its
  // status line can stay the same (MM with the work tree back at HEAD) and
  // keep the old object, so its counts go to 0. When numstat failed, the
  // last counts stand.
  const none = numstat.code === 0 ? { add: 0, del: 0, binary: false } : {}
  takeStatus(s, listed.stdout)
  for (const file of s.files) if (!file.untracked) Object.assign(file, counts.get(file.path) ?? none)
  countUntracked(s.root, s.files, s.lineCounts)
  s.message = s.files.length === 0 ? t('diff.clean') : ''
  return true
}

async function readDiff(r: Reader, file: DiffFile, base: string): Promise<string> {
  if (file.untracked) {
    // Exits 1 when the files differ, which they always do here.
    const res = await r.git(['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', file.path])
    if (res.code > 1) log.warn('git failed', { cmd: ['git', 'diff', '--no-index', file.path], path: r.s.root, exit: res.code, err: res.err })
    return res.stdout
  }
  const paths = file.old ? [file.path, file.old] : [file.path]
  return (await checked(r, 'diff', ['diff', base, '-M', '--no-color', '--no-ext-diff', '--', ...paths])).stdout
}

async function readOpenDiff(r: Reader, base: string): Promise<void> {
  const { s } = r
  const path = s.openPath
  const open = s.files.find(f => f.path === path)
  const text = open ? await readDiff(r, open, base) : ''
  // Another file opened while git ran: this text is the old one's, and the
  // refresh toggleOpen queued reads the new one.
  if (s.openPath !== path || text === s.lastDiff) return
  s.lastDiff = text
  s.openRows = parseDiff(text)
}

// A call while fn runs makes it run once more after.
function oneAtATime(fn: () => Promise<void>): () => Promise<void> {
  let running = false
  let again = false
  const call = async (): Promise<void> => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      await fn()
    } finally {
      running = false
      if (again) {
        again = false
        void call()
      }
    }
  }
  return call
}

export function diffEffects(s: DiffState, where: Where, io: DiffIo): DiffEffects {
  const { dir, tabsSocket, tabsSession } = where
  // Every refresh runs these, once a second: a failure is logged as it starts.
  const polls = failing(log)
  const r: Reader = { s, git: (args, cwd = s.root) => io.git(args, cwd), polls }

  // When tmux can't say, the folder stays the one before, so a hiccup doesn't
  // jump to dir.
  async function activeFolder(): Promise<string> {
    if (!tabsSession) return dir
    const cmd = ['tmux', '-L', tabsSocket, ...paneFolderArgs(tabsSession)]
    const res = await io.run(cmd)
    if (res.ok) polls.ok('folder')
    else polls.failed('folder', 'active tab unreadable', { cmd, err: res.err })
    return (res.ok && res.out.trim()) || s.folder || dir
  }

  async function readRepo(): Promise<void> {
    s.folder = await activeFolder()
    if (await readRoot(r)) {
      if (s.root !== s.repo) startOver(s)
      s.branch = await readBranch(r)
      const base = await readBase(r)
      if (await readFiles(r, base)) await readOpenDiff(r, base)
    }
    io.draw()
  }

  const refresh = oneAtATime(async () => {
    const debug = log.enabled('debug')
    const started = debug ? performance.now() : 0
    try {
      await readRepo()
    } finally {
      if (debug) log.debug('refresh done', { ms: Math.round(performance.now() - started), files: s.files.length })
    }
  })

  return { refresh, activeFolder }
}
