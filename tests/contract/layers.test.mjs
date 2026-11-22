// The layers of docs/architecture.md: a module imports only from its own
// layer or the ones below, and apps import each other only through the
// tray's libraries. Tests may import anything.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'

import { CONF } from '../harness.mjs'

const LAYER = { core: 1, settings: 2, tui: 3, agents: 4, hub: 5, tray: 5, viewer: 5 }
// What an app may take from another app.
const SHARED = new Set(['tray/approvals.ts', 'tray/links.ts', 'tray/navigate.ts', 'tray/permission.ts'])

const modules = readdirSync(CONF, { recursive: true }).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))

function imports(file) {
  const text = readFileSync(join(CONF, file), 'utf8')
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g)].map(m => relative(CONF, resolve(CONF, dirname(file), m[1])))
}

// A rename of every module (as from .mjs to .ts) would otherwise leave the
// tests below checking nothing and passing.
test('the modules are found', () => {
  assert.ok(modules.length > 50, `found only ${modules.length}`)
})

test('every module is in a known layer', () => {
  const unknown = modules.filter(f => !(f.split('/')[0] in LAYER))
  assert.deepEqual(unknown, [])
})

test('imports point down the layers, and between apps only to the shared tray libraries', () => {
  const bad = []
  for (const file of modules) {
    const top = file.split('/')[0]
    for (const target of imports(file)) {
      const to = target.split('/')[0]
      if (!(to in LAYER)) bad.push(`${file} imports ${target}, outside every layer`)
      else if (LAYER[to] > LAYER[top]) bad.push(`${file} (${top}) imports ${target} (${to}), a layer up`)
      else if (LAYER[to] === 5 && to !== top && !SHARED.has(target)) bad.push(`${file} (${top}) imports ${target}, another app`)
    }
  }
  assert.deepEqual(bad, [])
})
