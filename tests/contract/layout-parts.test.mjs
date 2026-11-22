// Contract: Settings › Layout's Side panel switch reaches the shell. With it
// off, Alt+V (ghostty-viewer-toggle) says so and opens no viewer pane. tmux
// is a stub that records what it was asked.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { BIN, sandbox } from '../harness.mjs'
import { stubDir } from '../fixtures/shell/lib.mjs'

const TMUX = `#!/bin/sh
echo "$*" >> "$TMUX_LOG"
case "$*" in *"-v @tabs"*) echo %1 ;; esac
exit 0
`

function toggle(values) {
  const box = sandbox('layout-parts')
  try {
    const log = join(box.root, 'tmux.log')
    const tmux = box.write(join(stubDir(box), 'tmux'), TMUX)
    chmodSync(tmux, 0o755)
    box.settings(values)
    const r = spawnSync('bash', [join(BIN, 'ghostty-viewer-toggle'), '1'], {
      env: { ...box.env, TMUX_LOG: log },
      encoding: 'utf8',
      timeout: 15000,
    })
    assert.equal(r.status, 0, r.stderr)
    return existsSync(log) ? readFileSync(log, 'utf8') : ''
  } finally {
    box.cleanup()
  }
}

test('with the side panel off, Alt+V says so and opens nothing', () => {
  const calls = toggle({ 'layout.sidePanel': false })
  assert.match(calls, /display-message The side panel is off: turn it on in Settings › Layout › Side panel\./)
  assert.doesNotMatch(calls, /split-window|join-pane|break-pane/)
})
