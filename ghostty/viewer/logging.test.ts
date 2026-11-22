import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Fields, Logger } from '../core/log.ts'
import { failing, logCrashes } from './logging.ts'

type Recorded = [level: string, message: string, fields: Fields]

function recorder() {
  const lines: Recorded[] = []
  const at = (level: string) => (message: string, fields: Fields = {}) => {
    lines.push([level, message, fields])
  }
  return { lines, warn: at('warn'), error: at('error') }
}

test('a crash is logged at error with its stack, a rejection with no Error too', () => {
  const log = recorder()
  const on = new EventEmitter()
  logCrashes(log as unknown as Logger, on as unknown as Parameters<typeof logCrashes>[1])
  const err = new Error('boom')
  on.emit('uncaughtExceptionMonitor', err, 'uncaughtException')
  on.emit('uncaughtExceptionMonitor', 42, 'unhandledRejection')
  assert.deepEqual(log.lines[0], ['error', 'crashed', { origin: 'uncaughtException', err: 'boom', stack: err.stack }])
  assert.equal(log.lines[1][2].err, '42')
  assert.equal(log.lines[1][2].origin, 'unhandledRejection')
})

test('a crashing view still prints the error and exits 1, and the log has it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-crash-'))
  const script = `import { logger } from '../core/log.ts'; import { logCrashes } from './logging.ts'; logCrashes(logger('crashy')); Promise.reject(new Error('it broke'))`
  let result: { status: number | null; stderr: Buffer } | undefined
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: import.meta.dirname, env: { ...process.env, AGENT_HUB_LOG_DIR: dir }, stdio: 'pipe' })
  } catch (e) {
    result = e as { status: number | null; stderr: Buffer }
  }
  assert.equal(result?.status, 1)
  assert.match(String(result?.stderr), /Error: it broke/)
  assert.match(readFileSync(join(dir, 'crashy.log'), 'utf8'), /ERROR crashy: crashed \{"origin":"unhandledRejection","err":"it broke","stack":"Error: it broke/)
})

test('a poll that keeps failing warns as it starts, and again after it has worked', () => {
  const log = recorder()
  const polls = failing(log)
  polls.failed('git', 'git failed', { exit: 1 })
  polls.failed('git', 'git failed', { exit: 1 })
  polls.failed('tmux', 'tmux failed', {})
  polls.ok('git')
  polls.failed('git', 'git failed', { exit: 2 })
  assert.deepEqual(
    log.lines.map(([, message, fields]) => [message, fields]),
    [
      ['git failed', { exit: 1 }],
      ['tmux failed', {}],
      ['git failed', { exit: 2 }],
    ],
  )
})
