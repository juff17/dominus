// The three loggers (Node core/log.ts, Python agent_hub/log.py, bash
// bin/lib/log.sh) write the same line for the same event, so one grep or jq
// reads them all (docs/logging.md).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { CONF, REPO } from '../harness.mjs'

const LOG_SH = join(CONF, 'bin', 'lib', 'log.sh')
const PY = join(REPO, 'hub-plugin', 'lib', 'py')
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /

function shell(dir, script, env = {}) {
  return execFileSync('bash', ['-c', `source ${JSON.stringify(LOG_SH)}; ${script}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, AGENT_HUB_LOG_DIR: dir, ...env },
  })
}

const read = (dir, component) => readFileSync(join(dir, `${component}.log`), 'utf8').trim().split('\n')

test('Node, Python and bash write the same line for the same event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'logfmt-'))
  process.env.AGENT_HUB_LOG_DIR = dir
  const { logger } = await import(join(CONF, 'core', 'log.ts'))
  logger('node').warn('poll failed', { exit: 1, ok: false, cmd: 'gh api', note: 'a "quoted"\tline\nnext' })
  execFileSync(
    'python3',
    ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(PY)}); from agent_hub.log import logger; logger("py").warn("poll failed", exit=1, ok=False, cmd="gh api", note='a "quoted"\\tline\\nnext')`],
    { env: { PATH: process.env.PATH, HOME: dir, AGENT_HUB_LOG_DIR: dir } },
  )
  shell(dir, `ah_log warn sh "poll failed" exit 1 ok false cmd "gh api" note $'a "quoted"\\tline\\nnext'`)
  const tail = c => read(dir, c)[0].replace(TIME, '').replace(`${c}:`, 'C:')
  const expected = 'WARN C: poll failed {"exit":1,"ok":false,"cmd":"gh api","note":"a \\"quoted\\"\\tline\\nnext"}'
  assert.equal(tail('node'), expected)
  assert.equal(tail('py'), expected)
  assert.equal(tail('sh'), expected)
  for (const c of ['node', 'py', 'sh']) assert.match(read(dir, c)[0], TIME)
})

test('under Claude, Node, Python and bash add the same claude_session, unless the call names one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'logses-'))
  const env = { PATH: process.env.PATH, HOME: dir, AGENT_HUB_LOG_DIR: dir, CLAUDE_CODE_SESSION_ID: 'claude-1' }
  const node = `import(${JSON.stringify(join(CONF, 'core', 'log.ts'))}).then(({ logger }) => { logger('node').info('ran', { id: 'p1' }); logger('node').info('ran', { claude_session: 'other' }) })`
  execFileSync(process.execPath, ['-e', node], { env })
  execFileSync(
    'python3',
    ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(PY)}); from agent_hub.log import logger; logger("py").info("ran", id="p1"); logger("py").info("ran", claude_session="other")`],
    { env },
  )
  shell(dir, 'ah_log info sh ran id p1; ah_log info sh ran claude_session other', { CLAUDE_CODE_SESSION_ID: 'claude-1' })
  for (const c of ['node', 'py', 'sh'])
    assert.deepEqual(
      read(dir, c).map(l => l.replace(TIME, '').replace(`${c}:`, 'C:')),
      ['INFO C: ran {"id":"p1","claude_session":"claude-1"}', 'INFO C: ran {"claude_session":"other"}'],
      c,
    )
})

test('bash: debug only when asked, backslashes and control characters escaped, the line parses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logsh-'))
  shell(dir, `ah_log debug hidden "not shown"; ah_log info tray "approval ran" id p1 path 'C:\\x' ms 12.5 bell $'\\a'`)
  const lines = read(dir, 'tray')
  assert.equal(lines.length, 1)
  const json = JSON.parse(lines[0].slice(lines[0].indexOf(' {') + 1))
  assert.deepEqual(json, { id: 'p1', path: 'C:\\x', ms: 12.5, bell: '' })
  shell(dir, 'ah_log debug hidden "now shown"', { AGENT_HUB_DEBUG: '1' })
  assert.match(read(dir, 'hidden')[0], / DEBUG hidden: now shown \{\}$/)
})

test('bash: a log past the limit moves to .1 once its size is checked, and an unwritable log is dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logsh-'))
  writeFileSync(join(dir, 'big.log'), 'x'.repeat(1024 * 1024 + 1))
  // The size is checked on about one write in 64; enough writes reach one.
  shell(dir, 'for i in {1..1000}; do ah_log info big after; done')
  assert.ok(existsSync(join(dir, 'big.log.1')), 'rotated')
  assert.ok(!readFileSync(join(dir, 'big.log'), 'utf8').startsWith('x'))
  writeFileSync(join(dir, 'blocker'), '')
  assert.equal(shell(dir, 'ah_log error x lost; echo "status $?"', { AGENT_HUB_LOG_DIR: join(dir, 'blocker', 'logs') }), 'status 0\n')
})
