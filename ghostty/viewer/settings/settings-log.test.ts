import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

import { SECTIONS, row } from '../../settings/catalog.ts'
import { isSetting } from '../../settings/rows.ts'
import { items, onKey, start } from './state.ts'

const logs = mkdtempSync(join(tmpdir(), 'settings-log-'))
process.env.AGENT_HUB_LOG_DIR = logs
const logged = () => readFileSync(join(logs, 'settings-panel.log'), 'utf8')

beforeEach(() => {
  process.env.AGENT_HUB_SETTINGS = join(mkdtempSync(join(tmpdir(), 'settings-log-')), 'settings.json')
})

function on(key: string) {
  const sec = SECTIONS.findIndex(s => s.rows.some(r => isSetting(r) && r.key === key))
  const s = start(SECTIONS[sec].id)
  s.sel = items(s).findIndex(r => r.key === key)
  return s
}

test('a change is logged with its key and value, a reset with its key', () => {
  const key = 'layout.diagramsPercent'
  const { default: def, step } = row(key)
  const s = on(key)
  onKey(s, '\x1b[D')
  onKey(s, 'r')
  assert.match(logged(), new RegExp(` INFO settings-panel: setting changed \\{"key":"${key}","value":${def - step}\\}\\n`))
  assert.match(logged(), new RegExp(` INFO settings-panel: setting reset \\{"key":"${key}"\\}\\n`))
})

test('a save that failed is a warn with the error', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'settings-log-')), 'file')
  writeFileSync(file, '')
  process.env.AGENT_HUB_SETTINGS = join(file, 'settings.json')
  onKey(on('layout.diagramsPercent'), '\x1b[D')
  assert.match(logged(), / WARN settings-panel: setting change failed \{"key":"layout\.diagramsPercent","value":\d+,"err":"[^"]+"\}/)
})
