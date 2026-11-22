import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { row } from '../../settings/settings.ts'
import { type AttachOptions, DEFAULT_WATCH, UNTILS, WATCH_KEYS, attachLine, readAttached, recordAttached, untilOf, watchOf } from './attach.ts'

const OPTIONS: AttachOptions = { watch: DEFAULT_WATCH, until: 'merged', model: 'sonnet', effort: 'medium', brief: '' }

test('the defaults: everything but pings, until merged', () => {
  assert.equal(attachLine(OPTIONS), 'Attach options: watch pipeline, comments, rebase; until merged or closed.')
})

test('skipped parts, pings and another until; the brief isn’t on the line', () => {
  const o = { ...OPTIONS, watch: { pipeline: true, comments: false, rebase: false, ping: true }, until: 'pipeline' as const, brief: 'e2e:checkout is flaky' }
  assert.equal(attachLine(o), 'Attach options: watch pipeline; skip comments, rebase; ping on every comment; until the pipeline passes.')
  assert.equal(attachLine({ ...OPTIONS, watch: { pipeline: false, comments: false, rebase: false, ping: false }, until: '24h' }), 'Attach options: watch nothing; skip pipeline, comments, rebase; for 24 hours.')
})

test('records: written per PR, read back, old and broken ones left out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attach-'))
  try {
    const file = join(dir, 'monitors', 'attached.json')
    assert.deepEqual(readAttached(file), {}, 'none yet')
    const DAY = 86400e3
    recordAttached(['https://github.com/a/b/pull/1'], OPTIONS, 1000, file)
    const next = recordAttached(['https://github.com/a/b/pull/2'], { ...OPTIONS, until: '8h' }, 1000 + 31 * DAY, file)
    assert.deepEqual(Object.keys(next), ['https://github.com/a/b/pull/2'], 'a month-old record goes')
    assert.deepEqual(readAttached(file)['https://github.com/a/b/pull/2'], { ...OPTIONS, until: '8h', at: 1000 + 31 * DAY })
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...raw, bad: { watch: 'all' } }))
    assert.deepEqual(Object.keys(readAttached(file)), ['https://github.com/a/b/pull/2'])
    const warned: unknown[] = []
    writeFileSync(file, '{ not json')
    assert.deepEqual(readAttached(file, { warn: (...a: unknown[]) => warned.push(a) }), {})
    assert.equal((warned[0] as unknown[])[0], 'attach records unreadable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Settings › Monitors’ Watch by default and Until are the drawer’s toggles and untils', () => {
  assert.deepEqual(row('monitors.watch').choices.map(c => c.value), [...WATCH_KEYS])
  assert.deepEqual(row('monitors.until').choices.map(c => c.value), [...UNTILS])
  assert.deepEqual(watchOf(row('monitors.watch').default), DEFAULT_WATCH)
  assert.deepEqual(watchOf(['ping']), { pipeline: false, comments: false, rebase: false, ping: true })
  assert.equal(untilOf('8h'), '8h')
  assert.equal(untilOf('soon'), 'merged')
})
