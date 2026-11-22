// node --test ghostty/hub/newagent/newagent.test.ts
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { type TaskSpec, launch } from '../../agents/model.ts'
import type { Done, Field, Form } from './newagent.ts'

// The form reads home once, as it loads, for ~ and the default folder.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'hub-newagent-')))
process.env.HOME = HOME
process.env.AGENT_HUB_PROMPTS = join(HOME, 'prompts')
process.env.AGENT_HUB_SETTINGS = join(HOME, 'settings.json')
// A refused save logs an error; it goes here, not to the real logs.
process.env.AGENT_HUB_LOG_DIR = join(HOME, 'logs')
process.env.AGENT_HUB_IMAGES = join(HOME, 'images')
after(() => rmSync(HOME, { recursive: true, force: true }))
const P = join(HOME, 'projects')
for (const d of ['alpha', 'alphabet', 'Beta', '.hidden', 'alpha/.claude/worktrees/fix-x']) mkdirSync(join(P, d), { recursive: true })
symlinkSync(join(P, 'alpha'), join(P, 'linked'))
symlinkSync(join(P, 'missing'), join(P, 'broken'))
writeFileSync(join(P, 'notes.txt'), '')

const { POPUP, attach, fields, form, key, matchesOf, pick, save, scrollTo, suggestion } = await import('./newagent.ts')
const { tokens } = await import('../../tui/term.ts')

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const SHIFT_TAB = '\x1b[Z'
const CTRL_S = '\x13'
const type = (s: string) => [...s].forEach(c => key(c))
const keys = (...ks: string[]) => ks.map(k => key(k))
const at = (d: Form, field: Field) => ((d.field = field), d)
const specOf = (r: Done | undefined): TaskSpec => {
  assert.ok(r?.done, 'the form finished with a spec')
  return r.done
}

test('a new form is a task, in its own worktree, on the prompt, with opus, auto and medium', () => {
  const d = form({ folder: join(P, 'alpha'), recents: [join(P, 'beta'), join(P, 'alpha')] })
  assert.equal(d.field, 'prompt')
  assert.equal(d.folder.text, '~/projects/alpha')
  assert.equal(d.folder.at, d.folder.text.length)
  assert.equal(d.recent, 1)
  assert.deepEqual(fields(), ['prompt', 'where', 'folder', 'recent', 'branch', 'model', 'mode', 'effort', 'chrome', 'start'])
  type('go')
  const done = specOf(key(CTRL_S))
  assert.deepEqual(done, {
    kind: 'task',
    cwd: join(P, 'alpha'),
    prompt: 'go',
    worktree: true,
    model: 'opus',
    mode: 'auto',
    effort: 'medium',
    chrome: false,
  })
})

test('Chrome on launches with --chrome; off leaves it out', () => {
  const d = form({ folder: P })
  type('browse')
  at(d, 'chrome')
  keys(RIGHT)
  const done = specOf(key(CTRL_S))
  assert.equal(done.chrome, true)
  assert.deepEqual(launch(done).argv.slice(4, 11), ['--model', 'opus', '--permission-mode', 'auto', '--effort', 'medium', '--chrome'])
  assert.ok(!launch({ ...done, chrome: false }).argv.includes('--chrome'))
})

test('the folder is the repo when given a worktree, else the newest recent, else ~/projects', () => {
  assert.equal(form({ folder: join(P, 'alpha/.claude/worktrees/fix-x') }).folder.text, '~/projects/alpha')
  assert.equal(form({ recents: [join(P, 'Beta')] }).folder.text, '~/projects/Beta')
  assert.equal(form().folder.text, '~/projects')
  // Outside home the path stays as it is.
  assert.equal(form({ folder: '/srv/app' }).folder.text, '/srv/app')
  assert.equal(form({ folder: '/srv/app', recents: ['/x'] }).recent, -1)
})

test('with Default folder at ~/projects, the form starts there whatever is selected', async () => {
  const { set } = await import('../../settings/settings.ts')
  set('newAgent.defaultFolder', 'projects')
  try {
    assert.equal(form({ folder: join(P, 'alpha'), recents: [join(P, 'Beta')] }).folder.text, '~/projects')
  } finally {
    set('newAgent.defaultFolder', 'tab')
  }
})

test('Runs in › Default starts in General’s Default folder, on its current branch, with no folder to pick', async () => {
  const d = form({ folder: join(P, 'alpha'), recents: [join(P, 'alpha')] })
  type('check my calendar')
  keys(DOWN, RIGHT)
  assert.equal(d.field, 'where')
  assert.deepEqual(fields(), ['prompt', 'where', 'branch', 'model', 'mode', 'effort', 'chrome', 'start'])
  const done = specOf(key(CTRL_S))
  assert.equal(done.cwd, P)
  assert.equal(done.worktree, false)
  assert.doesNotMatch(launch(done).argv.at(-1) ?? '', /EnterWorktree/)
  const { set } = await import('../../settings/settings.ts')
  set('general.folder', join(P, 'Beta'))
  try {
    assert.equal(specOf(key(CTRL_S)).cwd, join(P, 'Beta'))
  } finally {
    set('general.folder', '')
  }
  // Back to Select folder, the folder typed is still there.
  keys(LEFT)
  assert.equal(specOf(key(CTRL_S)).cwd, join(P, 'alpha'))
})

test('Branch under Default can still be a worktree, and each Runs in choice keeps its own', () => {
  const d = form({ folder: P })
  type('go')
  at(d, 'where')
  keys(RIGHT)
  at(d, 'branch')
  keys(RIGHT)
  assert.equal(specOf(key(CTRL_S)).worktree, true)
  at(d, 'where')
  keys(LEFT)
  at(d, 'branch')
  keys(RIGHT)
  assert.equal(specOf(key(CTRL_S)).worktree, false, 'Select folder started on Worktree')
  at(d, 'where')
  keys(RIGHT)
  assert.equal(specOf(key(CTRL_S)).worktree, true, 'Default kept its Worktree')
})

test('Runs in › Default needs no folder on disk: a bad Folder is left for Select folder', () => {
  const d = form({ folder: join(P, 'nope') })
  type('go')
  at(d, 'where')
  keys(RIGHT)
  assert.equal(specOf(key(CTRL_S)).cwd, P)
})

test('Esc and Ctrl+C cancel without a spec', () => {
  form()
  assert.deepEqual(key('\x1b'), { done: null })
  form()
  assert.deepEqual(key('\x03'), { done: null })
})

test('Start needs a prompt, and puts you on it', () => {
  const d = form({ folder: P })
  at(d, 'model')
  assert.equal(key(CTRL_S), undefined)
  assert.equal(d.field, 'prompt')
  assert.equal(d.error, 'Give the task a first prompt')
  type('   ')
  assert.equal(key(CTRL_S), undefined)
  // The error goes with the next key.
  type('x')
  assert.equal(d.error, null)
  assert.equal(specOf(key(CTRL_S)).prompt, '   x')
})

test('Start needs a folder that exists, and puts you on it', () => {
  const d = form({ folder: join(P, 'nope') })
  type('go')
  assert.equal(key(CTRL_S), undefined)
  assert.equal(d.field, 'folder')
  assert.equal(d.error, 'No folder ~/projects/nope')
  form({ folder: join(P, 'notes.txt') })
  type('go')
  assert.equal(key(CTRL_S), undefined)
})

test('the folder may be ~, end in slashes, or be empty for home', () => {
  const d = form()
  type('go')
  d.folder = { text: ' ~/projects/alpha// ', at: 0 }
  assert.equal(specOf(key(CTRL_S)).cwd, join(P, 'alpha'))
  d.folder = { text: '', at: 0 }
  assert.equal(specOf(key(CTRL_S)).cwd, HOME)
})

test('/ is the root, not home', () => {
  const d = form()
  type('go')
  d.folder = { text: '/', at: 0 }
  assert.equal(specOf(key(CTRL_S)).cwd, '/')
  d.folder = { text: '///', at: 0 }
  assert.equal(specOf(key(CTRL_S)).cwd, '/')
})

test('a relative folder is from the popup\'s folder, and the spec carries it absolute', () => {
  const was = process.cwd()
  process.chdir(HOME)
  try {
    const d = form()
    type('go')
    d.folder = { text: 'projects/alpha/', at: 0 }
    assert.equal(specOf(key(CTRL_S)).cwd, join(P, 'alpha'))
    d.folder = { text: '.', at: 0 }
    assert.equal(specOf(key(CTRL_S)).cwd, HOME)
  } finally {
    process.chdir(was)
  }
})

test('a folder beside home keeps its whole path rather than ~ and the rest', () => {
  const beside = `${HOME}2`
  mkdirSync(join(beside, 'app'), { recursive: true })
  try {
    const d = form({ folder: join(beside, 'app') })
    assert.equal(d.folder.text, join(beside, 'app'))
    type('go')
    assert.equal(specOf(key(CTRL_S)).cwd, join(beside, 'app'))
  } finally {
    rmSync(beside, { recursive: true, force: true })
  }
})

test('Enter moves to the next field, and starts on Start', () => {
  const d = form({ folder: P })
  type('go')
  key('\r')
  assert.equal(d.field, 'where')
  at(d, 'start')
  assert.equal(specOf(key('\r')).prompt, 'go')
})

test('up, down, tab and shift+tab move between fields, held at the ends', () => {
  const d = form({ folder: P })
  // The prompt is the top field.
  keys(UP)
  assert.equal(d.field, 'prompt')
  // Tab on Folder completes rather than moving on.
  keys(DOWN, DOWN, '\t', DOWN)
  assert.equal(d.field, 'recent')
  keys(SHIFT_TAB, SHIFT_TAB, SHIFT_TAB, SHIFT_TAB)
  assert.equal(d.field, 'prompt')
  keys(DOWN, DOWN)
  assert.equal(d.field, 'folder')
  d.folder = { text: '~/projects/zz', at: 13 }
  keys('\t')
  assert.equal(d.field, 'folder')
  at(d, 'start')
  keys(DOWN, '\t')
  assert.equal(d.field, 'start')
})

test('New agent starts tasks only: no kind, skill or target to choose', () => {
  form({ folder: P })
  type('go')
  const done = specOf(key(CTRL_S))
  assert.equal(done.kind, 'task')
  assert.equal('skill' in done, false)
  assert.equal('target' in done, false)
})

test('choices step with → and space, back with ←, and wrap both ways', () => {
  const d = at(form({ folder: P }), 'model')
  const model = () => ['default', 'fable', 'opus', 'sonnet', 'haiku'][d.model]
  assert.equal(model(), 'opus')
  keys(RIGHT, ' ', ' ')
  assert.equal(model(), 'default')
  keys(LEFT)
  assert.equal(model(), 'haiku')
})

test('the current branch ends up in the spec, and the agent launches in the background', () => {
  const d = form({ folder: P })
  type("fix the rail's dot")
  at(d, 'branch')
  keys(RIGHT)
  at(d, 'effort')
  keys(RIGHT)
  const done = specOf(key(CTRL_S))
  assert.equal(done.worktree, false)
  assert.equal(done.effort, 'high')
  const plan = launch(done)
  assert.deepEqual(plan.argv, ['claude', '--bg', '--name', 'fix-the-rail-s-dot', '--model', 'opus', '--permission-mode', 'auto', '--effort', 'high', "fix the rail's dot"])
})

test('a task in a worktree asks the agent to make one first', () => {
  form({ folder: P })
  type('go')
  assert.match(launch(specOf(key(CTRL_S))).argv.at(-1) ?? '', /^From the hub: Before anything else, make your own worktree [^\n]*\n\nMy prompt:\ngo$/)
})

test('Recent steps through the recents and fills Folder; with none it does nothing', () => {
  const d = at(form({ folder: join(P, 'alpha'), recents: [join(P, 'alpha'), join(P, 'Beta'), '/srv/app'] }), 'recent')
  keys(RIGHT)
  assert.equal(d.folder.text, '~/projects/Beta')
  keys(RIGHT)
  assert.equal(d.folder.text, '/srv/app')
  keys(RIGHT)
  assert.equal(d.folder.text, '~/projects/alpha')
  keys(LEFT)
  assert.equal(d.folder.text, '/srv/app')
  const e = at(form({ folder: P }), 'recent')
  keys(RIGHT)
  assert.equal(e.recent, -1)
  assert.equal(e.folder.text, '~/projects')
})

test('with Folder not among the recents, → takes the first recent and ← the last', () => {
  const recents = [join(P, 'Beta'), '/srv/app', join(P, 'alphabet')]
  const d = at(form({ folder: join(P, 'alpha'), recents }), 'recent')
  assert.equal(d.recent, -1)
  keys(RIGHT)
  assert.equal(d.recent, 0)
  assert.equal(d.folder.text, '~/projects/Beta')
  const e = at(form({ folder: join(P, 'alpha'), recents }), 'recent')
  keys(LEFT)
  assert.equal(e.recent, 2)
  assert.equal(e.folder.text, '~/projects/alphabet')
})

test('editing Folder away from a recent unmarks it, so → takes the first; back to one marks it', () => {
  const d = at(form({ folder: join(P, 'alpha'), recents: [join(P, 'alpha'), join(P, 'Beta')] }), 'folder')
  assert.equal(d.recent, 0)
  type('bet')
  assert.equal(d.folder.text, '~/projects/alphabet')
  assert.equal(d.recent, -1)
  at(d, 'recent')
  keys(RIGHT)
  assert.equal(d.recent, 0)
  assert.equal(d.folder.text, '~/projects/alpha')
  at(d, 'folder')
  keys('\x15')
  key('', '~/projects/Beta/')
  assert.equal(d.recent, 1)
})

test('text fields: arrows, home and end, backspace, ctrl+u and ctrl+w', () => {
  const d = form({ folder: P })
  type('fix bug')
  keys(LEFT, LEFT, LEFT)
  type('the ')
  assert.deepEqual(d.prompt, { text: 'fix the bug', at: 8 })
  keys('\x7f')
  assert.deepEqual(d.prompt, { text: 'fix thebug', at: 7 })
  keys('\x01', '\x7f')
  assert.deepEqual(d.prompt, { text: 'fix thebug', at: 0 })
  keys('\x05', '\x17')
  assert.deepEqual(d.prompt, { text: 'fix ', at: 4 })
  keys('\x1b[H', RIGHT, RIGHT)
  keys('\x15')
  assert.deepEqual(d.prompt, { text: 'x ', at: 0 })
  keys('\x1b[F', RIGHT)
  assert.equal(d.prompt.at, 2)
  keys('\b', '\b', '\b')
  assert.deepEqual(d.prompt, { text: '', at: 0 })
})

test('text fields: an emoji or a wide character is one step, and never cut in half', () => {
  const d = form({ folder: P })
  type('ok 😀 漢字')
  keys(LEFT, LEFT, LEFT, LEFT)
  assert.equal(d.prompt.at, 3, 'four steps back from the end is before the emoji')
  keys(RIGHT, '\x7f')
  assert.deepEqual(d.prompt, { text: 'ok  漢字', at: 3 })
})

test('an emoji typed, not pasted, is one key, so the caret lands just after it', () => {
  assert.deepEqual(
    tokens(Buffer.from('a😀b')).map(tok => tok.key),
    ['a', '😀', 'b'],
  )
  const d = form({ folder: P })
  type('ab')
  keys(LEFT)
  for (const tok of tokens(Buffer.from('😀'))) key(tok.key ?? '')
  assert.deepEqual(d.prompt, { text: 'a😀b', at: 2 })
})

test('a paste joins its lines and drops control characters; outside a text field it does nothing', () => {
  const d = form({ folder: P })
  key('', 'first line\n   second\tline\r\n')
  assert.equal(d.prompt.text, 'first line second line ')
  at(d, 'model')
  key('', 'ignored')
  assert.equal(d.prompt.text, 'first line second line ')
  assert.equal(d.model, 2)
})

test('a pasted image goes in the prompt at the caret as [Image #n], and the spec carries those still named', () => {
  const d = form({ folder: join(P, 'alpha') })
  type('fix ')
  attach({ image: '/i/one.png' })
  type(' and ')
  attach({ image: '/i/two.png' })
  assert.equal(d.prompt.text, 'fix [Image #1] and [Image #2]')
  // One Backspace deletes a placeholder whole, which takes its image out.
  key('\x7f')
  assert.equal(d.prompt.text, 'fix [Image #1] and ')
  keys('\x7f', '\x7f', '\x7f', '\x7f', '\x7f')
  assert.equal(d.prompt.text, 'fix [Image #1]')
  const done = specOf(key(CTRL_S))
  assert.deepEqual(done.images, [{ n: 1, path: '/i/one.png' }])
  assert.equal(launch(done).name, 'fix')
})

test('an image that could not be pasted says why, leaving you in the prompt; a spec without images has none', () => {
  const d = form({ folder: join(P, 'alpha') })
  attach({ error: 'No image on the clipboard' })
  assert.equal(d.error, 'No image on the clipboard')
  assert.equal(d.field, 'prompt')
  type('go')
  assert.equal(d.error, null)
  assert.equal('images' in specOf(key(CTRL_S)), false)
})

test('pasting an image file into the prompt attaches a copy; into Folder it is text', () => {
  const shot = join(HOME, 'shot.png')
  writeFileSync(shot, 'png')
  const d = form({ folder: join(P, 'alpha') })
  key('', shot)
  assert.equal(d.prompt.text, '[Image #1]')
  assert.equal(d.images.length, 1)
  assert.ok(d.images[0].path.startsWith(join(HOME, 'images', 'agent')))
  assert.equal(readFileSync(d.images[0].path, 'utf8'), 'png')
  at(d, 'folder')
  d.folder = { text: '', at: 0 }
  key('', shot)
  assert.equal(d.folder.text, shot)
})

test('folder matches: those that start with it, then any case; dirs and their links only', () => {
  const names = (text: string) => matchesOf(text).names
  assert.deepEqual(names('~/projects/al'), ['alpha', 'alphabet'])
  assert.deepEqual(names('~/projects/b'), ['Beta'])
  assert.deepEqual(names('~/projects/'), ['Beta', 'alpha', 'alphabet', 'linked'])
  assert.deepEqual(names('~/projects/.h'), ['.hidden'])
  assert.deepEqual(names('~/projects/zzz'), [])
  assert.deepEqual(names('/no/such/place/'), [])
  assert.deepEqual(matchesOf('~/projects/al').dir, P)
  assert.equal(matchesOf('~/projects/al').part, 'al')
})

test('tab fills in one match with its slash, and what several share', () => {
  const d = at(form({ folder: P }), 'folder')
  d.folder = { text: '~/projects/B', at: 12 }
  keys('\t')
  assert.equal(d.folder.text, '~/projects/Beta/')
  d.folder = { text: '~/projects/al', at: 13 }
  keys('\t')
  assert.equal(d.folder.text, '~/projects/alpha')
  assert.equal(d.folder.at, d.folder.text.length)
  d.folder = { text: '~/projects/zz', at: 13 }
  keys('\t')
  assert.equal(d.folder.text, '~/projects/zz')
  assert.equal(d.field, 'folder')
})

test('once nothing more is shared, tab steps through the matches, shift+tab back', () => {
  const d = at(form({ folder: P }), 'folder')
  d.folder = { text: '~/projects/alpha', at: 16 }
  keys('\t')
  assert.equal(d.folder.text, '~/projects/alpha/')
  keys('\t')
  assert.equal(d.folder.text, '~/projects/alphabet/')
  keys('\t')
  assert.equal(d.folder.text, '~/projects/alpha/')
  keys(SHIFT_TAB)
  assert.equal(d.folder.text, '~/projects/alphabet/')
  // Another key keeps the one shown and ends the menu.
  type('x')
  assert.equal(d.folder.text, '~/projects/alphabet/x')
  assert.equal(d.field, 'folder')
})

test('shift+tab starts the menu at the last match, once it is open; before, it moves up', () => {
  const d = at(form({ folder: P }), 'folder')
  d.folder = { text: '~/projects/', at: 11 }
  keys(SHIFT_TAB)
  assert.equal(d.field, 'where')
  at(d, 'folder')
  keys('\t')
  assert.equal(d.folder.text, '~/projects/Beta/')
  keys(SHIFT_TAB)
  assert.equal(d.folder.text, '~/projects/linked/')
})

test('a click off Folder ends its Tab menu, so shift+tab back there moves up', () => {
  const d = at(form({ folder: P }), 'folder')
  d.folder = { text: '~/projects/', at: 11 }
  keys('\t')
  assert.equal(d.folder.text, '~/projects/Beta/')
  pick('model')
  assert.equal(d.field, 'model')
  at(d, 'folder')
  keys(SHIFT_TAB)
  assert.equal(d.field, 'where')
  assert.equal(d.folder.text, '~/projects/Beta/')
})

test('the folder suggests the rest of its first match, and → or end takes it', () => {
  const d = at(form({ folder: P }), 'folder')
  d.folder = { text: '~/projects/alphab', at: 17 }
  assert.equal(suggestion(), 'et/')
  keys(RIGHT)
  assert.equal(d.folder.text, '~/projects/alphabet/')
  assert.equal(suggestion(), '')
  d.folder = { text: '~/projects/alph', at: 15 }
  keys('\x05')
  assert.equal(d.folder.text, '~/projects/alpha/')
})

test('no suggestion mid-line, off the folder, for a different case or a trailing slash', () => {
  const d = at(form({ folder: P }), 'folder')
  d.folder = { text: '~/projects/alph', at: 3 }
  assert.equal(suggestion(), '')
  // → then only moves the cursor.
  keys(RIGHT)
  assert.equal(d.folder.text, '~/projects/alph')
  assert.equal(d.folder.at, 4)
  d.folder = { text: '~/projects/be', at: 13 }
  assert.equal(suggestion(), '')
  d.folder = { text: '~/projects/', at: 11 }
  assert.equal(suggestion(), '')
  at(d, 'prompt')
  d.folder = { text: '~/projects/alph', at: 15 }
  assert.equal(suggestion(), '')
})

test('the popup is the form\'s size, border included', () => {
  assert.deepEqual(POPUP, { w: 80, h: 22 })
})

test('a short popup scrolls the form only as far as the field you are on needs', () => {
  assert.equal(scrollTo(0, 3, 12, 18), 0)
  assert.equal(scrollTo(0, 17, 12, 18), 6, 'Start, the last row, is drawn')
  assert.equal(scrollTo(6, 14, 12, 18), 6, 'a field already drawn stays put')
  assert.equal(scrollTo(6, 2, 12, 18), 2)
  assert.equal(scrollTo(6, 0, 20, 18), 0, 'with room for every row')
  assert.equal(scrollTo(9, -1, 12, 18), 6, 'never past the last row')
})

test("a spec that can't be saved keeps the form open, on Start with why", () => {
  const d = form({ folder: P })
  type('go')
  const spec = specOf(key(CTRL_S))
  assert.equal(save(spec, join(HOME, 'no-such-dir', 'result.json')), false)
  assert.equal(d.field, 'start')
  assert.ok(d.error)
  const file = join(HOME, 'result.json')
  assert.equal(save(spec, file), true)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), spec)
})
