// node --test ghostty/core/images.test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { Grab } from './images.ts'

const dir = mkdtempSync(join(tmpdir(), 'hub-images-'))
process.env.AGENT_HUB_LOG_DIR = join(dir, 'logs')
after(() => rmSync(dir, { recursive: true, force: true }))

const images = await import('./images.ts')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const ok = (out: string | Buffer) => ({ ok: true, out: Buffer.from(out), err: '', missing: false })
const failed = (err: string) => ({ ok: false, out: Buffer.alloc(0), err, missing: false })
const notInstalled = { ok: false, out: Buffer.alloc(0), err: 'spawn ENOENT', missing: true }

// A clipboard tool per program name: what --list-types or TARGETS answers,
// and the bytes of each type.
function clipboard(tools: Record<string, { types?: string[]; data?: Record<string, Buffer>; missing?: boolean; list?: string }>) {
  const calls: string[][] = []
  const grab: Grab = argv => {
    calls.push([...argv])
    const tool = tools[argv[0]]
    if (!tool || tool.missing) return notInstalled
    if (argv.includes('--list-types') || argv.includes('TARGETS')) return tool.list ? failed(tool.list) : ok((tool.types ?? []).join('\n'))
    const type = argv[argv.indexOf(argv[0] === 'wl-paste' ? '--type' : '-t') + 1]
    return tool.data?.[type] ? ok(tool.data[type]) : failed('no such type')
  }
  return { grab, calls }
}

const WAYLAND = { WAYLAND_DISPLAY: 'wayland-1' }
const X11 = { DISPLAY: ':0' }
const none = () => false

test('Ctrl+V reads the PNG off a Wayland clipboard, before the other image types', () => {
  const { grab, calls } = clipboard({ 'wl-paste': { types: ['text/plain', 'image/jpeg', 'image/png'], data: { 'image/png': PNG } } })
  const clip = images.clipboardImage({ grab, env: WAYLAND, exists: none })
  assert.deepEqual(clip, { data: PNG, ext: 'png' })
  assert.deepEqual(calls[1], ['wl-paste', '--no-newline', '--type', 'image/png'])
})

test('without a PNG it takes the first image type offered, and X11 when Wayland has none', () => {
  const jpeg = clipboard({ xclip: { types: ['TARGETS', 'image/jpeg'], data: { 'image/jpeg': PNG } } })
  assert.deepEqual(images.clipboardImage({ grab: jpeg.grab, env: X11, exists: none }), { data: PNG, ext: 'jpg' })
  assert.deepEqual(jpeg.calls[0], ['xclip', '-selection', 'clipboard', '-t', 'TARGETS', '-o'])
  // wl-paste fails on an empty clipboard; xclip is asked next.
  const both = clipboard({ 'wl-paste': { list: 'Nothing is copied' }, xclip: { types: ['image/x-portable'], data: { 'image/x-portable': PNG } } })
  assert.deepEqual(images.clipboardImage({ grab: both.grab, env: { ...WAYLAND, ...X11 }, exists: none }), { data: PNG, ext: 'xportable' })
})

test('text on the clipboard, no tool, or no desktop session each say why', () => {
  const text = clipboard({ 'wl-paste': { types: ['text/plain'] } })
  assert.deepEqual(images.clipboardImage({ grab: text.grab, env: WAYLAND, exists: none }), { error: 'No image on the clipboard' })
  const missing = clipboard({ 'wl-paste': { missing: true }, xclip: { missing: true } })
  assert.deepEqual(images.clipboardImage({ grab: missing.grab, env: { ...WAYLAND, ...X11 }, exists: none }), {
    error: 'Install wl-clipboard (Wayland) or xclip (X11) to paste images',
  })
  assert.match((images.clipboardImage({ grab: text.grab, env: {}, exists: none }) as { error: string }).error, /No desktop session/)
  const empty = clipboard({ 'wl-paste': { types: ['image/png'], data: { 'image/png': Buffer.alloc(0) } } })
  assert.match((images.clipboardImage({ grab: empty.grab, env: WAYLAND, exists: none }) as { error: string }).error, /Couldn’t read/)
})

test('a tmux started outside the desktop session finds the usual Wayland socket', () => {
  const env = { XDG_RUNTIME_DIR: '/run/user/1000' }
  const tools = images.clipboardTools(env, p => p === '/run/user/1000/wayland-0')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].env.WAYLAND_DISPLAY, 'wayland-0')
  assert.deepEqual(images.clipboardTools(env, none), [])
})

test('a pasted image is saved in the folder given, and its path comes back', () => {
  const { grab } = clipboard({ 'wl-paste': { types: ['image/png'], data: { 'image/png': PNG } } })
  const into = join(dir, 'pasted')
  const r = images.pasteImage(into, { grab, env: WAYLAND, exists: none })
  assert.ok('image' in r)
  assert.match(r.image, /\/pasted\/image-\d{8}-\d{6}-[a-z0-9]+\.png$/)
  assert.deepEqual(readFileSync(r.image), PNG)
})

test('a paste that only names image files attaches them: paths, quoted, escaped or file:// URIs', () => {
  const a = join(dir, 'shot one.png')
  const b = join(dir, 'b.JPG')
  writeFileSync(a, PNG)
  writeFileSync(b, PNG)
  assert.deepEqual(images.imageFiles(`'${a}'`), [a])
  assert.deepEqual(images.imageFiles(a.replace(' ', '\\ ')), [a])
  assert.deepEqual(images.imageFiles(`${pathToFileURL(a).href}\n${b}\n`), [a, b])
  // Any other text pastes as it is.
  assert.deepEqual(images.imageFiles(`see ${b}`), [])
  assert.deepEqual(images.imageFiles(join(dir, 'gone.png')), [])
  assert.deepEqual(images.imageFiles(join(dir, 'logs')), [])
  assert.deepEqual(images.imageFiles(''), [])
  const [copied] = images.attachFiles([a], join(dir, 'copied'))
  assert.ok('image' in copied)
  assert.match(copied.image, /\/copied\/image-.*\.png$/)
  assert.deepEqual(readFileSync(copied.image), PNG)
  assert.ok('error' in images.attachFiles([join(dir, 'gone.png')], join(dir, 'copied'))[0])
})

test('placeholders: numbered past the highest, kept while the text names them, renumbered in order', () => {
  const list = [
    { n: 1, path: '/i/a.png' },
    { n: 3, path: '/i/c.png' },
  ]
  assert.equal(images.nextNumber([]), 1)
  assert.equal(images.nextNumber(list), 4)
  assert.deepEqual(images.keptImages(list, 'see [Image #3]'), [list[1]])
  // An edit drops only the image whose placeholder it deleted.
  assert.deepEqual(images.keptImages(list, 'none left', 'was [Image #3]'), [list[0]])
  assert.deepEqual(images.renumber('[Image #3] then [Image #1] and [Image #9]', list), {
    text: '[Image #2] then [Image #1] and [Image #9]',
    images: [
      { n: 1, path: '/i/a.png' },
      { n: 2, path: '/i/c.png' },
    ],
  })
  assert.equal(images.withoutImages('[Image #1] fix  the [Image #2] layout'), 'fix the layout')
  assert.deepEqual(images.imageList([{ n: 1, path: '/a.png' }, { n: '2', path: '/b.png' }, { n: 3, path: '' }, null]), [{ n: 1, path: '/a.png' }])
  assert.equal(images.imagesLine([]), '')
  assert.equal(
    images.imagesLine(list),
    'The prompt has images attached: [Image #1] is /i/a.png, [Image #3] is /i/c.png. Read each one with the Read tool before you start.',
  )
})

test('the sweep removes old images nothing names, and leaves the rest', () => {
  const into = join(dir, 'sweep')
  const { grab } = clipboard({ 'wl-paste': { types: ['image/png'], data: { 'image/png': PNG } } })
  const paste = () => (images.pasteImage(into, { grab, env: WAYLAND, exists: none }) as { image: string }).image
  const [old, named, fresh] = [paste(), paste(), paste()]
  const day = 24 * 60 * 60 * 1000
  const then = (Date.now() - 2 * day) / 1000
  for (const p of [old, named]) utimesSync(p, then, then)
  assert.equal(images.sweepImages(into, new Set([named]), day), 1)
  assert.ok(!existsSync(old))
  assert.deepEqual(readdirSync(into).sort(), [named, fresh].map(p => p.split('/').pop()).sort())
  assert.equal(images.sweepImages(join(dir, 'never-made'), new Set(), day), 0)
})
