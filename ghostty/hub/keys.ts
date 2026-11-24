// What the hub's keys and clicks do, apart from doing it: the action each
// key names, how a question and the filter take keys, and which clicks
// count. hub.ts runs the actions; keys.test.ts pins the bindings.

import type { AskSetting, Asked } from './actions.ts'
import type { Hit } from './view.ts'
import { type Mouse, leftPress } from '../tui/input.ts'
import { editField } from '../tui/line.ts'

// The escape sequences other programs send the hub (core/keys.ts).
export { AGENT_VIEW_KEY, DIAGRAMS_KEY, EDITOR_KEY, NEW_AGENT_KEY, OPEN_AGENT_KEY, PEEK_CLOSING_KEY } from '../core/keys.ts'

export type Action =
  | 'laneLeft'
  | 'laneRight'
  | 'down'
  | 'up'
  | 'tab'
  | 'open'
  | 'allow'
  | 'deny'
  | 'reviewed'
  | 'reviewAll'
  | 'goToTab'
  | 'close'
  | 'restart'
  | 'restartAll'
  | 'new'
  | 'filter'
  | 'back'
  | 'workspace'

export const KEYS: Readonly<Record<string, Action>> = {
  h: 'laneLeft',
  l: 'laneRight',
  '\x1b[D': 'laneLeft',
  '\x1b[C': 'laneRight',
  j: 'down',
  k: 'up',
  '\x1b[B': 'down',
  '\x1b[A': 'up',
  '\t': 'tab',
  '\r': 'open',
  a: 'allow',
  d: 'deny',
  e: 'reviewed',
  E: 'reviewAll',
  o: 'goToTab',
  x: 'close',
  // Ctrl+X, for the list beside an open session.
  '\x18': 'close',
  r: 'restart',
  R: 'restartAll',
  n: 'new',
  '/': 'filter',
  '\x1b': 'back',
  q: 'workspace',
}

// Own keys only, so a key named like an Object method is no action.
export const keyAction = (key: string): Action | null => (Object.hasOwn(KEYS, key) ? KEYS[key] : null)

// A question waiting in the footer takes the next key, whatever it is: the
// key that asked it says yes, as does another key for the same action (x
// and Ctrl+X both close). `remember` names the question to stop asking.
export type Answer = { yes: boolean; remember: AskSetting | null }

export function answerConfirm(confirm: Pick<Asked, 'skip' | 'key'>, key: string): Answer {
  const again = key === confirm.key || (keyAction(key) !== null && keyAction(key) === keyAction(confirm.key))
  if (again) return { yes: true, remember: null }
  if (key === 'a' && confirm.skip) return { yes: true, remember: confirm.skip }
  return { yes: false, remember: null }
}

// `at` is the caret (tui/line.ts), undefined at the end, and comes back only
// when it's off the end.
export type FilterState = { filter: string; filtering: boolean; at?: number }

export function filterKey(filter: string, key: string, at?: number): FilterState {
  if (key === '\r') return { filter, filtering: false }
  if (key === '\x1b') return { filter: '', filtering: false }
  const state: FilterState = { filter, filtering: true, ...(at === undefined ? {} : { at }) }
  editField(state, 'filter', key)
  return state
}

// The wheel moves the selection, down +1 and up -1.
export type MouseAct = { wheel: 1 | -1; click?: undefined } | { click: true; wheel?: undefined }

export function mouseAction(m: Pick<Mouse, 'button' | 'up' | 'released'>): MouseAct | null {
  if (m.button & 64) return { wheel: m.button & 1 ? 1 : -1 }
  return leftPress(m) ? { click: true } : null
}

// The clickable region of the last frame under x, y; with `wheel`, only
// regions that take the wheel (a lane, or the monitors strip).
export const hitAt = (hits: readonly Hit[], x: number, y: number, wheel = false): Hit | undefined =>
  hits.find(r => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2 && (!wheel || r.wheel !== undefined))
