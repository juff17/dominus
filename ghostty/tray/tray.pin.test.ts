// Pins tray.ts's pieces as they are today, past tray.test.ts.
// tray-act.test.mjs and tray-snapshot.test.mjs run the CLI end to end.
//
// Safety: tray.ts fixes its runtime folder and tmux socket names as it
// loads, so they're set to a temp folder and private names first, and a tmux
// stub leads PATH before go() runs tmux.
//   node --test ghostty/tray/tray.pin.test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import type { Agent, Monitor } from '../agents/model.ts'
import type { Runner } from '../core/proc.ts'
import type { Proposal } from '../agents/proposals.ts'

const TMP = mkdtempSync(join(tmpdir(), 'tray-pin-'))
after(() => rmSync(TMP, { recursive: true, force: true }))
process.env.XDG_RUNTIME_DIR = TMP
const SETTINGS = join(TMP, 'settings.json')
process.env.AGENT_HUB_SETTINGS = SETTINGS
process.env.AGENT_HUB_TABS_SOCKET = 'tray-pin-tabs'
process.env.GHOSTTY_LAYOUT_SOCKET = 'tray-pin-layout'
mkdirSync(join(TMP, 'bin'))
// send-keys plays the hubs: it takes every window's open request
// (hubOpen(<win>)) and notes whose it was, unless the test says the hub is
// asleep. The glob also matches go()'s `.lock` folder, so the loop ends
// with `true`: a failed -f test there must not read as a send-keys failure.
// Two go()s at once run two of these, so each takes a request by moving it
// first, as a hub would, and only one of them reads it.
const OPENED = join(TMP, 'opened')
const ASLEEP = join(TMP, 'hub-asleep')
const REQUESTS = join(TMP, 'agent-hub', 'hub-open-')
writeFileSync(
  join(TMP, 'bin', 'tmux'),
  `#!/bin/sh\necho "$@" >> ${join(TMP, 'tmux.calls')}\ncase "$*" in *list-sessions*) echo "1 layout-9";; *send-keys*) [ -e ${ASLEEP} ] || for f in ${REQUESTS}*; do [ -f "$f" ] && mv "$f" ${join(TMP, 'taken')}.$$ 2>/dev/null && { printf '%s\\n' "$(cat ${join(TMP, 'taken')}.$$)" >> ${OPENED}; rm -f ${join(TMP, 'taken')}.$$; }; done; true;; *show*) echo "%4";; esac\n`,
  { mode: 0o755 },
)
process.env.PATH = `${join(TMP, 'bin')}:${process.env.PATH}`
const { hubOpen, act, approvalRow, go, readNotes, runApproval, trayItems } = await import('./tray.ts')
const { APPROVAL_MS, runGroup } = await import('../agents/proposals.ts')
const { TRAY, updateSet } = await import('./items.ts')

const NOTES = join(TMP, 'agent-hub', 'notes')
const HOUR = 3_600_000

test('runApproval: a JSON last line on stdout, else on stderr, else either’s last line as text', async () => {
  const script = join(TMP, 'approval.py')
  writeFileSync(script, '')
  const answer = (out: string, err = '', ok = true) => runApproval({ script }, ['approve', 'p'], async () => ({ ok, out, err, exit: ok ? 0 : 1 }))
  assert.deepEqual(await answer('progress\n{"ok": true, "message": "Pushed"}\n'), { ok: true, message: 'Pushed' })
  // ok is whatever the JSON says, not the exit status.
  assert.deepEqual(await answer('{"ok": false, "message": "Already running"}', 'exit 1', false), { ok: false, message: 'Already running' })
  assert.deepEqual(await answer('{"ok": true, "message": "x"}', '', false), { ok: true, message: 'x' })
  assert.deepEqual(await answer('{"ok": 1}'), { ok: true, message: '' })
  assert.deepEqual(await answer('{"message": "no ok"}'), { ok: false, message: 'no ok' })
  // A JSON answer not on the last line is missed; the last line is shown as it is.
  assert.deepEqual(await answer('{"ok": true, "message": "x"}\ndone\n', ''), { ok: false, message: 'done' })
  // approval.py's SystemExit puts its refusal on stderr, as JSON or as text.
  assert.deepEqual(await answer('', 'Traceback\n{"ok": false, "message": "Already running"}\n', false), { ok: false, message: 'Already running' })
  assert.deepEqual(await answer('', 'Already running\n', false), { ok: false, message: 'Already running' })
  assert.deepEqual(await answer('[push] fetching\n', 'Traceback\nRuntimeError: boom\n', false), { ok: false, message: 'RuntimeError: boom' })
  assert.deepEqual(await answer('Already running\n', '', false), { ok: false, message: 'Already running' })
  // A JSON value that isn't an answer is text.
  assert.deepEqual(await answer('[1]', '', false), { ok: false, message: '[1]' })
  assert.deepEqual(await answer('', '', false), { ok: false, message: 'The approval script failed' })
})

test('runApproval runs python3 on the script under zsh -c when zsh is there', async () => {
  const script = join(TMP, 'approval.py')
  writeFileSync(script, '')
  let argv: string[] | null = null
  let opts: Parameters<Runner>[1] | null = null
  const exec: Runner = async (a, o) => ((argv = a), (opts = o), { ok: true, out: '{}', err: '', exit: 0 })
  await runApproval({ script }, ['reject', 'p'], exec)
  assert.deepEqual(opts, { timeout: APPROVAL_MS })
  const zsh = existsSync('/bin/zsh') || existsSync('/usr/bin/zsh')
  assert.deepEqual(argv, zsh ? ['zsh', '-c', 'exec "$@"', 'approval', 'python3', script, 'reject', 'p'] : ['python3', script, 'reject', 'p'])
  // Only a file named approval.py that exists.
  assert.deepEqual(await runApproval(null, []), { ok: false, message: 'The babysit script that proposed this is gone' })
  assert.deepEqual(await runApproval({ script: join(TMP, 'other.py') }, []), { ok: false, message: 'The babysit script that proposed this is gone' })
})

test('runApproval stops an approval.py that hangs and says so', async () => {
  const dir = join(TMP, 'hang')
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'approval.py')
  writeFileSync(script, 'import time\nprint("[push] working", flush=True)\ntime.sleep(30)\n')
  const started = Date.now()
  const r = await runApproval({ id: 'h', kind: 'push', script }, ['approve', 'h'], undefined, 300)
  assert.deepEqual(r, { ok: false, message: 'The approval script took too long and was stopped' })
  assert.ok(Date.now() - started < 10_000)
})

test('readNotes: oldest file first, expired and time-less notes removed, broken ones kept and hidden', () => {
  rmSync(NOTES, { recursive: true, force: true })
  mkdirSync(NOTES, { recursive: true })
  const now = 1_800_000_000_000
  const put = (name: string, text: string | object) => writeFileSync(join(NOTES, name), typeof text === 'string' ? text : JSON.stringify(text))
  put('b.json', { message: 'B', at: now - HOUR })
  put('a.json', { message: 'A', at: String(now - 2 * HOUR) })
  put('edge.json', { message: 'exactly a day', at: now - 24 * HOUR })
  put('old.json', { message: 'old', at: now - 24 * HOUR - 1 })
  put('none.json', { message: 'no time' })
  put('empty.json', '')
  put('other.txt', 'x')
  const notes = readNotes(now)
  assert.deepEqual(
    notes.map(n => [n.file, n.message, n.at]),
    [
      ['a', 'A', now - 2 * HOUR],
      ['b', 'B', now - HOUR],
      ['edge', 'exactly a day', now - 24 * HOUR],
    ],
  )
  // pins current behaviour (todo zpb: an empty note can't be parsed, so it's neither shown nor ever removed)
  assert.deepEqual(readdirSync(NOTES).sort(), ['a.json', 'b.json', 'edge.json', 'empty.json', 'other.txt'])
  rmSync(NOTES, { recursive: true, force: true })
  assert.deepEqual(readNotes(now), [])
})

test('readNotes follows Settings’ tray.noteHours', () => {
  mkdirSync(NOTES, { recursive: true })
  const now = 1_800_000_000_000
  writeFileSync(join(NOTES, 'n.json'), JSON.stringify({ message: 'two hours', at: now - 2 * HOUR }))
  writeFileSync(SETTINGS, JSON.stringify({ 'tray.noteHours': 1 }))
  try {
    assert.deepEqual(readNotes(now), [])
    assert.equal(existsSync(join(NOTES, 'n.json')), false)
  } finally {
    rmSync(SETTINGS, { force: true })
  }
})

test('a proposal of a kind the tray doesn’t know: ▲, no detail, and it opens in Monitors rather than approve', () => {
  const p: Proposal = { id: 'x1', kind: 'mystery', at: 5, status: 'pending', title: 'Do a thing', pr: { repo: 'r', ref: '#1' } }
  const r = approvalRow(p, [])
  assert.deepEqual([r.section, r.glyph, r.title, r.meta], ['you', '▲', 'Do a thing', 'r #1'])
  assert.deepEqual(r.actions, ['review', 'skip'])
  assert.equal(r.preview, '')
  assert.equal(r.link, null)
})

test('a session waiting on input is a ▲ row that says where it runs', () => {
  const a = { id: 's', state: 'needs', need: 'input', cmd: 'Waiting: input needed', title: 't', repo: 'r', worktree: 'w', pane: null, kind: 'bg', since: 10, stateSince: 10, monitor: false, monitors: [] } as Partial<Agent> as Agent
  const t = trayItems([a, { ...a, id: 'u', kind: 'term', worktree: '', since: 20 }])
  assert.deepEqual(
    t.items.map(i => [i.id, i.meta, i.actions]),
    [
      ['i:s:10', 'r ⑂ w · background', ['go']],
      ['i:u:20', 'r · terminal', ['go']],
    ],
  )
})

test('go: a background agent with a layout named goes there; one with neither pane nor job has nowhere', async () => {
  const calls = () => (existsSync(join(TMP, 'tmux.calls')) ? readFileSync(join(TMP, 'tmux.calls'), 'utf8').split('\n').filter(Boolean) : [])
  const bg = { id: 'job-agent', title: 'Job', pane: null, jobId: 'j1' }
  assert.deepEqual(await go(bg, 'layout-3'), { ok: true, raise: true, layout: 'layout-3', message: 'Job, in the hub' })
  assert.deepEqual(calls(), [
    '-L tray-pin-layout show -v -t layout-3 @hub',
    '-L tray-pin-layout select-window -t layout-3:hub',
    '-L tray-pin-layout send-keys -t %4 -l \x1b[9102~',
  ])
  assert.equal(readFileSync(OPENED, 'utf8'), 'job-agent\n')
  assert.equal(hubOpen(3), join(TMP, 'agent-hub', 'hub-open-3'))
  assert.equal(existsSync(`${hubOpen(3)}.lock`), false)
  // A hub tab names its own window, whatever layout is passed.
  await go({ id: 't', title: 'T', pane: { win: 2, hub: true } as Agent['pane'], jobId: null }, 'layout-3')
  assert.equal(calls()[3], '-L tray-pin-layout show -v -t layout-2 @hub')
  // No layout given: the window used last, else an attached session's.
  await go(bg)
  assert.equal(calls()[6], '-L tray-pin-layout list-clients -F #{client_activity} #{client_name} #{client_session}')
  assert.equal(calls()[7], '-L tray-pin-layout list-sessions -F #{session_attached} #{session_name}')
  assert.equal(calls()[8], '-L tray-pin-layout show -v -t layout-9 @hub')
  assert.deepEqual(await go({ id: 'x', title: 'X', pane: null, jobId: null }), { ok: false, message: "X runs outside the layout, so there's nowhere to take you" })
})

test('go: a workspace tab is shown in its own window’s workspace, never through the hub', async () => {
  rmSync(join(TMP, 'tmux.calls'), { force: true })
  const pane = { win: 2, hub: false, session: 'ghostty-2', window: '@5' } as Agent['pane']
  assert.deepEqual(await go({ id: 'w', title: 'W', pane, jobId: null }, 'layout-3'), { ok: true, raise: true, layout: 'layout-2', message: 'W, in its tab' })
  assert.deepEqual(readFileSync(join(TMP, 'tmux.calls'), 'utf8').split('\n').filter(Boolean), [
    '-L tray-pin-tabs select-window -t ghostty-2:@5',
    '-L tray-pin-layout select-window -t layout-2:work',
  ])
})

test('go: a request no hub takes (one between restarts) fails, and goes, so a later key can’t open it', async () => {
  writeFileSync(ASLEEP, '')
  try {
    assert.deepEqual(await go({ id: 'lost', title: 'Lost', pane: null, jobId: 'j' }, 'layout-3'), { ok: false, message: 'The hub is not running' })
    assert.equal(existsSync(hubOpen(3)), false)
    assert.equal(existsSync(`${hubOpen(3)}.lock`), false)
  } finally {
    rmSync(ASLEEP)
  }
})

test('go: two at once each reach their hub, through a file per window, and two to one window take turns', async () => {
  rmSync(OPENED, { force: true })
  const tab = (id: string, win: number) => ({ id, title: id, pane: { win, hub: true } as Agent['pane'], jobId: null })
  const [one, two] = await Promise.all([go(tab('one', 1)), go(tab('two', 2))])
  assert.deepEqual([one.ok, two.ok], [true, true])
  assert.deepEqual(readFileSync(OPENED, 'utf8').split('\n').filter(Boolean).sort(), ['one', 'two'])
  rmSync(OPENED, { force: true })
  const [three, four] = await Promise.all([go(tab('three', 1)), go(tab('four', 1))])
  assert.deepEqual([three.ok, four.ok], [true, true])
  assert.deepEqual(readFileSync(OPENED, 'utf8').split('\n').filter(Boolean).sort(), ['four', 'three'])
})

const fake = (id: string, extra: Partial<Agent>): Agent =>
  ({ id, state: 'idle', need: null, via: '', cmd: '', title: id, repo: 'r', worktree: '', pane: null, kind: 'bg', since: 10, stateSince: 10, monitor: false, monitors: [], ...extra }) as Partial<Agent> as Agent
const mon = (session: string, task: string, state: Monitor['state'], tag: string, at: number): Monitor => ({
  key: `${session}:${task}`,
  task,
  description: task,
  kind: 'logger',
  command: '',
  state,
  busy: false,
  event: { tag, line: `[${tag}] ${task}`, at },
  startedAt: 1,
  ended: null,
})

test('dismiss reviews the session only for its Done row or its last alert; a Watch row or a prompt is only hidden', async () => {
  const reviewed = (id: string) => existsSync(join(TMP, 'agent-hub', 'reviewed', id))
  const s = fake('s', {
    state: 'needs',
    need: 'monitor',
    monitor: true,
    monitors: [mon('s', 't1', 'watching', 'comment', 5), mon('s', 't2', 'action', 'failed', 6), mon('s', 't3', 'action', 'crash', 7)],
  })
  const p = fake('p', { state: 'needs', need: 'permission', cmd: 'Allow Bash(ls)?' })
  const d = fake('d', { state: 'done', cmd: 'Merged.' })
  const agents = [s, p, d]
  const ids = trayItems(agents).items.map(i => i.id)
  assert.deepEqual(ids.filter(i => i.includes(':s:')), ['m:s:t2:6', 'm:s:t3:7', 'mw:s:t1:5'])
  for (const id of ['mw:s:t1:5', 'm:s:t2:6']) {
    assert.deepEqual(await act('dismiss', id, agents), { ok: true, message: 'Dismissed' })
    assert.equal(reviewed('s'), false, `${id} only hides its row`)
  }
  await act('dismiss', 'm:s:t3:7', agents)
  assert.equal(reviewed('s'), true, 'the last alert reviews the session')
  await act('dismiss', ids.find(i => i.startsWith('p:')) ?? '', agents)
  assert.equal(reviewed('p'), false)
  await act('dismiss', ids.find(i => i.startsWith('d:')) ?? '', agents)
  assert.equal(reviewed('d'), true)
})

test('a dismissed row stays dismissed while its session lives, though hidden for now; it goes with its session', async () => {
  writeFileSync(TRAY, '{}')
  const watching = fake('s', { monitor: true, monitors: [mon('s', 't1', 'watching', 'comment', 5)] })
  await act('dismiss', 'mw:s:t1:5', [watching])
  // A permission prompt hides the session's monitors behind its own row.
  const asking = fake('s', { state: 'needs', need: 'permission', cmd: 'Allow Bash(ls)?', monitors: [mon('s', 't1', 'action', 'comment', 5)], monitor: true })
  const prompt = trayItems([asking]).items[0].id
  await act('dismiss', prompt, [asking])
  const dismissed = () => JSON.parse(readFileSync(TRAY, 'utf8')).dismissed
  assert.deepEqual(dismissed(), ['mw:s:t1:5', prompt])
  assert.equal(trayItems([watching], new Set(), new Set(dismissed())).items.length, 0, 'still dismissed once back in Watch')
  const other = fake('o', { state: 'done' })
  await act('dismiss', trayItems([other]).items[0].id, [other])
  assert.deepEqual(dismissed(), [trayItems([other]).items[0].id])
})

test('a list is changed under a lock and written whole, the others kept; a lock left by a dead act is taken over', () => {
  const file = join(TMP, 'agent-hub', 'lists.json')
  updateSet('seen', ids => [...ids, 'a'], file)
  updateSet('dismissed', ids => [...ids, 'x'], file)
  updateSet('seen', ids => [...ids, 'b'], file)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { seen: ['a', 'b'], dismissed: ['x'] })
  assert.equal(existsSync(`${file}.lock`), false)
  mkdirSync(`${file}.lock`)
  utimesSync(`${file}.lock`, new Date(0), new Date(0))
  updateSet('seen', ids => [...ids, 'c'], file)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).seen, ['a', 'b', 'c'])
  assert.deepEqual(
    readdirSync(join(TMP, 'agent-hub')).filter(f => f.endsWith('.tmp') || f.endsWith('.lock')),
    [],
  )
})

test('runGroup stops the whole process group on a timeout, so a child of the script can’t finish its work after', async () => {
  const pidFile = join(TMP, 'child.pid')
  const r = await runGroup(['sh', '-c', `sleep 30 & echo $! > ${pidFile}; wait`], { timeout: 300 })
  assert.equal(r.exit, null)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (let i = 0; i < 40 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(alive(), false)
})
