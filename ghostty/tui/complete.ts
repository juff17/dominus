// Path completion as a shell does it. Paths are typed and shown with ~ for
// your home folder.

import { type Dirent, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { errCode, logger } from '../core/log.ts'
import { expandHome, tilde } from '../core/paths.ts'

const log = logger('complete')

export type CompleteOptions = { files?: boolean }
export type Matches = { dir: string; part: string; names: string[]; folders: Set<string> }
// The one shown is names[i].
export type Menu = Matches & { i: number }
export type Completion = { text: string; menu: Menu | null }

// Case is ignored only when nothing matches with it. Hidden names only when
// the part starts with a dot, as in a shell.
export function matchesOf(text: string, { files = false }: CompleteOptions = {}): Matches {
  const full = expandHome(text)
  const dir = full.endsWith('/') ? full : dirname(full)
  const part = full.endsWith('/') ? '' : basename(full)
  const folders = new Set<string>()
  let all: string[] = []
  try {
    all = readdirSync(dir, { withFileTypes: true })
      .filter(e => part.startsWith('.') || !e.name.startsWith('.'))
      .filter(e => {
        const folder = isDir(dir, e)
        if (folder) folders.add(e.name)
        return folder || files
      })
      .map(e => e.name)
      .sort()
  } catch (err) {
    unlisted(dir, err)
  }
  let names = all.filter(n => n.startsWith(part))
  if (!names.length) names = all.filter(n => n.toLowerCase().startsWith(part.toLowerCase()))
  return { dir, part, names, folders }
}

// A folder typed that isn't there yet is the usual case; one that is there
// but can't be read is worth a line, once, as a field asks on every key.
const warned = new Set<string>()
function unlisted(dir: string, err: unknown): void {
  const code = errCode(err)
  if (code === 'ENOENT' || code === 'ENOTDIR' || warned.has(dir)) return
  warned.add(dir)
  log.warn('folder unreadable', { path: dir, err })
}

function isDir(dir: string, e: Dirent): boolean {
  if (e.isDirectory()) return true
  if (!e.isSymbolicLink()) return false
  try {
    return statSync(join(dir, e.name)).isDirectory()
  } catch {
    // A link to nothing is not a folder.
    return false
  }
}

export const pathTo = ({ dir, folders }: Pick<Matches, 'dir' | 'folders'>, name: string): string => `${tilde(join(dir, name))}${folders.has(name) ? '/' : ''}`

// Tab as in zsh: several matches fill in what they share, and once nothing
// more is shared, Tab steps through them (`back` for Shift+Tab). `menu` is
// that stepping, null before it starts.
export function complete(text: string, menu: Menu | null, back = false, opts: CompleteOptions = {}): Completion {
  if (menu) {
    const i = (menu.i + (back ? menu.names.length - 1 : 1)) % menu.names.length
    return { text: pathTo(menu, menu.names[i]), menu: { ...menu, i } }
  }
  const m = matchesOf(text, opts)
  const { part, names } = m
  if (!names.length) return { text, menu: null }
  if (names.length === 1) return { text: pathTo(m, names[0]), menu: null }
  let common = names[0]
  for (const n of names) while (!n.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1)
  if (common.length > part.length) return { text: tilde(join(m.dir, common)), menu: null }
  const i = back ? names.length - 1 : 0
  return { text: pathTo(m, names[i]), menu: { ...m, i } }
}

// The rest of the first match, drawn dim after the text as fish and
// zsh-autosuggestions do.
export function suggestion(text: string, opts: CompleteOptions = {}): string {
  const m = matchesOf(text, opts)
  const first = m.names[0]
  if (!m.part || !first?.startsWith(m.part)) return ''
  return `${first.slice(m.part.length)}${m.folders.has(first) ? '/' : ''}`
}
