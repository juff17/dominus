// Board layout shared by the hub, the rail and the tray. Pure.

import { skillAt } from '../core/hub-skills.ts'
import type { Agent, AgentState, Monitor, MonitorState } from './classify.ts'

export type Lane = AgentState
export type Lanes<A> = Record<Lane, A[]>
export type StripMonitor<A> = Monitor & { agent: A }
export type Counts = Record<Lane, number> & { watching: number; monitors: number }

type Placed = Pick<Agent, 'state' | 'since' | 'monitor' | 'prompt'>

// A session started to watch something stays one after its watcher ends, so
// it never turns into a finished task in Done or Idle.
const WATCHER = new RegExp(skillAt('pr-babysit|pipeline-watch|log-watcher|logger'))
// prompt can be missing from an older agentd's snapshot.
export const watches = (a: Placed): boolean => a.monitor || WATCHER.test((a.prompt ?? '').trim())

// Needs you and Idle oldest first: the longest wait is the most urgent, the
// longest idle the first to close. A monitor agent shows only in Needs you.
export function lanes<A extends Placed>(agents: readonly A[]): Lanes<A> {
  const by = (state: Lane) => agents.filter(a => a.state === state && (!watches(a) || state === 'needs'))
  const old = (a: A, b: A) => a.since - b.since
  const recent = (a: A, b: A) => b.since - a.since
  return {
    needs: by('needs').sort(old),
    working: by('working').sort(recent),
    done: by('done').sort(recent),
    idle: by('idle').sort(old),
  }
}

const STRIP_RANK: Record<MonitorState, number> = { action: 0, stale: 1, watching: 2, ended: 3 }

export function monitorsOf<A extends Pick<Agent, 'monitors'>>(agents: readonly A[]): StripMonitor<A>[] {
  return agents
    .flatMap(a => a.monitors.map(m => ({ ...m, agent: a })))
    .sort((a, b) => STRIP_RANK[a.state] - STRIP_RANK[b.state] || (b.event?.at ?? b.startedAt) - (a.event?.at ?? a.startedAt))
}

export function counts(agents: readonly (Placed & Pick<Agent, 'monitors'>)[]): Counts {
  const l = lanes(agents)
  return {
    needs: l.needs.length,
    working: l.working.length,
    done: l.done.length,
    idle: l.idle.length,
    watching: agents.reduce((n, a) => n + a.monitors.filter(m => m.state === 'watching').length, 0),
    monitors: agents.reduce((n, a) => n + a.monitors.length, 0),
  }
}

// Needs you never shrinks a card, since every one is a decision. A full card
// is its top border (the title), two lines and its bottom border.
export function cardHeights(lane: Lane, n: number, height: number, doneCards = 2): number[] {
  const FULL = 4
  if (lane === 'needs') return new Array<number>(n).fill(FULL)
  if (lane === 'working') return new Array<number>(n).fill(n * FULL <= height ? FULL : 3)
  if (lane === 'done') return Array.from({ length: n }, (_, i) => (i < doneCards ? FULL : 1))
  return new Array<number>(n).fill(1)
}

// The first item to show so that `selected` is on screen. Rows are kept for
// the "more" cues.
export function scrollTo(heights: readonly number[], height: number, selected: number, from = 0): number {
  if (selected < 0) return 0
  let top = Math.min(from, selected)
  const fits = (a: number, b: number) => heights.slice(a, b + 1).reduce((n, h) => n + h, 0) <= height - (a > 0 ? 1 : 0) - 1
  while (top < selected && !fits(top, selected)) top++
  return top
}
