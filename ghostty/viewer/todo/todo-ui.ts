// The Todo mode's decisions. Everything here takes what it needs as
// arguments, so it loads without a terminal and the tests can drive it.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

import { type Image, keptImages, nextNumber, placeholder, renumber } from '../../core/images.ts'
import { t } from '../../core/text.ts'
import type { Agent } from '../../agents/model.ts'
import { width as cells } from '../../tui/term.ts'
import { type Hint, type ModeTab, keyHintsWidth, tabAt } from '../../tui/chrome.ts'
import { type Mouse, type Token, leftPress, tokenizer } from '../../tui/input.ts'
import { type FieldState, caretParts, caretShown, editField, editLine, head, insertAt, length, tail, withCaret } from '../../tui/line.ts'
import { clampScroll, keepInView } from '../../tui/list.ts'
import { fit, tidy, visible, wrapText as wrap } from '../../tui/text.ts'
import { load as settings } from '../../settings/settings.ts'
import type { Panes, TabPane } from './state.ts'
import {
  type Arranged,
  CATEGORIES,
  DEFAULT_CATEGORY,
  type Exists,
  type Fields,
  HANDOFF_MODELS,
  type Here,
  type Item,
  type KnownRepo,
  TYPES,
  filingState,
  handoffPlace,
  imagesOf,
  inGit,
} from './todo.ts'

// Widths are in terminal cells: a CJK character or an emoji takes two.
export { cells, caretParts, caretShown, editLine, fit, head, tail, tidy, visible, withCaret, wrap }

// u, so a character outside the BMP is escaped whole, not as two halves.
export const shellQuote = (text: string): string => text.replace(/[^\w./-]/gu, '\\$&')

export type KeyAction =
  | 'quit'
  | 'close'
  | 'next-mode'
  | 'down'
  | 'up'
  | 'page-down'
  | 'page-up'
  | 'first'
  | 'last'
  | 'go'
  | 'done'
  | 'claude'
  | 'manual'
  | 'retry'
  | 'edit'
  | 'category'
  | 'type'
  | 'delete'
  | 'mark'
  | 'clear-marks'
  | 'handoff'
  | 'only'
  | 'show-done'

// With no prompt open; todo-view.ts's ACTIONS runs each.
export const KEYS: Partial<Record<string, KeyAction>> = {
  q: 'quit',
  '\x03': 'quit',
  '\x1b': 'close',
  '\t': 'next-mode',
  j: 'down',
  k: 'up',
  '\x1b[B': 'down',
  '\x1b[A': 'up',
  '\x04': 'page-down',
  '\x15': 'page-up',
  '\x1b[6~': 'page-down',
  '\x1b[5~': 'page-up',
  g: 'first',
  G: 'last',
  '\r': 'go',
  ' ': 'done',
  a: 'claude',
  A: 'manual',
  r: 'retry',
  e: 'edit',
  c: 'category',
  t: 'type',
  x: 'delete',
  m: 'mark',
  M: 'clear-marks',
  w: 'handoff',
  f: 'only',
  d: 'show-done',
}

// `at` is a text field's caret (tui/line.ts), off at the end; `replaces` the
// failed filing an add by hand starts from; `images` those pasted so far
// (Ctrl+V), carried from the title to the note.
export type ClaudePrompt = { kind: 'claude'; text: string; at?: number; images?: Image[] }
export type TitlePrompt = { kind: 'title'; text: string; at?: number; replaces?: string; images?: Image[] }
export type CatPrompt = { kind: 'cat'; title: string; cat: string; replaces?: string; images?: Image[] }
export type NotePrompt = { kind: 'note'; title: string; cat: string; text: string; at?: number; replaces?: string; images?: Image[] }
export type EditPrompt = {
  kind: 'edit'
  id: string
  field: EditField
  title: string
  cat: string
  type: string | null
  // from is the repo it had; find is the filter typed.
  repos: KnownRepo[]
  repo: KnownRepo
  from: KnownRepo
  find: string
  note: string
  at?: number
  // The item's images and those pasted since; `was` its title and note,
  // and images, as the edit found them.
  images?: Image[]
  was: { text: string; images: Image[] }
}
// moved: sent there for having no repo of its own.
export type HandoffPlace = { cwd: string | undefined; git: boolean; moved: boolean }
export type HandoffPrompt = {
  kind: 'handoff'
  ids: string[]
  here: Here
  places: HandoffPlace[]
  inGit: number
  worktree: boolean
  model: string
  // When b last had nothing to choose, which lights the note up.
  flash?: number
}
export type ConfirmPrompt = { kind: 'confirm'; text: string; yes: () => void; key: string; answers: Hint[] }
export type Prompt = ClaudePrompt | TitlePrompt | CatPrompt | NotePrompt | EditPrompt | HandoffPrompt | ConfirmPrompt

const read = tokenizer({ paste: true, alt: 'letters', unicode: true, release: 'released' })
export const parseInput = (chunk: string | Uint8Array): Token[] => read(chunk)

export function selectable(view: Arranged, showDone: boolean): Item[] {
  const list = [...view.filing, ...view.groups.flatMap(g => g.items)]
  return showDone ? [...list, ...view.doneToday] : list
}

export const cursorItem = <I extends Pick<Item, 'id'>>(list: readonly I[], cursorId: string): I | undefined =>
  list.find(i => i.id === cursorId) ?? list[0]

// ±Infinity goes to the first or last. Undefined on an empty list.
export function moveTo(list: readonly Pick<Item, 'id'>[], cursorId: string, by: number): string | undefined {
  if (!list.length) return undefined
  const current = cursorItem(list, cursorId)
  const at = Math.max(0, current ? list.indexOf(current) : -1)
  return list[Math.max(0, Math.min(list.length - 1, at + by))]?.id ?? list[by < 0 ? 0 : list.length - 1].id
}

// Where the cursor goes when the item leaves the list.
export const neighbour = <I>(list: readonly I[], item: I): I | undefined => list[list.indexOf(item) + 1] ?? list[list.indexOf(item) - 1]

// Marks only hold open, real items still in the store. `items` is the whole
// store, not the list as shown, so an item f hides keeps its mark for when
// it shows again; what acts on marks takes only the shown ones (markedIds).
export function pruneMarks(marked: Set<string>, items: readonly Pick<Item, 'id' | 'done' | 'filing'>[]): Set<string> {
  for (const id of marked) if (!items.some(i => i.id === id && !i.done && !i.filing)) marked.delete(id)
  return marked
}

// From a value not in the ring, steps as if from just before the first.
const around = <T>(ring: readonly T[], at: T, by: number): T => ring[(ring.indexOf(at) + by + ring.length) % ring.length]

const CATEGORY_RING: readonly string[] = CATEGORIES.map(c => c.name)
const TYPE_RING: readonly (string | null)[] = [...TYPES.map(t => t.name), null]

export const nextCategory = (cat: string): string => around(CATEGORY_RING, cat, 1)
export const nextType = (type: string | null | undefined): string | null => around(TYPE_RING, type ?? null, 1)

export const filingHint = (item: Pick<Item, 'filing'>): string =>
  t(filingState(item) === 'failed' ? 'todo.filing.failedHint' : 'todo.filing.busyHint')

export type ScrollRow = { item?: unknown; header?: boolean }

// Keeps the selected item's whole card in view, its row first. The first item
// in a group brings its group's header along when the card still fits, or
// scrolling back up would leave the header just off the top.
export function scrollTo(rows: readonly ScrollRow[], current: unknown, scroll: number, height: number): number {
  // With nothing selected, rows without an item (headers, and past the end)
  // would all match it.
  const first = current ? rows.findIndex(r => r.item === current) : -1
  if (first >= 0) {
    let last = first
    while (rows[last + 1]?.item === current) last++
    scroll = keepInView(scroll, first, last, height)
    const top = rows[first - 1]?.header ? first - 1 : first
    if (top < scroll && last - top < height) scroll = top
  }
  return clampScroll(scroll, rows.length, height)
}

// repoOf calls the repo 'none' outside git.
export const scopeName = (repo: string): string => (repo && repo !== 'none' ? repo : t('todo.thisRepo'))

export type EmptyState = { loadError: string; only: boolean; repo: string }

export function emptyLines({ loadError, only, repo }: EmptyState): string[] {
  if (loadError) return [loadError]
  if (only) return [t('todo.empty.noneIn', { scope: scopeName(repo) }), t('todo.empty.showAll')]
  return [t('todo.empty.none'), t('todo.empty.howToAdd')]
}

export const statusPairs = (marks: number, only: boolean): Hint[] =>
  marks
    ? [
        ['w', t('todo.keys.handOff')],
        ['m', t('todo.keys.mark')],
        ['shift+m', t('hints.clear')],
        ['space', t('todo.keys.done')],
      ]
    : [
        ['space', t('todo.keys.done')],
        ['a', t('hints.add')],
        ['shift+a', t('todo.keys.byHand')],
        ['m', t('todo.keys.mark')],
        ['w', t('todo.keys.handOff')],
        ['f', t(only ? 'todo.keys.allRepos' : 'todo.keys.thisRepo')],
      ]
export const position = <I>(list: readonly I[], current: I | undefined, marks: number): string =>
  list.length ? `${marks ? `${marks} marked · ` : ''}${current === undefined ? 0 : list.indexOf(current) + 1}/${list.length} ` : ''

// The least used go first (category, type, then edit), so ↵ and space stay.
export function cardKeys(pairs: readonly Hint[], w: number): Hint[] {
  let keep = [...pairs]
  for (const key of ['c', 't', 'e']) if (keyHintsWidth(keep) > w) keep = keep.filter(([k]) => k !== key)
  while (keep.length && keyHintsWidth(keep) > w) keep = keep.slice(0, -1)
  return keep
}

// The steps of adding by hand. It skips the type, since t sets it after;
// the edit form has it.
export const FIELDS = ['title', 'cat', 'note'] as const
export type AddStep = (typeof FIELDS)[number]
export const EDIT_FIELDS = ['title', 'cat', 'type', 'repo', 'note'] as const
export type EditField = (typeof EDIT_FIELDS)[number]
export const fieldName = (field: EditField): string => t(`todo.fields.${field}`)

export const editText = (text: string, key: string): string => editLine(text, undefined, key).text

// Left off when there are none.
const withImages = (images: Image[]): { images?: Image[] } => (images.length ? { images } : {})

// On a filing that failed, starts from its message, with its images, and
// replaces it.
export const manualPrompt = (item: Pick<Item, 'id' | 'title' | 'filing' | 'images'> | undefined): TitlePrompt =>
  item && filingState(item) === 'failed' ? { kind: 'title', text: item.title, replaces: item.id, ...withImages(imagesOf(item)) } : { kind: 'title', text: '' }

export const NO_REPO: KnownRepo = { repo: 'none', root: '' }

type EditSource = Pick<Item, 'id' | 'title' | 'cat' | 'type' | 'note' | 'repo' | 'root' | 'images'>

const hasRepo = (item: Pick<Item, 'repo' | 'root'>): boolean => item.repo !== 'none' && !!item.root

// The item's own goes first when `repos` doesn't have it: a repo whose folder
// is gone, or one outside the projects folder.
export function repoChoices(item: Pick<Item, 'repo' | 'root'>, repos: readonly KnownRepo[]): KnownRepo[] {
  if (!hasRepo(item)) return [...repos, NO_REPO]
  const own = repos.find(r => r.root === item.root) ?? { repo: item.repo, root: item.root }
  return [...(repos.includes(own) ? [] : [own]), ...repos, NO_REPO]
}

export const repoMatches = ({ repos, find }: Pick<EditPrompt, 'repos' | 'find'>): KnownRepo[] =>
  repos.filter(r => r.repo.toLowerCase().includes(find.toLowerCase()))

export function editPrompt(item: EditSource, repos: readonly KnownRepo[] = []): EditPrompt {
  const choices = repoChoices(item, repos)
  // repoChoices always has the item's own.
  const own = (hasRepo(item) && choices.find(r => r.root === item.root)) || NO_REPO
  const note = item.note ?? ''
  return {
    kind: 'edit',
    id: item.id,
    field: 'title',
    title: item.title,
    cat: item.cat,
    type: item.type ?? null,
    repos: choices,
    repo: own,
    from: own,
    find: '',
    note,
    ...withImages(imagesOf(item)),
    was: { text: `${item.title}\n${note}`, images: imagesOf(item) },
  }
}

const PICK_STEPS: Partial<Record<string, 1 | -1>> = { '\x1b[C': 1, ' ': 1, '\x1b[D': -1 }
const FIELD_STEPS: Partial<Record<string, 1 | -1>> = { '\t': 1, '\x1b[B': 1, '\x1b[Z': -1, '\x1b[A': -1 }

const nth = <T>(list: readonly T[], key: string): T | undefined => (/^[1-9]$/.test(key) ? list[Number(key) - 1] : undefined)

// The first match becomes the pick; no match, or an emptied filter, keeps it.
function pickFirstMatch(prompt: EditPrompt): void {
  const first = prompt.find && repoMatches(prompt)[0]
  if (first) prompt.repo = first
}

const EDIT_KEYS: Record<EditField, (prompt: EditPrompt, key: string) => void> = {
  title: (prompt, key) => void editField(prompt, 'title', key),
  note: (prompt, key) => void editField(prompt, 'note', key),
  cat(prompt, key) {
    const step = PICK_STEPS[key]
    const cat = step ? around(CATEGORY_RING, prompt.cat, step) : nth(CATEGORIES, key)?.name
    if (cat) prompt.cat = cat
  },
  type(prompt, key) {
    const step = PICK_STEPS[key]
    if (step) prompt.type = around(TYPE_RING, prompt.type, step)
    else if (key === '0') prompt.type = null
    else prompt.type = nth(TYPES, key)?.name ?? prompt.type
  },
  repo(prompt, key) {
    const step = PICK_STEPS[key]
    if (!step) {
      prompt.find = editText(prompt.find, key)
      return pickFirstMatch(prompt)
    }
    const ring = repoMatches(prompt)
    if (ring.length) prompt.repo = around(ring, prompt.repo, step)
  },
}

// Every key in the edit form but ↵, which editChanges saves. Changes the
// prompt in place.
export function editKey(prompt: EditPrompt, key: string): EditPrompt {
  const move = FIELD_STEPS[key]
  if (!move) {
    EDIT_KEYS[prompt.field](prompt, key)
    return prompt
  }
  prompt.field = around(EDIT_FIELDS, prompt.field, move)
  // The caret starts at the end of the field it lands on.
  delete prompt.at
  return prompt
}

export type EditSave = { id: string; fields: Fields }

// Null when the title is empty. A new repo starts the item at its main checkout, with no branch or worktree,
// and drops the Claude session, which can only resume where it ran. No repo
// puts it under home, as ghostty-todo add --dir none does. An image whose
// placeholder the edit deleted goes, as does one pasted in it and deleted.
export function editChanges(
  { id, title, cat, type, note, repo, from, images = [], was }: Pick<EditPrompt, 'id' | 'title' | 'cat' | 'type' | 'note' | 'repo' | 'from' | 'images'> & Partial<Pick<EditPrompt, 'was'>>,
  home = homedir(),
): EditSave | null {
  if (!title.trim()) return null
  const fields: Fields = { title: title.trim(), cat, type, note: note.trim() }
  if (images.length) {
    const text = `${fields.title}\n${fields.note}`
    const had = new Set(was?.images.map(i => i.path))
    const old = images.filter(i => had.has(i.path))
    fields.images = [...keptImages(old, text, was?.text ?? ''), ...keptImages(images.filter(i => !had.has(i.path)), text)]
  }
  if (repo && repo !== from) {
    const root = repo === NO_REPO ? home : repo.root
    Object.assign(fields, { repo: repo.repo, root, cwd: root, worktree: '', branch: '', session: '' })
  }
  return { id, fields }
}

export type Note = { ok: boolean; text: string }

// Null when the store failed, so its error stays showing.
export function savedNote(saved: Pick<Item, 'title'> | undefined, error: unknown): Note | null {
  if (error) return null
  return saved ? { ok: true, text: t('todo.say.saved', { title: saved.title }) } : { ok: false, text: t('todo.say.gone') }
}

export type ByHand = { title: string; cat: string; note: string; replaces?: string; images?: Image[] }

// The prompt after a key (null closes it), and what the viewer does besides:
//   yes      the confirm was answered with its key
//   edit     the edit form takes the key (editKey, editChanges)
//   handoff  the hand-off row takes it (handoffKey)
//   manual   switch to adding by hand (manualPrompt)
//   add      add `add` by hand
//   file     hand `text` and its images to Claude to file
//   ignore   nothing, not even a redraw
export type PromptStep =
  | { prompt: Prompt | null; run?: '' | 'manual' | 'ignore' }
  | { prompt: null; run: 'yes' }
  | { prompt: EditPrompt; run: 'edit' }
  | { prompt: HandoffPrompt; run: 'handoff' }
  | { prompt: null; run: 'add'; add: ByHand }
  | { prompt: null; run: 'file'; text: string; images: Image[] }

// An empty note still adds the item. A title moves on to its category,
// starting on that of `current`, the item under the cursor.
function submit(prompt: ClaudePrompt | TitlePrompt | NotePrompt, current: Item | undefined): PromptStep {
  const text = prompt.text.trim()
  if (prompt.kind === 'note') {
    const { title, cat, replaces } = prompt
    const images = keptImages(prompt.images ?? [], `${title}\n${text}`)
    return { prompt: null, run: 'add', add: { title, cat, note: text, replaces, ...withImages(images) } }
  }
  if (!text) return { prompt: null }
  // The filer is given the images as paths alone, numbered in order.
  if (prompt.kind === 'claude') return { prompt: null, run: 'file', ...renumber(text, keptImages(prompt.images ?? [], text)) }
  const cat = (!current?.filing && current?.cat) || DEFAULT_CATEGORY
  return { prompt: { kind: 'cat', title: text, replaces: prompt.replaces, cat, ...withImages(prompt.images ?? []) } }
}

function pickCategory(prompt: CatPrompt, key: string): PromptStep {
  const picked = key === '\r' ? prompt.cat : nth(CATEGORIES, key)?.name
  if (!picked) return { prompt, run: 'ignore' }
  return { prompt: { ...prompt, kind: 'note', cat: picked, text: '' } }
}

export function promptKey(prompt: Prompt, key: string, current?: Item): PromptStep {
  if (prompt.kind === 'confirm') return key === prompt.key ? { prompt: null, run: 'yes' } : { prompt: null, run: '' }
  if (key === '\x1b' || key === '\x03') return { prompt: null }
  if (prompt.kind === 'edit') return { prompt, run: 'edit' }
  if (prompt.kind === 'handoff') return { prompt, run: 'handoff' }
  if (prompt.kind === 'cat') return pickCategory(prompt, key)
  // What the placeholder offers. Only on an empty line, so a message can
  // still have a capital A in it.
  if (prompt.kind === 'claude' && key === 'A' && !prompt.text) return { prompt, run: 'manual' }
  if (key === '\r') return submit(prompt, current)
  editField(prompt, 'text', key)
  return { prompt }
}

function insertInto<K extends string>(state: FieldState<K>, field: K, text: string): void {
  const texts: Record<K, string> = state
  const { text: next, at } = insertAt(texts[field], state.at, text)
  texts[field] = next
  if (at < length(next)) state.at = at
  else delete state.at
}

// The text field Ctrl+V puts an image in, or none: the prompts that write a
// todo's title or note.
function imageField(prompt: Prompt | null): 'text' | 'title' | 'note' | null {
  if (prompt?.kind === 'claude' || prompt?.kind === 'title' || prompt?.kind === 'note') return 'text'
  if (prompt?.kind === 'edit' && (prompt.field === 'title' || prompt.field === 'note')) return prompt.field
  return null
}

export const takesImages = (prompt: Prompt | null): boolean => imageField(prompt) !== null

// The image goes in at the caret as its placeholder, with no space after it,
// so one Backspace takes it out again (tui/line.ts). False when the prompt
// doesn't take one.
export function attachImage(prompt: Prompt | null, path: string): boolean {
  const field = imageField(prompt)
  if (!field || !prompt || prompt.kind === 'cat' || prompt.kind === 'handoff' || prompt.kind === 'confirm') return false
  const n = nextNumber(prompt.images ?? [])
  prompt.images = [...(prompt.images ?? []), { n, path }]
  const mark = placeholder(n)
  if (prompt.kind !== 'edit') insertInto(prompt, 'text', mark)
  else if (field !== 'text') insertInto(prompt, field, mark)
  return true
}

// On one line: every field is one, and a newline typed would be ↵. False when
// the prompt has no text to take it, so the paste is dropped rather than read
// as keys.
export function pasteInto(prompt: Prompt | null, text: string): boolean {
  const flat = tidy(text.replace(/\r\n?|\n/g, ' '))
  if (prompt?.kind === 'claude' || prompt?.kind === 'title' || prompt?.kind === 'note') {
    insertInto(prompt, 'text', flat)
    return true
  }
  if (prompt?.kind !== 'edit') return false
  if (prompt.field === 'repo') {
    prompt.find += flat
    const first = repoMatches(prompt)[0]
    if (first) prompt.repo = first
    return true
  }
  if (prompt.field !== 'title' && prompt.field !== 'note') return false
  insertInto(prompt, prompt.field, flat)
  return true
}

export const markedIds = (list: readonly Pick<Item, 'id'>[], marked: Set<string>): string[] => list.filter(i => marked.has(i.id)).map(i => i.id)

// An item deleted while the row opens reads as one without a repo, so it
// counts toward those sent to the open folder; handOff skips it later.
const GONE: Item = { id: '', title: '', cat: '', note: '', created: 0, done: null, root: '', repo: '' }

// Fixed as the row opens, so what it says is where the agents start. Without
// a layout window (win 0) there is no tab session to open tabs in.
export function handoffPrompt(ids: string[], items: readonly Item[], here: Here, exists: Exists = existsSync): HandoffPrompt {
  const s = settings()
  const at = { ...here }
  const places = ids.map(id => {
    const item = items.find(i => i.id === id) ?? GONE
    const place = handoffPlace(item, at, exists)
    return { cwd: place.cwd, git: inGit(place, exists), moved: place !== item }
  })
  const git = places.filter(p => p.git).length
  return {
    kind: 'handoff',
    ids,
    here: at,
    places,
    inGit: git,
    worktree: git > 0 && s['todo.handoff.branch'] === 'worktree',
    model: s['todo.handoff.model'],
  }
}

// What a key on the hand-off row did besides changing it: 'start' on ↵,
// 'no-git' when b has no worktree or branch to choose.
export type HandoffKeyResult = '' | 'start' | 'no-git'

export function handoffKey(prompt: HandoffPrompt, key: string): HandoffKeyResult {
  if (key === '\r') return 'start'
  if (key === 'b') {
    if (!prompt.inGit) return 'no-git'
    prompt.worktree = !prompt.worktree
  } else if (key === 'm') prompt.model = around<string>(HANDOFF_MODELS, prompt.model, 1)
  return ''
}

export function handoffResult(started: readonly Pick<Item, 'title'>[], failed: readonly string[]): Note {
  if (failed.length)
    return { ok: false, text: t(started.length ? 'todo.handOff.someFailed' : 'todo.handOff.allFailed', { n: started.length, failed: failed.join('; ') }) }
  if (started.length === 1) return { ok: true, text: t('todo.handOff.oneInBackground', { title: started[0].title }) }
  return { ok: true, text: t('todo.handOff.manyInBackground', { n: started.length }) }
}

export const reopenLine = (claude: string, session: string | undefined): string =>
  session ? `${shellQuote(claude)} --resume ${shellQuote(session)}` : shellQuote(claude)

export const reopenDir = (item: Pick<Item, 'worktree' | 'cwd' | 'root'>, exists: Exists = existsSync): string | undefined =>
  [item.worktree, item.cwd, item.root].find(d => d && exists(d))

// The running tab server's start time; '' when tmux didn't say or no tab is open.
export const serverOf = (panes: Panes): string => panes?.values().next().value?.server ?? ''

// Only while it's still the tab it was recorded for: an id recorded under
// another server is a closed tab (see Item's paneServer). A server that wasn't
// recorded, or that tmux didn't say, is taken to be the same.
export function paneAt(panes: Panes, pane: string | undefined, server: string | undefined): TabPane | undefined {
  const at = pane ? panes?.get(pane) : undefined
  return at && (!server || !at.server || at.server === server) ? at : undefined
}

// Says nothing while tmux can't say (`panes` null). `win` is 0 outside a
// layout window.
export function tabOf(pane: string | undefined, panes: Panes, win: number, server?: string): string {
  if (!pane || !panes) return ''
  const at = paneAt(panes, pane, server)
  if (!at) return t('todo.tabs.closed')
  const tab = at.hub ? t('todo.tabs.hub') : t('todo.tabs.tab', { n: at.index })
  return at.win === win || !win ? tab : t('todo.tabs.otherWindow', { win: at.win, tab })
}

// A tab agent is found by its pane, a background one by the name it was
// started with (launch in agents/model.ts). A pane recorded under another
// tab server than `server` is some other tab's.
export function hubAgent(item: Pick<Item, 'handoff'>, agents: readonly Agent[], server = ''): Agent | null {
  const { pane, name, server: was } = item.handoff ?? {}
  if (!pane && !name) return null
  if (pane && was && server && was !== server) return null
  return agents.find(a => (pane ? a.pane?.pane === pane : a.kind === 'bg' && a.title === name)) ?? null
}

export const agentPane = (item: Pick<Item, 'handoff'>, panes: Panes): string =>
  item.handoff?.pane && paneAt(panes, item.handoff.pane, item.handoff.server) ? item.handoff.pane : ''

// '' when ↵ does nothing. With the tabs unread, a tab is taken to be open.
export function goLabel(item: Pick<Item, 'handoff' | 'pane' | 'paneServer'>, panes: Panes, agents: readonly Agent[]): string {
  if (hubAgent(item, agents, serverOf(panes)) || agentPane(item, panes)) return t('todo.keys.goToAgent')
  if (!item.pane) return ''
  return !panes || paneAt(panes, item.pane, item.paneServer) ? t('todo.keys.goToTab') : t('todo.keys.reopen')
}

export const noTabText = (item: Pick<Item, 'handoff' | 'by'>): string =>
  item.handoff?.where === 'bg'
    ? t('todo.go.ranInBackground', { name: item.handoff.name })
    : t(item.by === 'you' ? 'todo.go.addedHere' : 'todo.go.outsideTabs')

// col counts from 1.
export const modeAt = <M extends ModeTab>(col: number, modes: readonly M[]): M | undefined => modes[tabAt(modes, col)]

// `header` is a column on the top row; `row` an index into the body rows as
// scrolled.
export type MouseAction = { move: number } | { header: number } | { row: number }
export type MouseContext = { prompt: Prompt | null; top: number; height: number }

// Only left presses click, and none while a prompt is open; the wheel moves
// the cursor under any prompt but the edit form, which is drawn in its
// item's card and would vanish with it. Null for anything else.
export function mouseAction(report: Mouse, { prompt, top, height }: MouseContext): MouseAction | null {
  const { button, x, y } = report
  if (button & 64) return prompt?.kind === 'edit' ? null : { move: (button & 1) === 0 ? -1 : 1 }
  if (!leftPress(report) || prompt) return null
  if (y === 1) return { header: x }
  if (y < top || y >= top + height) return null
  return { row: y - top }
}
