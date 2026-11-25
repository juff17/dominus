// Images pasted into a prompt, the way Claude Code takes them: Ctrl+V reads
// the clipboard's image and the prompt shows it as [Image #n]. A terminal's
// own paste only carries text, so the image comes from wl-paste (Wayland) or
// xclip (X11). Each is saved as a file, and the agent is given its path to
// read with its Read tool: claude's command line has no way to attach one.
//
// A file manager's copy, or a file dragged onto the terminal, pastes its path
// instead; a paste that is only paths to image files attaches those.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isRecord } from './json.ts'
import { images as imagesPrompt } from './prompts/shared.ts'
import { errorMessage, logger } from './log.ts'
import { t } from './text.ts'

const log = logger('images')

// `n` is the number its placeholder shows.
export type Image = { n: number; path: string }
export type Kind = 'agent' | 'todo'
export type Pasted = { image: string } | { error: string }

// AGENT_HUB_IMAGES is for tests. Beside the todo list's store.
export const imagesDir = (kind: Kind): string =>
  join(process.env.AGENT_HUB_IMAGES || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'agent-hub/images'), kind)

export const placeholder = (n: number): string => `[Image #${n}]`
// The line editor (tui/line.ts) takes each as one character.
export const PLACEHOLDERS = /\[Image #\d+\]/g

export const nextNumber = (images: readonly Image[]): number => Math.max(0, ...images.map(i => i.n)) + 1

// Text with its placeholders taken out, for a name made from it.
export const withoutImages = (text: string): string => text.replace(PLACEHOLDERS, ' ').replace(/\s+/g, ' ').trim()

// The images a prompt keeps once it's saved: deleting an image's placeholder
// is how you take it out. `before` is the text an edit started from; an image
// whose placeholder wasn't in it either stays (a filer may have written the
// title round it), so only one deleted in the edit goes.
export function keptImages(images: readonly Image[], text: string, before?: string): Image[] {
  return images.filter(i => text.includes(placeholder(i.n)) || (before !== undefined && !before.includes(placeholder(i.n))))
}

// Numbers the images 1, 2… in order, and their placeholders in `text` with
// them: for a list given as paths alone (ghostty-todo file --image).
export function renumber(text: string, images: readonly Image[]): { text: string; images: Image[] } {
  const sorted = [...images].sort((x, y) => x.n - y.n)
  const to = new Map(sorted.map((i, k) => [i.n, k + 1]))
  return {
    text: text.replace(/\[Image #(\d+)\]/g, (all, n: string) => (to.has(Number(n)) ? placeholder(to.get(Number(n)) ?? 0) : all)),
    images: sorted.map((i, k) => ({ n: k + 1, path: i.path })),
  }
}

// A spec or a store entry, read from a file, keeps only well-formed images.
export const imageList = (v: unknown): Image[] =>
  Array.isArray(v) ? v.filter((i): i is Image => isRecord(i) && typeof i.n === 'number' && typeof i.path === 'string' && i.path !== '') : []

// What the agent is told about them (prompts/shared.ts).
export function imagesLine(images: readonly Image[]): string {
  if (!images.length) return ''
  return imagesPrompt(images.map(i => `${placeholder(i.n)} is ${i.path}`).join(', '))
}

// ------------------------------------------------------------ the clipboard

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
}
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

export type Grabbed = { ok: boolean; out: Buffer; err: string; missing: boolean }
// Runs a clipboard tool and takes its output as bytes.
export type Grab = (argv: readonly string[], env: NodeJS.ProcessEnv) => Grabbed

// A clipboard owner that stopped answering would otherwise hold the screen.
const GRAB_TIMEOUT_MS = 3000
const MAX_IMAGE_BYTES = 64 * 1024 * 1024

const grab: Grab = ([cmd = '', ...args], env) => {
  const r = spawnSync(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: GRAB_TIMEOUT_MS, maxBuffer: MAX_IMAGE_BYTES })
  const code = r.error && 'code' in r.error ? r.error.code : undefined
  return {
    ok: !r.error && r.status === 0,
    out: r.stdout ?? Buffer.alloc(0),
    err: (r.stderr?.toString() || r.error?.message || '').trim(),
    missing: code === 'ENOENT',
  }
}

type Tool = { list: string[]; read: (mime: string) => string[] }
const WAYLAND: Tool = { list: ['wl-paste', '--list-types'], read: mime => ['wl-paste', '--no-newline', '--type', mime] }
const X11: Tool = { list: ['xclip', '-selection', 'clipboard', '-t', 'TARGETS', '-o'], read: mime => ['xclip', '-selection', 'clipboard', '-t', mime, '-o'] }

// Wayland first, then X11. A tmux server started outside the desktop session
// has neither variable, so the session's usual Wayland socket stands in.
export function clipboardTools(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): { tool: Tool; env: NodeJS.ProcessEnv }[] {
  const tools: { tool: Tool; env: NodeJS.ProcessEnv }[] = []
  const socket = env.WAYLAND_DISPLAY || (env.XDG_RUNTIME_DIR && exists(join(env.XDG_RUNTIME_DIR, 'wayland-0')) ? 'wayland-0' : '')
  if (socket) tools.push({ tool: WAYLAND, env: { ...env, WAYLAND_DISPLAY: socket } })
  if (env.DISPLAY) tools.push({ tool: X11, env })
  return tools
}

export type Clip = { data: Buffer; ext: string } | { error: string }
export type ClipOptions = { grab?: Grab; env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean }

// The clipboard's image, PNG when it offers one. A clipboard that answers
// with no image says so; one tool that isn't installed passes to the next.
export function clipboardImage({ grab: run = grab, env = process.env, exists = existsSync }: ClipOptions = {}): Clip {
  const tools = clipboardTools(env, exists)
  if (!tools.length) return { error: t('images.noDisplay') }
  let missing = 0
  for (const { tool, env: toolEnv } of tools) {
    const listed = run(tool.list, toolEnv)
    if (listed.missing) {
      missing++
      continue
    }
    // wl-paste fails on an empty clipboard; X11's may still hold one.
    if (!listed.ok) {
      log.debug('clipboard unreadable', { cmd: tool.list, err: listed.err })
      continue
    }
    const types = listed.out.toString('utf8').split('\n').map(s => s.trim())
    const mime = Object.keys(MIME_EXT).find(m => types.includes(m)) ?? types.find(m => m.startsWith('image/'))
    if (!mime) return { error: t('images.none') }
    const cmd = tool.read(mime)
    const read = run(cmd, toolEnv)
    if (!read.ok || !read.out.length) {
      log.warn('clipboard image unreadable', { cmd, err: read.err || 'empty' })
      return { error: t('images.unreadable', { err: read.err || t('images.empty') }) }
    }
    return { data: read.out, ext: MIME_EXT[mime] ?? (mime.slice('image/'.length).replace(/[^a-z0-9]/g, '') || 'img') }
  }
  return { error: t(missing === tools.length ? 'images.noTool' : 'images.none') }
}

// ------------------------------------------------------------ files

const pad = (n: number): string => String(n).padStart(2, '0')
function fileName(ext: string, now: number): string {
  const d = new Date(now)
  const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `image-${day}-${time}-${Math.random().toString(36).slice(2, 8)}.${ext}`
}

export function saveImage(data: Buffer, ext: string, dir: string, now = Date.now()): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, fileName(ext, now))
  writeFileSync(path, data)
  return path
}

// A file pasted by its path is copied in too, so a screenshot in /tmp is
// still there when the agent starts.
export function copyImage(from: string, dir: string, now = Date.now()): string {
  mkdirSync(dir, { recursive: true })
  const ext = extname(from).slice(1).toLowerCase() || 'img'
  const path = join(dir, fileName(ext, now))
  copyFileSync(from, path)
  return path
}

// Ctrl+V: the clipboard's image, saved in `dir`.
export function pasteImage(dir: string, opts: ClipOptions = {}): Pasted {
  const clip = clipboardImage(opts)
  if ('error' in clip) return clip
  try {
    const image = saveImage(clip.data, clip.ext, dir)
    log.info('image pasted', { path: image, bytes: clip.data.length })
    return { image }
  } catch (err) {
    log.error('image not saved', { path: dir, err })
    return { error: t('images.notSaved', { err: errorMessage(err) }) }
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    // Not a file there: the paste is text.
    return false
  }
}

// Each word of a paste as the path it names: quoted, with \-escaped spaces,
// or a file:// URI.
function pathsIn(text: string): string[] {
  const words = [...text.matchAll(/'([^']*)'|"([^"]*)"|((?:\\.|\S)+)/g)].map(m => m[1] ?? m[2] ?? m[3].replace(/\\(.)/g, '$1'))
  return words.map(w => {
    if (w.startsWith('file://')) {
      try {
        return fileURLToPath(w)
      } catch {
        // Not a local file's URI: the paste is text.
        return ''
      }
    }
    return w === '~' || w.startsWith('~/') ? homedir() + w.slice(1) : w
  })
}

// The image files a paste names, when that's all it is; [] for any other
// text, which pastes as it is.
export function imageFiles(text: string, exists: (path: string) => boolean = isFile): string[] {
  const paths = pathsIn(text.trim())
  const image = (p: string): boolean => p.startsWith('/') && IMAGE_EXTS.has(extname(p).slice(1).toLowerCase()) && exists(p)
  return paths.length && paths.every(image) ? paths : []
}

// Pasted paths, each copied into `dir` or the reason it couldn't be.
export function attachFiles(files: readonly string[], dir: string): Pasted[] {
  return files.map(from => {
    try {
      const image = copyImage(from, dir)
      log.info('image attached', { path: image, from })
      return { image }
    } catch (err) {
      log.error('image not copied', { path: from, err })
      return { error: t('images.notSaved', { err: errorMessage(err) }) }
    }
  })
}

// Removes the files in `dir` older than `ms` that nothing in `keep` names:
// prompts closed without saving, and todos long gone.
export function sweepImages(dir: string, keep: ReadonlySet<string>, ms: number, now = Date.now()): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) log.warn('images folder unreadable', { path: dir, err })
    return 0
  }
  let removed = 0
  for (const name of names) {
    const path = join(dir, name)
    if (keep.has(path)) continue
    try {
      if (now - statSync(path).mtimeMs < ms) continue
      unlinkSync(path)
      removed++
    } catch (err) {
      log.warn('image not removed', { path, err })
    }
  }
  if (removed) log.info('old images removed', { path: dir, n: removed })
  return removed
}
