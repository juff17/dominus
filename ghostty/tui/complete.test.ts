import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { expandHome, tilde } from '../core/paths.ts'
import { complete, matchesOf, pathTo, suggestion } from './complete.ts'

function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'complete-'))
  for (const d of ['alpha', 'alphabet', 'Beta', '.hidden']) mkdirSync(join(dir, d))
  writeFileSync(join(dir, 'about.txt'), '')
  symlinkSync(join(dir, 'alpha'), join(dir, 'linked'))
  symlinkSync(join(dir, 'nowhere'), join(dir, 'broken'))
  return dir
}

test('~ is the home folder both ways, the rest kept as typed', () => {
  const home = homedir()
  assert.equal(expandHome('~'), home)
  assert.equal(expandHome('~/a/'), `${home}/a/`)
  assert.equal(expandHome('/x/~/y'), '/x/~/y')
  assert.equal(tilde(`${home}/p`), '~/p')
  assert.equal(tilde('/etc'), '/etc')
  assert.equal(tilde(home), '~')
  assert.equal(tilde(`${home}2/p`), `${home}2/p`, 'a folder next to home that starts with its name stays whole')
  assert.equal(expandHome(tilde(`${home}-shared`)), `${home}-shared`)
})

test('matches: folders (links to folders too), hidden ones only after a dot, case ignored when nothing else matches', () => {
  const dir = tree()
  assert.deepEqual(matchesOf(`${dir}/`).names, ['Beta', 'alpha', 'alphabet', 'linked'])
  assert.deepEqual(matchesOf(`${dir}/a`, { files: true }).names, ['about.txt', 'alpha', 'alphabet'])
  assert.deepEqual(matchesOf(`${dir}/.`).names, ['.hidden'])
  assert.deepEqual(matchesOf(`${dir}/b`).names, ['Beta'])
  assert.deepEqual(matchesOf(`${dir}/nope/x`).names, [], 'a folder not there yet has none')
})

test('tab fills one in, then what several share, then steps through them both ways', () => {
  const dir = tree()
  assert.deepEqual(complete(`${dir}/B`, null), { text: `${dir}/Beta/`, menu: null })
  assert.equal(complete(`${dir}/al`, null).text, `${dir}/alpha`)
  const first = complete(`${dir}/alpha`, null)
  assert.equal(first.text, `${dir}/alpha/`)
  assert.equal(first.menu?.i, 0)
  const next = complete(first.text, first.menu)
  assert.equal(next.text, `${dir}/alphabet/`)
  assert.equal(complete(next.text, next.menu, true).text, `${dir}/alpha/`)
  assert.deepEqual(complete(`${dir}/zz`, null), { text: `${dir}/zz`, menu: null })
})

test('the suggestion is the rest of the first match, a folder with its slash', () => {
  const dir = tree()
  assert.equal(suggestion(`${dir}/Be`), 'ta/')
  assert.equal(suggestion(`${dir}/abo`, { files: true }), 'ut.txt')
  assert.equal(suggestion(`${dir}/`), '', 'nothing typed of the last part')
  assert.equal(pathTo({ dir, folders: new Set(['x']) }, 'x'), `${tilde(dir)}/x/`)
})
