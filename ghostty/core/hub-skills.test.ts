import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { watches } from '../agents/board.ts'
import type { Agent } from '../agents/model.ts'
import { kindOf, monitorUrl, pipeTargetOf } from '../viewer/monitors/rows.ts'
import { pluginInstalled, skillAt, skillCommand } from './hub-skills.ts'

test('a hub skill runs as the plugin’s command', () => {
  assert.equal(skillCommand('pr-babysit'), '/dominus:pr-babysit')
})

test('a prompt names a hub skill with the plugin’s name or, from before the plugin, without', () => {
  const re = new RegExp(skillAt('log-watcher|logger'))
  for (const p of ['/dominus:log-watcher watch', '/log-watcher watch', '/logger x']) assert.match(p, re)
  for (const p of ['/log-watchers', '/other:log-watcher x', 'see /log-watcher']) assert.doesNotMatch(p, re)
})

test('both forms keep a session a watcher, and its kind and target readable', () => {
  const agent = (prompt: string) => ({ state: 'idle', since: 0, monitor: false, prompt }) as Pick<Agent, 'state' | 'since' | 'monitor' | 'prompt'>
  for (const p of ['/dominus:pipeline-watch g/r@main', '/pipeline-watch g/r@main']) {
    assert.ok(watches(agent(p)), p)
    assert.equal(kindOf({ kind: 'other', agent: { prompt: p } }), 'pipe')
    assert.equal(pipeTargetOf(p), 'g/r@main')
  }
  for (const p of ['/dominus:pr-babysit https://h/o/r/pull/1', '/pr-babysit https://h/o/r/pull/1'])
    assert.equal(monitorUrl({ kind: 'pr-babysit', command: '', agent: { prompt: p } }), 'https://h/o/r/pull/1')
})

test('the plugin counts as installed when Claude Code lists it and settings don’t turn it off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-skills-'))
  try {
    const write = (name: string, body: string) => writeFileSync(join(dir, name), body)
    mkdirSync(join(dir, 'plugins'))
    assert.equal(pluginInstalled(dir), false, 'no plugin list: nothing installed')
    write('plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'other@market': [{}] } }))
    assert.equal(pluginInstalled(dir), false, 'listed without it')
    write('plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'dominus@dominus': [{ scope: 'user' }] } }))
    assert.equal(pluginInstalled(dir), true, 'listed, no settings file')
    write('settings.json', JSON.stringify({ enabledPlugins: { 'dominus@dominus': true } }))
    assert.equal(pluginInstalled(dir), true)
    write('settings.json', JSON.stringify({ enabledPlugins: { 'dominus@dominus': false } }))
    assert.equal(pluginInstalled(dir), false, 'turned off')
    write('settings.json', '{')
    write('plugins/installed_plugins.json', '{')
    assert.equal(pluginInstalled(dir), true, 'files it can’t parse don’t block a start')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
