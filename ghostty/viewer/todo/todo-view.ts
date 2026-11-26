#!/usr/bin/env node
// The viewer pane's Todo mode.
//   todo-view.ts [dir]
// DV_TABS names the window's tab session as `socket:session`
// (bin/ghostty-claude-start); without it, dir is the folder.
// TD_POPUP=1 runs it in Alt+T's overlay (bin/ghostty-todo-panel) instead: no
// modes, and going to a tab closes it.
//
// This file wires the keys and the terminal; state.ts holds the state,
// draw.ts draws it and effects.ts does what touches the world.

import { mkdirSync, } from 'node:fs'
import { basename, dirname } from 'node:path'

import { imageFiles } from '../../core/images.ts'
import { logger } from '../../core/log.ts'
import { t } from '../../core/text.ts'
import { load as loadSettings } from '../../settings/settings.ts'
import type { Hint } from '../../tui/chrome.ts'
import type { Mouse } from '../../tui/input.ts'
import { openOverlay } from '../../tui/overlay.ts'
import { P } from '../../tui/palette.ts'
import { leave, needTerminal, out, startPane } from '../../tui/screen.ts'
import { logCrashes } from '../logging.ts'
import { SPIN_MS, TITLE, bodyHeight, frame, listTop, paint, sayMs } from './draw.ts'
import { todoEffects, world } from './effects.ts'
import { config, confirmPrompt, createState, cursorItem, moveCursor as move, pinEdit, selectable } from './state.ts'
import { type Item, STORE, filingState, knownRepos, moveOldStoreOnce } from './todo.ts'
import * as ui from './todo-ui.ts'
import { type EditPrompt, type HandoffPrompt, KEYS, type KeyAction, type Prompt } from './todo-ui.ts'
import { onTabChanged, watchName } from '../tab.ts'
import { CTRL_C, CTRL_V } from '../../tui/input.ts'

const log = logger('todo')
logCrashes(log)

const REFRESH_MS = 2000
// Drag reports and bracketed paste, so a newline in a paste can't submit a
// prompt halfway through it.
const SCREEN = { drag: true, paste: true }

const s = createState(config())
const { popup: POPUP, pane: PANE, modes: MODES } = s.config

const ov = POPUP
  ? openOverlay({
      name: 'todo',
      key: 'keys.todo',
      screen: SCREEN,
      box: () => {
        const values = loadSettings()
        return { w: `${values['layout.todoWidth']}%`, h: `${values['layout.todoHeight']}%` }
      },
    })
  : null

const size = () => ov?.size() ?? { cols: process.stdout.columns, rows: process.stdout.rows }

function draw(): void {
  ui.pruneMarks(s.marked, s.items)
  if (!pinEdit(s)) {
    s.said = { text: t('todo.say.gone'), color: P.peach, until: Date.now() + sayMs() }
    setTimeout(draw, sayMs() + 50)
  }
  const { cols, rows } = size()
  const f = frame(s, cols, rows)
  if (f.cursorId) s.cursorId = f.cursorId
  s.drawn = f.body
  s.scroll = f.scroll
  if (ov) ov.paint(f.lines, TITLE)
  else out(paint(f.lines))
}

function say(text: string, color: string = P.sub): void {
  const ms = sayMs()
  s.said = { text, color, until: Date.now() + ms }
  draw()
  setTimeout(draw, ms + 50)
}

function confirm(text: string, yes: () => void, key: string, answers: Hint[]): void {
  s.prompt = confirmPrompt(text, yes, key, answers)
  draw()
}

function quit(code = 0): never {
  leave(SCREEN)
  process.exit(code)
}

// The exit code once q, Esc, Tab or the effects have asked to quit while
// work was in flight; null until then. The view then quits once it has
// settled, and takes no keys but another quit.
let leaving: number | null = null

// Quits once a hand-off, a reopened tab or an add by hand under way has
// finished, so every agent asked for starts and gets recorded.
function quitWhenDone(code = 0): void {
  if (!fx.busy()) quit(code)
  if (leaving !== null) return
  leaving = code
  if (s.handingOff.size) say(t('todo.handOff.starting', { n: s.handingOff.size }), P.peach)
  void fx.settled().then(() => quit(code))
}

// While it waits to quit, a second q, Esc, Tab or Ctrl+C quits at once: a
// claude --bg that never returns mustn't keep the view open.
function onLeavingKey(code: number, key: string | undefined): void {
  const action = key === undefined ? undefined : KEYS[key]
  if (action === 'quit' || action === 'close' || action === 'next-mode') quit(code)
}

const fx = todoEffects(s, { ...world(), say, draw, confirm, quit: quitWhenDone })

function moveCursor(by: number): void {
  if (move(s, by)) draw()
}

// The item under the cursor, unless Claude is still filing it: until then
// it has nothing to mark done, edit or recategorize.
function realItem(): Item | undefined {
  const item = cursorItem(s)
  if (!item?.filing) return item
  say(ui.filingHint(item))
}

const withReal = (act: (item: Item) => void) => (): void => {
  const item = realItem()
  if (item) act(item)
}

function openPrompt(prompt: Prompt): void {
  s.prompt = prompt
  draw()
}

const startManual = (): void => openPrompt(ui.manualPrompt(cursorItem(s)))

function startEdit(): void {
  const item = realItem()
  if (item) openPrompt(ui.editPrompt(item, knownRepos(s.items)))
}

function onEditKey(prompt: EditPrompt, key: string) {
  if (key !== '\r') {
    ui.editKey(prompt, key)
    return draw()
  }
  const save = ui.editChanges(prompt)
  if (!save) {
    prompt.field = 'title'
    delete prompt.at
    return say(t('todo.say.needsTitle'), P.peach)
  }
  s.prompt = null
  const { value, error } = fx.save(save)
  const note = ui.savedNote(value, error)
  if (note) say(note.text, note.ok ? P.green : P.peach)
}

function toggleMark() {
  const item = realItem()
  if (!item) return
  if (item.done) return say(t('todo.say.isDone'))
  if (!s.marked.delete(item.id)) s.marked.add(item.id)
  moveCursor(1)
}

// Counts w's presses, so only the latest one opens its row.
let handoffAsks = 0

async function startHandoff(): Promise<void> {
  const marked = ui.markedIds(selectable(s), s.marked)
  let ids = marked
  if (!marked.length) {
    const item = realItem()
    if (!item) return
    if (item.done) return say(t('todo.say.isDone'))
    ids = [item.id]
  }
  ids = ids.filter(id => !s.handingOff.has(id))
  if (!ids.length) return say(t('todo.handOff.starting', { n: s.handingOff.size }), P.peach)
  const ask = ++handoffAsks
  const at = await fx.handoffAt()
  // Looking up the Default repo runs git; a prompt opened meanwhile has the
  // keys, and a later w opens its own row.
  if (ask !== handoffAsks || s.prompt) return
  openPrompt(ui.handoffPrompt(ids, s.items, at))
}

function onHandoffKey(prompt: HandoffPrompt, key: string) {
  const result = ui.handoffKey(prompt, key)
  if (result === 'no-git') {
    // The row covers the status line, so the note itself lights up.
    prompt.flash = Date.now()
    setTimeout(draw, sayMs() + 50)
    return draw()
  }
  if (result === 'start') {
    const { ids, here: at, worktree, model } = prompt
    s.prompt = null
    return void fx.handOff(ids, at, { worktree, model })
  }
  draw()
}

function startDelete() {
  const item = cursorItem(s)
  if (!item) return
  const answers = (what: string): Hint[] => [
    ['x', what],
    [t('todo.confirm.otherKeys'), t('todo.confirm.keep')],
  ]
  // A failed write leaves the store's error showing.
  if (item.filing) {
    const drop = (): void => {
      const { value, error } = fx.erase(item)
      if (error) return
      if (value) {
        say(t('todo.say.dropped'))
        return
      }
      // Claude filed it while the question was up; the todo it made stays.
      const filed = s.items.find(i => i.id === item.id && !i.filing)
      if (!filed) {
        say(t('todo.say.gone'), P.peach)
        return
      }
      say(t('todo.say.added', { repo: filed.repo, title: filed.title }), P.green)
    }
    return confirm(t('todo.confirm.drop', { title: item.title }), drop, 'x', answers(t('hints.drop')))
  }
  const del = (): void => {
    const { value, error } = fx.erase(item)
    if (error) return
    say(value ? t('todo.say.deleted', { title: item.title }) : t('todo.say.gone'), value ? P.sub : P.peach)
  }
  confirm(t('todo.confirm.delete', { title: item.title }), del, 'x', answers(t('hints.delete')))
}

function onPromptKey(prompt: Prompt, key: string) {
  const step = ui.promptKey(prompt, key, cursorItem(s))
  if (step.run === 'ignore') return
  s.prompt = step.prompt
  if (step.run === 'yes' && prompt.kind === 'confirm') return prompt.yes()
  if (step.run === 'edit') return onEditKey(step.prompt, key)
  if (step.run === 'handoff') return onHandoffKey(step.prompt, key)
  if (step.run === 'manual') return startManual()
  if (step.run === 'add') return void fx.finishAdd(step.add)
  if (step.run === 'file') return fx.file(step.text, step.images)
  draw()
}

function onMouse(raw: Mouse) {
  const report = ov ? ov.mouse(raw) : raw
  if (report === 'close') return quit()
  if (!report) return
  const action = ui.mouseAction(report, { prompt: s.prompt, top: listTop(POPUP), height: bodyHeight(size().rows, POPUP) })
  if (!action) return
  if ('move' in action) return moveCursor(action.move)
  if ('header' in action) {
    const mode = POPUP ? undefined : ui.modeAt(action.header, MODES)
    if (mode?.exit) quitWhenDone(mode.exit)
    return
  }
  const row = s.drawn[s.scroll + action.row]
  if (row?.done) {
    s.showDone = !s.showDone
    return draw()
  }
  if (row?.item) {
    s.cursorId = row.item.id
    draw()
  }
}

const halfPage = (): number => Math.max(1, Math.floor(bodyHeight(size().rows, POPUP) / 2))

function toggle(key: 'only' | 'showDone'): void {
  s[key] = !s[key]
  draw()
}

const ACTIONS: Record<KeyAction, () => void> = {
  quit: () => quitWhenDone(PANE.quit),
  close: () => POPUP && quitWhenDone(),
  'next-mode': () => PANE.next && quitWhenDone(PANE.next),
  down: () => moveCursor(1),
  up: () => moveCursor(-1),
  'page-down': () => moveCursor(halfPage()),
  'page-up': () => moveCursor(-halfPage()),
  first: () => moveCursor(-Infinity),
  last: () => moveCursor(Infinity),
  go: withReal(item => void fx.goTo(item)),
  done: withReal(fx.setDone),
  claude: () => openPrompt({ kind: 'claude', text: '' }),
  manual: startManual,
  retry: () => fx.retryFiling(cursorItem(s)),
  edit: startEdit,
  category: withReal(fx.setCategory),
  type: withReal(fx.setType),
  delete: startDelete,
  mark: toggleMark,
  'clear-marks': () => {
    s.marked.clear()
    draw()
  },
  handoff: () => void startHandoff(),
  only: () => toggle('only'),
  'show-done': () => toggle('showDone'),
}

function onKey(key: string) {
  // The overlay's own key closes it even with a prompt open; Ctrl+C there
  // cancels the prompt first.
  if (ov?.closes(key) && (key !== CTRL_C || !s.prompt)) return quit()
  // As in Claude Code: the clipboard's image, which a terminal's paste can't
  // carry.
  if (s.prompt && key === CTRL_V) return fx.pasteImage()
  if (s.prompt) return onPromptKey(s.prompt, key)
  const action = KEYS[key]
  if (action) ACTIONS[action]()
}

function onInput(data: Buffer): void {
  for (const event of ui.parseInput(data)) {
    if (leaving !== null) onLeavingKey(leaving, event.key)
    else if (event.mouse) onMouse(event.mouse)
    else if (event.paste !== undefined) {
      if (ui.takesImages(s.prompt) && fx.pasteFiles(imageFiles(event.paste))) continue
      if (ui.pasteInto(s.prompt, event.paste)) draw()
    } else onKey(event.key ?? '')
  }
}

function startScreen(): void {
  if (ov) {
    ov.start(onInput, draw)
    return
  }
  startPane({ onData: onInput, onResize: draw, quit: () => quit(), screen: SCREEN })
  draw()
}

needTerminal('todo-view')
moveOldStoreOnce()
mkdirSync(dirname(STORE), { recursive: true })
fx.readStore(true)
fx.sweepImages()
startScreen()
void fx.refresh()
setInterval(() => void fx.refresh(), REFRESH_MS)
// Turns the spinner of anything Claude is filing.
setInterval(() => {
  if (s.items.some(i => filingState(i) === 'filing')) draw()
}, SPIN_MS)
watchName(dirname(STORE), basename(STORE), () => void fx.refresh(), log)
onTabChanged(() => void fx.refresh(), log)
