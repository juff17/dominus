import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

import { tokens } from '../../tui/term.ts'
import { SECTIONS, get, isSetting, row, set } from '../../settings/settings.ts'
import * as nav from './state.ts'
import { AGENTS } from '../../settings/prompts.ts'
import { type FileInput, type Input, type ModeItem, type SettingsState, current, items, mayClose, onKey, start } from './state.ts'

const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const UP = '\x1b[A'
const DOWN = '\x1b[B'

// Each test gets its own empty settings file.
beforeEach(() => {
  process.env.AGENT_HUB_SETTINGS = join(mkdtempSync(join(tmpdir(), 'settings-nav-')), 'settings.json')
})

function on(key: string) {
  const sec = SECTIONS.findIndex(s => s.rows.some(r => isSetting(r) && r.key === key))
  const s = start(SECTIONS[sec].id)
  s.sel = items(s).findIndex(r => r.key === key)
  return s
}
const press = (s: SettingsState, ...keys: string[]) => keys.map(k => onKey(s, k))

test('← lowers a number and → raises it, a step at a time', () => {
  const key = 'layout.diagramsPercent'
  const s = on(key)
  const { default: def, step } = row(key)
  press(s, LEFT)
  assert.equal(get(key), def - step)
  press(s, LEFT, LEFT)
  assert.equal(get(key), def - 3 * step)
  press(s, RIGHT)
  assert.equal(get(key), def - 2 * step)
  press(s, 'l')
  assert.equal(get(key), def - step)
  press(s, 'h')
  assert.equal(get(key), def - 2 * step)
})

test('a number stops at the ends of its range', () => {
  const key = 'layout.diagramsPercent'
  const s = on(key)
  set(key, row(key).min)
  press(s, LEFT)
  assert.equal(get(key), row(key).min)
  set(key, row(key).max)
  press(s, RIGHT)
  assert.equal(get(key), row(key).max)
})

test('← and → walk a choice back and on, round the list', () => {
  const key = 'newAgent.task.model'
  const s = on(key)
  const values = row(key).choices.map(c => c.value)
  const at = values.indexOf(row(key).default)
  press(s, RIGHT)
  assert.equal(get(key), values[(at + 1) % values.length])
  press(s, LEFT, LEFT)
  assert.equal(get(key), values[(at - 1 + values.length) % values.length])
})

test('on a row of flags ← and → pick a flag, and space turns it over', () => {
  const key = 'hub.broke'
  const s = on(key)
  const values = row(key).choices.map(c => c.value)
  press(s, RIGHT, RIGHT)
  assert.equal(s.flag, 2)
  press(s, LEFT, LEFT, LEFT)
  assert.equal(s.flag, values.length - 1)
  assert.deepEqual(get(key), row(key).default)
  press(s, ' ')
  assert.deepEqual(get(key), values.slice(0, -1))
})

test('space turns a switch over, and r puts it back', () => {
  const key = 'hub.askStopMonitor'
  const s = on(key)
  press(s, ' ')
  assert.equal(get(key), !row(key).default)
  press(s, 'r')
  assert.equal(get(key), row(key).default)
})

test('↑ and ↓ move between settings, stopping at the ends', () => {
  const s = start('newAgent')
  press(s, DOWN, DOWN)
  assert.equal(s.sel, 2)
  press(s, UP)
  assert.equal(s.sel, 1)
  press(s, UP, UP)
  assert.equal(s.sel, 0)
  press(s, 'G', DOWN)
  assert.equal(current(s), items(s).at(-1))
})

test('tab and shift+tab move between sections, round the list', () => {
  const s = start(SECTIONS[0].id)
  press(s, DOWN, '\t')
  assert.deepEqual([s.sec, s.sel], [1, 0])
  press(s, '\x1b[Z', '\x1b[Z')
  assert.equal(s.sec, SECTIONS.length - 1)
})

// Ctrl+C and the Settings key close it in the overlay (tui/overlay.ts), when
// mayClose says they may.
test('esc and q close it; other keys don’t', () => {
  for (const k of ['\x1b', 'q']) assert.equal(onKey(start(), k), 'quit', JSON.stringify(k))
  for (const k of [LEFT, RIGHT, UP, DOWN, ' ', 'x', 'e', 'v']) assert.equal(onKey(start(), k), undefined, JSON.stringify(k))
})

test('a failed save shows in the footer and leaves the value', () => {
  // Its folder is a file, so the folder can't be made.
  const file = join(mkdtempSync(join(tmpdir(), 'settings-nav-')), 'file')
  writeFileSync(file, '')
  process.env.AGENT_HUB_SETTINGS = join(file, 'settings.json')
  const s = on('layout.diagramsPercent')
  press(s, LEFT)
  assert.match(s.note?.text ?? '', /^Couldn't save/)
  assert.equal(get('layout.diagramsPercent'), row('layout.diagramsPercent').default)
})

// Clicks used to step a value forward wherever they landed, ‹ included, so
// the panel takes keys only now.
test('takes no clicks: a click is a mouse report, never a key', () => {
  assert.equal((nav as Record<string, unknown>).onMouse, undefined)
  const click = [...tokens('\x1b[<0;60;8M\x1b[<0;60;8m')]
  assert.equal(click.length, 2)
  assert.ok(click.every(t => t.mouse && !t.key))
})

test('Task, the hand-off and filing say where their instructions are, and ↑↓ passes over it', () => {
  const where = SECTIONS.flatMap(x => x.rows.flatMap(r => ('prompt' in r ? [r.prompt] : [])))
  assert.deepEqual(where.sort(), [...AGENTS].sort())
  for (const x of SECTIONS) assert.ok(!items(start(x.id)).some(r => 'prompt' in r), x.id)
  assert.ok(!SECTIONS.some(x => x.rows.some(r => 'type' in r && (r.type as string) === 'skill')), 'no skills to pick')
})

test('↵ on a keybind waits for a key, which is saved and applied', () => {
  let applied = 0
  nav.effects.applyKeys = () => {
    applied++
    return ''
  }
  const s = on('keys.help')
  press(s, '\r')
  assert.equal(s.capture, true)
  press(s, '\x1bx')
  assert.deepEqual([s.capture, get('keys.help'), applied], [false, 'alt+x', 1])
  press(s, '\x7f')
  assert.equal(get('keys.help'), '')
  press(s, 'r')
  assert.equal(get('keys.help'), 'alt+h')
})

test('a keybind another row has is refused, and esc cancels the wait', () => {
  nav.effects.applyKeys = () => ''
  const s = on('keys.help')
  press(s, '\r', '\x1bt')
  assert.match(s.note?.text ?? '', /taken by Todo popup/)
  assert.equal(get('keys.help'), 'alt+h')
  assert.equal(press(s, '\r', '\x1b')[1], undefined)
  assert.equal(s.capture, false)
  press(s, LEFT, RIGHT)
  assert.equal(get('keys.help'), 'alt+h')
})

test('the overlay’s own keys may close it, but not while a path is typed or a key captured', () => {
  assert.equal(mayClose(start()), true)
  assert.equal(mayClose({ ...start(), capture: true }), false)
})

function onMode(i: number) {
  const s = start('workspace')
  s.sel = items(s).findIndex(r => r.type === 'mode' && r.index === i)
  return s
}
const modes = () => get('workspace.modes').map(m => `${m.id}${m.on ? '' : ' off'}`)

test('Workspace lists a row per viewer mode, then one to add a mode', () => {
  const s = start('workspace')
  const rows = items(s).filter(r => r.key === 'workspace.modes')
  assert.deepEqual(rows.map(r => r.label), ['Files', 'Diff', 'Todo', 'Diagrams', '+ Add a mode'])
})

test('space turns a mode off and on, but the last one on stays on', () => {
  const s = onMode(1)
  press(s, ' ')
  assert.deepEqual(modes(), ['files', 'diff off', 'todo', 'diagrams'])
  press(s, RIGHT)
  assert.deepEqual(modes(), ['files', 'diff', 'todo', 'diagrams'])
  set('workspace.modes', [{ id: 'files', on: true }, { id: 'diff', on: false }, { id: 'todo', on: false }, { id: 'diagrams', on: false }])
  press(onMode(0), ' ')
  assert.equal(get('workspace.modes')[0].on, true)
})

test('J and K move a mode down and up, and it stays selected', () => {
  const s = onMode(0)
  press(s, 'J', 'J')
  assert.deepEqual(modes(), ['diff', 'todo', 'files', 'diagrams'])
  assert.equal((current(s) as ModeItem).mode.id, 'files')
  press(s, 'K')
  assert.deepEqual(modes(), ['diff', 'files', 'todo', 'diagrams'])
  press(onMode(3), 'J')
  assert.deepEqual(modes(), ['diff', 'files', 'todo', 'diagrams'], 'the last stays last')
})

test('a adds a mode from a name and a command; esc gives up', () => {
  const s = onMode(0)
  press(s, 'a', ...'lazygit', '\r', ...'lazygit', '\r')
  assert.deepEqual(get('workspace.modes').at(-1), { id: 'x-lazygit', name: 'lazygit', cmd: 'lazygit', on: true })
  assert.equal((current(s) as ModeItem).mode.id, 'x-lazygit')
  assert.equal(s.input, null)
  press(s, 'a', ...'tig', '\x1b')
  assert.equal(s.input, null)
  assert.equal(get('workspace.modes').length, 5)
})

test('typing into a new mode takes q and esc as text, not as closing the panel', () => {
  const s = onMode(0)
  assert.deepEqual(press(s, 'a', 'q'), [undefined, undefined])
  assert.equal(s.input?.text, 'q')
  press(s, '\x7f', '\r')
  assert.equal(s.input?.field, 'name', 'a name is needed first')
  nav.typeText(s, 'two\nlines')
  assert.equal(s.input?.text, 'two lines')
})

test('an emoji typed into a new mode is kept, though it is two UTF-16 units', () => {
  const s = onMode(0)
  press(s, 'a', ...tokens(Buffer.from('🚀 x')).map(tok => tok.key ?? ''))
  assert.equal(s.input?.text, '🚀 x')
})

test('x removes a mode you added, never a built-in one', () => {
  set('workspace.modes', [...get('workspace.modes'), { id: 'x-tig', name: 'tig', cmd: 'tig', on: true }])
  press(onMode(1), 'x')
  assert.equal(get('workspace.modes').length, 5)
  press(onMode(4), 'x')
  assert.deepEqual(modes(), ['files', 'diff', 'todo', 'diagrams'])
})

test('r on a mode puts the built-in ones back in order and on, keeping added ones', () => {
  set('workspace.modes', [{ id: 'x-tig', name: 'tig', cmd: 'tig', on: true }, { id: 'todo', on: false }, { id: 'files', on: true }])
  const s = onMode(0)
  press(s, 'r')
  assert.deepEqual(modes(), ['files', 'diff', 'todo', 'diagrams', 'x-tig'])
  assert.equal((current(s) as ModeItem).mode.id, 'x-tig', 'the reset mode stays selected')
})

test('without yazi, Files alone on is refused, as the viewer pane could run nothing', () => {
  const hasYazi = nav.effects.hasYazi
  try {
    nav.effects.hasYazi = () => false
    set('workspace.modes', [{ id: 'files', on: true }, { id: 'diff', on: true }, { id: 'todo', on: false }, { id: 'diagrams', on: false }])
    const s = onMode(1)
    press(s, ' ')
    assert.deepEqual(modes(), ['files', 'diff', 'todo off', 'diagrams off'])
    assert.notEqual(s.note, null)
    nav.effects.hasYazi = () => true
    press(s, ' ')
    assert.deepEqual(modes(), ['files', 'diff off', 'todo off', 'diagrams off'])
  } finally {
    nav.effects.hasYazi = hasYazi
  }
})

test('a mode taken out from elsewhere leaves the cursor on the row it was on', () => {
  const tig = { id: 'x-tig', name: 'tig', cmd: 'tig', on: true }
  set('workspace.modes', [...get('workspace.modes'), tig])
  // On the last row, as the panel last drew it.
  const last = on('workspace.startMode')
  press(last, DOWN)
  // Another client's panel, or a hand edit, takes x-tig out.
  set('workspace.modes', get('workspace.modes').filter(m => m.id !== 'x-tig'))
  press(last, RIGHT)
  assert.equal(current(last).key, 'workspace.popupsWhenOff')
  assert.equal(get('workspace.popupsWhenOff'), 'off')

  set('workspace.modes', [...get('workspace.modes'), tig])
  const mid = on('workspace.startMode')
  press(mid, 'v')
  set('workspace.modes', get('workspace.modes').filter(m => m.id !== 'x-tig'))
  press(mid, RIGHT)
  assert.equal(current(mid).key, 'workspace.startMode')
  assert.equal(get('workspace.startMode'), 'files')
  assert.equal(get('workspace.popupsWhenOff'), 'off', 'the row now at its old place is left alone')
})

test('the footer note goes when the cursor moves off its row', () => {
  nav.effects.applyKeys = () => ''
  const s = on('keys.help')
  press(s, '\r', '\x1bt')
  assert.notEqual(s.note, null)
  press(s, DOWN)
  assert.equal(s.note, null)
  press(s, UP, '\r', '\x1bt')
  assert.notEqual(s.note, null)
  press(s, '\t')
  assert.equal(s.note, null)
})

test('a keybind saved but not taken up says so, not that it was not saved', () => {
  nav.effects.applyKeys = () => {
    throw new Error('EPERM')
  }
  try {
    const s = on('keys.help')
    press(s, '\r', '\x1bx')
    assert.equal(get('keys.help'), 'alt+x')
    assert.doesNotMatch(s.note?.text ?? '', /^Couldn't save/)
    assert.match(s.note?.text ?? '', /EPERM/)
    // tmux refusing the file, which apply() says rather than throws.
    nav.effects.applyKeys = () => 'keys.tmux.conf:3: unknown command: bnid'
    press(s, '\r', '\x1by')
    assert.equal(s.note?.text, 'Saved, but not applied: keys.tmux.conf:3: unknown command: bnid')
  } finally {
    nav.effects.applyKeys = () => ''
  }
})

test('J and K still change section outside the list of modes', () => {
  const s = on('workspace.startMode')
  press(s, 'J')
  assert.equal(SECTIONS[s.sec].id, 'layout')
})

test('↵ on Sound file types a path; only a file that is there is saved, and backspace clears it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sound-'))
  const ding = join(dir, 'ding.oga')
  writeFileSync(ding, '')
  const s = on('tray.soundFile')
  press(s, '\r', ...join(dir, 'nope.oga'), '\r')
  assert.match(s.note?.text ?? '', /No file at/)
  assert.notEqual(s.input, null, 'stays open to fix it')
  assert.equal(get('tray.soundFile'), '')
  press(s, '\x1b', '\r', ...'ding.oga', '\r')
  assert.match(s.note?.text ?? '', /whole path/)
  press(s, '\x1b', '\r', ...ding, '\r')
  assert.equal(s.input, null)
  assert.equal(get('tray.soundFile'), ding)
  press(s, '\r')
  assert.equal((s.input as Input | null)?.text, ding, 'starts from the path it has')
  press(s, '\x1b', RIGHT, '\x7f')
  assert.equal(get('tray.soundFile'), '')
})

test('↵ on Default repo takes a folder, not a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'))
  const file = join(dir, 'README')
  writeFileSync(file, '')
  const s = on('general.folder')
  press(s, '\r', ...file, '\r')
  assert.match(s.note?.text ?? '', /No folder at/)
  assert.equal(get('general.folder'), '')
  press(s, '\x1b', '\r', ...dir, '\r')
  assert.equal(s.input, null)
  assert.equal(get('general.folder'), dir)
})

test('a path that is not whole, or has a line break, is not a sound file', () => {
  const r = row('tray.soundFile')
  assert.ok(set('tray.soundFile', '~/a.oga'))
  assert.throws(() => set('tray.soundFile', 'a.oga'))
  assert.throws(() => set('tray.soundFile', '/a\nb.oga'))
  assert.equal(r.default, '')
})

test('a typed path completes as in a shell: tab fills in, steps through matches, → takes the suggestion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repos-'))
  for (const d of ['alpha', 'alphabet', 'beta']) mkdirSync(join(dir, d))
  writeFileSync(join(dir, 'bee.txt'), '')
  const s = on('general.folder')
  press(s, '\r', ...`${dir}/b`, '\t')
  assert.equal(s.input?.text, `${dir}/beta/`, 'a folder row offers only folders')
  press(s, '\x15', ...`${dir}/al`, '\t')
  assert.equal(s.input?.text, `${dir}/alpha`, 'what several share')
  press(s, '\t', '\t')
  assert.equal(s.input?.text, `${dir}/alphabet/`, 'then each in turn')
  press(s, '\x1b[Z')
  assert.equal(s.input?.text, `${dir}/alpha/`)
  press(s, '\x17', ...'al')
  assert.equal(s.input?.text, `${dir}/al`, 'ctrl+w takes a word back')
  assert.equal(nav.pathGhost(s.input as Input), 'pha/')
  press(s, RIGHT, '\r')
  assert.equal(get('general.folder'), `${dir}/alpha`, 'saved without the slash')
  const f = on('tray.soundFile')
  press(f, '\r', ...`${dir}/be`, '\t')
  assert.equal((f.input as FileInput).menu?.names.join(' '), 'bee.txt beta', 'a file row offers files too')
})

test('the home folder can be the default repo, typed as ~/', () => {
  const s = on('general.folder')
  press(s, '\r', ...'~/', '\r')
  assert.equal(s.input, null)
  assert.equal(get('general.folder'), '~/')
})

test('a typed path stops at the longest one a setting takes, as a pasted one does', () => {
  const s = on('tray.soundFile')
  press(s, '\r', ...`/${'a'.repeat(600)}`)
  assert.equal(s.input?.text.length, 500)
})

test('a save that fails keeps what was typed in the footer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sound-'))
  const ding = join(dir, 'ding.oga')
  writeFileSync(ding, '')
  // Its folder is a file, so the folder can't be made.
  const file = join(mkdtempSync(join(tmpdir(), 'settings-nav-')), 'file')
  writeFileSync(file, '')
  process.env.AGENT_HUB_SETTINGS = join(file, 'settings.json')
  const f = on('tray.soundFile')
  press(f, '\r', ...ding, '\r')
  assert.match(f.note?.text ?? '', /^Couldn't save/)
  assert.equal(f.input?.text, ding)
  const m = onMode(0)
  press(m, 'a', ...'lazygit', '\r', ...'lazygit', '\r')
  assert.match(m.note?.text ?? '', /^Couldn't save/)
  assert.deepEqual([m.input?.field, m.input?.text], ['cmd', 'lazygit'])
})

test('a row of hosts: ↵ types them in the footer, ↵ saves, a bad list stays to fix, backspace clears', () => {
  const s = on('monitors.gitlabHosts')
  press(s, '\r')
  assert.deepEqual(s.input, { field: 'hosts', key: 'monitors.gitlabHosts', label: 'GitLab hosts', text: '' })
  for (const t of tokens('gitlab.example.com bad/host')) press(s, t.key ?? '')
  press(s, '\r')
  assert.match(s.note?.text ?? '', /Not a list of hosts/)
  assert.deepEqual(get('monitors.gitlabHosts'), [])
  for (let i = 0; i < 9; i++) press(s, '\x7f')
  nav.typeText(s, ', git.corp.example')
  press(s, '\r')
  assert.equal(s.input, null)
  assert.deepEqual(get('monitors.gitlabHosts'), ['gitlab.example.com', 'git.corp.example'])
  press(s, '\r')
  assert.equal((s.input as Input | null)?.text, 'gitlab.example.com, git.corp.example', 'it starts from the hosts it has')
  press(s, '\x1b', LEFT, '\x7f')
  assert.deepEqual(get('monitors.gitlabHosts'), [], '← does nothing; backspace clears')
})

test('a row of words: ↵ types them comma apart, a bad one stays to fix, backspace clears to the empty label', () => {
  const s = on('monitors.logs.protected')
  press(s, '\r')
  assert.deepEqual(s.input, { field: 'list', key: 'monitors.logs.protected', label: 'Protected', text: '' })
  nav.typeText(s, 'eu, two words')
  press(s, '\r')
  assert.match(s.note?.text ?? '', /Not a list it takes/)
  assert.deepEqual(get('monitors.logs.protected'), [])
  for (let i = 0; i < 10; i++) press(s, '\x7f')
  nav.typeText(s, 'us-*')
  press(s, '\r')
  assert.equal(s.input, null)
  assert.deepEqual(get('monitors.logs.protected'), ['eu', 'us-*'])
  press(s, '\x7f')
  assert.deepEqual(get('monitors.logs.protected'), [])
})

test('Environments: backspace clears it to local alone, which it always keeps', () => {
  const s = on('monitors.logs.envs')
  press(s, '\x7f')
  assert.deepEqual(get('monitors.logs.envs'), ['local'])
  press(s, '\r')
  nav.typeText(s, ', qa')
  press(s, '\r')
  assert.deepEqual(get('monitors.logs.envs'), ['local', 'qa'])
})
