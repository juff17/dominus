// core/text.json holds every word the screens show; the code names each by
// its path. These check that every path the code names is in the file, that
// the file is all text, and that every setting has its words.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { CONF } from '../harness.mjs'

const { TEXT, lookup } = await import(join(CONF, 'core/text.ts'))
const { SECTIONS } = await import(join(CONF, 'settings/settings.ts'))

const modules = readdirSync(CONF, { recursive: true }).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
const source = Object.fromEntries(modules.map(f => [f, readFileSync(join(CONF, f), 'utf8')]))

// Every t('…') and text('…') with a plain string path, and where it is.
function named(fn) {
  const out = []
  for (const [file, text] of Object.entries(source))
    for (const m of text.matchAll(new RegExp(`\\b${fn}\\(\\s*'([^'$]+)'`, 'g'))) out.push({ file, path: m[1] })
  return out
}

// Without this, renaming every module would leave the tests below with
// nothing to read, passing.
test('the modules are found', () => {
  assert.ok(modules.length > 50, `found only ${modules.length}`)
})

const isPlural = v => v && typeof v === 'object' && !Array.isArray(v) && typeof v.other === 'string' && Object.keys(v).every(k => k === 'one' || k === 'other')

test('every string path the code names is a string in text.json', () => {
  const bad = named('t')
    .filter(({ path }) => {
      const v = lookup(path)
      return typeof v !== 'string' && !isPlural(v)
    })
    .map(({ file, path }) => `${file}: t('${path}')`)
  assert.deepEqual(bad, [])
})

test('every part the code walks is in text.json', () => {
  const bad = named('text')
    .filter(({ path }) => {
      const v = lookup(path)
      return !v || typeof v !== 'object'
    })
    .map(({ file, path }) => `${file}: text('${path}')`)
  assert.deepEqual(bad, [])
})

test('text.json holds only text: strings, lists and objects of them', () => {
  const bad = []
  const walk = (v, path) => {
    if (typeof v === 'string') return
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k)
    else if (typeof v !== 'boolean') bad.push(`${path}: ${JSON.stringify(v)}`)
  }
  walk(TEXT, '')
  assert.deepEqual(bad, [])
})

test('every setting, section, heading and fixed row has its words in text.json', () => {
  const bad = []
  for (const s of SECTIONS) {
    if (!TEXT.settings.sections[s.id]?.name) bad.push(`section ${s.id}`)
    for (const r of s.rows) {
      if (r.key && !TEXT.settings.rows[r.key]?.label) bad.push(`row ${r.key}`)
      if (r.head && !Object.values(TEXT.settings.sections[s.id]?.heads ?? {}).includes(r.head)) bad.push(`heading ${s.id}: ${r.head}`)
    }
  }
  assert.deepEqual(bad, [])
})

test('every {name} in a string is a plain word, so fill() can fill it', () => {
  const bad = []
  const walk = (v, path) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\{([^}]*)\}/g)) if (!/^\w+$/.test(m[1])) bad.push(`${path}: {${m[1]}}`)
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
  }
  walk(TEXT, '')
  assert.deepEqual(bad, [])
})
