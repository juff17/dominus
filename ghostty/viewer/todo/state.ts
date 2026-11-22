// The Todo mode's state: todo-view.ts creates it, draw.ts draws it, effects.ts
// fills it from the world, and todo-ui.ts holds what each key does to it.

import { t } from '../../core/text.ts'
import type { Agent } from '../../agents/model.ts'
import { type PaneModes, paneModes, tabs as modeTabs } from '../modes.ts'
import type { BodyRow } from './draw.ts'
import { type Arranged, type Here, type Item, arrange } from './todo.ts'
import * as ui from './todo-ui.ts'
import type { ConfirmPrompt, Prompt } from './todo-ui.ts'

// exit is 0 for this mode's own tab.
export type ModeTabExit = { label: string; exit: number }

export type Config = {
  dir: string
  tabsSocket: string
  tabsSession: string
  win: number
  popup: boolean
  pane: PaneModes
  modes: ModeTabExit[]
}

// window is tmux's window id (@N), win the Ghostty window's number. server is
// the tab server's start time, which tells its pane ids from an earlier
// server's (Item's paneServer); unset when tmux didn't say.
export type TabPane = { session: string; window: string; index: string; win: number; hub: boolean; server?: string }
// Every tab-session pane by its id (%N), or null while tmux can't say.
export type Panes = Map<string, TabPane> | null

export type Said = { text: string; color: string; until: number }

export type State = {
  config: Config
  items: Item[]
  lastStamp: string | null
  loadError: string
  here: Here
  panes: Panes
  agents: Agent[]
  only: boolean
  showDone: boolean
  cursorId: string
  marked: Set<string>
  handingOff: Set<string>
  scroll: number
  prompt: Prompt | null
  said: Said | null
  drawn: BodyRow[]
}

// DV_TABS names the window's tab session as `socket:session`; its window
// number is the layout window's, 0 outside one. TD_POPUP=1 is Alt+T's popup,
// which has no mode tabs.
export function config(env: NodeJS.ProcessEnv = process.env, argv = process.argv, cwd = process.cwd()): Config {
  const [tabsSocket, tabsSession = ''] = env.DV_TABS?.split(':') ?? [env.AGENT_HUB_TABS_SOCKET || 'ghostty', '']
  const popup = env.TD_POPUP === '1'
  const pane = paneModes(t('settings.modes.todo.name'), popup ? {} : env)
  return {
    dir: argv[2] || cwd,
    tabsSocket,
    tabsSession,
    win: Number(/^ghostty-(\d+)$/.exec(tabsSession)?.[1]) || 0,
    popup,
    pane,
    modes: modeTabs(pane).map(tab => ({ label: tab.label, exit: pane.exitOf(tab.i) })),
  }
}

export function createState(conf: Config): State {
  return {
    config: conf,
    items: [],
    // The store's stamp when it was last read, to skip reading it unchanged.
    lastStamp: null,
    loadError: '',
    // The active tab's; root is the main repo's, which every worktree shares.
    here: { folder: '', root: '', repo: '', worktree: '', branch: '' },
    panes: new Map(),
    // From agentd's state.
    agents: [],
    only: false,
    showDone: false,
    cursorId: '',
    // The ids m marked, for w to hand off together.
    marked: new Set(),
    // The ids whose agents a hand-off is still starting, so a second w
    // can't start them again.
    handingOff: new Set(),
    scroll: 0,
    prompt: null,
    said: null,
    // The body rows last drawn, for clicks.
    drawn: [],
  }
}

export const shown = (s: State, now?: number): Arranged => arrange(s.items, { here: s.here.root, only: s.only, now })
export const selectable = (s: State, view = shown(s)): Item[] => ui.selectable(view, s.showDone)
export const cursorItem = (s: State, list = selectable(s)): Item | undefined => ui.cursorItem(list, s.cursorId)

// ±Infinity goes to the first or last. False on an empty list.
export function moveCursor(s: State, by: number, list: readonly Pick<Item, 'id'>[] = selectable(s)): boolean {
  const id = ui.moveTo(list, s.cursorId, by)
  if (id === undefined) return false
  s.cursorId = id
  return true
}

// The edit form is drawn inside the cursor item's card, so the cursor stays on
// that item while the form is open. Once the item has left the list the form
// closes rather than take keys unseen; false then.
export function pinEdit(s: State, list: readonly Pick<Item, 'id'>[] = selectable(s)): boolean {
  const prompt = s.prompt
  if (prompt?.kind !== 'edit') return true
  if (!list.some(i => i.id === prompt.id)) {
    s.prompt = null
    return false
  }
  s.cursorId = prompt.id
  return true
}

// `key` answers yes; `answers` are the keys shown, as [key, what] pairs.
export const confirmPrompt = (text: string, yes: () => void, key: string, answers: ConfirmPrompt['answers']): ConfirmPrompt => ({
  kind: 'confirm',
  text,
  yes,
  key,
  answers,
})
