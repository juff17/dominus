import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Settings } from '../../settings/settings.ts'
import { type JiraTracker, type World, configOf, readCache, readLinks, ticketsEffects } from './effects.ts'
import { BOARD } from './fixtures.test.ts'
import { start } from './state.ts'

process.env.AGENT_HUB_PROMPTS = '/nonexistent/prompts'

const SETTINGS = {
  'jira.board': '42',
  'jira.team': 'Payments',
  'jira.teamId': '',
  'jira.cloudId': '',
  'tickets.folder': '/work',
  'tickets.handoff.model': 'opus',
  'tickets.handoff.mode': 'auto',
  'tickets.handoff.effort': 'medium',
  'tickets.showDone': false,
  'general.folder': '',
} as unknown as Settings

const ENV = { JIRA_SITE: 'https://acme.atlassian.net', JIRA_EMAIL: 'me@acme.test', JIRA_API_TOKEN: 'secret-token' }

type Spawned = { cmd: string; args: readonly string[] }

function fakeWorld(dir: string) {
  const spawned: Spawned[] = []
  const timers: number[] = []
  const tracker: JiraTracker = {
    id: 'jira',
    base: async () => 'https://acme.atlassian.net',
    me: async () => ({ ok: true, value: { id: 'me-1', name: 'Me' } }),
    board: async () => ({ ok: true, value: structuredClone(BOARD) }),
    boards: async () => ({ ok: true, value: [] }),
  }
  const w: World = {
    env: () => ENV,
    envSet: () => ({ JIRA_SITE: true, JIRA_EMAIL: true, JIRA_API_TOKEN: true, JIRA_TOKEN_KIND: false }),
    envFile: join(dir, '.env'),
    settings: () => SETTINGS,
    setSetting: () => {},
    tracker: () => tracker,
    run: async () => ({ ok: true, out: '', err: '', exit: 0 }),
    spawn: (cmd, args) => {
      spawned.push({ cmd, args })
      const child = new EventEmitter() as ChildProcess
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), unref: () => {} })
      setImmediate(() => child.emit('close', 0))
      return child
    },
    agents: () => [],
    go: async () => ({ ok: true, message: '' }),
    claude: () => 'claude',
    plugin: () => true,
    cacheFile: join(dir, 'cache.json'),
    linksFile: join(dir, 'links.json'),
    now: () => 1_000_000,
    later: (_fn, ms) => void timers.push(ms),
  }
  return { w, spawned, timers }
}

const setup = { env: { JIRA_SITE: true, JIRA_EMAIL: true, JIRA_API_TOKEN: true, JIRA_TOKEN_KIND: false }, board: '42', team: 'Payments', mcp: true, check: { state: 'ok' as const, name: 'Me' } }
const prefs = { showDone: false, folder: '/work', model: 'opus', effort: 'medium' }

test('a refresh fetches the board and caches it for the next opening', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tickets-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { w } = fakeWorld(dir)
  const s = start(setup, prefs)
  const fx = ticketsEffects(s, { ...w, draw: () => {}, quit: () => {}, outside: () => ({}) as never }, { client: 'c', layout: 'layout-1' })
  await fx.refresh()
  assert.equal(s.screen, 'board')
  assert.equal(s.board?.unassigned.length, 4)
  const cache = readCache(w.cacheFile)
  assert.equal(cache?.boardId, '42')
  assert.equal(cache?.board?.mine.length, 2)
  assert.ok(!readFileSync(w.cacheFile, 'utf8').includes('secret-token'))
})

test('starting an agent runs the skill on the ticket with its facts, never the token, and links the ticket', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tickets-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { w, spawned, timers } = fakeWorld(dir)
  const s = start(setup, prefs)
  const fx = ticketsEffects(s, { ...w, draw: () => {}, quit: () => {}, outside: () => ({}) as never }, { client: 'c', layout: 'layout-1' })
  await fx.refresh()
  await fx.run({ do: 'start', ticket: BOARD.unassigned[0] })
  const bg = spawned.find(x => x.cmd === 'claude')
  assert.ok(bg)
  assert.ok(!bg.args.includes('--settings'), 'the sandbox is off by default')
  const argv = bg.args.join(' ')
  assert.ok(!argv.includes('secret-token'))
  assert.deepEqual(bg.args.slice(0, 3), ['--bg', '--name', 'ENG-1-eng-1-title'])
  assert.ok(bg.args.includes('opus') && bg.args.includes('medium') && bg.args.includes('auto'))
  const prompt = bg.args.at(-1) ?? ''
  assert.deepEqual(prompt.split('\n'), [
    '/dominus:ticket-work https://acme.atlassian.net/browse/ENG-1',
    'Ticket: ENG-1 (jira)',
    'Link: https://acme.atlassian.net/browse/ENG-1',
    'Site: https://acme.atlassian.net',
    'Assign to: account me-1 (Me)',
    'Unassigned: yes',
    'Started column: In Progress (status ids 3)',
    'Board: Payments, Sprint 42',
    'Folder: /work',
  ])
  assert.deepEqual(readLinks(w.linksFile), { 'ENG-1': { name: 'ENG-1-eng-1-title', at: 1_000_000 } })
  // Re-read after 30 s and 2 min, to catch the assign and the move.
  assert.deepEqual(timers, [30_000, 120_000])
})

test('the token kind and board come from .env and Settings', () => {
  const c = configOf({ ...ENV, JIRA_TOKEN_KIND: 'classic', JIRA_SITE: 'https://acme.atlassian.net/' }, SETTINGS)
  assert.deepEqual(c, { site: 'https://acme.atlassian.net', email: 'me@acme.test', token: 'secret-token', kind: 'classic', cloudId: '', boardId: '42', teamId: '' })
  assert.equal(configOf(ENV, SETTINGS).kind, 'scoped')
})
