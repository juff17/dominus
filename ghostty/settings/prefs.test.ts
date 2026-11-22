// node --test ghostty/settings/prefs.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { frecency, recents, remember, repoRoot, storePaths } from './prefs.ts'
import { set } from './settings.ts'

const TMP = mkdtempSync(join(tmpdir(), 'hub-prefs-'))
process.env.AGENT_HUB_SETTINGS = join(TMP, 'settings.json')
const Z = join(TMP, 'z')
process.env._Z_DATA = Z
after(() => rmSync(TMP, { recursive: true, force: true }))
// Most tests use made-up folders, which Only git repos would drop.
set('newAgent.gitOnly', false)
let n = 0
const fresh = (name: string) => join(TMP, String(++n), 'agent-hub', name)
const HOME = '/home/u'
const at = (cwd: string) => ({ cwd })

test('recents live under XDG cache, or its default under home', () => {
  assert.deepEqual(storePaths({}, HOME), { recents: '/home/u/.cache/agent-hub/recents.json' })
  assert.deepEqual(storePaths({ XDG_CACHE_HOME: '/c' }, HOME), { recents: '/c/agent-hub/recents.json' })
})

test('recents: saved first, then running agents\' folders, a worktree as its repo', () => {
  const file = fresh('recents.json')
  assert.deepEqual(recents(file, [], HOME), [])
  remember(file, '/home/u/p/a', [], HOME)
  const list = recents(file, [at('/home/u/p/b'), at('/home/u/p/a/.claude/worktrees/fix-x'), at('/home/u/p/c/sub')], HOME)
  assert.deepEqual(list, ['/home/u/p/a', '/home/u/p/b', '/home/u/p/c/sub'])
})

test('recents never offer home, and stop at 8', () => {
  const file = fresh('recents.json')
  const many = Array.from({ length: 12 }, (_, i) => at(`/p/${i}`))
  assert.deepEqual(recents(file, [at(HOME), ...many], HOME), many.slice(0, 8).map(a => a.cwd))
})

test('recents stop at Settings’ Recent folders shown', () => {
  set('newAgent.recent', 3)
  const many = Array.from({ length: 5 }, (_, i) => at(`/p/${i}`))
  assert.deepEqual(recents(fresh('recents.json'), many, HOME), ['/p/0', '/p/1', '/p/2'])
  set('newAgent.recent', 8)
})

test('remember puts the folder first without repeating it', () => {
  const file = fresh('recents.json')
  for (const d of ['/p/a', '/p/b', '/p/c']) remember(file, d, [], HOME)
  remember(file, '/p/a', [], HOME)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['/p/a', '/p/c', '/p/b'])
})

test('remember also saves the running agents\' folders it offered', () => {
  const file = fresh('recents.json')
  remember(file, '/p/new', [at('/p/running')], HOME)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['/p/new', '/p/running'])
})

test('a broken recents file reads as none and is replaced', () => {
  const file = fresh('recents.json')
  remember(file, '/p/a', [], HOME)
  writeFileSync(file, '{not json')
  assert.deepEqual(recents(file, [], HOME), [])
  remember(file, '/p/b', [], HOME)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['/p/b'])
})

test('a relative folder an older form saved is dropped, and finding its repo ends', () => {
  const file = fresh('recents.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(['app', '/p/a', '.']))
  assert.deepEqual(recents(file, [], HOME), ['/p/a'])
  remember(file, 'rel', [], HOME)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['/p/a'])
  // From a folder outside git, so '.' has no .git either: it ends at '.'.
  const was = process.cwd()
  process.chdir(TMP)
  try {
    assert.equal(repoRoot('no/such/folder'), null)
    assert.equal(repoRoot('.'), null)
  } finally {
    process.chdir(was)
  }
})

test('frecency ages z.sh ranks: this hour ×4, today ×2, this week ×½, older ×¼', () => {
  const now = 1_000_000_000
  writeFileSync(Z, [`/a|10|${now - 60}`, `/b|10|${now - 7200}`, `/c|10|${now - 90000}`, '/d|10|1', 'junk', '/e|x|1'].join('\n'))
  assert.deepEqual([...frecency(HOME, now)], [['/a', 40], ['/b', 20], ['/c', 5], ['/d', 2.5]])
  rmSync(Z)
  assert.equal(frecency(HOME, now).size, 0)
})

test('ranked by frecency, the last folder used stays first and the rest follow z', () => {
  const now = Date.now() / 1000
  writeFileSync(Z, [`/p/z-often|50|${now}`, `/p/b|5|${now}`].join('\n'))
  const file = fresh('recents.json')
  remember(file, '/p/b', [], HOME)
  remember(file, '/p/a', [], HOME)
  assert.deepEqual(recents(file, [], HOME), ['/p/a', '/p/z-often', '/p/b'])
  set('newAgent.rankBy', 'recent')
  assert.deepEqual(recents(file, [], HOME), ['/p/a', '/p/b'])
  set('newAgent.rankBy', 'frecency')
  rmSync(Z)
})

test('with Only git repos, a subfolder or worktree counts as its repo and other folders drop', () => {
  const repo = join(TMP, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'sub', 'deep'), { recursive: true })
  mkdirSync(join(repo, '.claude', 'worktrees', 'wt'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'worktrees', 'wt', '.git'), 'gitdir: x')
  mkdirSync(join(TMP, 'plain'))
  assert.equal(repoRoot(join(repo, 'sub', 'deep')), repo)
  assert.equal(repoRoot(join(repo, '.claude', 'worktrees', 'wt')), repo)
  assert.equal(repoRoot(join(TMP, 'plain')), null)
  set('newAgent.gitOnly', true)
  const file = fresh('recents.json')
  remember(file, join(TMP, 'plain'), [], HOME)
  remember(file, join(repo, 'sub', 'deep'), [], HOME)
  assert.deepEqual(recents(file, [at(repo)], HOME), [repo])
  set('newAgent.gitOnly', false)
})
