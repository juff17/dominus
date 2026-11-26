// The approvals panel on screen. panel() also returns where it left the
// scroll and how much of the proposal has now been on screen, for the view
// to keep. It reads nothing but the state and $EDITOR, so a test can draw
// any state.

import { t } from '../../core/text.ts'
import { type ButtonSpec, buttons as buttonRow } from '../../tui/controls.ts'
import { CARET_MARK, caretParts, length, withCaret } from '../../tui/line.ts'
import { BG } from '../../tui/palette.ts'
import { ACCENT, ACCENT_INK, BOLD, type Line, P, type Span, ago, bg, clean, fg, render, spanWidth, split, width } from '../../tui/term.ts'
import { wrapText as wrap } from '../../tui/text.ts'
import { type Proposal, type ProposalCommit, editable } from '../../agents/proposals.ts'
import { proposalLink } from '../../tray/links.ts'
import { clampScroll, bodyRows as diffBodyRows, followCursor } from '../diff/diff.ts'
import { diffRow, fileRow, scaleOf } from '../diff/diff-rows.ts'
import { type DiffView, type Env, type State, afterSeen, bodyOf, current, inline } from './approvals.ts'

const BASE = bg(P.base)
const BOX = bg(P.mantle)
const SEL = bg(P.surface0)

// ------------------------------------------------------------ pieces

const blank = (w: number) => render([], w, BASE)
const label = (text: string, w: number, color = P.sub) => render([[` ${text}`, BOLD + fg(color)]], w, BASE)
const short = (sha: unknown) => String(sha ?? '').slice(0, 7)
const stat = (c: Pick<ProposalCommit, 'added' | 'removed'>) => `+${c.added ?? 0} −${c.removed ?? 0}`
const said = (text: string, w: number, color: string) => render([[` ${text}`, fg(color)]], w, BASE)
const failure = (text: string, w: number) => wrap(text, w - 2).map(l => render([[` ${l}`, BOLD + fg(P.red)]], w, BASE))

const boxLines = (text: string, w: number, caret?: number): string[] =>
  wrap(caret !== undefined ? withCaret(text, caret) : text.split('\n').map(clean).join('\n'), w - 6)

// The character under the caret mark (a space at the end) as its own span in
// reverse video. Drawn as spans, render measures the line in the cells it
// fills; an escape inside the text would count as cells and leave the box
// short.
function caretLine(l: string): Line {
  const chars = [...l]
  const at = chars.indexOf(CARET_MARK)
  if (at < 0) return [[l, fg(P.text)]]
  const { before, under, after } = caretParts(chars.toSpliced(at, 1).join(''), at, Number.POSITIVE_INFINITY)
  return [
    [before, fg(P.text)],
    [under, `${fg(P.text)}\x1b[7m`],
    [after, fg(P.text)],
  ]
}

function box(text: string, w: number, most = Number.POSITIVE_INFINITY, caret?: number): string[] {
  const editing = caret !== undefined
  let lines = boxLines(text, w, caret)
  if (lines.length > most) lines = [...lines.slice(0, most - 1), `${lines[most - 1]} …`]
  const edge = render([], 2, BASE) + render([], w - 4, BOX) + render([], 2, BASE)
  const row = (l: string) => render([], 2, BASE) + render([[' '], ...(editing ? caretLine(l) : [[l, fg(P.text)] as Span])], w - 4, BOX) + render([], 2, BASE)
  return [edge, ...lines.map(row), edge]
}

// ------------------------------------------------------------ the diff

function diffLines(d: DiffView, w: number, height: number): { lines: string[]; scroll: number } {
  const title: Line = [
    [` ${t('approvals.diff.badge')} `, BOLD + fg(ACCENT_INK) + bg(ACCENT)],
    [`  ${clean(d.title)}`, BOLD + fg(P.text)],
  ]
  const head = split(title, [[`${t('approvals.diff.files', { n: d.files.length })} `, fg(P.sub)]], w, BASE)
  const failed = d.error ? failure(t('approvals.diff.gitFailed', { err: d.error }), w) : []
  if (!d.files.length) return { lines: [head, blank(w), ...(failed.length ? failed : [said(` ${t('approvals.diff.noChanges')}`, w, P.sub)])], scroll: d.scroll }
  const list = diffBodyRows(d.files, d.open, d.rows)
  const room = height - 2 - failed.length
  const scroll = clampScroll(d.follow ? followCursor(list, d.cursor, d.scroll, room) : d.scroll, list.length, room)
  const most = scaleOf(d.files)
  const lines = [head, blank(w), ...failed]
  for (const r of list.slice(scroll, scroll + room)) {
    if (r.kind === 'file') lines.push(fileRow(d.files[r.i], { open: d.files[r.i].path === d.open, selected: r.i === d.cursor, width: w, most }))
    else if (r.kind === 'diff') lines.push(diffRow(r.row, w))
    else lines.push(blank(w))
  }
  return { lines, scroll }
}

// ------------------------------------------------------------ the body

function metaOf(p: Proposal): (string | number | undefined)[] {
  const where = `${p.pr?.repo ?? ''} ${p.pr?.ref ?? ''}`.trim()
  if (p.kind === 'reply') return [where, p.thread?.where, p.thread?.id && t('approvals.meta.thread', { id: p.thread.id })]
  if (p.kind === 'comment') return [where, p.comment && `${p.comment.path}:${p.comment.line}`, p.comment?.sha && t('approvals.meta.at', { sha: short(p.comment.sha) })]
  if (p.kind === 'push') return [where, `${p.local} → ${p.remote}/${p.branch}`]
  if (p.kind === 'move') return [where, t('approvals.meta.onto', { local: p.local ?? '', sha: short(p.onto) })]
  return [where, p.job?.stage && t('approvals.meta.stage', { stage: p.job.stage }), p.job?.id && t('approvals.meta.job', { id: p.job.id })]
}

function heading(p: Proposal, w: number): string[] {
  const out = [
    blank(w),
    render([[` ${clean(p.title)}`, BOLD + fg(P.text)]], w, BASE),
    said(metaOf(p).filter(Boolean).join(' · '), w, P.sub),
    said(t('approvals.meta.proposed', { ago: ago(p.at) }), w, P.overlay1),
  ]
  if (p.status === 'failed') out.push(blank(w), ...failure(t('approvals.meta.failed', { message: p.result?.message ?? '' }), w))
  return [...out, blank(w)]
}

// A reply under their comment, or a review comment of the user's own, which
// answers nothing.
function replyBody(s: State, p: Proposal, w: number, env: Env): Body {
  const reply = p.kind === 'reply'
  const out = reply ? [label(p.thread?.author ? t('approvals.labels.theirCommentBy', { author: p.thread.author }) : t('approvals.labels.theirComment'), w)] : []
  if (reply) out.push(...box(p.thread?.body ?? '', w, 12))
  if (p.briefing) out.push(blank(w), label(t('approvals.labels.briefing'), w), ...box(p.briefing, w))
  if (p.commit) {
    const commit: Line = [
      [`  ${short(p.commit.sha)}`, fg(P.green)],
      [`  ${clean(p.commit.subject)}  `, fg(P.text)],
      [stat(p.commit), fg(P.sub)],
    ]
    out.push(blank(w), label(t('approvals.labels.whatIDid'), w), render(commit, w, BASE))
  }
  const which = reply ? 'reply' : 'comment'
  if (out.length) out.push(blank(w))
  out.push(label(t(s.editing ? `approvals.labels.${which}Editing` : `approvals.labels.${which}`), w, P.peach))
  let caret: number | undefined
  if (s.editing) {
    // `at` is left off at the end, where the caret still shows. The 1 is the
    // box's top edge.
    const at = s.at ?? length(s.draft)
    const lines = boxLines(s.draft, w, at)
    const row = lines.findIndex(l => l.includes(CARET_MARK))
    caret = out.length + 1 + (row >= 0 ? row : lines.length - 1)
    out.push(...box(s.draft, w, Number.POSITIVE_INFINITY, at))
  } else out.push(...box(bodyOf(s, p), w))
  // While editing, the footer has the keys; how to start editing is moot.
  const how = s.editing ? '' : ` ${t(inline(env) ? 'approvals.reply.editHere' : 'approvals.reply.editInEditor')}`
  out.push(said(`${t(s.edited ? 'approvals.reply.postedEdited' : 'approvals.reply.posted')}${how}`, w, P.sub))
  return { lines: out, caret }
}

function commitRow(s: State, c: ProposalCommit, i: number, w: number): string {
  const dropped = s.drop.has(c.sha)
  const left: Line = [
    [`  ${dropped ? '✗' : '✓'} `, fg(dropped ? P.red : P.green)],
    [short(c.sha), fg(dropped ? P.overlay1 : P.green)],
    [`  ${clean(c.subject)}`, dropped ? `${fg(P.overlay1)}\x1b[9m` : fg(P.text)],
  ]
  const right: Line = [
    [c.note ? `${clean(c.note)}  ` : '', fg(P.sub)],
    [`${stat(c)}  `, fg(P.sub)],
    ['▸ ', fg(ACCENT)],
  ]
  return render([], 1, BASE) + split(left, right, w - 2, i === s.commit ? SEL : BOX) + render([], 1, BASE)
}

function pushBody(s: State, p: Proposal, w: number): string[] {
  const out = [label(t('approvals.labels.commits'), w), ...(p.commits ?? []).map((c, i) => commitRow(s, c, i, w))]
  out.push(blank(w), label(t('approvals.labels.checks'), w))
  const leaseOk = p.remote_head === p.lease
  const lease = leaseOk ? t('approvals.push.leaseOk', { sha: short(p.lease) }) : t('approvals.push.remoteMoved', { sha: short(p.remote_head) || t('approvals.push.nothing') })
  const checks: [boolean, string][] = [...(p.checks ?? []).map((c): [boolean, string] => [c.ok, c.name]), [leaseOk, lease]]
  out.push(render(checks.flatMap(([ok, name]): Span[] => [[' '], [` ${ok ? '✓' : '✗'} ${clean(name)} `, fg(ok ? P.green : P.red) + (ok ? BG.ok : BG.bad)]]), w, BASE))
  if (p.removes?.length) {
    out.push(blank(w), label(t('approvals.labels.takesOff', { n: p.removes.length, branch: p.branch ?? '' }), w, P.red))
    for (const c of p.removes) {
      const removed: Line = [
        ['  − ', fg(P.red)],
        [short(c.sha), fg(P.red)],
        [`  ${clean(c.subject)}  `, fg(P.text)],
        [stat(c), fg(P.sub)],
      ]
      out.push(render(removed, w, BASE))
    }
  }
  const command = s.drop.size ? t('approvals.push.afterDropping', { command: p.command ?? '', n: s.drop.size }) : (p.command ?? '')
  return [...out, blank(w), ...box(command, w)]
}

const WHAT: Record<string, (p: Proposal, name: string) => string> = {
  retry: (p, name) => [t('approvals.what.retry', { name }), p.job?.reason && t('approvals.what.flaky', { reason: p.job.reason })].filter(Boolean).join(' '),
  manual: (p, name) => (p.job?.stage ? t('approvals.what.manualIn', { name, stage: p.job.stage }) : t('approvals.what.manual', { name })),
  deploy: (_, name) => t('approvals.what.deploy', { name }),
  move: p => t('approvals.what.move', { from: short(p.lease), onto: short(p.onto) }),
}

function jobBody(p: Proposal, w: number): string[] {
  const what = Object.hasOwn(WHAT, p.kind) ? WHAT[p.kind](p, p.job?.name ?? '') : ''
  return [label(t('approvals.labels.whatApproving'), w), ...box(what, w, 4)]
}

type Body = { lines: string[]; caret?: number }

function body(s: State, p: Proposal, w: number, env: Env): Body {
  const own: Body = editable(p) ? replyBody(s, p, w, env) : { lines: p.kind === 'push' ? pushBody(s, p, w) : jobBody(p, w) }
  const top = heading(p, w)
  return { lines: [...top, ...own.lines], caret: own.caret === undefined ? undefined : top.length + own.caret }
}

function buttons(s: State, p: Proposal, w: number): string {
  const B = (k: string) => t(`approvals.buttons.${k}`)
  const total = (p.commits ?? []).length
  const approve = p.status === 'failed' ? B('tryAgain') : p.kind === 'push' && s.drop.size ? t('approvals.buttons.pushSome', { n: total - s.drop.size, total }) : B(p.kind)
  const link = proposalLink(p)
  const list: ButtonSpec[] = [
    { label: approve, key: 'a', main: true, color: P.peach },
    ...(editable(p) && p.status === 'pending' ? [{ label: B('edit'), key: 'e' }] : []),
    ...(p.kind === 'push' ? [{ label: B('openDiff'), key: 'd' }] : []),
    p.status === 'failed' ? { label: B('dismiss'), key: 'x' } : { label: B(p.kind === 'push' || p.kind === 'move' ? 'notYet' : 'reject'), key: 'r' },
    { label: B('goToSession'), key: 'g' },
    ...(link ? [{ label: `${link.label} ↗`, key: 'o' }] : []),
  ]
  const spans: Span[] = [[' '], ...buttonRow(list)]
  // A push says what refuses it, shorter or not at all when the buttons
  // need the room: the lease check above says it too.
  const lease = short(p.lease)
  const says = p.kind === 'push' ? [`${t('approvals.push.refused', { sha: lease })} `, `${t('approvals.push.refusedShort', { sha: lease })} `] : []
  const room = w - spanWidth(spans) - 2
  const right = says.find(text => width(text) <= room)
  return split(spans, right ? [[right, fg(P.sub)]] : [], w, BASE)
}

// Most needed first: the footer drops them from the end when there's too
// little room.
export function keysFor(s: State, p: Proposal | null): [key: string, what: string][] {
  const H = (k: string) => t(`hints.${k}`)
  const K = (k: string) => t(`approvals.keys.${k}`)
  if (s.diff) return [['j k', K('file')], ['enter', K('openClose')], ['J K', H('scroll')], ['esc', H('back')]]
  if (s.editing) return [['enter', K('done')], ['esc', K('dropEdit')], ['←→', H('move')], ['ctrl+u ctrl+w', H('delete')]]
  if (!p) return []
  const step: [string, string] = ['← →', K('proposal')]
  // A failed one can only be tried again, with a, or dismissed; A refuses it.
  if (p.status === 'failed') return [step, ['x', K('dismiss')], ['g', K('goToSession')]]
  // d isn't here: the Open diff button shows it.
  if (p.kind === 'push') return [step, ['↑ ↓', K('commits')], ['enter', K('itsDiff')], ['space', K('keepDrop')], ['A', K('always')]]
  if (p.kind === 'reply') return [step, ['e', H('edit')], ['A', K('alwaysReplies')]]
  if (p.kind === 'comment') return [step, ['e', H('edit')], ['r', K('reject')]]
  if (p.kind === 'deploy') return [step, ['r', K('reject')], ['g', K('goToSession')]]
  return [step, ['A', K(p.kind === 'retry' ? 'alwaysRetries' : 'alwaysKind')]]
}

export const dots = (s: Pick<State, 'list' | 'i'>): string => (s.list.length > 1 ? s.list.slice(0, 12).map((_, i) => (i === s.i ? '●' : '○')).join(' ') : '')

// ------------------------------------------------------------ the panel

export type PanelOptions = { env?: Env; empty?: string }

export type Drawn = {
  lines: string[]
  scroll: number
  seen: ReturnType<typeof afterSeen> | null
  diffScroll: number | null
}

export function panel(s: State, w: number, h: number, { env = process.env, empty = t('approvals.nothingWaiting') }: PanelOptions = {}): Drawn {
  const p = current(s)
  const lines: string[] = []
  if (s.diff && p) {
    const diff = diffLines(s.diff, w, h)
    lines.push(...diff.lines)
    while (lines.length < h) lines.push(blank(w))
    return { lines: lines.slice(0, h), scroll: s.scroll, seen: null, diffScroll: diff.scroll }
  }
  const room = Math.max(1, h - 1)
  const { lines: main, caret } = p ? body(s, p, w, env) : { lines: [blank(w), said(` ${empty}`, w, P.sub)], caret: undefined }
  const fits = main.length <= room
  const view = fits ? room : room - 1
  // A resize before all of it was seen starts from the top again: seen is
  // counted in rows from the top, and kept further down, the clamp below
  // could reach the end and count the rows above it as seen.
  const restart = s.seenWidth !== 0 && s.seenWidth !== w && s.seenTo !== Number.POSITIVE_INFINITY
  const from = restart ? 0 : s.scroll
  // The inline editor takes every key, so the body follows its caret.
  const want = caret === undefined ? from : Math.min(Math.max(from, caret - view + 1), caret)
  const scroll = Math.max(0, Math.min(want, main.length - view))
  lines.push(...main.slice(scroll, scroll + view))
  if (!fits) {
    const below = main.length - scroll - view
    lines.push(said(below > 0 ? t('approvals.moreBelow', { n: below }) : t('approvals.backToTop'), w, P.overlay1))
  }
  const seen = afterSeen(s, scroll + view, main.length, w)
  while (lines.length < h - 1) lines.push(blank(w))
  lines.push(p ? buttons(s, p, w) : blank(w))
  return { lines: lines.slice(0, h), scroll, seen, diffScroll: null }
}
