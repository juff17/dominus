import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

import { MAX_BYTES, format, logger } from './log.ts'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'log-'))
  process.env.AGENT_HUB_LOG_DIR = dir
  delete process.env.AGENT_HUB_DEBUG
  delete process.env.AGENT_HUB_LOG_LEVEL
})

const lines = (component: string) => readFileSync(join(dir, `${component}.log`), 'utf8').trim().split('\n')
const fieldsOf = (line: string) => JSON.parse(line.slice(line.indexOf(' {') + 1))

test('a line is the time, level, component, fixed message, then every value as JSON', () => {
  const line = format('info', 'tray', 'approval ran', { id: 'p1', ok: false, ms: 312 }, new Date('2026-11-09T21:14:03.120Z'))
  assert.equal(line, '2026-11-09T21:14:03.120Z INFO tray: approval ran {"id":"p1","ok":false,"ms":312}')
  assert.equal(format('warn', 'hub', 'no fields', undefined, new Date(0)), '1970-01-01T00:00:00.000Z WARN hub: no fields {}')
})

test('an Error becomes err and stack; undefined is left out; bigints are strings', () => {
  const fields = fieldsOf(format('error', 'x', 'boom', { e: new Error('nope'), gone: undefined, n: 10n }))
  assert.equal(fields.err, 'nope')
  assert.match(fields.stack, /Error: nope/)
  assert.equal('gone' in fields, false)
  assert.equal(fields.n, '10')
})

test('fields that cannot be written say so instead of throwing', () => {
  const loop: { self?: unknown } = {}
  loop.self = loop
  assert.match(format('info', 'x', 'm', { loop }), /"logError":"fields not serializable/)
})

test('info and up are written to <component>.log; debug only with AGENT_HUB_DEBUG=1', () => {
  const log = logger('tray')
  log.debug('hidden', {})
  log.info('shown', { a: 1 })
  log.error('bad', { err: 'x' })
  assert.deepEqual(
    lines('tray').map(l => l.split(' ').slice(1, 4).join(' ')),
    ['INFO tray: shown', 'ERROR tray: bad'],
  )
  process.env.AGENT_HUB_DEBUG = '1'
  assert.equal(log.enabled('debug'), true)
  log.debug('now shown')
  assert.match(lines('tray').at(-1) ?? '', / DEBUG tray: now shown \{\}$/)
})

test('AGENT_HUB_LOG_LEVEL raises the bar', () => {
  process.env.AGENT_HUB_LOG_LEVEL = 'warn'
  const log = logger('hub')
  log.info('quiet')
  log.warn('loud')
  assert.equal(lines('hub').length, 1)
})

test('a child adds its fields to every line', () => {
  logger('hub').child({ win: 2 }).info('opened', { id: 'a' })
  assert.deepEqual(fieldsOf(lines('hub')[0]), { win: 2, id: 'a' })
})

test('a span logs its end with ms, and a failure with err, then rethrows', async () => {
  process.env.AGENT_HUB_DEBUG = '1'
  const log = logger('approvals')
  assert.equal(log.span('sync op', { id: 1 }, () => 7), 7)
  assert.equal(await log.span('async op', { id: 2 }, async () => 8), 8)
  assert.throws(() => log.span('bad op', { id: 3 }, () => {
    throw new Error('sync boom')
  }), /sync boom/)
  await assert.rejects(log.span('bad async', {}, async () => {
    throw new Error('async boom')
  }), /async boom/)
  const got = lines('approvals').map(l => l.replace(/^\S+ /, '').replace(/"ms":\d+/, '"ms":N').replace(/,"stack":".*"/, ''))
  assert.deepEqual(got, [
    'DEBUG approvals: sync op start {"id":1}',
    'INFO approvals: sync op done {"id":1,"ms":N}',
    'DEBUG approvals: async op start {"id":2}',
    'INFO approvals: async op done {"id":2,"ms":N}',
    'DEBUG approvals: bad op start {"id":3}',
    'ERROR approvals: bad op failed {"id":3,"ms":N,"err":"sync boom"}',
    'DEBUG approvals: bad async start {}',
    'ERROR approvals: bad async failed {"ms":N,"err":"async boom"}',
  ])
})

test('a span on a hot path can end at debug, writing nothing when debug is off', () => {
  logger('agentd').span('tick', {}, () => 1, { level: 'debug' })
  assert.equal(existsSync(join(dir, 'agentd.log')), false)
})

test('a log past the size limit moves to .log.1 and starts again', () => {
  const file = join(dir, 'big.log')
  writeFileSync(file, 'x'.repeat(MAX_BYTES + 1))
  logger('big').info('after')
  assert.equal(statSync(`${file}.1`).size, MAX_BYTES + 1)
  assert.equal(lines('big').length, 1)
})

test('a log folder removed while a process runs is made again on its next line', () => {
  const log = logger('rail')
  log.info('before')
  rmSync(dir, { recursive: true })
  log.info('after')
  assert.deepEqual(lines('rail').map(l => l.split(' ')[3]), ['after'])
})

test('a log that cannot be written is dropped quietly', () => {
  // A file where the log folder should be.
  writeFileSync(join(dir, 'blocker'), '')
  process.env.AGENT_HUB_LOG_DIR = join(dir, 'blocker', 'logs')
  assert.doesNotThrow(() => logger('x').error('lost', {}))
})
