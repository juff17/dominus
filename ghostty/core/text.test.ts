import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fill, lookup, t, text } from './text.ts'

test('t gives the string at a path, filled from the values passed', () => {
  assert.equal(t('controls.close'), 'close')
  assert.equal(t('settings.keybinds.takenBy', { key: 'alt+b', what: 'the shell' }), 'alt+b is taken by the shell')
})

test('t picks one or other by n', () => {
  assert.equal(t('settings.ui.lines', { n: 1 }), '1 line')
  assert.equal(t('settings.ui.lines', { n: 0 }), '0 lines')
  assert.equal(t('settings.ui.lines', { n: 3 }), '3 lines')
})

test('a path not in the file draws as the path, and a part as {}', () => {
  assert.equal(t('no.such.words'), 'no.such.words')
  assert.equal(t('controls'), 'controls')
  assert.deepEqual(text('no.such.part'), {})
  assert.equal(lookup('controls.close.more'), undefined)
})

test('fill leaves a name it has no value for as written', () => {
  assert.equal(fill('{a} and {b}', { a: 1 }), '1 and {b}')
  assert.equal(fill('{n} of {n}', { n: 0 }), '0 of 0')
})
