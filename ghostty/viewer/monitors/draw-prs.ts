// Alt+M's PRs & MRs view: a row per PR or MR, its pipeline, reviews and
// branch, and the drawer that starts watchers on the selected ones.

import { tilde } from '../../core/paths.ts'
import { t } from '../../core/text.ts'
import { button, field, frameBottom, frameTop, select, spanWidth } from '../../tui/controls.ts'
import { clampScroll, keepInView } from '../../tui/list.ts'
import { TINT } from '../../tui/palette.ts'
import { BOLD, ITALIC, P, type Span, ago, bg, clean, fg, render, split } from '../../tui/term.ts'
import { WATCH_KEYS } from './attach.ts'
import { babysitBranch, repoKey } from './checkout.ts'
import type { Branch, HostResult, Pipeline, Pr, Reviews } from './forge.ts'
import { rule } from './heading.ts'
import { lit } from './lit.ts'
import { type PrRow, refLabel, sameUrl } from './rows.ts'
import {
  type Drawer,
  type MonitorsState,
  prList,
  selectedPr,
  targets,
} from './state.ts'
import { BASE, BOX, DIM, SEL, SUB, blank, cell, hiddenLine } from './look.ts'

type Col = 'ref' | 'title' | 'pipe' | 'rev' | 'branch' | 'mon'
const FIXED: Record<Exclude<Col, 'title'>, number> = { ref: 24, pipe: 24, rev: 29, branch: 13, mon: 13 }
// Dropped in this order when the title would get too narrow.
const DROP: readonly Col[] = ['rev', 'branch', 'pipe', 'mon']
const LEAD = 2 + 4 + 3

export function prColumns(w: number): { cols: Col[]; title: number } {
  let cols: Col[] = ['ref', 'title', 'pipe', 'rev', 'branch', 'mon']
  const titleW = (cs: Col[]) => w - LEAD - cs.reduce((n, c) => n + (c === 'title' ? 0 : FIXED[c] + 1), 0) - 1
  for (const c of DROP) if (titleW(cols) < 18) cols = cols.filter(x => x !== c)
  return { cols, title: Math.max(6, titleW(cols)) }
}

const PIPE_LOOK: Record<Pipeline['state'], string> = {
  passed: P.green,
  failed: P.red,
  running: P.blue,
  pending: P.sub,
  manual: P.peach,
  canceled: P.overlay1,
  none: P.overlay1,
}

export function pipelineText(p: Pipeline): string {
  if (p.state === 'failed') return p.job ? t('monitors.pipeline.failed', { job: p.job }) : t('monitors.pipeline.failedNoJob')
  if (p.state === 'manual') return t('monitors.pipeline.manual', { job: p.job })
  if (p.state === 'running') return t('monitors.pipeline.running', { done: p.done, total: p.total })
  return t(`monitors.pipeline.${p.state}`)
}

export function reviewsText(r: Reviews, draft: boolean): [text: string, color: string] {
  const threads = r.threads ? ` · ${t('monitors.reviews.threads', { n: r.threads })}` : ''
  if (r.changes) return [`${t('monitors.reviews.changes')}${threads}`, P.peach]
  if (r.required) return [`${t('monitors.reviews.of', { n: r.approvedBy.length, required: r.required })}${threads}`, P.sub]
  if (r.approvedBy.length && !r.waiting) return [`${t('monitors.reviews.approved')}${threads}`, P.green]
  if (r.waiting) return [`${t('monitors.reviews.required')}${threads}`, P.sub]
  if (draft) return [t('monitors.reviews.draft'), P.overlay1]
  if (r.reviewers.length) return [`${t('monitors.reviews.waiting', { n: r.reviewers.length })}${threads}`, P.sub]
  return [r.threads ? threads.slice(3) : t('monitors.reviews.none'), P.overlay1]
}

export function branchText(b: Branch): [text: string, color: string] {
  if (b.state === 'conflict') return [t('monitors.branch.conflict'), P.peach]
  if (b.state === 'behind') return [b.behind ? t('monitors.branch.behind', { n: b.behind }) : t('monitors.branch.behindSome'), P.sub]
  if (b.state === 'ok') return [t('monitors.branch.ok'), P.overlay1]
  return [t('monitors.branch.unknown'), P.overlay1]
}

const MON_LOOK: Record<string, [string, string]> = {
  action: [t('monitors.monitor.action'), P.peach],
  watching: [t('monitors.monitor.watching'), P.rose],
  stale: [t('monitors.monitor.stale'), P.sub],
  none: [t('monitors.monitor.attach'), P.rose],
}

function prLine(row: PrRow, on: boolean, marked: boolean, layout: ReturnType<typeof prColumns>): string {
  const fill = on ? SEL : BASE
  const { pr } = row
  const dim = pr.draft
  const text = (color: string) => fg(dim ? P.overlay1 : color)
  const out = [cell([[on ? ' ▌' : '  ', fg(P.rose)]], 2, fill), cell([[marked ? '[x]' : '[ ]', fg(marked ? P.rose : P.overlay1)]], 4, fill), cell([[pr.forge, DIM]], 3, fill)]
  for (const c of layout.cols) {
    const spans: Span[] =
      c === 'ref'
        ? lit(clean(row.ref), row.hit.ref, text(P.text))
        : c === 'title'
          ? lit(clean(pr.title), row.hit.title, (on ? BOLD : '') + text(P.text))
          : c === 'pipe'
            ? [[pipelineText(pr.pipeline), text(PIPE_LOOK[pr.pipeline.state])]]
            : c === 'rev'
              ? (([s, color]) => [[s, text(color)] as Span])(reviewsText(pr.reviews, pr.draft))
              : c === 'branch'
                ? (([s, color]) => [[s, text(color)] as Span])(branchText(pr.branch))
                : (([s, color]) => [[s, text(color)] as Span])(MON_LOOK[row.monitor ?? 'none'])
    out.push(cell(spans, c === 'title' ? layout.title : FIXED[c], fill), cell([], 1, fill))
  }
  return out.join('')
}

function prHeader(s: MonitorsState, rows: readonly PrRow[], layout: ReturnType<typeof prColumns>, w: number): string {
  const marked = rows.filter(r => s.prs.marked.has(sameUrl(r.pr.url))).length
  const box = s.prs.marked.size === 0 ? '[ ]' : marked === rows.length && rows.length ? '[x]' : '[-]'
  const names: Record<Col, string> = {
    ref: t('monitors.cols.pr'),
    title: t('monitors.cols.title'),
    pipe: t('monitors.cols.pipeline'),
    rev: t('monitors.cols.reviews'),
    branch: t('monitors.cols.branch'),
    mon: t('monitors.cols.monitor'),
  }
  const spans: Span[] = [['  '], [box.padEnd(4), fg(s.prs.marked.size ? P.rose : P.overlay1)], ['   ']]
  for (const c of layout.cols) spans.push([names[c].padEnd((c === 'title' ? layout.title : FIXED[c]) + 1), DIM])
  return render(spans, w, BASE)
}

// A host that failed this time keeps the rows it had, this line under them.
function hostLine(h: Extract<HostResult, { ok: false }>, w: number): string {
  const cli = h.forge === 'gh' ? 'gh' : 'glab'
  const why = h.why === 'failed' ? t(h.prs.length ? 'monitors.hosts.stale' : 'monitors.hosts.failed', { err: clean(h.err).slice(0, 120) }) : t(`monitors.hosts.${h.why}`, { cli })
  return render([['   '], [`${h.forge} ${h.host} · ${why}`, DIM]], w, BASE)
}

function infoBox(s: MonitorsState, row: PrRow, w: number, now: number): string[] {
  const { pr } = row
  const label = (k: string): Span => [` ${t(`monitors.info.${k}`).padEnd(11)}`, DIM + BOX]
  const conflicts: Span[] = pr.branch.state === 'conflict' ? [[` · ${t('monitors.branch.conflict')}`, fg(P.peach) + BOX]] : []
  const opened = pr.createdAt ? ` · ${t('monitors.info.opened', { ago: ago(pr.createdAt, now) })}` : ''
  const approved = pr.reviews.approvedBy.length ? ` · ${t('monitors.info.approvedBy', { who: pr.reviews.approvedBy.map(a => `@${a}`).join(', ') })}` : ''
  const reviewers = pr.reviews.reviewers.length ? pr.reviews.reviewers.map(r => `@${r}`).join(', ') : t('monitors.info.noReviewers')
  const dir = s.checkouts.get(repoKey(pr.host, pr.repo))
  const checkout: Span[] = dir
    ? [[tilde(dir), fg(P.text) + BOX], [' · ', DIM + BOX], ['⑂ ', DIM + BOX], [babysitBranch(pr.number), fg(P.text) + BOX]]
    : [[t('monitors.info.noCheckout', { repo: pr.repo }), fg(P.peach) + BOX]]
  return [
    render([label('selected'), [`${pr.forge} `, DIM + BOX], [clean(row.ref), BOLD + fg(P.text) + BOX], [` · ⎇ ${clean(pr.head)} → ${clean(pr.base)}${opened}`, SUB + BOX], ...conflicts], w, BOX),
    render([label('reviewers'), [`${reviewers}${approved}`, SUB + BOX]], w, BOX),
    render([label('checkout'), ...checkout], w, BOX),
  ]
}

// ------------------------------------------------------------ the drawer

export const DRAWER_ROWS = 5

// !512, #44
const shortRefs = (prs: readonly Pr[]): string => prs.map(p => `${p.forge === 'gh' ? '#' : '!'}${p.number}`).join(', ')

function toggleChip(i: number, label: string, on: boolean): Span[] {
  const fill = on ? bg(TINT.ok) : BOX
  return [[` ${i + 1}`, BOLD + fg(on ? P.rose : P.overlay1) + fill], [` ${label} `, fg(on ? P.text : P.overlay1) + fill], [' ', BOX]]
}

function drawerLines(s: MonitorsState, d: Drawer, prs: readonly Pr[], offScreen: number, w: number): string[] {
  const inner = w - 4
  const marked = s.prs.marked.size
  const head: Span[] = marked
    ? [[t('monitors.drawer.attachTo', { n: prs.length }), BOLD + fg(P.rose) + BOX], ...(offScreen ? ([[` ${t('monitors.drawer.offScreen', { n: offScreen })}`, fg(P.peach) + BOX]] as Span[]) : [])]
    : [[t('monitors.drawer.attachOne', { ref: prs[0] ? refLabel(prs[0].forge, prs[0].repo.split('/').at(-1) ?? '', prs[0].number) : '' }), BOLD + fg(P.rose) + BOX]]
  const refs: Span = [`  ${shortRefs(prs)}`, SUB + BOX]
  const summary: Span[] = d.more
    ? [
        [`${t('monitors.drawer.until')} `, DIM + BOX],
        ...select(t(`monitors.untilShort.${d.until}`), d.focus === 'until').map(([x, st]): Span => [x, `${st ?? ''}${BOX}`]),
        [`  ${t('monitors.drawer.model')} `, DIM + BOX],
        ...select(d.model, d.focus === 'model').map(([x, st]): Span => [x, `${st ?? ''}${BOX}`]),
        [`  ${t('monitors.drawer.effort')} `, DIM + BOX],
        ...select(d.effort, d.focus === 'effort').map(([x, st]): Span => [x, `${st ?? ''}${BOX}`]),
        [' ', BOX],
      ]
    : [
        [`${t('monitors.drawer.summary', { until: t(`monitors.untilShort.${d.until}`), model: d.model, effort: d.effort })} · `, DIM + BOX],
        ['m', fg(P.text) + BOX],
        [` ${t('monitors.drawer.more')} `, DIM + BOX],
      ]
  const toggles: Span[] = [[`${t('monitors.drawer.watch')}`.padEnd(7), DIM + BOX], ...WATCH_KEYS.flatMap((k, i) => toggleChip(i, t(`monitors.drawer.toggles.${k}`), d.watch[k]))]
  const start = button(t('monitors.drawer.start'), { key: ' ctrl+s', main: true, color: P.rose })
  const fieldW = Math.max(4, inner - 7 - spanWidth(start) - 2)
  const brief: Span[] = [
    [`${t('monitors.drawer.brief')}`.padEnd(7), (d.focus === 'brief' ? fg(P.rose) : DIM) + BOX],
    ...field({ text: d.brief, at: d.at, w: fieldW, focused: d.focus === 'brief', placeholder: t('monitors.drawer.briefPlaceholder') }),
  ]
  return [
    frameTop(w, { fill: BASE }),
    boxed(split([...head, refs], summary, inner, BOX)),
    boxed(render(toggles, inner, BOX)),
    boxed(split(brief, start, inner, BOX)),
    frameBottom(w, { fill: BASE }),
  ]
}

// Content is `w - 4` cells wide.
const EDGE = render([['│', fg(P.rose)]], 1, BASE)
const PAD = render([[' ']], 1, BOX)
const boxed = (content: string): string => `${EDGE}${PAD}${content}${PAD}${EDGE}`

export function prs(s: MonitorsState, w: number, height: number, now: number): { lines: string[]; scroll: number } {
  const f = s.filters.prs
  const { rows, hidden } = prList(s)
  const sel = selectedPr(s)
  const layout = prColumns(w)
  const down = s.hosts.filter((h): h is Extract<HostResult, { ok: false }> => !h.ok)
  const noHosts = !s.hosts.length && !s.refreshing
  const below = (hidden && f.query.trim() ? 1 : 0) + Math.min(3, down.length) + (noHosts ? 1 : 0)
  const box = s.drawer ? DRAWER_ROWS : sel ? 4 : 0
  const listH = Math.max(1, height - 2 - below - box)
  const selUrl = sel ? sameUrl(sel.pr.url) : ''
  const at = rows.findIndex(r => sameUrl(r.pr.url) === selUrl)
  const scroll = clampScroll(at < 0 ? 0 : keepInView(s.prs.scroll, at, at, listH), rows.length, listH)
  const lines = [prHeader(s, rows, layout, w), rule(w)]
  for (let y = 0; y < listH; y++) {
    const r = rows[scroll + y]
    if (r) lines.push(prLine(r, sameUrl(r.pr.url) === selUrl, s.prs.marked.has(sameUrl(r.pr.url)), layout))
    else if (y === 0) {
      const say = f.query.trim() ? t('monitors.empty.noMatch', { query: f.query.trim() }) : s.refreshing && !s.hosts.some(h => h.at) ? t('monitors.refreshing') : t('monitors.empty.prs')
      lines.push(render([['   '], [say, ITALIC + SUB]], w, BASE))
    } else lines.push(blank(w))
  }
  if (hidden && f.query.trim()) lines.push(hiddenLine(hidden, w))
  for (const h of down.slice(0, 3)) lines.push(hostLine(h, w))
  if (noHosts) lines.push(render([['   '], [t('monitors.empty.noHosts'), DIM]], w, BASE))
  if (s.drawer) {
    const visible = new Set(rows.slice(scroll, scroll + listH).map(r => sameUrl(r.pr.url)))
    const offScreen = [...s.prs.marked].filter(u => !visible.has(u)).length
    lines.push(...drawerLines(s, s.drawer, targets(s), offScreen, w))
  } else if (sel) lines.push(blank(w), ...infoBox(s, sel, w, now))
  return { lines, scroll }
}
