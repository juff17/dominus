// node --test ghostty/core/crash.test.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const here = import.meta.dirname
const dir = mkdtempSync(join(tmpdir(), 'hub-crash-'))

function crash(how: 'throw' | 'reject', logged: boolean) {
  const file = join(dir, `${how}-${logged}.mjs`)
  const url = (f: string) => pathToFileURL(join(here, f)).href
  writeFileSync(
    file,
    [
      `import { logger } from '${url('log.ts')}'`,
      `import { logCrashes } from '${url('crash.ts')}'`,
      `if (${logged}) logCrashes(logger('hub'))`,
      `setTimeout(() => { ${how === 'throw' ? "throw new Error('boom')" : "Promise.reject(new Error('boom'))"} }, 1)`,
    ].join('\n'),
  )
  const logs = join(dir, `logs-${how}-${logged}`)
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', env: { ...process.env, AGENT_HUB_LOG_DIR: logs, AGENT_HUB_LOG_LEVEL: '' } })
  let log = ''
  try {
    log = readFileSync(join(logs, 'hub.log'), 'utf8')
  } catch {}
  return { status: r.status, stderr: r.stderr.replaceAll(`-${logged}.mjs`, '.mjs'), log }
}

for (const how of ['throw', 'reject'] as const) {
  test(`a crash (${how}) is logged with its stack, and Node still reports it and exits 1`, () => {
    const before = crash(how, false)
    const after = crash(how, true)
    assert.equal(after.status, 1)
    assert.equal(after.status, before.status)
    assert.equal(after.stderr, before.stderr)
    const [line] = after.log.trim().split('\n')
    assert.match(line, / ERROR hub: crashed \{/)
    const fields = JSON.parse(line.slice(line.indexOf('{')))
    assert.equal(fields.origin, how === 'throw' ? 'uncaughtException' : 'unhandledRejection')
    assert.equal(fields.err, 'boom')
    assert.match(fields.stack, /^Error: boom\n {4}at /)
  })
}
