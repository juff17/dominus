// Shared by bin/ghostty-todo (what Claude and the /todo skill call) and the
// Todo mode. One JSON file holds every repo's items. Each write takes a lock and replaces the file whole, so the
// viewer never reads half a write.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { skillCommand } from '../../core/hub-skills.ts'
import { todoFiler } from '../../core/prompts/todo-filer.ts'
import { todoHandoff } from '../../core/prompts/todo-handoff.ts'
import { type Image, imageList, imagesDir, imagesLine, withoutImages } from '../../core/images.ts'
import { isRecord, writeAtomic } from '../../core/json.ts'
import { errCode, errorMessage, logger } from '../../core/log.ts'
import { t, text } from '../../core/text.ts'
import { type TaskSpec, slug } from '../../agents/model.ts'
import { MODEL_IDS } from '../../settings/models.ts'
import { expandHome, load as settings } from '../../settings/settings.ts'
import { P } from '../../tui/palette.ts'

const log = logger('todo')

const STATE_HOME = process.env.XDG_STATE_HOME || join(homedir(), '.local/state')
export const STORE = process.env.TODO_FILE || join(STATE_HOME, 'agent-hub/todos.json')
// Where the list was kept before it joined the hub's other state.
export const OLD_STORE = join(STATE_HOME, 'ghostty-layout/todos.json')

// In the order the viewer groups them. name is what the store holds; the
// viewer shows categoryName and categoryShort.
export const CATEGORIES = [
  { name: 'bug', short: 'bug', color: P.red },
  { name: 'feature', short: 'feat', color: P.blue },
  { name: 'follow-up', short: 'follow', color: P.mauve },
  { name: 'docs', short: 'docs', color: P.rose },
  { name: 'question', short: 'ask', color: P.yellow },
  { name: 'other', short: 'other', color: P.sub },
] as const
export type CategoryName = (typeof CATEGORIES)[number]['name']
export const DEFAULT_CATEGORY: CategoryName = 'follow-up'
const ALIASES: Record<string, CategoryName> = {
  fix: 'bug',
  feat: 'feature',
  follow: 'follow-up',
  followup: 'follow-up',
  doc: 'docs',
  ask: 'question',
  q: 'question',
  misc: 'other',
}

export const TYPES = [
  { name: 'research', color: P.peach },
  { name: 'decide', color: P.pink },
  { name: 'action', color: P.green },
  { name: 'review', color: P.sapphire },
  { name: 'chore', color: P.overlay2 },
] as const
export type TypeName = (typeof TYPES)[number]['name']
const TYPE_ALIASES: Record<string, TypeName> = { do: 'action', act: 'action', task: 'action' }

// A message Claude is turning into a todo; pid is the filer's.
export type Filing = { started: number; pid?: number; error?: string }
// `server` is the tab server `pane` belongs to (see Item's paneServer).
// Every hand-off now starts a background agent; 'tab' is a record from
// before, when a hand-off could open a tab.
export type Handoff = { name: string; where: 'tab' | 'bg'; pane: string; at: number; server?: string }

// cat and type are strings, not CategoryName and TypeName, so a value this
// version doesn't know shows as stored. `root` is the main repo's root (or,
// outside git, the folder, with `repo` 'none'). `session` is the Claude
// session that added it. `paneServer` is the tab server's start time (tmux's
// #{start_time}) when `pane` was recorded: tmux numbers panes from %0 again on
// each new server, so after a reboot the same id names some other tab.
// `images` were pasted into its title or note, which name each [Image #n];
// the files are in IMAGES_DIR, and an agent it's handed to gets their paths.
export type Item = {
  id: string
  title: string
  cat: string
  type?: string | null
  note: string
  by?: 'claude' | 'you'
  created: number
  done: number | null
  root: string
  repo: string
  cwd?: string
  worktree?: string
  branch?: string
  pane?: string
  paneServer?: string
  session?: string
  agent?: string
  handoff?: Handoff
  filing?: Filing
  images?: Image[]
}

export const IMAGES_DIR = imagesDir('todo')
// An image no todo names is from a prompt closed without adding it, or a
// todo since dropped; a day leaves an open prompt's alone.
export const IMAGES_KEPT_MS = 24 * 60 * 60 * 1000
export const imagesOf = (item: Pick<Item, 'images'>): Image[] => imageList(item.images)

export type RepoPlace = { root: string; repo: string; worktree: string; branch: string }
export type Here = RepoPlace & { folder: string }
export type KnownRepo = { repo: string; root: string }

// Done items stay this long by default (Settings' todo.keepDone, in days),
// then a write drops them.
export const KEEP_DONE_MS = 7 * 24 * 60 * 60 * 1000
const keepDoneMs = (): number => settings()['todo.keepDone'] * 24 * 60 * 60 * 1000

// A filing item holds the message until `add --filing` replaces it with the
// real one. ghostty-todo stops Claude well before this; past it the item counts as failed anyway,
// in case the filer died without saying so. Settings can give the filer
// longer (todo.filing.limit), so this keeps two minutes past that.
export const FILING_TIMEOUT_MS = 5 * 60 * 1000
const filingTimeoutMs = (): number => Math.max(FILING_TIMEOUT_MS, (settings()['todo.filing.limit'] + 2) * 60 * 1000)

export type FilingState = 'filing' | 'failed' | ''

// Whether pid is still a ghostty-todo filer (`ghostty-todo file`), by its
// command line: a filer that has exited may have left its pid to something
// else by now, which must neither be signalled nor keep a filing alive.
export function filerAlive(pid: number | undefined, read = (path: string): string => readFileSync(path, 'utf8')): boolean {
  if (!pid || pid < 1) return false
  let argv: string[]
  try {
    argv = read(`/proc/${pid}/cmdline`).split('\0')
  } catch (error) {
    // No such process is the usual answer, and means it isn't one.
    if (errCode(error) !== 'ENOENT' && errCode(error) !== 'ESRCH') log.debug('filer unreadable', { pid, err: errorMessage(error) })
    return false
  }
  return argv.some(arg => basename(arg) === 'ghostty-todo') && argv.includes('file')
}

// Past the timeout a filer still running counts as filing: the limit may have been lowered since it
// started, or the clock jumped while the machine slept, and the filer stops
// on its own limit and says so.
export function filingState(item: Pick<Item, 'filing'>, now = Date.now(), timeout = filingTimeoutMs(), alive = filerAlive): FilingState {
  if (!item.filing) return ''
  const { error, started, pid } = item.filing
  if (error) return 'failed'
  return now - started > timeout && !alive(pid) ? 'failed' : 'filing'
}

// What someone typed, as one of `names`: an alias or a unique prefix.
function pick<N extends string>(word: string, aliases: Record<string, N>, names: readonly { name: N }[]): N | undefined {
  if (Object.hasOwn(aliases, word)) return aliases[word]
  const matches = names.filter(c => c.name.startsWith(word))
  return matches.length === 1 ? matches[0].name : undefined
}

const wordOf = (input: unknown): string =>
  String(input ?? '')
    .trim()
    .toLowerCase()

export function category(input: unknown): CategoryName | undefined {
  const word = wordOf(input)
  return word ? pick(word, ALIASES, CATEGORIES) : undefined
}

// 'none' gives null, which clears the type.
export function taskType(input: unknown): TypeName | null | undefined {
  const word = wordOf(input)
  if (!word) return undefined
  if (word === 'none') return null
  return pick(word, TYPE_ALIASES, TYPES)
}

type CategoryWords = Record<string, { name: string; short: string } | undefined>
type TypeWords = Record<string, string | undefined>
export const categoryName = (cat: string): string => text<CategoryWords>('todo.categories')[cat]?.name ?? cat
export const categoryShort = (cat: string): string => text<CategoryWords>('todo.categories')[cat]?.short ?? cat
export const typeName = (type: string | null | undefined): string => (type ? (text<TypeWords>('todo.types')[type] ?? type) : t('todo.none'))

export const typeColorOf = (name: string | null | undefined): string => TYPES.find(t => t.name === name)?.color ?? P.sub

export const colorOf = (name: string): string => CATEGORIES.find(c => c.name === name)?.color ?? P.text

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz'

export function newId(items: readonly Pick<Item, 'id'>[], random = Math.random): string {
  const taken = new Set(items.map(i => i.id))
  for (let length = 3; ; length++) {
    for (let tries = 0; tries < 20; tries++) {
      const id = Array.from({ length }, () => ID_CHARS[Math.floor(random() * 36)]).join('')
      if (!taken.has(id)) return id
    }
  }
}

export const prune = <I extends Pick<Item, 'done'>>(items: readonly I[], now = Date.now(), keep = keepDoneMs()): I[] =>
  items.filter(i => !i.done || now - i.done < keep)

export function find<I extends Pick<Item, 'id'>>(items: readonly I[], id: string): I | undefined {
  const exact = items.find(i => i.id === id)
  if (exact) return exact
  const matches = items.filter(i => i.id.startsWith(id))
  return matches.length === 1 ? matches[0] : undefined
}

export function age(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / (24 * 60))}d`
}

const startOfDay = (now: number): number => {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

export type ArrangeOptions = { here?: string; only?: boolean; now?: number }
export type Group = (typeof CATEGORIES)[number] & { items: Item[] }
export type Arranged = { groups: Group[]; filing: Item[]; doneToday: Item[]; open: number }

// `here` is a main repo's root; its items sort first in each group. Items
// Claude is still filing go apart, oldest first: they have no real category
// yet and don't count as open.
export function arrange(items: readonly Item[], { here = '', only = false, now = Date.now() }: ArrangeOptions = {}): Arranged {
  const shown = items.filter(i => !only || i.root === here)
  const filing = shown.filter(i => i.filing).sort((a, b) => a.created - b.created)
  const real = shown.filter(i => !i.filing)
  const order = (a: Item, b: Item): number => Number(b.root === here) - Number(a.root === here) || b.created - a.created
  const groups = CATEGORIES.map(c => ({ ...c, items: real.filter(i => !i.done && i.cat === c.name).sort(order) })).filter(g => g.items.length)
  const today = startOfDay(now)
  const doneToday = real.filter(i => i.done && i.done >= today).sort((a, b) => (b.done ?? 0) - (a.done ?? 0))
  return { groups, filing, doneToday, open: groups.reduce((n, g) => n + g.items.length, 0) }
}



// Only an entry's outline is checked: the fields every writer sets and the
// list needs to sort and find it by.
const isItem = (v: unknown): v is Item =>
  isRecord(v) && typeof v.id === 'string' && typeof v.title === 'string' && typeof v.created === 'number'

// The file's items, and the entries that aren't items, which a write keeps
// as they are rather than lose what someone wrote by hand.
function read(file: string): { items: Item[]; other: unknown[] } {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (errCode(error) === 'ENOENT') return { items: [], other: [] }
    throw new Error(t('todo.store.unreadable', { file, err: errorMessage(error) }))
  }
  const entries: unknown[] = isRecord(data) && Array.isArray(data.items) ? data.items : []
  const items = entries.filter(isItem)
  const other = entries.filter(e => !isItem(e))
  if (other.length) log.warn('store entries skipped', { path: file, n: other.length })
  return { items, other }
}

export const load = (file = STORE): Item[] => read(file).items

export function stamp(file = STORE): string {
  try {
    const { mtimeMs, size } = statSync(file)
    return `${mtimeMs}:${size}`
  } catch (error) {
    // No file yet is an empty list; anything else load() reports.
    if (errCode(error) !== 'ENOENT') log.warn('store not statted', { path: file, err: errorMessage(error) })
    return ''
  }
}

const pause = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// A lock held longer than this belongs to a writer that died.
const STALE_LOCK_MS = 10000

function takeLock(lock: string): void {
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock)
      return
    } catch (error) {
      if (errCode(error) !== 'EEXIST') throw error
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmdirSync(lock)
    } catch (stale) {
      // The writer let go meanwhile; the next try takes it.
      if (errCode(stale) !== 'ENOENT') log.warn('stale lock not removed', { path: lock, err: errorMessage(stale) })
    }
    if (tries > 250) throw new Error(t('todo.store.locked', { lock }))
    pause(20)
  }
}

// Moves the list from OLD_STORE once, under the old file's lock, so a
// viewer still running from before the move doesn't write into it midway.
// Called by the programs that open the store, not on import, so tests that
// only import this never touch the real one.
export function moveOldStore(from = OLD_STORE, to = STORE): boolean {
  if (from === to) return false
  if (existsSync(to) || !existsSync(from)) return false
  const lock = `${from}.lock`
  takeLock(lock)
  try {
    if (existsSync(to) || !existsSync(from)) return false
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
    log.info('store moved', { from, to })
    return true
  } finally {
    rmdirSync(lock)
  }
}

// A failed move leaves the list where it was; the new one starts empty.
export function moveOldStoreOnce(): void {
  if (process.env.TODO_FILE) return
  try {
    moveOldStore()
  } catch (error) {
    log.warn('store not moved', { from: OLD_STORE, to: STORE, err: errorMessage(error) })
  }
}

export type Change<T> = { items: Item[]; value?: T }

// The items change returns are saved pruned of old done items.
export function update<T>(change: (items: Item[]) => Change<T>, file = STORE): T | undefined {
  mkdirSync(dirname(file), { recursive: true })
  const lock = `${file}.lock`
  takeLock(lock)
  try {
    const { items: before, other } = read(file)
    const { items, value } = change(before)
    writeAtomic(file, `${JSON.stringify({ v: 1, items: [...prune(items), ...other] }, null, 1)}\n`)
    return value
  } finally {
    rmdirSync(lock)
  }
}

export type NewItem = Partial<Item> & Pick<Item, 'title' | 'root' | 'repo'>

export function add(fields: NewItem, file = STORE): Item | undefined {
  return update(items => {
    const item: Item = { id: newId(items), created: Date.now(), done: null, cat: DEFAULT_CATEGORY, note: '', ...fields }
    return { items: [...items, item], value: item }
  }, file)
}

export type Fields = Partial<Item>

// `id` may be a unique prefix; undefined when no single item matches.
export function change(id: string, fields: Fields | ((item: Item) => Fields), file = STORE): Item | undefined {
  return update<Item>(items => {
    const item = find(items, id)
    if (!item) return { items }
    const changed = { ...item, ...(typeof fields === 'function' ? fields(item) : fields) }
    return { items: items.map(i => (i === item ? changed : i)), value: changed }
  }, file)
}

// Undefined when no item is filing under that id: it was dropped, or filed
// already.
export function fill(id: string, fields: Fields, file = STORE): Item | undefined {
  return update<Item>(items => {
    const item = items.find(i => i.id === id && i.filing)
    if (!item) return { items }
    const { filing, ...rest } = item
    const filled = { ...rest, ...fields }
    return { items: items.map(i => (i === item ? filled : i)), value: filled }
  }, file)
}

export function remove(id: string, file = STORE): Item | undefined {
  return update(items => {
    const item = find(items, id)
    return { items: items.filter(i => i !== item), value: item }
  }, file)
}

// Exact id only: the viewer's x knows the id whole, so a prefix can't take
// another item. A drop of a filing passes `which` so the todo the filer made
// of it meanwhile stays.
export function removeIf(id: string, which: (item: Item) => boolean = () => true, file = STORE): Item | undefined {
  return update(items => {
    const item = items.find(i => i.id === id && which(i))
    return { items: items.filter(i => i !== item), value: item }
  }, file)
}

// Shift+A on a failed filing: the filing becomes what was typed, or, when
// the filer filed it while you typed, the todo it became does, so adding it
// by hand never makes a second one. Undefined when the item is gone.
export function replaceFiling(id: string, fields: Fields, file = STORE): Item | undefined {
  return update<Item>(items => {
    const item = items.find(i => i.id === id)
    if (!item) return { items }
    const { filing, ...rest } = item
    const replaced = { ...rest, ...fields }
    return { items: items.map(i => (i === item ? replaced : i)), value: replaced }
  }, file)
}

// git gets this long; a folder on a mount that stopped answering would
// otherwise hold up whoever asked where it sits.
const GIT_TIMEOUT_MS = 10000

// git's output, or '' when it fails, which outside a repo it does.
const git = (args: string[], cwd: string): Promise<string> =>
  new Promise(done => execFile('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }, (error, out) => done(error ? '' : out.trim())))

// root and repo are the main repo's, the same for all its worktrees.
export async function repoOf(dir: string): Promise<RepoPlace> {
  const top = await git(['rev-parse', '--show-toplevel'], dir)
  // Outside a repo the folder still scopes "this repo", but its name would
  // read as a repo, so it is labelled none.
  if (!top) return { root: resolve(dir), repo: 'none', worktree: '', branch: '' }
  const common = resolve(top, await git(['rev-parse', '--git-common-dir'], top))
  const root = basename(common) === '.git' ? dirname(common) : top
  const branch = (await git(['branch', '--show-current'], top)) || (await git(['rev-parse', '--short', 'HEAD'], top))
  return { root, repo: basename(root), worktree: top === root ? '' : top, branch }
}

export type KnownReposOptions = { exists?: (path: string) => boolean; list?: (dir: string) => string[] }

// The repos the filer may put an item in, including the git repos beside
// those on the list (a projects folder): a message typed in one tab is often
// about another repo, and without the paths Claude can only file it where the
// tab is.
export function knownRepos(
  items: readonly Pick<Item, 'repo' | 'root'>[],
  { exists = existsSync, list = dir => readdirSync(dir) }: KnownReposOptions = {},
): KnownRepo[] {
  const roots = new Set(items.filter(i => i.repo !== 'none' && i.root).map(i => i.root))
  for (const parent of new Set([...roots].map(r => dirname(r)))) {
    let names: string[] = []
    try {
      names = list(parent)
    } catch (error) {
      log.warn('repo folder unreadable', { path: parent, err: errorMessage(error) })
    }
    for (const name of names) roots.add(join(parent, name))
  }
  return [...roots]
    .filter(root => exists(join(root, '.git')))
    .sort()
    .map(root => ({ repo: basename(root), root }))
}

export const HANDOFF_MODELS = MODEL_IDS

export type Exists = (path: string) => boolean

export const inGit = (item: Pick<Item, 'repo' | 'root'>, exists: Exists = existsSync): boolean =>
  item.repo !== 'none' && !!item.root && exists(join(item.root, '.git'))

// An item added outside git works in the folder the viewer has open (`here`),
// whose repo stands in, without the branch the item was added on.
export function handoffPlace<I extends Item>(item: I, here: Here | undefined, exists: Exists = existsSync): I {
  if (inGit(item, exists) || !here?.folder) return item
  return { ...item, root: here.root, worktree: here.worktree, cwd: here.folder, repo: here.repo, branch: '' }
}

// Todos without a repo go to Settings' Default folder when it is on disk,
// else `here`.
export async function handoffHere(
  here: Here,
  defaultFolder: string,
  isDir = (d: string): boolean => !!statSync(d, { throwIfNoEntry: false })?.isDirectory(),
): Promise<Here> {
  const folder = defaultFolder && expandHome(defaultFolder)
  if (!folder || !isDir(folder)) return here
  return { folder, ...(await repoOf(folder)) }
}

export type HandoffSpec = TaskSpec & { name: string; prompt: string }

export type HandoffOptions = { worktree?: boolean; model?: string; mode?: string; effort?: string }

// The todo as you wrote it: its title, then its note.
const handoffTask = (item: Item): string => [item.title.trim(), item.note?.trim()].filter(Boolean).join('\n\n')

// What the hub adds about the todo, before it.
function handoffHub(item: Item, worktree: boolean): string[] {
  const about = [`a ${item.cat} in ${item.repo}`, item.branch && `added on ${item.branch}`].filter(Boolean).join(', ')
  return todoHandoff({ id: item.id, about, worktree, merge: settings()['todo.handoff.merge'] })
}

export function handoffSpec(
  item: Item,
  { worktree = true, model = 'opus', mode = 'auto', effort = 'medium' }: HandoffOptions = {},
  exists: Exists = existsSync,
): HandoffSpec | undefined {
  const own = worktree && inGit(item, exists)
  const places = own ? [item.root, item.worktree, item.cwd] : [item.worktree, item.cwd, item.root]
  const cwd = places.find(d => d && exists(d))
  if (!cwd) return undefined
  const name = slug(`${slug(withoutImages(item.title)).split('-').slice(0, 4).join(' ')} ${item.id}`)
  const images = imagesOf(item)
  return {
    kind: 'task',
    agent: 'todo-handoff',
    cwd,
    name,
    prompt: handoffTask(item),
    hub: handoffHub(item, own),
    worktree: own,
    model,
    mode,
    effort,
    ...(images.length ? { images } : {}),
  }
}

// The todo skill's "Filing from the Todo pane" says how to fill in a filing
// item. `cli` is named only when it isn't the installed one the skill names
// (a worktree's copy).
export const INSTALLED_CLI = join(homedir(), '.config/ghostty/bin/ghostty-todo')
// The images stay on the item whatever the filer writes; it's asked to keep
// their placeholders, which say where each belongs.
export function filerMessage(item: Pick<Item, 'id' | 'title' | 'repo' | 'root' | 'images'>, cli = INSTALLED_CLI): string {
  const where = item.repo === 'none' ? `${item.root}, outside any repo` : `the ${item.repo} repo (${item.root})`
  return todoFiler({
    command: skillCommand('todo'),
    id: item.id,
    where,
    cli: cli === INSTALLED_CLI ? undefined : cli,
    pictures: imagesLine(imagesOf(item)),
    message: item.title,
  })
}
