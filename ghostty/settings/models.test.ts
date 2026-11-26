import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { FILER_MODELS, LONGEST_MODEL_ID, MODELS, MODEL_IDS, model, modelLabel, modelName } from './models.ts'
import { row } from './catalog.ts'

const CONF = join(dirname(fileURLToPath(import.meta.url)), '..')

test('every picker offers the same models, in the same order', () => {
  assert.deepEqual(MODEL_IDS, ['fable', 'opus', 'sonnet', 'haiku'])
  assert.deepEqual(
    row('newAgent.task.model').choices.map(c => c.value),
    ['default', ...MODEL_IDS],
  )
  assert.deepEqual(
    row('todo.handoff.model').choices.map(c => c.value),
    MODEL_IDS,
  )
})

test('the filer offers the models marked for it, the smallest first, with their versions', () => {
  assert.deepEqual(FILER_MODELS, [
    ['haiku', 'haiku 5.5'],
    ['sonnet', 'sonnet 5.5'],
    ['fable', 'fable 5.2'],
  ])
  assert.deepEqual(row('todo.filing.model').choices, [
    { value: 'haiku', label: 'haiku 5.5' },
    { value: 'sonnet', label: 'sonnet 5.5' },
    { value: 'fable', label: 'fable 5.2' },
  ])
})

test('each model has an API id; an unknown one has none', () => {
  for (const m of MODELS) assert.match(m.api, /^claude-[a-z]+-\d+-\d+$/)
  assert.equal(model('haiku')!.api, 'claude-haiku-5-5')
  assert.equal(model('nope'), undefined)
  assert.equal(model('fable')!.api, 'claude-fable-5-2')
  assert.equal(LONGEST_MODEL_ID, 'sonnet')
})

test('a model’s label carries its version, its name is capitalized', () => {
  assert.equal(modelLabel('fable'), 'fable 5.2')
  assert.equal(modelLabel('sonnet'), 'sonnet 5.5')
  assert.equal(modelLabel('nope'), 'nope')
  assert.equal(modelName('haiku'), 'Haiku')
  assert.equal(modelName('fable'), 'Fable')
})

// The list lives in models.ts only: a model's name written into another
// file is a second list that falls behind when a model is added.
test('no other source file names a model', () => {
  const ids = MODEL_IDS.join('|')
  // Two names side by side ('opus', 'sonnet' or 'haiku', 'haiku 5.5'), or an API id.
  const named = new RegExp(`'(?:${ids})'\\s*,\\s*'(?:${ids})(?: [\\d.]+)?'|claude-(?:${ids})-\\d`)
  const files: string[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if ((p.endsWith('.ts') && !p.endsWith('.test.ts')) || dirname(p).endsWith('/bin')) files.push(p)
    }
  }
  walk(CONF)
  const found = files.filter(p => !p.endsWith('/settings/models.ts') && named.test(readFileSync(p, 'utf8')))
  assert.deepEqual(
    found.map(p => relative(CONF, p)),
    [],
  )
})
