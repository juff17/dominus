// The approvals panel's state and keys, apart from the terminal so it can be
// tested; draw.ts draws it and effects.ts carries out what a key asks for.
// It steps through one monitor's proposals (pr-babysit's approval.py).
//
// Approving needs the whole proposal to have been on screen, and approving,
// rejecting or dismissing a look at one that replaced what you were
// reading, so a key never settles something you didn't see.

import { t } from '../../core/text.ts'
import { load as settings } from '../../settings/settings.ts'
import { editField, pasteField } from '../../tui/line.ts'
import { type Proposal, editable } from '../../agents/proposals.ts'
import { proposalLink } from '../../tray/links.ts'
import type { DiffFile, DiffRow } from '../diff/diff.ts'

export type Tone = 'green' | 'red' | 'peach' | 'sub'
export type Note = { text: string; tone: Tone }

// A push's diff, shown as the Diff mode shows uncommitted changes. error is
// why git couldn't give the files.
export type DiffView = {
  title: string
  from: string
  to: string
  files: DiffFile[]
  error: string
  cursor: number
  open: string
  rows: DiffRow[]
  scroll: number
  follow: boolean
}

export type State = {
  list: Proposal[]
  i: number
  commit: number
  drop: Set<string>
  diff: DiffView | null
  // The edit a would post (reply) is kept apart from the inline editor's
  // draft, so dropping a second edit leaves the first one as it was.
  editing: boolean
  draft: string
  at: number | undefined
  edited: boolean
  reply: string
  note: Note | null
  // The footer while a proposal is being settled; keys wait.
  busy: string
  // seenTo is rows seen at seenWidth columns, or Infinity once all of it has
  // been. hidden holds until a draw says otherwise, so it is set whenever
  // what's shown changes before the next draw.
  scroll: number
  seenTo: number
  seenWidth: number
  hidden: boolean
  // changed: the proposal shown just replaced the one you were looking at.
  // held: a settling key was just refused for it, until a draw shows why.
  changed: boolean
  held: boolean
}

// `always` is A: approve and always run this kind from now on.
export type Approve = { do: 'approve'; p: Proposal; always: boolean; body?: string; drop?: string[] }
export type Effect =
  | Approve
  | { do: 'reject'; p: Proposal }
  | { do: 'dismiss'; p: Proposal }
  | { do: 'go'; p: Proposal }
  | { do: 'editor'; p: Proposal; text: string }
  | { do: 'diff'; p: Proposal; from: string; to: string; title: string }
  | { do: 'diffFile'; file: DiffFile }
  | { do: 'open'; p: Proposal; url: string }
export type KeyResult = Effect | 'close' | undefined

export type Env = { EDITOR?: string }

export const start = (list: Proposal[], focus = ''): State => ({
  list,
  i: Math.max(0, list.findIndex(p => p.id === focus)),
  commit: 0,
  diff: null,
  drop: new Set(),
  editing: false,
  draft: '',
  at: undefined,
  edited: false,
  reply: '',
  note: null,
  busy: '',
  scroll: 0,
  seenTo: 0,
  seenWidth: 0,
  // The view draws before it reads a key.
  hidden: false,
  changed: false,
  held: false,
})

export const current = (s: State): Proposal | null => s.list[Math.min(s.i, s.list.length - 1)] ?? null

// The one shown stays shown while it's there. `settled` is the one this
// panel just settled: its going is no surprise, but any other one going is,
// even right after a settle that failed because it had gone.
export function reload(s: State, list: Proposal[], settled = ''): void {
  const was = current(s)
  const id = was?.id
  const at = list.findIndex(p => p.id === id)
  s.list = list
  if (at >= 0) {
    // Settled elsewhere and failed: the drops were chosen for the pending
    // push, space can't change them on a failed one, and approval.py would
    // hand a failed one back with them instead of trying it again.
    if (list[at].status !== was?.status) s.drop = new Set()
    s.i = at
    return
  }
  s.i = Math.min(s.i, Math.max(0, list.length - 1))
  reset(s)
  if (id && list.length && id !== settled) {
    s.changed = true
    s.note = { text: t('approvals.notes.replaced'), tone: 'peach' }
  }
}

function reset(s: State): void {
  s.commit = 0
  s.diff = null
  s.drop = new Set()
  s.editing = false
  s.draft = ''
  s.at = undefined
  s.edited = false
  s.reply = ''
  s.scroll = 0
  s.seenTo = 0
  // Not drawn yet: keys read with the one that stepped here, before any
  // draw, must not approve it.
  s.hidden = true
  s.changed = false
}

const UNSEEN: Note = { text: t('approvals.notes.unseen'), tone: 'peach' }

// Rows seen at another width wrapped other text, so they count for nothing;
// all of it seen stays seen. A draw also ends a refusal's hold (looked).
export function afterSeen(s: State, to: number, length: number, width: number): Pick<State, 'seenTo' | 'seenWidth' | 'hidden' | 'note' | 'held'> {
  const before = s.seenWidth === width || s.seenTo === Number.POSITIVE_INFINITY ? s.seenTo : 0
  const most = Math.max(before, to)
  const seenTo = most >= length ? Number.POSITIVE_INFINITY : most
  const hidden = seenTo < length
  return { seenTo, seenWidth: width, hidden, note: !hidden && s.note === UNSEEN ? null : s.note, held: false }
}

export function seen(s: State, to: number, length: number, width = s.seenWidth): void {
  Object.assign(s, afterSeen(s, to, length, width))
}

// A settling key is refused the first time after the proposal replaced what
// you were reading. A second a or r in the same read of the keyboard is
// refused too, and leaves the note as it is: nothing was drawn between them.
function looked(s: State, note: string): boolean {
  if (s.held) return false
  if (!s.changed) return true
  s.changed = false
  s.held = true
  s.note = { text: t(note), tone: 'peach' }
  return false
}

function ready(s: State): boolean {
  if (!looked(s, 'approvals.notes.lookAgain')) return false
  if (s.hidden) {
    s.note = UNSEEN
    return false
  }
  return true
}

function move(s: State, n: number): void {
  if (!s.list.length) return
  s.i = (s.i + n + s.list.length) % s.list.length
  reset(s)
  s.note = null
}

export const bodyOf = (s: State, p: Proposal): string => (s.edited ? s.reply : (p.body ?? ''))

export function approval(s: State, p: Proposal, always = false): Approve {
  const e: Approve = { do: 'approve', p, always }
  if (editable(p) && s.edited && s.reply !== p.body) e.body = s.reply
  if (p.kind === 'push' && s.drop.size) e.drop = [...s.drop]
  return e
}

// A deployment and a review comment on someone else's PR always ask.
export const canAlways = (p: Proposal): boolean => p.status === 'pending' && p.kind !== 'deploy' && p.kind !== 'comment'

// The Settings key and value A turns on for each kind.
export type AlwaysSetting = readonly ['approvals.reply', 'post'] | readonly ['approvals.push' | 'approvals.retry' | 'approvals.manual' | 'approvals.move', 'auto']
const ALWAYS: Record<string, AlwaysSetting> = {
  reply: ['approvals.reply', 'post'],
  push: ['approvals.push', 'auto'],
  retry: ['approvals.retry', 'auto'],
  manual: ['approvals.manual', 'auto'],
  move: ['approvals.move', 'auto'],
}
export const alwaysSetting = (p: Proposal): AlwaysSetting | null => (Object.hasOwn(ALWAYS, p.kind) ? ALWAYS[p.kind] : null)

// With Settings' "post it", a finished edit is approved at once; with "show
// it once more", it waits for a.
export function edited(s: State, p: Proposal, text: string | null): Approve | undefined {
  s.editing = false
  s.at = undefined
  if (text == null || text === bodyOf(s, p)) {
    s.note = { text: t('approvals.notes.unchanged'), tone: 'sub' }
    return undefined
  }
  s.reply = text
  s.edited = true
  if (settings()['approvals.edited'] === 'post') return approval(s, p)
  s.note = { text: t('approvals.notes.edited'), tone: 'peach' }
  return undefined
}

export const inline = (env: Env): boolean => settings()['approvals.editor'] === 'inline' || !env.EDITOR

function editKey(s: State, p: Proposal, key: string): KeyResult {
  if (key === '\r') return edited(s, p, s.draft)
  if (key === '\x1b') {
    s.editing = false
    s.draft = ''
    s.at = undefined
    s.note = { text: t('approvals.notes.editDropped'), tone: 'sub' }
    return undefined
  }
  editField(s, 'draft', key)
  return undefined
}

export function paste(s: State, text: string): void {
  pasteField(s, 'draft', text)
}

export function openDiff(s: State, { title, from, to, files, error = '' }: Pick<DiffView, 'title' | 'from' | 'to' | 'files'> & { error?: string }): void {
  s.diff = { title, from, to, files, error, cursor: 0, open: files[0]?.path ?? '', rows: [], scroll: 0, follow: true }
}

// The overlay's own closing keys (tui/overlay.ts) would throw away a reply
// being edited.
export const mayClose = (s: Pick<State, 'editing'>): boolean => !s.editing

type DiffKey = (d: DiffView, s: State) => KeyResult | undefined

const pick =
  (to: (d: DiffView) => number): DiffKey =>
  d => {
    d.cursor = Math.max(0, Math.min(d.files.length - 1, to(d)))
    d.follow = true
  }
const next = pick(d => d.cursor + 1)
const previous = pick(d => d.cursor - 1)
const scrollDiff =
  (by: number): DiffKey =>
  d => {
    d.scroll = Math.max(0, d.scroll + by)
    d.follow = false
  }
const back: DiffKey = (_, s) => {
  s.diff = null
}
const toggle: DiffKey = d => {
  const f = d.files[d.cursor]
  if (!f) return undefined
  d.open = d.open === f.path ? '' : f.path
  d.rows = []
  d.error = ''
  d.follow = true
  return d.open ? { do: 'diffFile', file: f } : undefined
}

const DIFF_KEYS: Record<string, DiffKey> = {
  '\x1b': back,
  q: back,
  d: back,
  j: next,
  k: previous,
  '\x1b[B': next,
  '\x1b[A': previous,
  g: pick(() => 0),
  G: pick(d => d.files.length - 1),
  '\r': toggle,
  ' ': toggle,
  J: scrollDiff(5),
  K: scrollDiff(-5),
  '\x1b[6~': scrollDiff(10),
  '\x1b[5~': scrollDiff(-10),
}

function diffKey(s: State, d: DiffView, key: string): KeyResult {
  return Object.hasOwn(DIFF_KEYS, key) ? (DIFF_KEYS[key](d, s) ?? undefined) : undefined
}

type ProposalKey = (s: State, p: Proposal, env: Env) => Effect | undefined

const step =
  (by: number): ProposalKey =>
  s => {
    move(s, by)
  }
const scrollBy =
  (by: number): ProposalKey =>
  s => {
    s.scroll = Math.max(0, s.scroll + by)
  }
const commitsOf = (p: Proposal) => p.commits ?? []

const KEYS: Record<string, ProposalKey> = {
  // j and k are Monitors', which move between monitors.
  '\x1b[D': step(-1),
  '\x1b[C': step(1),
  // ↑ and ↓ pick a push's commit, and step on anything else.
  '\x1b[B': (s, p) => {
    if (p.kind === 'push') s.commit = Math.min(commitsOf(p).length - 1, s.commit + 1)
    else move(s, 1)
  },
  '\x1b[A': (s, p) => {
    if (p.kind === 'push') s.commit = Math.max(0, s.commit - 1)
    else move(s, -1)
  },
  '\r': (s, p) => {
    const c = commitsOf(p)[s.commit]
    if (p.kind !== 'push' || !c?.sha) return undefined
    return { do: 'diff', p, from: `${c.sha}^`, to: c.sha, title: `${c.sha.slice(0, 7)} ${c.subject ?? ''}`.trim() }
  },
  ' ': (s, p) => {
    const commits = commitsOf(p)
    const sha = commits[s.commit]?.sha
    if (p.kind !== 'push' || !sha || p.status !== 'pending') return
    if (s.drop.has(sha)) s.drop.delete(sha)
    else s.drop.add(sha)
    if (s.drop.size === commits.length) {
      s.drop.delete(sha)
      s.note = { text: t('approvals.notes.keepOne'), tone: 'peach' }
    }
  },
  J: scrollBy(5),
  '\x1b[6~': scrollBy(10),
  K: scrollBy(-5),
  '\x1b[5~': scrollBy(-10),
  a: (s, p) => (ready(s) ? approval(s, p) : undefined),
  A: (s, p) => {
    if (canAlways(p)) return ready(s) ? approval(s, p, true) : undefined
    const why = p.kind === 'deploy' ? 'approvals.notes.deployAsks' : p.kind === 'comment' ? 'approvals.notes.commentAsks' : 'approvals.notes.tryAgain'
    s.note = { text: t(why), tone: 'peach' }
    return undefined
  },
  e: (s, p, env) => {
    if (!editable(p) || p.status !== 'pending') return undefined
    if (!inline(env)) return { do: 'editor', p, text: bodyOf(s, p) }
    s.editing = true
    s.draft = bodyOf(s, p)
    s.at = undefined
    s.note = null
    return undefined
  },
  r: (s, p) => (looked(s, 'approvals.notes.replaced') ? { do: p.status === 'pending' ? 'reject' : 'dismiss', p } : undefined),
  x: (s, p) => (p.status === 'pending' || !looked(s, 'approvals.notes.replaced') ? undefined : { do: 'dismiss', p }),
  g: (_, p) => ({ do: 'go', p }),
  d: (_, p) =>
    p.kind === 'push' ? { do: 'diff', p, from: p.lease ?? '', to: p.head ?? '', title: t('approvals.diff.allCommits', { n: commitsOf(p).length }) } : undefined,
  o: (_, p) => {
    const link = proposalLink(p)
    return link ? { do: 'open', p, url: link.url } : undefined
  },
}

// Any other key counts as a look at a replacement (looked).
const SETTLES = new Set(['a', 'A', 'r', 'x'])

export function onKey(s: State, key: string, env: Env = process.env): KeyResult {
  const p = current(s)
  if (s.editing && p) return editKey(s, p, key)
  if (s.diff && p) return diffKey(s, s.diff, key)
  if (key === 'q' || key === '\x1b') return 'close'
  if (!p) return undefined
  if (!SETTLES.has(key)) s.changed = false
  return Object.hasOwn(KEYS, key) ? (KEYS[key](s, p, env) ?? undefined) : undefined
}
