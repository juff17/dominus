import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'

import { type FixedLine, ROWS, SECTIONS, type SettingKey, addedId, defaultFolder, defaultFolderSetting, isSetting, load, parseHosts,
  parseList, reset, row, set, show, step, toggleFlag, valid } from './settings.ts'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'settings-')), 'settings.json')
const shownAs = (id: string, label: string) =>
  SECTIONS.find(s => s.id === id)!
    .rows.filter(isSetting)
    .find(r => r.label === label)!

test('keys are unique and every default is a valid value', () => {
  assert.equal(new Set(ROWS.map(r => r.key)).size, ROWS.length)
  for (const r of ROWS) assert.ok(valid(r, r.default), r.key)
  for (const s of SECTIONS) assert.ok(s.rows.some(isSetting), s.name)
})

test('no file reads as every default', () => {
  const values = load(fresh())
  for (const r of ROWS) assert.deepEqual(values[r.key], r.default)
})

test('a bad or unknown value reads as the default', () => {
  const file = fresh()
  writeFileSync(file, JSON.stringify({ 'newAgent.task.model': 'gpt', 'hub.doneCards': 99, 'tray.foldDone': 'yes', 'hub.broke': ['failed', 'boom'] }))
  const v = load(file)
  assert.equal(v['newAgent.task.model'], 'opus')
  assert.equal(v['hub.doneCards'], 2)
  assert.equal(v['tray.foldDone'], true)
  assert.deepEqual(v['hub.broke'], row('hub.broke').default)
})

test('a broken file reads as every default', () => {
  const file = fresh()
  writeFileSync(file, '{ not json')
  assert.equal(load(file)['prBabysit.interval'], 60)
})

test('set refuses a file that is there but no JSON object, and leaves it as it is', () => {
  for (const body of ['{ "hub.doneCards": 4, }', '[1, 2]', 'null']) {
    const file = fresh()
    writeFileSync(file, body)
    assert.throws(() => set('prBabysit.interval', 120, file), /settings\.json is broken/)
    assert.equal(readFileSync(file, 'utf8'), body)
  }
  // A file that isn't there yet is only empty.
  const file = fresh()
  set('prBabysit.interval', 120, file)
  assert.equal(load(file)['prBabysit.interval'], 120)
})

test('a file replaced within one clock tick is read again', () => {
  const file = fresh()
  writeFileSync(file, JSON.stringify({ 'hub.doneCards': 3 }))
  utimesSync(file, 1000, 1000)
  assert.equal(load(file)['hub.doneCards'], 3)
  // Another process's set(): a new file renamed in, with the same mtime.
  const tmp = `${file}.other.tmp`
  writeFileSync(tmp, JSON.stringify({ 'hub.doneCards': 4 }))
  utimesSync(tmp, 1000, 1000)
  renameSync(tmp, file)
  assert.equal(load(file)['hub.doneCards'], 4)
})

test('set saves only changed values, and keeps keys it does not know', () => {
  const file = fresh()
  writeFileSync(file, JSON.stringify({ 'some.future.key': 1 }))
  set('prBabysit.interval', 120, file)
  assert.equal(load(file)['prBabysit.interval'], 120)
  set('newAgent.task.model', 'sonnet', file)
  reset('prBabysit.interval', file)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'some.future.key': 1, 'newAgent.task.model': 'sonnet' })
  assert.throws(() => set('prBabysit.interval', 5, file))
  assert.throws(() => set('no.such.key' as SettingKey, 1, file))
})

test('the old "don\'t ask again" for stopping monitors carries over', () => {
  const file = fresh()
  writeFileSync(join(file, '..', 'prefs.json'), JSON.stringify({ skip: { 'stop-monitor': true } }))
  assert.equal(load(file)['hub.askStopMonitor'], false)
  set('hub.askStopMonitor', true, file)
  assert.equal(load(file)['hub.askStopMonitor'], true)
})

test('step cycles choices, keeps numbers in range and flips switches', () => {
  const model = row('newAgent.task.model')
  assert.equal(step(model, 'haiku', 1), 'default')
  assert.equal(step(model, 'default', -1), 'haiku')
  const cards = row('hub.doneCards')
  assert.equal(step(cards, 6, 1), 6)
  assert.equal(step(cards, 0, -1), 0)
  assert.equal(step(row('prBabysit.interval'), 60, 1), 75)
  assert.equal(step(row('tray.foldDone'), true, 1), false)
})

test('flags toggle in the order the choices list them', () => {
  const broke = row('hub.broke')
  assert.deepEqual(toggleFlag(broke, ['crash', 'failed'], 'stuck'), ['failed', 'stuck', 'crash'])
  assert.deepEqual(toggleFlag(broke, ['failed', 'stuck'], 'failed'), ['stuck'])
})

test('values show with their units and labels', () => {
  assert.equal(show(row('prBabysit.interval'), 60), '60s')
  assert.equal(show(row('newAgent.task.branch'), 'current'), 'current branch')
  assert.equal(show(row('tray.foldDone'), false), 'off')
})

test('the scripts read Settings through ghostty-lib.sh, the environment winning', () => {
  const file = fresh()
  set('layout.topRows', 14, file)
  const lib = fileURLToPath(new URL('../bin/ghostty-lib.sh', import.meta.url))
  const run = (script: string) =>
    execFileSync('bash', ['-c', `source "$1"; ${script}`, 'bash', lib], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_HUB_SETTINGS: file, GHOSTTY_TOP_ROWS: '', GHOSTTY_RAIL_COLS: '' },
    }).trim()
  assert.equal(run('top_rows'), '14')
  assert.equal(run('GHOSTTY_TOP_ROWS=7 top_rows'), '7')
  assert.equal(run("setting layout.todoWidth '' 70"), '70')
  assert.equal(run("setting no.such.key '' 33"), '33')
})

test('every section starts with a heading', () => {
  for (const s of SECTIONS) {
    const first = s.rows[0]
    assert.ok('head' in first && first.head, s.name)
  }
})

test('an alias row is its setting under another name, in another section', () => {
  const file = fresh()
  const babysit = shownAs('prBabysit', 'Auto push changes')
  assert.equal(babysit.key, 'approvals.push')
  assert.deepEqual(babysit.choices, row('approvals.push').choices)
  set(babysit.key, 'auto', file)
  assert.equal(load(file)['approvals.push'], 'auto')
  assert.equal(ROWS.filter(r => r.key === 'approvals.push').length, 1)
})

test('fixed rows show a value but are not settings', () => {
  const fixed = SECTIONS.flatMap(s => s.rows).filter((r): r is FixedLine => 'fixed' in r && Boolean(r.fixed))
  assert.ok(fixed.some(r => r.label === 'Shortcut' && r.fixed === 'Meta+A'))
  for (const r of fixed) assert.equal((r as { key?: string }).key, undefined)
})

test('Approvals’ popup key is the Keybinds row, so moving it in either place moves both', () => {
  const popup = shownAs('approvals', 'Popup key')
  assert.equal(popup.key, 'keys.approvals')
  assert.equal(popup.type, 'key')
  assert.equal(popup.default, 'alt+a')
})

test('a list of viewer modes needs each mode once, added ones named with a command, and one on', () => {
  const r = row('workspace.modes')
  const four = r.default
  assert.ok(valid(r, [{ id: 'diff', on: true }, { id: 'x-lazygit', name: 'lazygit', cmd: 'lazygit', on: false }]))
  assert.ok(!valid(r, four.map(m => ({ ...m, on: false }))), 'none on')
  assert.ok(!valid(r, [...four, { id: 'diff', on: true }]), 'twice')
  assert.ok(!valid(r, [...four, { id: 'lazygit', name: 'lazygit', cmd: 'lazygit', on: true }]), 'added without x-')
  assert.ok(!valid(r, [...four, { id: 'x-a', name: 'a', cmd: '  ', on: true }]), 'no command')
  assert.ok(!valid(r, [...four, { id: 'x-a', name: 'a\tb', cmd: 'a', on: true }]), 'a tab in the name')
})

test('a saved list of modes missing a built-in one gets it back at the end, on', () => {
  const file = fresh()
  writeFileSync(file, JSON.stringify({ 'workspace.modes': [{ id: 'todo', on: true }, { id: 'files', on: false }] }))
  assert.deepEqual(
    load(file)['workspace.modes'].map(m => [m.id, m.on]),
    [['todo', true], ['files', false], ['diff', true], ['diagrams', true]],
  )
  assert.equal(show(row('workspace.modes'), load(file)['workspace.modes']), 'Todo, Diff, Diagrams')
})

test('a bad entry in a saved list of modes costs only itself', () => {
  const file = fresh()
  const good = { id: 'x-lazygit', name: 'lazygit', cmd: 'lazygit', on: true }
  writeFileSync(
    file,
    JSON.stringify({
      'workspace.modes': [
        { id: 'diff', on: false },
        good,
        { id: 'x-long', name: 'a name far longer than any mode may have', cmd: 'x', on: true },
        { id: 'gone', on: true },
        { id: 'diff', on: true },
      ],
    }),
  )
  assert.deepEqual(
    load(file)['workspace.modes'].map(m => [m.id, m.on]),
    [['diff', false], ['x-lazygit', true], ['files', true], ['todo', true], ['diagrams', true]],
  )
  // A list with nothing good in it, and none on, reads as the default.
  writeFileSync(file, JSON.stringify({ 'workspace.modes': [{ id: 'gone', on: true }, ...row('workspace.modes').default.map(m => ({ ...m, on: false }))] }))
  assert.deepEqual(load(file)['workspace.modes'], row('workspace.modes').default)
})

test('an added mode’s id comes from its name and is never one the list has', () => {
  assert.equal(addedId('Lazy Git!', []), 'x-lazy-git')
  assert.equal(addedId('lazy git', [{ id: 'x-lazy-git' }]), 'x-lazy-git-2')
  assert.equal(addedId('日本', []), 'x-mode')
})

test('hosts: names typed comma or space apart, a scheme or path dropped; anything else isn’t a host', () => {
  assert.deepEqual(parseHosts('github.com, https://GHE.corp.example/x  ghe.corp.example'), ['github.com', 'ghe.corp.example'])
  assert.deepEqual(parseHosts('gitlab.example.com:8443'), ['gitlab.example.com:8443'])
  assert.deepEqual(parseHosts(''), [])
  assert.equal(parseHosts('not a/host'), null)
  assert.equal(parseHosts('bad_host.com'), null)
  const r = row('monitors.gitlabHosts')
  assert.equal(valid(r, ['a.example', 'a.example']), false, 'each once')
  assert.equal(valid(r, Array.from({ length: 9 }, (_, i) => `h${i}.example`)), false, 'no more than eight')
  assert.equal(show(r, []), 'none')
  assert.equal(show(row('monitors.githubHosts'), ['github.com', 'ghe.example']), 'github.com, ghe.example')
})

test('Settings › Monitors: PR, the key, Pipelines and Logs, each model and effort set there only', () => {
  const sec = SECTIONS.find(s => s.id === 'monitors')!
  assert.deepEqual(
    sec.rows.filter(r => 'head' in r).map(r => ('head' in r ? r.head : '')),
    ['PR', 'Key', 'Pipelines', 'Logs'],
  )
  const keys = sec.rows.filter(isSetting).map(r => r.key)
  for (const k of ['newAgent.pr.model', 'newAgent.pr.effort', 'newAgent.logs.model', 'newAgent.logs.effort', 'monitors.pipelines.model', 'monitors.pipelines.effort']) {
    assert.ok(keys.includes(k as never), k)
    const elsewhere = SECTIONS.filter(x => x.id !== 'monitors' && x.rows.some(r => isSetting(r) && r.key === k))
    assert.deepEqual(elsewhere.map(x => x.id), [], `${k} shows only in Monitors`)
  }
  assert.equal(row('newAgent.logs.model').default, 'haiku')
  assert.equal(row('newAgent.logs.effort').default, 'low')
  assert.equal(row('monitors.pipelines.model').default, 'haiku')
  assert.equal(show(row('monitors.pipelines.refs'), row('monitors.pipelines.refs').default), 'default branch, v*')
  assert.equal(show(row('monitors.pipelines.projects'), []), 'ones with an open PR')
  assert.equal(show(row('monitors.logs.kubeconfig'), ''), '~/.kube/config')
  assert.equal(show(row('monitors.logs.envs'), row('monitors.logs.envs').default), 'local, qa, stage, eu, ca, us')
  assert.equal(show(row('monitors.logs.level'), 'warn'), 'warn and up')
})

test('a list: words comma apart, each once and matching its row; too many or a bad one isn’t taken', () => {
  const projects = row('monitors.pipelines.projects')
  assert.deepEqual(parseList(projects, ' gitlab.example.com/platform/api, github.com/jl/dotfiles ,, gitlab.example.com/platform/api'), ['gitlab.example.com/platform/api', 'github.com/jl/dotfiles'])
  assert.deepEqual(parseList(projects, ''), [])
  assert.equal(parseList(projects, 'platform/api'), null, 'a project names its host')
  const refs = row('monitors.pipelines.refs')
  assert.deepEqual(parseList(refs, 'default branch, v*, release/*'), ['default branch', 'v*', 'release/*'])
  assert.equal(parseList(refs, 'two words'), null)
  const prot = row('monitors.logs.protected')
  assert.deepEqual(parseList(prot, 'eu, prod-*, us-?'), ['eu', 'prod-*', 'us-?'])
  assert.deepEqual(row('monitors.logs.protected').default, [], 'none ask first')
  assert.equal(valid(prot, Array.from({ length: 13 }, (_, i) => `c${i}`)), false, 'no more than twelve')
  assert.equal(valid(prot, ['a', 'a']), false, 'each once')
})

test('Environments always has local: typed without it, it goes first; a saved list without it isn’t taken', () => {
  const envs = row('monitors.logs.envs')
  assert.deepEqual(parseList(envs, 'qa, eu'), ['local', 'qa', 'eu'])
  assert.deepEqual(parseList(envs, 'eu, local'), ['eu', 'local'], 'where you put it')
  assert.deepEqual(parseList(envs, ''), ['local'])
  assert.equal(parseList(envs, 'qa-*'), null, 'a name, not a pattern')
  assert.equal(valid(envs, ['qa']), false)
  assert.equal(valid(envs, ['local']), true)
})

test('Default folder is General’s, first; Todo’s old Default repo carries over until it’s saved', () => {
  assert.equal(SECTIONS[0].id, 'general')
  const file = fresh()
  assert.equal(defaultFolderSetting(load(file)), '~/projects', 'none set')
  writeFileSync(file, JSON.stringify({ 'todo.handoff.defaultRepo': '~/projects/personal' }))
  assert.equal(load(file)['general.folder'], '~/projects/personal')
  set('general.folder', '~/work', file)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'general.folder': '~/work' }, 'the old key goes')
  writeFileSync(file, JSON.stringify({ 'todo.handoff.defaultRepo': '~/a' }))
  reset('general.folder', file)
  assert.equal(load(file)['general.folder'], '', 'reset stays reset')
})

test('an agent with no folder starts in the Default folder, or home when it isn’t on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'folder-'))
  const v = { ...load(fresh()), 'general.folder': dir }
  assert.equal(defaultFolder(v), dir)
  assert.equal(defaultFolder({ ...v, 'general.folder': join(dir, 'gone') }), homedir())
})
