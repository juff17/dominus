// What Alt+M keeps between openings (the PR list, the pipelines, the gates
// you skipped and the pipelines you dismissed), and which hosts and projects
// it asks.

import { isRecord, readJsonFile, writeAtomic } from '../../core/json.ts'
import { errorMessage, logger } from '../../core/log.ts'
import type { Settings } from '../../settings/catalog.ts'
import type { ForgeId } from '../../core/forge.ts'
import type { HostResult } from './forge.ts'
import type { PipeHost, PipeQuery, PrSource } from './pipelines.ts'
import { type RunRow, parsePrUrl } from './rows.ts'
import type { MonitorsState } from './state.ts'

const log = logger('monitors')

export const configuredHosts = (v: Pick<Settings, 'monitors.githubHosts' | 'monitors.gitlabHosts'>): { forge: ForgeId; host: string }[] => [
  ...v['monitors.githubHosts'].map(host => ({ forge: 'gh' as const, host })),
  ...v['monitors.gitlabHosts'].map(host => ({ forge: 'gl' as const, host })),
]

// What the popup keeps between openings, in one file: the PR list, and the
// pipelines with the gates you skipped and the pipelines you dismissed.
export type PipesCache = { hosts: PipeHost[]; skipped: Record<string, string>; dismissed: string[] }
export type Cache = { prs: HostResult[]; pipes: PipesCache }

// We wrote the cache, so only its outline is checked: one that parses to
// something else is from another version, and the next fetch replaces it.
const isHostResult = (v: unknown): v is HostResult => isRecord(v) && (v.forge === 'gh' || v.forge === 'gl') && typeof v.host === 'string' && Array.isArray(v.prs) && typeof v.ok === 'boolean'
const isPipeHost = (v: unknown): v is PipeHost => isRecord(v) && (v.forge === 'gh' || v.forge === 'gl') && typeof v.host === 'string' && Array.isArray(v.pipes) && typeof v.ok === 'boolean'

export function readCache(file: string): Cache {
  const none: Cache = { prs: [], pipes: { hosts: [], skipped: {}, dismissed: [] } }
  const v = readJsonFile(file, log, 'cache unreadable')
  if (!isRecord(v)) return none
  const p = isRecord(v.pipelines) ? v.pipelines : {}
  const skipped = isRecord(p.skipped) ? Object.fromEntries(Object.entries(p.skipped).filter((e): e is [string, string] => typeof e[1] === 'string')) : {}
  const dismissed = Array.isArray(p.dismissed) ? p.dismissed.filter((k): k is string => typeof k === 'string') : []
  return {
    prs: Array.isArray(v.prs) ? v.prs.filter(isHostResult) : [],
    pipes: { hosts: Array.isArray(p.hosts) ? p.hosts.filter(isPipeHost) : [], skipped, dismissed },
  }
}

export function writeCache(file: string, s: Pick<MonitorsState, 'hosts' | 'pipes'>): void {
  const value = { v: 1, prs: s.hosts, pipelines: { hosts: s.pipes.hosts, skipped: s.pipes.skipped, dismissed: [...s.pipes.dismissed] } }
  try {
    writeAtomic(file, `${JSON.stringify(value)}\n`)
  } catch (err) {
    log.warn('cache not written', { path: file, err: errorMessage(err) })
  }
}

// With no projects in Settings, a host's are those of the open PRs it
// lists. The PRs a running pr-babysit monitor watches are added on top.
export function pipeQueries(
  v: Pick<Settings, 'monitors.githubHosts' | 'monitors.gitlabHosts' | 'monitors.pipelines.projects' | 'monitors.pipelines.refs'>,
  prHosts: readonly HostResult[],
  running: readonly RunRow[],
  fromPrs: boolean,
): PipeQuery[] {
  const configured = v['monitors.pipelines.projects']
  const watched: PrSource[] = fromPrs
    ? running.flatMap(r => {
        const ref = r.kind === 'pr' && r.m.state !== 'ended' && !r.standIn && r.url ? parsePrUrl(r.url) : null
        return ref ? [{ forge: ref.forge, host: ref.host, project: ref.repo, number: ref.number, url: r.url }] : []
      })
    : []
  return configuredHosts(v).flatMap(({ forge, host }) => {
    const projects = configured.length
      ? configured.filter(p => p.toLowerCase().startsWith(`${host.toLowerCase()}/`)).map(p => p.slice(host.length + 1))
      : [...new Set(prHosts.filter(h => h.forge === forge && h.host === host).flatMap(h => h.prs.map(pr => pr.repo)))]
    const prs = watched.filter(p => p.forge === forge && p.host === host.toLowerCase())
    const unique = [...new Map(prs.map(p => [p.url, p])).values()]
    return projects.length || unique.length ? [{ forge, host, projects, refs: v['monitors.pipelines.refs'], prs: unique }] : []
  })
}
