#!/usr/bin/env node
// gv: the viewer pane's Diff mode. Shows the uncommitted changes (staged,
// unstaged and untracked) of the git repository around the active tmux tab's
// folder, checking git every second.
//   diff-view.ts [dir]
// DV_TABS names the window's tab session as `socket:session`
// (bin/ghostty-claude-start); without it, dir is the folder.
// effects.ts reads git and the tab; this file draws and takes the keys.

import { watch } from 'node:fs'
import { dirname } from 'node:path'

import { errorMessage, logger } from '../../core/log.ts'
import { TAB_CHANGED, tilde } from '../../core/paths.ts'
import { t } from '../../core/text.ts'
import { keyHints as hint, modeHeader, switchCol } from '../../tui/chrome.ts'
import { frameBottom, frameRow, frameTop, spanWidth } from '../../tui/controls.ts'
import { type Mouse, leftPress } from '../../tui/input.ts'
import { enter, leave, paint } from '../../tui/screen.ts'
import { BOLD, P, type Span, width as cells, fg } from '../../tui/term.ts'
import { fit } from '../../tui/text.ts'
import { logCrashes } from '../logging.ts'
import { type BodyRow, type DiffFile, type DiffRow, addShare, bodyRows as listRows, cardSize, changeWords, clampScroll, followCursor, keyAction, modeAt as modeIn, parseInput, scrollLines } from './diff.ts'
import { C, diffRow as drawDiff, fileRow as drawFile, scaleOf } from './diff-rows.ts'
import { createState, diffEffects, world } from './effects.ts'
import { paneModes, tabs as modeTabs } from '../modes.ts'

const log = logger('diff')
logCrashes(log)

const DIR = process.argv[2] || process.cwd()
const [TABS_SOCKET = '', TABS_SESSION = ''] = (process.env.DV_TABS ?? '').split(':')
const PANE = paneModes(t('settings.modes.diff.name'))
const MODES = modeTabs(PANE).map(t => t.label)
const REFRESH_MS = 1000
// Rows besides the file list: the mode header, the path row and the summary
// card above, the status row below.
const TOP = 7
const CHROME_ROWS = 7
// No bracketed paste: a paste comes in as keys.
const SCREEN = { drag: true, paste: false }

const s = createState()
const fx = diffEffects(s, { dir: DIR, tabsSocket: TABS_SOCKET, tabsSession: TABS_SESSION }, { ...world(), draw })
// What the last frame showed. A click goes to the file it landed on: a
// refresh replaces s.files and only draws once git has read the open diff,
// so in between the live rows aren't the ones on screen.
let shown: { rows: BodyRow[]; files: DiffFile[]; scroll: number } = { rows: [], files: [], scroll: 0 }

function moveCursor(i: number): void {
  if (s.files.length === 0) return
  s.cursor = Math.max(0, Math.min(i, s.files.length - 1))
  s.follow = true
  draw()
}

function toggleOpen(i = s.cursor): void {
  const file = s.files[i]
  if (!file) return
  s.cursor = i
  s.openPath = s.openPath === file.path ? '' : file.path
  s.openRows = []
  s.lastDiff = ''
  s.follow = true
  draw()
  void fx.refresh()
}

function scrollBy(by: number): void {
  // No list under a message to scroll.
  if (s.message) return
  s.scroll = clampScroll(s.scroll + by, bodyRows().length, bodyHeight())
  s.follow = false
  draw()
}

const bodyHeight = (): number => Math.max(1, process.stdout.rows - CHROME_ROWS)
const width = (): number => process.stdout.columns

const bodyRows = (): BodyRow[] => listRows(s.files, s.openPath, s.openRows)

const header = (): string => modeHeader(MODES, PANE.at, PANE.next, Math.max(1, switchCol(width())))

function card(): string[] {
  const { w, inner } = cardSize(width())
  const add = s.files.reduce((n, f) => n + f.add, 0)
  const del = s.files.reduce((n, f) => n + f.del, 0)
  const left: Span[] = [
    [t('diff.files', { n: s.files.length }), BOLD + fg(P.text)],
    [` ${t('diff.changed')}  ·  ${changeWords(s.files)}`, fg(P.sub)],
  ]
  const right: Span[] = [[`+${add}`, BOLD + fg(P.green)], ['  ', ''], [`−${del}`, BOLD + fg(P.red)]]
  const gap = ' '.repeat(Math.max(1, inner - spanWidth(left) - spanWidth(right)))
  const green = addShare(add, del, inner)
  const bar: Span[] = [['━'.repeat(green), fg(P.green)], ['━'.repeat(inner - green), fg(P.red)]]
  const edge = { color: P.surface1 }
  return [` ${frameTop(w, edge)}`, ` ${frameRow([...left, [gap, ''], ...right], w, edge)}`, ` ${frameRow(bar, w, edge)}`, ` ${frameBottom(w, edge)}`]
}

function fileRow(file: DiffFile, i: number, most: number): string {
  return drawFile(file, { open: file.path === s.openPath, selected: i === s.cursor, width: width(), most })
}

const diffRow = (row: DiffRow): string => drawDiff(row, width())

function statusRow(): string {
  const left = `${C.pillBg}${C.crust}${C.bold} ${t('diff.pill')} ${C.reset}  ${hint([['enter', t('hints.open')], ['j k', t('hints.move')]])}`
  if (!s.files.length) return left
  const position = `${s.cursor + 1}/${s.files.length} `
  return `${left}\x1b[${Math.max(1, width() - position.length + 1)}G${C.text}${position}${C.reset}`
}

function draw(): void {
  const height = bodyHeight()
  const rows = bodyRows()
  const path = s.root ? `${C.blue}${C.bold}${tilde(s.root)}${C.reset}${s.branch ? `${C.sub}  ${s.branch}${C.reset}` : ''}` : ''
  const lines = [header(), path]
  if (s.message) {
    const total = height + 4
    // git's own error can be wider than the pane.
    const message = fit(s.message, Math.max(1, width() - 2)).trimEnd()
    for (let row = 0; row < total; row++) {
      const middle = row === Math.floor(total / 2) - 1
      const pad = Math.max(0, Math.floor((width() - cells(message)) / 2))
      lines.push(middle ? `${' '.repeat(pad)}${C.sub}${message}${C.reset}` : '')
    }
    shown = { rows: [], files: [], scroll: 0 }
  } else {
    // Only with the list on screen: a message has no rows, and clamping to
    // none would lose the scroll a passing git failure interrupted.
    if (s.follow) s.scroll = followCursor(rows, s.cursor, s.scroll, height)
    s.scroll = clampScroll(s.scroll, rows.length, height)
    shown = { rows, files: s.files, scroll: s.scroll }
    lines.push(...card())
    const most = scaleOf(s.files)
    for (let row = 0; row < height; row++) {
      const r = rows[s.scroll + row]
      if (!r || r.kind === 'gap') lines.push('')
      else if (r.kind === 'file') lines.push(fileRow(s.files[r.i], r.i, most))
      else lines.push(diffRow(r.row))
    }
  }
  lines.push(statusRow())
  paint(lines, { clear: true })
}

// The terminal goes back in the 'exit' handler set beside enter().
function quit(code = 0): never {
  process.exit(code)
}

const modeAt = (col: number): number => modeIn(MODES, col)

function onMouse(mouse: Mouse): void {
  const { button, x, y } = mouse
  if (button & 64) {
    scrollBy((button & 1) === 0 ? -scrollLines() : scrollLines())
    return
  }
  if (!leftPress(mouse)) return
  if (y === 1) {
    const code = PANE.exitOf(modeAt(x))
    if (code) quit(code)
    return
  }
  if (y < TOP || y >= TOP + bodyHeight()) return
  const r = shown.rows[shown.scroll + y - TOP]
  if (r?.kind !== 'file') return
  const path = shown.files[r.i]?.path
  const i = s.files.findIndex(f => f.path === path)
  if (i >= 0) toggleOpen(i)
}

function onKey(key: string): void {
  const act = keyAction(key, Math.max(1, Math.floor(bodyHeight() / 2)))
  if (!act) return
  if (act[0] === 'quit') quit(PANE.quit)
  else if (act[0] === 'next') PANE.next && quit(PANE.next)
  else if (act[0] === 'toggle') toggleOpen()
  else if (act[0] === 'move') moveCursor(s.cursor + act[1])
  else scrollBy(act[1])
}

function onInput(data: Buffer): void {
  for (const tok of parseInput(data)) {
    if (tok.mouse) onMouse(tok.mouse)
    else onKey(tok.key ?? '')
  }
}

if (!process.stdin.isTTY) {
  console.error('diff-view needs a terminal.')
  process.exit(1)
}

process.stdin.setRawMode(true)
process.stdin.on('data', onInput)
process.on('SIGWINCH', draw)
process.on('SIGTERM', () => quit())
// On every exit, a crash too: otherwise the alt screen and mouse reporting
// stay on, and a click answers bin/ghostty-viewer's "press any key".
process.on('exit', () => leave(SCREEN))
enter(SCREEN)
draw()
void fx.refresh()
setInterval(() => void fx.refresh(), REFRESH_MS)
try {
  watch(dirname(TAB_CHANGED), (_, name) => {
    if (name === 'tab-changed') void fx.refresh()
  })
} catch (err) {
  // No layout state folder: outside the layout, the tab never changes.
  log.warn('not watching a folder', { path: dirname(TAB_CHANGED), err: errorMessage(err) })
}
