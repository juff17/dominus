import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { babysitBranch, findCheckouts, gitConfigOf, remoteKey, remotesIn, repoKey, repoRootOf, reposUnder } from './checkout.ts'

test('a remote’s address as host/path, whatever form it’s in', () => {
  assert.equal(remoteKey('git@github.com:JL/Dotfiles.git'), 'github.com/jl/dotfiles')
  assert.equal(remoteKey('https://github.com/jl/dotfiles'), 'github.com/jl/dotfiles')
  assert.equal(remoteKey('https://oauth2@gitlab.example.com:8443/platform/api.git/'), 'gitlab.example.com/platform/api')
  assert.equal(remoteKey('ssh://git@gitlab.example.com:2222/platform/sub/api.git'), 'gitlab.example.com/platform/sub/api')
  assert.equal(remoteKey('/srv/git/local.git'), null)
  assert.equal(repoKey('gitlab.example.com:8443', 'Platform/API'), 'gitlab.example.com/platform/api')
  assert.equal(babysitBranch(512), 'babysit/512')
})

test('every remote in a git config', () => {
  const config = '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:jl/a.git\n\tfetch = +refs/heads/*\n[remote "up"]\n  url = https://github.com/up/a\n'
  assert.deepEqual(remotesIn(config), ['git@github.com:jl/a.git', 'https://github.com/up/a'])
})

function tree() {
  const home = mkdtempSync(join(tmpdir(), 'checkout-'))
  const repo = (path: string, url: string) => {
    mkdirSync(join(home, path, '.git'), { recursive: true })
    writeFileSync(join(home, path, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`)
  }
  repo('projects/platform-api', 'git@gitlab.example.com:platform/api.git')
  repo('projects/personal/dotfiles', 'https://github.com/jl/dotfiles.git')
  repo('elsewhere/dotfiles-copy', 'git@github.com:jl/dotfiles.git')
  repo('elsewhere/gad', 'git@github.com:jl/gad.git')
  // A worktree of platform-api: its .git is a file naming the git dir.
  const wt = join(home, 'projects/platform-api/.claude/worktrees/babysit-512')
  mkdirSync(join(home, 'projects/platform-api/.git/worktrees/babysit-512'), { recursive: true })
  writeFileSync(join(home, 'projects/platform-api/.git/worktrees/babysit-512/commondir'), '../..\n')
  mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${join(home, 'projects/platform-api/.git/worktrees/babysit-512')}\n`)
  // Something big that isn't a repo, under the depth.
  mkdirSync(join(home, 'projects/notes/a/b/c/d'), { recursive: true })
  return { home, wt }
}

test('a worktree reads its main repo’s config, and counts as that repo', () => {
  const { home, wt } = tree()
  try {
    assert.equal(gitConfigOf(wt), join(home, 'projects/platform-api/.git/config'))
    assert.equal(repoRootOf(join(wt, 'src')), join(home, 'projects/platform-api'))
    assert.equal(repoRootOf(home), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the clones: the known ones first, then those under ~/projects and beside the known ones', () => {
  const { home, wt } = tree()
  try {
    assert.deepEqual(reposUnder(join(home, 'projects')).sort(), [join(home, 'projects/personal/dotfiles'), join(home, 'projects/platform-api')])
    const map = findCheckouts([join(home, 'elsewhere/dotfiles-copy'), wt], home)
    assert.equal(map.get('github.com/jl/dotfiles'), join(home, 'elsewhere/dotfiles-copy'), 'a known clone wins')
    assert.equal(map.get('gitlab.example.com/platform/api'), join(home, 'projects/platform-api'))
    assert.equal(map.get('github.com/jl/gad'), join(home, 'elsewhere/gad'), 'beside a known clone')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
