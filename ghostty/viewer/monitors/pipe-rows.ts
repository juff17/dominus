// The Pipelines view's rows. Gates are items in the same list as their
// pipeline, so j/k move through both.

import { type Gate, type Pipe, type PipeHost, gateKey, gateSig, parsePipeTarget, pipeKey } from './pipelines.ts'
import { type RunRow, hitsIn, matches, sameUrl, words } from './rows.ts'

export type PipeGroup = 'own' | 'prs'
export const PIPE_GROUPS: readonly PipeGroup[] = ['own', 'prs']

export type PipeItem =
  | { kind: 'group'; group: PipeGroup; n: number }
  | { kind: 'pipe'; key: string; pipe: Pipe; monitor: PipeMonitor; hit: { project: number[]; ref: number[] } }
  | { kind: 'gate'; key: string; pipe: Pipe; gate: Gate; pipeKey: string }

// via: the PR monitor it comes from.
export type PipeMonitor = { kind: 'watching' } | { kind: 'via'; ref: string } | { kind: 'none' }

// A pipeline that ended ages out keepMs after it started (0 keeps every
// one).
export type PipeView = {
  fromPrs: boolean
  closed: ReadonlySet<string>
  skipped: Readonly<Record<string, string>>
  dismissed?: ReadonlySet<string>
  keepMs?: number
  now?: number
  query?: string
}

// Only what ended without failing ages out. A failed pipeline stays until
// a newer run replaces it or x dismisses it, and one with a gate waiting
// stays while the gate does.
const AGES: ReadonlySet<Pipe['state']> = new Set(['passed', 'canceled', 'skipped'])

export function shownPipe(pipe: Pipe, v: PipeView): boolean {
  if (v.dismissed?.has(pipeKey(pipe))) return false
  if (!v.keepMs || !AGES.has(pipe.state) || shownGates(pipe, v.skipped).length) return true
  return (v.now ?? Date.now()) - pipe.at <= v.keepMs
}

export const shownGates = (pipe: Pipe, skipped: Readonly<Record<string, string>>): Gate[] => pipe.gates.filter(g => skipped[gateKey(pipe, g)] !== gateSig(g))

// In every form a pipeline can be named: its address, and project@ref with
// and without the host.
export function watchedPipes(rows: readonly RunRow[]): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    if (r.kind !== 'pipe' || r.m.state === 'ended' || !r.pipeTarget) continue
    const t = parsePipeTarget(r.pipeTarget)
    if (!t) continue
    if (t.url) out.add(sameUrl(t.url))
    if (t.ref) out.add(`${t.host ? `${t.host}/` : ''}${t.project}@${t.ref}`.toLowerCase())
  }
  return out
}

function monitorOf(pipe: Pipe, watched: ReadonlySet<string>): PipeMonitor {
  if (pipe.pr) return { kind: 'via', ref: pipe.prRef }
  const names = [sameUrl(pipe.url), `${pipe.project}@${pipe.ref}`.toLowerCase(), `${pipe.host}/${pipe.project}@${pipe.ref}`.toLowerCase()]
  return names.some(n => watched.has(n)) ? { kind: 'watching' } : { kind: 'none' }
}

const refOf = (pipe: Pipe): string => (pipe.pr ? pipe.prRef : pipe.ref)

function pipeMatches(pipe: Pipe, ws: readonly string[]): boolean {
  if (!ws.length) return true
  return matches([pipe.project, pipe.ref, pipe.prRef, pipe.trigger, pipe.state, pipe.failed, ...pipe.gates.flatMap(g => [g.name, g.env])], ws)
}

export function pipeGroups(hosts: readonly PipeHost[], v: PipeView): Record<PipeGroup, Pipe[]> {
  const ws = words(v.query ?? '')
  const all = hosts
    .flatMap(h => h.pipes)
    .filter(p => shownPipe(p, v) && pipeMatches(p, ws))
    .sort((a, b) => b.at - a.at)
  return { own: all.filter(p => !p.pr), prs: v.fromPrs ? all.filter(p => p.pr) : [] }
}

// Dismissed or aged out; not those the filter hides.
export function hiddenCount(hosts: readonly PipeHost[], v: PipeView): number {
  return hosts.flatMap(h => h.pipes).filter(p => (v.fromPrs || !p.pr) && !shownPipe(p, v)).length
}

export function pipeItems(hosts: readonly PipeHost[], v: PipeView, watched: ReadonlySet<string>): PipeItem[] {
  const groups = pipeGroups(hosts, v)
  const ws = words(v.query ?? '')
  const items: PipeItem[] = []
  for (const g of PIPE_GROUPS) {
    const pipes = groups[g]
    if (!pipes.length) continue
    items.push({ kind: 'group', group: g, n: pipes.length })
    for (const pipe of pipes) {
      const key = pipeKey(pipe)
      items.push({ kind: 'pipe', key, pipe, monitor: monitorOf(pipe, watched), hit: { project: hitsIn(pipe.project, ws), ref: hitsIn(refOf(pipe), ws) } })
      if (v.closed.has(key)) continue
      for (const gate of shownGates(pipe, v.skipped)) items.push({ kind: 'gate', key: gateKey(pipe, gate), pipe, gate, pipeKey: key })
    }
  }
  return items
}

// Closed panels count too.
export function waitingCount(hosts: readonly PipeHost[], v: PipeView): number {
  const groups = pipeGroups(hosts, v)
  return [...groups.own, ...groups.prs].reduce((n, p) => n + shownGates(p, v.skipped).length, 0)
}

// The "now" column.
export type NowLine = { tone: 'peach' | 'red' | 'blue' | 'green' | 'sub'; text: string }

export function nowOf(pipe: Pipe, gates: readonly Gate[], words: (key: string, vars?: Record<string, string | number>) => string): NowLine {
  if (gates.length === 1) return { tone: 'peach', text: words('waitsOne', { job: gates[0].name }) }
  if (gates.length > 1) return { tone: 'peach', text: words('waitsMany', { n: gates.length }) }
  if (pipe.state === 'failed') return { tone: 'red', text: pipe.failed ? words('failed', { job: pipe.failed }) : words('failedNoJob') }
  if (pipe.state === 'running') {
    const stage = pipe.stages.find(s => s.state === 'running') ?? pipe.stages.find(s => s.state === 'waiting')
    return { tone: 'blue', text: stage ? words('running', { stage: stage.name, done: stage.done, total: stage.total }) : words('runningNoStage') }
  }
  if (pipe.state === 'passed') return { tone: 'green', text: words('passed') }
  if (pipe.state === 'manual') return { tone: 'peach', text: words('manual') }
  return { tone: 'sub', text: words(pipe.state) }
}
