// frame(state, size, now) → the lines inside the Tickets overlay's frame and
// its title. Pure: it reads nothing but its arguments, so a test can draw
// any state.

import { t } from '../../core/text.ts'
import { type Hint, hintSpans } from '../../tui/chrome.ts'
import { type BoxLine, type HeaderTitle, card, field, laneHeader } from '../../tui/controls.ts'
import type { Size } from '../../tui/overlay.ts'
import { ACCENT, BOLD, ITALIC, type Line, P, STATE, type Span, ago, bg, clean, fg, render, split, width } from '../../tui/term.ts'
import { JIRA_KEYS } from '../../settings/env.ts'
import { ROLES, Role } from '../../agents/launch.ts'
import { type Confirm, LANES, ROLE_KEYS, type TicketsState, agentOf, agentsOf, columnTickets, laneTickets, missing, pickable } from './state.ts'
import type { Phase, Ticket } from './tracker.ts'

export type { Size }
export type Frame = { lines: string[]; title: HeaderTitle; firstCol: number }

// Narrower than this a card can't hold its key and summary; under this the
// popup only says it needs more room.
export const MIN_COL = 24
export const MAX_COLS = 6
export const MIN_SIZE = { cols: 80, rows: 24 }
const GAP = 2
const CARD_ROWS = 4

const LANE = bg(P.mantle)
const BASE = bg(P.base)
const PHASE_COLOR: Record<Phase, string> = { todo: P.sub, doing: P.blue, done: P.green }
const TONE: Record<string, string> = { ok: P.green, working: P.blue, warn: P.yellow, bad: P.red, sub: P.sub }

const blank = (w: number, fill = LANE): string => render([], w, fill)
const centred = (spans: Line, w: number, fill = LANE): string => render([[' '.repeat(Math.max(0, Math.floor((w - spans.reduce((n, [s]) => n + width(s), 0)) / 2)))], ...spans], w, fill)

// How many columns show, at equal widths, and which come first.
export function columnsShown(total: number, cols: number, focused: number, first: number): { n: number; w: number; first: number } {
  const inner = cols - 2
  const n = Math.max(1, Math.min(MAX_COLS, total, Math.floor((inner + GAP) / (MIN_COL + GAP))))
  let from = Math.max(0, Math.min(first, total - n))
  if (focused < from) from = focused
  if (focused >= from + n) from = focused - n + 1
  return { n, w: Math.floor((inner - (n - 1) * GAP) / n), first: from }
}

const ARROW: Record<string, string> = { highest: '⇈', high: '↑', medium: '→', low: '↓', lowest: '⇊' }

// The card's last line: its most urgent agent in the hub's words and
// colours, named by role unless it's the worker, then a glyph and key for
// each other live agent (`✻w`, `●t`); else its priority and parent, quiet.
function bottomLine(s: TicketsState, x: Ticket): { line: Span[]; needs: boolean } {
  const [lead, ...others] = agentsOf(s, x.key)
  if (lead) {
    const look = STATE[lead.agent.state]
    const role = lead.role === Role.Work ? '' : ` · ${t(`tickets.roles.${lead.role}`)}`
    const marks: Span[] = others.map(o => [`  ${STATE[o.agent.state].glyph}${ROLE_KEYS[o.role]}`, BOLD + fg(STATE[o.agent.state].color)])
    const cmd = lead.agent.cmd ? ` · ${clean(lead.agent.cmd)}` : ''
    return { line: [[`${look.glyph} ${look.name}`, BOLD + fg(look.color)], [role, fg(look.color)], ...marks, [cmd, fg(look.color)]], needs: agentsOf(s, x.key).some(a => a.agent.state === 'needs') }
  }
  if (s.links[x.key]) return { line: [[`○ ${t('tickets.card.ended')}`, fg(P.overlay1)]], needs: false }
  const prio = x.priority ? `${ARROW[x.priority.toLowerCase()] ?? '·'} ${x.priority}` : ''
  return { line: [[[prio, x.parent].filter(Boolean).join(' · '), fg(P.sub)]], needs: false }
}

function ticketCard(s: TicketsState, x: Ticket, w: number, on: boolean, now: number): string[] {
  const { line, needs } = bottomLine(s, x)
  const when = Date.parse(x.updated)
  const right = [x.points !== undefined ? t('tickets.card.points', { n: x.points }) : '', Number.isFinite(when) ? ago(when, now) : ''].filter(Boolean).join(' · ')
  const title: Span[] = [
    [` ${x.key}`, BOLD + fg(on ? ACCENT : P.text)],
    [x.type ? ` ${clean(x.type)} ` : ' ', fg(P.sub)],
  ]
  const lines: BoxLine[] = [[[clean(x.title), BOLD + fg(P.text)]], line]
  return card(title, right ? [[` ${right} `, fg(P.sub)]] : [], lines, w, { border: on ? ACCENT : needs ? P.peach : P.surface1, fill: on ? bg(P.surface0) : bg(P.base), under: LANE })
}

const doneRow = (x: Ticket, w: number, on: boolean, now: number): string => {
  const when = Date.parse(x.updated)
  return split(
    [
      [on ? '▌' : ' ', fg(ACCENT)],
      ['✓ ', fg(P.green)],
      [`${x.key} `, fg(P.sub)],
      [clean(x.title), fg(P.text)],
    ],
    [[Number.isFinite(when) ? ` ${ago(when, now)} ` : '', fg(P.sub)]],
    w,
    on ? bg(P.surface0) : LANE,
  )
}

// One column of one lane, `h` rows tall, every row `w` wide.
function column(s: TicketsState, lane: number, col: number, w: number, h: number, now: number): string[] {
  const b = s.board
  if (!b) return []
  const c = b.columns[col]
  const tickets = columnTickets(b, lane, col)
  const out: string[] = []
  if (c.phase === 'done' && !s.prefs.showDone) {
    if (tickets.length) out.push(render([[' ✓ ', fg(P.green)], [t('tickets.board.doneHidden', { n: tickets.length }), fg(P.overlay1)]], w, LANE))
  } else {
    const focused = s.lane === lane && s.col === col
    const tall = c.phase === 'done' ? 1 : CARD_ROWS
    const fits = Math.max(1, Math.floor(h / tall))
    const room = tickets.length > fits ? Math.max(1, Math.floor((h - 1) / tall)) : fits
    const from = focused ? Math.max(0, Math.min(s.row - room + 1, tickets.length - room)) : 0
    tickets.slice(from, from + room).forEach((x, i) => {
      const on = focused && from + i === s.row && pickable(s, col)
      if (tall === 1) out.push(doneRow(x, w, on, now))
      else out.push(...ticketCard(s, x, w, on, now))
    })
    const below = tickets.length - from - room
    if (from > 0) out.unshift(render([[` ▴ ${t('tickets.board.above', { n: from })}`, fg(P.sub)]], w, LANE))
    if (below > 0) out.push(render([[` ▾ ${t('tickets.board.more', { n: below })}`, fg(P.sub)]], w, LANE))
  }
  while (out.length < h) out.push(blank(w))
  return out.slice(0, h)
}

function lane(s: TicketsState, i: number, shown: { n: number; w: number; first: number }, cols: number, h: number, now: number): string[] {
  const b = s.board
  if (!b) return []
  const on = s.lane === i
  const all = laneTickets(b, i)
  const name = t(`tickets.lanes.${LANES[i]}`)
  const out = [render([[on ? '▌' : ' ', fg(ACCENT)], [name, BOLD + fg(on ? ACCENT : P.sub)], [`  ${all.length}`, fg(P.overlay1)]], cols, LANE)]
  const idx = Array.from({ length: shown.n }, (_, k) => shown.first + k)
  const gap = ' '.repeat(GAP)
  const join = (parts: string[]) => `${LANE} ${parts.join(`${LANE}${gap}`)}${blank(cols - 1 - shown.n * shown.w - (shown.n - 1) * GAP)}`
  out.push(join(idx.map(k => laneHeader({ glyph: '', color: PHASE_COLOR[b.columns[k].phase], name: b.columns[k].name }, columnTickets(b, i, k).length, shown.w))))
  const body = h - 2
  if (!all.length) {
    const msg = render([[` ${t(`tickets.empty.${LANES[i]}`)}`, ITALIC + fg(P.overlay1)]], cols, LANE)
    out.push(msg, ...Array.from({ length: Math.max(0, body - 1) }, () => blank(cols)))
    return out.slice(0, h)
  }
  const colLines = idx.map(k => column(s, i, k, shown.w, body, now))
  for (let r = 0; r < body; r++) out.push(join(colLines.map(c => c[r])))
  return out
}

function hintsFor(s: TicketsState): Hint[] {
  const H = (k: string) => t(`tickets.keys.${k}`)
  if (s.screen === 'setup') {
    const ready = !missing(s.setup).length && s.setup.check.state === 'ok'
    return [['e', H('env')], ['s', H('settings')], ...(missing({ ...s.setup, board: 'x' }).length ? [] : ([['b', H('board')]] as Hint[])), ['R', H('check')], ...(ready ? ([['↵', H('openBoard')]] as Hint[]) : []), ['esc', H('close')]]
  }
  if (s.screen === 'picker') return [['↑↓', H('pickBoard')], ['↵', s.picker && s.picker.query.trim() !== s.picker.searched ? H('search') : H('choose')], ['esc', H('cancel')]]
  return [['←→', H('column')], ['↑↓', H('card')], ['tab', H('lane')], ['o', H('open')], ['a', H('agent')], ['r', H('reviewer')], ['t', H('tester')], ['↵', H('go')], ['R', H('refresh')], ['b', H('board')], ['s', H('settings')]]
}

const ROLE_HINT: Record<Role, string> = { work: 'worker', review: 'reviewer', test: 'tester' }

// The question a start asks, and the keys that answer it.
function asking(s: TicketsState, c: Confirm): { ask: string; keys: Hint[] } {
  const K = (k: string) => t(`tickets.keys.${k}`)
  if (c.step === 'role') {
    // A role that has a live agent goes to it rather than starting another.
    const keys = ROLES.map((r): Hint => [ROLE_KEYS[r], agentOf(s, c.key, r) ? `${K(ROLE_HINT[r])} ↗` : K(ROLE_HINT[r])])
    return { ask: t('tickets.confirm.role', { key: c.key }), keys: [...keys, ['esc', K('cancel')]] }
  }
  const p = s.prefs.roles[c.role]
  const words = { key: c.key, role: t(`tickets.roles.${c.role}`), folder: s.prefs.folder, model: p.model, effort: p.effort }
  if (c.step === 'mode') return { ask: t('tickets.confirm.mode', words), keys: [['f', K('fix')], ['o', K('feedback')], ['esc', K('cancel')]] }
  return { ask: t('tickets.confirm.start', words), keys: [['y', K('start')], ['n', K('cancel')]] }
}

function footer(s: TicketsState, cols: number): string {
  if (s.confirm) {
    const { ask, keys } = asking(s, s.confirm)
    // Only the worker writes to the tracker, so only it needs the MCP to.
    const writes = s.confirm.step === 'start' && s.confirm.role === Role.Work
    const warn = writes && s.setup.mcp === false ? `  ${t('tickets.confirm.noMcp')}` : ''
    return split(
      [
        [` ${ask}`, BOLD + fg(P.text)],
        [warn, fg(P.yellow)],
      ],
      [...hintSpans(keys), [' ', '']],
      cols,
      bg(P.surface0),
    )
  }
  const note: Span[] = s.note ? [[` ${s.note.text}`, fg(TONE[s.note.tone] ?? P.text)]] : []
  return split(note, [...hintSpans(hintsFor(s), { noBreak: true }), [' ', '']], cols, BASE)
}

function statusText(s: TicketsState, now: number): Span[] {
  const f = s.fetch
  if (f.state === 'loading') return [[t('tickets.status.refreshing'), fg(P.blue)]]
  if (f.state === 'failed') return [[s.fetchedAt ? t('tickets.status.lastGood', { ago: ago(s.fetchedAt, now) }) : t('tickets.status.notLoaded'), fg(f.why === 'auth' ? P.red : P.yellow)]]
  return s.fetchedAt ? [[t('tickets.status.updated', { ago: ago(s.fetchedAt, now) }), fg(P.overlay1)]] : []
}

function banner(s: TicketsState): Span[] | null {
  const f = s.fetch
  if (f.state !== 'failed') return null
  const words: Record<string, string> = {
    auth: t('tickets.banner.auth', { status: f.err ?? '' }),
    limited: t('tickets.banner.limited', { secs: f.retryAfter ?? 30 }),
    missing: t('tickets.banner.missing', { what: f.err ?? '' }),
    failed: t('tickets.banner.failed', { err: f.err ?? '' }),
  }
  const bad = f.why === 'auth'
  return [[bad ? ' ✗ ' : ' ! ', BOLD + fg(bad ? P.red : P.yellow)], [words[f.why ?? 'failed'], fg(bad ? P.red : P.yellow)], [bad ? `  ${t('tickets.banner.authHint')}` : `  ${t('tickets.banner.retryHint')}`, fg(P.sub)]]
}

function boardBody(s: TicketsState, cols: number, rows: number, now: number): { lines: string[]; firstCol: number } {
  const b = s.board
  const lines: string[] = []
  if (!b) {
    lines.push(blank(cols))
    const msg = s.fetch.state === 'failed' ? t('tickets.board.notLoaded') : t('tickets.board.loading')
    while (lines.length < Math.floor(rows / 2)) lines.push(blank(cols))
    lines.push(centred([[msg, fg(P.sub)]], cols))
    const ban = banner(s)
    if (ban) lines.push(centred(ban, cols))
    return { lines, firstCol: 0 }
  }
  const shown = columnsShown(b.columns.length, cols, s.col, s.firstCol)
  const hiddenRight = b.columns.length - shown.first - shown.n
  lines.push(
    split(
      [[shown.first ? ` ‹ ${t('tickets.board.hidden', { n: shown.first })}` : '', BOLD + fg(ACCENT)]],
      [...statusText(s, now), [hiddenRight > 0 ? `  ${t('tickets.board.hidden', { n: hiddenRight })} ›` : '', BOLD + fg(ACCENT)], [' ', '']],
      cols,
      LANE,
    ),
  )
  const ban = banner(s)
  if (ban) lines.push(render(ban, cols, bg(P.base)))
  if (!b.sprint) {
    const left = rows - lines.length
    const words: Line[] = [
      [[t('tickets.noSprint.title', { board: b.name }), BOLD + fg(P.text)]],
      [[b.next ? t('tickets.noSprint.next', { name: b.next.name, date: (b.next.starts ?? '').slice(0, 10) }) : t('tickets.noSprint.none'), fg(P.sub)]],
      [[t('tickets.noSprint.after'), fg(P.sub)]],
    ]
    const top = Math.max(0, Math.floor((left - words.length) / 2))
    for (let i = 0; i < top; i++) lines.push(blank(cols))
    for (const w of words) lines.push(centred(w, cols))
    while (lines.length < rows) lines.push(blank(cols))
    return { lines, firstCol: shown.first }
  }
  const avail = rows - lines.length
  const top = Math.floor(avail / 2)
  lines.push(...lane(s, 0, shown, cols, top, now), ...lane(s, 1, shown, cols, avail - top, now))
  return { lines, firstCol: shown.first }
}

const mark = (ok: boolean | null, warn = false): Span => (ok ? [' ✓ ', BOLD + fg(P.green)] : warn ? [' ! ', BOLD + fg(P.yellow)] : [' ✗ ', BOLD + fg(P.red)])

// The fixed lines setup asks you to put in .env: never the file's own values.
const ENV_TEMPLATE = [
  '# in .env (install copied it from .env.example):',
  'JIRA_SITE=https://<site>.atlassian.net',
  'JIRA_EMAIL=you@company.com',
  'JIRA_API_TOKEN=          # a scoped, read-only token with:',
  '#   read:jira-work  read:jira-user  read:project:jira',
  '#   read:board-scope:jira-software  read:board-scope.admin:jira-software',
  '#   read:sprint:jira-software  read:issue-details:jira  read:jql:jira',
  'JIRA_TOKEN_KIND=scoped   # scoped | classic',
]

function setupBody(s: TicketsState, cols: number, envPath: string): string[] {
  const u = s.setup
  const gone = missing(u)
  const lines: string[] = [blank(cols, BASE)]
  const row = (m: Span, label: string, value: string, tone = P.sub) => render([m, [label.padEnd(18), fg(P.text)], [value, fg(tone)]], cols, BASE)
  lines.push(render([[gone.length ? ` ${t('tickets.setup.needs')}` : ` ${t('tickets.setup.ready')}`, BOLD + fg(ACCENT)]], cols, BASE))
  lines.push(render([[` ${t('tickets.setup.intro', { path: envPath })}`, fg(P.sub)]], cols, BASE), blank(cols, BASE))
  for (const k of JIRA_KEYS.filter(k => k !== 'JIRA_TOKEN_KIND')) lines.push(row(mark(u.env[k]), k, u.env[k] ? t('tickets.setup.set') : t('tickets.setup.notSet')))
  lines.push(row(mark(!!u.board), t('tickets.setup.board'), u.board ? t('tickets.setup.boardId', { id: u.board }) : t('tickets.setup.boardNone')))
  lines.push(row(mark(u.mcp, u.mcp !== true), t('tickets.setup.mcp'), u.mcp === null ? t('tickets.setup.mcpChecking') : u.mcp ? t('tickets.setup.mcpOk') : t('tickets.setup.mcpMissing')))
  const c = u.check
  if (!gone.length) {
    const value =
      c.state === 'running'
        ? t('tickets.setup.checking')
        : c.state === 'ok'
          ? t('tickets.setup.checked', { name: c.name ?? '' })
          : c.state === 'failed'
            ? t(c.why === 'auth' ? 'tickets.setup.checkAuth' : 'tickets.setup.checkFailed', { err: c.err ?? '' })
            : t('tickets.setup.checkIdle')
    lines.push(row(c.state === 'ok' ? mark(true) : c.state === 'failed' ? mark(false) : [' … ', fg(P.sub)], t('tickets.setup.check'), value, c.state === 'ok' ? P.green : c.state === 'failed' ? P.red : P.sub))
  }
  // The template and scopes, when a .env value is missing or Jira refused it.
  if (gone.some(k => k.startsWith('JIRA_')) || c.why === 'auth') {
    lines.push(blank(cols, BASE))
    for (const l of ENV_TEMPLATE) lines.push(render([['   '], [l, fg(l.startsWith('#') ? P.overlay1 : P.text)]], cols, BASE))
  }
  return lines
}

function pickerBody(s: TicketsState, cols: number): string[] {
  const p = s.picker
  if (!p) return []
  const lines: string[] = [blank(cols, BASE)]
  lines.push(render([[` ${t('tickets.picker.heading')}`, BOLD + fg(ACCENT)]], cols, BASE))
  const label = ` ${t('tickets.picker.name')} `
  lines.push(render([[label, fg(P.sub)], ...field({ text: p.query, w: Math.max(10, cols - width(label) - 2) })], cols, BASE), blank(cols, BASE))
  if (p.state === 'loading') lines.push(render([[`   ${t('tickets.picker.searching', { query: p.searched })}`, fg(P.blue)]], cols, BASE))
  else if (p.state === 'failed') lines.push(render([[`   ${t(p.why === 'auth' ? 'tickets.picker.auth' : 'tickets.picker.failed', { err: p.err ?? '' })}`, fg(P.red)]], cols, BASE))
  else if (!p.boards.length) lines.push(render([[`   ${t('tickets.picker.none', { query: p.searched })}`, ITALIC + fg(P.overlay1)]], cols, BASE))
  else
    p.boards.forEach((x, i) => {
      const on = i === p.sel
      lines.push(
        render(
          [
            [on ? ' ▸ ' : '   ', fg(ACCENT)],
            [x.name.padEnd(32), (on ? BOLD : '') + fg(on ? ACCENT : P.text)],
            [t('tickets.picker.row', { project: x.project || '—', id: x.id }), fg(P.sub)],
          ],
          cols,
          on ? bg(P.surface0) : BASE,
        ),
      )
    })
  lines.push(blank(cols, BASE), render([[` ${t('tickets.picker.after')}`, fg(P.overlay1)]], cols, BASE))
  return lines
}

export function title(s: TicketsState): HeaderTitle {
  const b = s.board
  if (s.screen === 'picker') return [t('tickets.title'), t('tickets.picker.title')]
  if (s.screen === 'setup' || !b) return [t('tickets.title'), s.screen === 'setup' ? t('tickets.setup.title') : '']
  const team = s.setup.team || b.name
  const sprint = b.sprint ? [b.sprint.name, b.sprint.ends ? t('tickets.ends', { date: shortDate(b.sprint.ends) }) : ''] : [t('tickets.noSprint.short')]
  const others = b.others.length ? t('tickets.alsoActive', { names: b.others.join(', ') }) : ''
  return [t('tickets.title'), team, ...sprint, others]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const shortDate = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : iso
}

export function frame(s: TicketsState, size: Size, now: number, envPath = '.env'): Frame {
  const { cols, rows } = size
  if (cols < MIN_SIZE.cols - 2 || rows < MIN_SIZE.rows - 2) {
    const lines = Array.from({ length: rows }, () => blank(cols, BASE))
    const mid = Math.max(0, Math.floor(rows / 2) - 1)
    lines[mid] = centred([[t('tickets.tooSmall.title'), BOLD + fg(ACCENT)]], cols, BASE)
    if (mid + 1 < rows) lines[mid + 1] = centred([[t('tickets.tooSmall.need', { cols: MIN_SIZE.cols, rows: MIN_SIZE.rows, now: `${cols + 2} × ${rows + 2}` }), fg(P.sub)]], cols, BASE)
    return { lines, title: t('tickets.title'), firstCol: s.firstCol }
  }
  const bodyRows = rows - 1
  let body: string[]
  let firstCol = s.firstCol
  if (s.screen === 'setup') body = setupBody(s, cols, envPath)
  else if (s.screen === 'picker') body = pickerBody(s, cols)
  else {
    const r = boardBody(s, cols, bodyRows, now)
    body = r.lines
    firstCol = r.firstCol
  }
  const fill = s.screen === 'board' ? LANE : BASE
  while (body.length < bodyRows) body.push(blank(cols, fill))
  return { lines: [...body.slice(0, bodyRows), footer(s, cols)], title: title(s), firstCol }
}
