import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { RunResult } from '../../core/proc.ts'
import type { GitResult } from './effects.ts'

const logs = mkdtempSync(join(tmpdir(), 'diff-effects-'))
process.env.AGENT_HUB_LOG_DIR = logs

const { EMPTY_TREE, createState, diffEffects, git: realGit, gitTrouble } = await import('./effects.ts')

const logged = () => {
  try {
    return readFileSync(join(logs, 'diff.log'), 'utf8')
  } catch {
    return ''
  }
}

// git answering from `answers` by its first argument or two; anything else
// works and prints nothing. Records [cwd, ...args].
type Answers = Record<string, Partial<GitResult>>

function fakeGit(answers: Answers) {
  const calls: string[][] = []
  const git = async (args: string[], cwd: string): Promise<GitResult> => {
    calls.push([cwd, ...args])
    const answer = answers[args.slice(0, 2).join(' ')] ?? answers[args[0]]
    return { code: 0, stdout: '', err: '', ...answer }
  }
  return { git, calls }
}

const REPO: Answers = {
  'rev-parse --show-toplevel': { stdout: '/r/dot\n' },
  'branch --show-current': { stdout: 'main\n' },
  'rev-parse --verify': { code: 0 },
  status: { stdout: ' M a.txt\0 M b.txt\0' },
  'diff HEAD': { stdout: '1\t1\ta.txt\0' },
}

function setup(answers = REPO, { tabs = '', tmux = { ok: true, out: '/r/dot/sub\n', err: '', exit: 0 } as RunResult } = {}) {
  const s = createState()
  const git = fakeGit(answers)
  const runs: string[][] = []
  let draws = 0
  const where = { dir: '/start', tabsSocket: tabs && 'sock', tabsSession: tabs }
  const fx = diffEffects(s, where, {
    git: git.git,
    run: async (argv: string[]) => {
      runs.push(argv)
      return tmux
    },
    draw: () => draws++,
  })
  return { s, fx, git, runs, draws: () => draws }
}

test('a refresh reads the repo, its status and counts, and opens the first file', async () => {
  const { s, fx, git, draws } = setup()
  await fx.refresh()
  assert.deepEqual(git.calls, [
    ['/start', 'rev-parse', '--show-toplevel'],
    ['/r/dot', 'branch', '--show-current'],
    ['/r/dot', 'rev-parse', '--verify', '--quiet', 'HEAD'],
    ['/r/dot', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    ['/r/dot', 'diff', 'HEAD', '--numstat', '-M', '-z'],
    ['/r/dot', 'diff', 'HEAD', '-M', '--no-color', '--no-ext-diff', '--', 'a.txt'],
  ])
  assert.deepEqual(s.files.map(f => f.path), ['a.txt', 'b.txt'])
  assert.equal(s.openPath, 'a.txt')
  assert.equal(s.root, '/r/dot')
  assert.equal(s.branch, 'main')
  assert.equal(s.message, '')
  assert.equal(draws(), 1)
})

test('in a layout window the folder is the active tab’s', async () => {
  const { fx, git, runs } = setup(REPO, { tabs: 'ghostty-1' })
  await fx.refresh()
  assert.deepEqual(runs, [['tmux', '-L', 'sock', 'display', '-p', '-t', 'ghostty-1:', '#{pane_current_path}']])
  assert.equal(git.calls[0][0], '/r/dot/sub')
})

test('with no commits it diffs against the empty tree; with no branch it shows the commit', async () => {
  const { fx, git } = setup({ ...REPO, 'branch --show-current': { stdout: '' }, 'rev-parse --short': { stdout: 'abc1234\n' }, 'rev-parse --verify': { code: 1 } })
  await fx.refresh()
  assert.deepEqual(git.calls[2], ['/r/dot', 'rev-parse', '--short', 'HEAD'])
  assert.deepEqual(git.calls[5], ['/r/dot', 'diff', EMPTY_TREE, '--numstat', '-M', '-z'])
})

test('outside git it says so and runs nothing more', async () => {
  const { s, fx, git } = setup({ 'rev-parse --show-toplevel': { code: 128, err: 'fatal: not a git repository (or any of the parent directories): .git' } })
  await fx.refresh()
  assert.equal(git.calls.length, 1)
  assert.equal(s.message, 'Not a git repository')
  assert.equal(s.root, '')
})

test('a refresh asked for during one runs once it ends', async () => {
  const { fx, git } = setup()
  await Promise.all([fx.refresh(), fx.refresh(), fx.refresh()])
  await new Promise(r => setTimeout(r, 10))
  assert.equal(git.calls.filter(c => c[1] === 'status').length, 2)
})

test('a git status that keeps failing says why, and warns once', async () => {
  const { s, fx } = setup({ ...REPO, status: { code: 128, err: 'fatal: index file corrupt' } })
  await fx.refresh()
  await fx.refresh()
  assert.equal(s.message, 'git failed: index file corrupt', 'never read as a clean tree')
  assert.deepEqual(s.files, [])
  assert.equal(logged().split('\n').filter(l => l.includes('git failed') && l.includes('index file corrupt')).length, 1)
})

test('a held index.lock shows git’s error, and the list comes back once status works', async () => {
  const lock = "fatal: Unable to create '/r/dot/.git/index.lock': File exists.\n\nAnother git process seems to be running"
  const answers: Answers = { ...REPO, status: { code: 128, err: lock } }
  const { s, fx } = setup(answers)
  await fx.refresh()
  assert.equal(s.message, "git failed: Unable to create '/r/dot/.git/index.lock': File exists.")
  answers.status = REPO.status
  await fx.refresh()
  assert.equal(s.message, '')
  assert.deepEqual(s.files.map(f => f.path), ['a.txt', 'b.txt'])
})

test('a repository git won’t trust (safe.directory) says so, not that it isn’t one', async () => {
  const err = "fatal: detected dubious ownership in repository at '/r/dot'\nTo add an exception for this directory, call:"
  const { s, fx } = setup({ 'rev-parse --show-toplevel': { code: 128, err } })
  await fx.refresh()
  assert.equal(s.message, "git failed: detected dubious ownership in repository at '/r/dot'")
  assert.equal(s.root, '')
  assert.match(logged(), /WARN diff: git failed .*dubious ownership/)
})

test('git runs with optional locks off, so its status never holds index.lock against a commit', async () => {
  // A shell alias prints the environment git hands its children.
  const res = await realGit(['-c', 'alias.locks=!printf %s "$GIT_OPTIONAL_LOCKS"', 'locks'], tmpdir())
  assert.equal(res.code, 0)
  assert.equal(res.stdout, '0')
})

test('after a commit the open file closes, and the next changes open the first file', async () => {
  const answers: Answers = { ...REPO }
  const { s, fx } = setup(answers)
  await fx.refresh()
  assert.equal(s.openPath, 'a.txt')
  answers.status = { stdout: '' }
  await fx.refresh()
  assert.equal(s.openPath, '')
  answers.status = { stdout: ' M c.txt\0 M d.txt\0' }
  await fx.refresh()
  assert.equal(s.openPath, 'c.txt')
})

test('another folder in the same repository keeps the cursor and the open file', async () => {
  const tmux = { ok: true, out: '/r/dot\n', err: '', exit: 0 }
  const { s, fx, git } = setup(REPO, { tabs: 'ghostty-1', tmux })
  await fx.refresh()
  s.cursor = 1
  s.openPath = 'b.txt'
  tmux.out = '/r/dot/sub\n'
  await fx.refresh()
  assert.equal(git.calls.filter(c => c[1] === 'rev-parse' && c[2] === '--show-toplevel').at(-1)?.[0], '/r/dot/sub')
  assert.equal(s.cursor, 1)
  assert.equal(s.openPath, 'b.txt')
})

test('another repository starts over', async () => {
  const answers: Answers = { ...REPO }
  const { s, fx } = setup(answers)
  await fx.refresh()
  s.cursor = 1
  s.openPath = 'b.txt'
  answers['rev-parse --show-toplevel'] = { stdout: '/r/other\n' }
  await fx.refresh()
  assert.equal(s.cursor, 0)
  assert.equal(s.openPath, 'a.txt', 'a first look at it')
})

test('a failed status in between keeps a closed file closed and the cursor on its file', async () => {
  const answers: Answers = { ...REPO, status: { stdout: ' M a.txt\0 M b.txt\0 M c.txt\0' } }
  const { s, fx } = setup(answers)
  await fx.refresh()
  s.openPath = ''
  s.cursor = 2
  answers.status = { code: 128, err: 'fatal: index file corrupt' }
  await fx.refresh()
  assert.equal(s.files.length, 0)
  answers.status = { stdout: ' M a.txt\0 M a2.txt\0 M b.txt\0 M c.txt\0' }
  await fx.refresh()
  assert.equal(s.openPath, '', 'still closed')
  assert.equal(s.files[s.cursor].path, 'c.txt')
})

test('a failed status, then a clean tree: the next changes open the first file', async () => {
  const answers: Answers = { ...REPO }
  const { s, fx } = setup(answers)
  await fx.refresh()
  answers.status = { code: 128, err: 'fatal: index file corrupt' }
  await fx.refresh()
  answers.status = { stdout: '' }
  await fx.refresh()
  assert.equal(s.message, 'No uncommitted changes')
  answers.status = { stdout: ' M c.txt\0' }
  await fx.refresh()
  assert.equal(s.openPath, 'c.txt')
})

test('a file opened while git reads the old one’s diff doesn’t get the old diff', async () => {
  const s = createState()
  const { git } = fakeGit(REPO)
  // The user opens b.txt while git diffs a.txt.
  const slow = async (args: string[], cwd: string): Promise<GitResult> => {
    if (args.includes('--no-color')) {
      s.openPath = 'b.txt'
      return { code: 0, stdout: '@@ -1 +1 @@\n-x\n+y\n', err: '' }
    }
    return git(args, cwd)
  }
  const fx = diffEffects(s, { dir: '/start', tabsSocket: '', tabsSession: '' }, { git: slow, run: async () => ({ ok: true, out: '', err: '', exit: 0 }), draw: () => {} })
  await fx.refresh()
  assert.equal(s.openPath, 'b.txt')
  assert.deepEqual(s.openRows, [])
})

test('counts go to 0 when numstat drops a file whose status line stays the same', async () => {
  const answers: Answers = { ...REPO, status: { stdout: 'MM a.txt\0' }, 'diff HEAD': { stdout: '40\t3\ta.txt\0' } }
  const { s, fx } = setup(answers)
  await fx.refresh()
  assert.deepEqual([s.files[0].add, s.files[0].del], [40, 3])
  answers['diff HEAD'] = { stdout: '' }
  await fx.refresh()
  assert.deepEqual([s.files[0].add, s.files[0].del], [0, 0])
})

test('a failed numstat keeps the last counts', async () => {
  const answers: Answers = { ...REPO, status: { stdout: 'MM a.txt\0' }, 'diff HEAD': { stdout: '40\t3\ta.txt\0' } }
  const { s, fx } = setup(answers)
  await fx.refresh()
  answers['diff HEAD'] = { code: 128, err: 'fatal: bad object' }
  await fx.refresh()
  assert.deepEqual([s.files[0].add, s.files[0].del], [40, 3])
})

test('gitTrouble: outside a repository, else git’s first line', () => {
  assert.equal(gitTrouble('fatal: not a git repository (or any of the parent directories): .git'), 'Not a git repository')
  assert.equal(gitTrouble('error: something broke\nmore'), 'git failed: something broke')
  assert.equal(gitTrouble(''), 'git failed')
})
