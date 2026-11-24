import assert from 'node:assert/strict'
import { test } from 'node:test'

import { envSet, parseEnv, readEnv } from './env.ts'

test('.env lines: comments, quotes, export and a trailing comment', () => {
  const env = parseEnv(
    [
      '# comment',
      'JIRA_SITE=https://acme.atlassian.net',
      'export JIRA_EMAIL = me@acme.test',
      'JIRA_API_TOKEN="abc # not a comment"',
      'JIRA_TOKEN_KIND=scoped   # scoped | classic',
      'EMPTY=',
      'not a line',
    ].join('\n'),
  )
  assert.deepEqual(env, {
    JIRA_SITE: 'https://acme.atlassian.net',
    JIRA_EMAIL: 'me@acme.test',
    JIRA_API_TOKEN: 'abc # not a comment',
    JIRA_TOKEN_KIND: 'scoped',
    EMPTY: '',
  })
})

test('the environment wins over the file, and a missing file reads as empty', () => {
  const read = () => 'JIRA_SITE=https://file.test\nJIRA_EMAIL=file@test'
  assert.deepEqual(readEnv({ read, environ: { JIRA_SITE: 'https://env.test' } }), { JIRA_SITE: 'https://env.test', JIRA_EMAIL: 'file@test' })
  const gone = () => {
    throw new Error('ENOENT')
  }
  assert.deepEqual(readEnv({ read: gone, environ: {} }), {})
})

test('envSet says only whether each key has a value', () => {
  const read = () => 'JIRA_SITE=https://acme.atlassian.net\nJIRA_API_TOKEN=\nJIRA_EMAIL=me@acme.test'
  assert.deepEqual(envSet({ read, environ: {} }), { JIRA_SITE: true, JIRA_EMAIL: true, JIRA_API_TOKEN: false, JIRA_TOKEN_KIND: false })
})
