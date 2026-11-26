import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { claudeBin } from './paths.ts'

const missing = () => {
  throw Object.assign(new Error('no file'), { code: 'ENOENT' })
}

test('claude is the one bin/ghostty-hub found, then the saved one, then the installer’s, then PATH’s', () => {
  assert.equal(claudeBin({ env: { AGENT_HUB_CLAUDE: '/hub/claude' }, read: () => '/saved/claude\n' }), '/hub/claude')
  assert.equal(claudeBin({ env: {}, read: () => '/saved/claude\n' }), '/saved/claude')
  assert.equal(claudeBin({ env: {}, read: missing, exists: () => true }), join(homedir(), '.local/bin/claude'))
  assert.equal(claudeBin({ env: {}, read: () => '\n', exists: () => false }), 'claude')
})
