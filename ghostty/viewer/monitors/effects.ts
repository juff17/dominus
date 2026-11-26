// Everything the Monitors popup does to the world. What the approvals panel
// asks is viewer/approvals/effects.ts's to do. monitorsEffects() takes the
// world, so tests hand it fakes.

import { type ChildProcess, type SpawnOptions, type SpawnSyncReturns, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { readState } from '../../agents/client.ts'
import { type Agent, type MonitorSpec, launch } from '../../agents/model.ts'
import { type StopResult, type StopTarget, stopMonitor, stopWorld } from '../../agents/stop.ts'
import { pluginInstalled, pluginMissing } from '../../core/hub-skills.ts'
import type { Image } from '../../core/images.ts'
import { isRecord } from '../../core/json.ts'
import { errorMessage, logger } from '../../core/log.ts'
import { TABS_SOCKET, claudeBin } from '../../core/paths.ts'
import { type Runner, run } from '../../core/proc.ts'
import { t } from '../../core/text.ts'
import { storePaths } from '../../settings/prefs.ts'
import { type Settings, defaultFolder, load as loadSettings, set as setSetting } from '../../settings/settings.ts'
import { type Proposal, readApprovals } from '../../tray/approvals.ts'
import { type Reachable, type Shown, go } from '../../tray/navigate.ts'
import type { State as ApprovalsState } from '../approvals/approvals.ts'
import { type ApprovalsWorld, approvalEffects, world as approvalsWorld } from '../approvals/effects.ts'
import { type AttachOptions, BRIEF_LABEL, attachLine,attachedFile, monitorsDir, readAttached, recordAttached } from './attach.ts'
import { findCheckouts, repoKey } from './checkout.ts'
import { type ForgeClient, type ForgeId, type HostResult, type Pr, forgeClient } from './forge.ts'
import { type Blocked, blockedSources, kubeconfigs } from './sources.ts'
import { type LogsSpec, WATCH_FOR_LABEL, logsLines, logsName, setWorld } from './logs-state.ts'
import { keptDismissed, keptSkips } from './pipe-state.ts'
import { type Gate, type Pipe, type PipeHost, type PipeQuery, type PipelinesClient, type PrSource, parsePipeTarget, pipelinesClient, targetLabel } from './pipelines.ts'
import { type RunRow, matchName, matchTarget, parsePrUrl, refLabel } from './rows.ts'
import { type Act, type MonitorsState, allRunning, panelEmptied, panelRow, setAgents, setHosts, setProposals, started, startedOne } from './state.ts'

const log = logger('monitors')

export type World = {
  forge: ForgeClient
  pipelines: PipelinesClient
  // What the Logs view can't watch from, for the tab's folder.
  sources: (folder: string) => Blocked
  // The active tab's folder in the window the popup opened over, or ''.
  tabFolder: (layout: string) => Promise<string>
  setFromPrs: (on: boolean) => void
  spawn: (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess
  agents: () => Agent[] | null
  proposals: () => Proposal[]
  approvals: ApprovalsWorld
  go: (a: Reachable, layout: string) => Promise<Shown>
  stop: (m: StopTarget) => StopResult
  settings: () => Settings
  dontAskStop: () => void
  claude: () => string
  // Whether the dominus plugin, whose skills every monitor runs, is installed.
  plugin: () => boolean
  cacheFile: string
  attachedFile: string
  // The folders to look for clones from: New agent's recents and agents' folders.
  known: () => string[]
  home: string
  now: () => number
}

// outside runs a program on the whole terminal (the panel's $EDITOR).
export type ViewIo = { draw: () => void; quit: () => void; outside: (cmd: string, args: string[]) => SpawnSyncReturns<Buffer> }

const readText = (path: string): string => readFileSync(path, 'utf8')

// New agent's recent folders.
function recentFolders(): string[] {
  try {
    const v: unknown = JSON.parse(readText(storePaths().recents))
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []
  } catch {
    // No recents yet.
    return []
  }
}

// The tab session of layout session layout-<n> is ghostty-<n>; its active
// pane's folder is the tab's.
async function activeTabFolder(runner: Runner, layout: string): Promise<string> {
  const n = /^layout-(\d+)$/.exec(layout)?.[1]
  if (!n) return ''
  const cmd = ['tmux', '-L', TABS_SOCKET, 'display', '-p', '-t', `ghostty-${n}:`, '#{pane_current_path}']
  const r = await runner(cmd, { timeout: 3000 })
  if (!r.ok) log.warn('tab folder unreadable', { cmd, exit: r.exit, err: r.err.slice(0, 160) })
  return r.ok ? r.out.trim() : ''
}

export const world = (runner: Runner = run): World => ({
  forge: forgeClient({ run: runner, log }),
  pipelines: pipelinesClient({ run: runner, log }),
  sources: folder =>
    blockedSources({
      path: process.env.PATH,
      kubeconfigs: kubeconfigs(loadSettings()['monitors.logs.kubeconfig'], process.env.KUBECONFIG, homedir()),
      claudeJson: join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json'),
      folder,
    }),
  tabFolder: layout => activeTabFolder(runner, layout),
  setFromPrs: on => setSetting('monitors.pipelines.fromPrs', on),
  spawn,
  agents: () => readState()?.agents ?? null,
  proposals: () => readApprovals(),
  approvals: approvalsWorld(),
  go,
  stop: m => stopMonitor(m, stopWorld()),
  settings: loadSettings,
  dontAskStop: () => setSetting('hub.askStopMonitor', false),
  claude: () => claudeBin(),
  plugin: pluginInstalled,
  cacheFile: join(monitorsDir(), 'cache.json'),
  attachedFile: attachedFile(),
  known: recentFolders,
  home: homedir(),
  now: Date.now,
})

// ------------------------------------------------------------ the cache

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
  try {
    const v: unknown = JSON.parse(readText(file))
    if (!isRecord(v)) return none
    const p = isRecord(v.pipelines) ? v.pipelines : {}
    const skipped = isRecord(p.skipped) ? Object.fromEntries(Object.entries(p.skipped).filter((e): e is [string, string] => typeof e[1] === 'string')) : {}
    const dismissed = Array.isArray(p.dismissed) ? p.dismissed.filter((k): k is string => typeof k === 'string') : []
    return {
      prs: Array.isArray(v.prs) ? v.prs.filter(isHostResult) : [],
      pipes: { hosts: Array.isArray(p.hosts) ? p.hosts.filter(isPipeHost) : [], skipped, dismissed },
    }
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) log.warn('cache unreadable', { path: file, err: errorMessage(err) })
    return none
  }
}

function writeCache(file: string, s: Pick<MonitorsState, 'hosts' | 'pipes'>): void {
  const value = { v: 1, prs: s.hosts, pipelines: { hosts: s.pipes.hosts, skipped: s.pipes.skipped, dismissed: [...s.pipes.dismissed] } }
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(value)}\n`)
    renameSync(tmp, file)
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

// ------------------------------------------------------------ the effects

export type MonitorsEffects = {
  load: () => void
  // Runs once, after the first draw.
  findClones: () => void
  agents: () => void
  proposals: () => void
  closeWhenDone: () => void
  // Then the pipelines, which need the PR list.
  refresh: () => Promise<void>
  refreshPipes: () => Promise<void>
  readLogsWorld: () => Promise<void>
  run: (act: Act) => Promise<void>
}

export type EffectsOptions = { layout?: string }

export function monitorsEffects(s: MonitorsState, io: World & ViewIo, { layout = '' }: EffectsOptions = {}): MonitorsEffects {
  const hostsNow = (): HostResult[] => {
    const want = configuredHosts(io.settings())
    return s.hosts.filter(h => want.some(w => w.forge === h.forge && w.host === h.host))
  }

  function agents(): void {
    const list = io.agents()
    if (list) setAgents(s, list)
  }

  const proposals = (): void => setProposals(s, io.proposals())

  // Made again for each panel opened, as they act on its state. They read
  // the proposals themselves rather than through setProposals, which would
  // count the one just settled as replaced.
  let panelFx: { ap: ApprovalsState; fx: ReturnType<typeof approvalEffects> } | null = null
  function approvals(): ReturnType<typeof approvalEffects> | null {
    const panel = s.panel
    if (!panel) return null
    if (panelFx?.ap === panel.ap) return panelFx.fx
    const fx = approvalEffects(panel.ap, {
      ...io.approvals,
      proposals: () => {
        s.proposals = io.proposals()
        return panelRow(s)?.waits ?? []
      },
      agents: () => s.agents,
      go: a => io.go(a, layout),
      draw: io.draw,
      quit: io.quit,
      emptied: () => panelEmptied(s),
      outside: io.outside,
    })
    panelFx = { ap: panel.ap, fx }
    return fx
  }

  async function refresh(): Promise<void> {
    if (s.refreshing) return
    const want = configuredHosts(io.settings())
    if (!want.length) {
      setHosts(s, [])
      return io.draw()
    }
    s.refreshing = true
    io.draw()
    const started = io.now()
    const results = await Promise.all(want.map(w => io.forge.fetch(w.forge, w.host, s.hosts.find(h => h.forge === w.forge && h.host === w.host))))
    setHosts(s, results)
    s.refreshing = false
    writeCache(io.cacheFile, s)
    log.debug('prs refreshed', { ms: io.now() - started, hosts: results.length, ok: results.filter(r => r.ok).length })
    io.draw()
    await refreshPipes()
  }

  async function refreshPipes(): Promise<void> {
    const p = s.pipes
    if (p.refreshing) return
    const queries = pipeQueries(io.settings(), s.hosts, allRunning(s), p.fromPrs)
    p.refreshing = true
    io.draw()
    const started = io.now()
    const results = await Promise.all(queries.map(q => io.pipelines.fetch(q, p.hosts.find(h => h.forge === q.forge && h.host === q.host))))
    p.hosts = results
    p.skipped = keptSkips(results, p.skipped)
    p.dismissed = keptDismissed(results, p.dismissed)
    p.refreshing = false
    writeCache(io.cacheFile, s)
    log.debug('pipelines refreshed', { ms: io.now() - started, hosts: results.length, ok: results.filter(r => r.ok).length })
    io.draw()
  }

  async function runGate(pipe: Pipe, gate: Gate): Promise<void> {
    const words = { job: gate.name, ref: pipe.pr ? pipe.prRef : pipe.ref }
    s.note = { text: t('monitors.pipes.notes.running', words), tone: 'sub' }
    io.draw()
    const r = await io.pipelines.run(pipe, gate)
    if (r.ok) s.note = { text: t(gate.kind === 'deployment' ? 'monitors.pipes.notes.approved' : 'monitors.pipes.notes.ran', { ...words, env: gate.env }), tone: 'green' }
    else if (r.why === 'changed') s.note = { text: t('monitors.pipes.notes.changed', { ...words, why: r.err }), tone: 'peach' }
    else s.note = { text: t('monitors.pipes.notes.failed', { ...words, err: r.err }), tone: 'red' }
    io.draw()
    await refreshPipes()
  }

  async function readLogsWorld(): Promise<void> {
    const ms = io.now()
    const folder = (await io.tabFolder(layout)) || defaultFolder(io.settings())
    const blocked = io.sources(folder)
    setWorld(s.logs, blocked, folder)
    log.debug('logs world read', { ms: io.now() - ms, path: folder, blocked })
    io.draw()
  }

  function rowOf(key: string) {
    return allRunning(s).find(r => r.key === key) ?? null
  }

  async function open(key: string): Promise<void> {
    const r = rowOf(key)
    if (!r) return
    const went = await io.go(r.m.agent, layout)
    log.info('monitor session opened', { id: r.m.agent.id, ok: went.ok, ...(went.ok ? {} : { err: went.message }) })
    if (went.ok) return io.quit()
    s.note = { text: went.message, tone: 'red' }
  }

  function stop(key: string, remember: boolean): void {
    const r = rowOf(key)
    if (!r) return
    if (remember) {
      try {
        io.dontAskStop()
        s.options.askStop = false
      } catch (err) {
        log.warn('setting not saved', { key: 'hub.askStopMonitor', err: errorMessage(err) })
      }
    }
    const words = { name: r.m.description, title: r.m.agent.title }
    const result = io.stop(r.m)
    if (result.unreadable !== undefined) log.warn('processes unreadable', { err: errorMessage(result.unreadable) })
    if (result.ok) {
      log.info('monitor stopped', { id: r.m.agent.id, task: r.m.task, ok: true, pid: result.pid, group: result.group })
      s.note = { text: t('hub.notes.monitorStopped', words), tone: 'green' }
    } else if (result.reason === 'no process') {
      log.info('monitor stopped', { id: r.m.agent.id, task: r.m.task, ok: false, reason: 'no process' })
      s.note = { text: t('hub.notes.monitorNoProcess', words), tone: 'peach' }
    } else {
      log.error('monitor not stopped', { id: r.m.agent.id, task: r.m.task, pid: result.pid, err: errorMessage(result.err) })
      s.note = { text: t('hub.notes.monitorStopFailed', { ...words, err: errorMessage(result.err) }), tone: 'red' }
    }
  }

  function browse(url: string): void {
    const child = io.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
    child.on('error', err => {
      log.warn('link not opened', { url, err: err.message })
      s.note = { text: t('monitors.notes.noOpener', { url }), tone: 'red' }
      io.draw()
    })
    child.unref()
    log.info('link opened', { url })
    s.note = { text: t('monitors.notes.opened', { url }), tone: 'green' }
  }

  // claude --bg prints the job's id and returns once the agent runs. Resolves
  // '' then, or what went wrong. `id` names it in the log.
  function spawnBg(spec: MonitorSpec, id: string, more: Record<string, unknown> = {}): Promise<string> {
    if (!io.plugin()) {
      log.error('monitor not started', { id, skill: spec.skill, err: 'plugin missing' })
      return Promise.resolve(pluginMissing())
    }
    const plan = launch(spec)
    const cwd = spec.cwd
    return new Promise(done => {
      let out = ''
      const ms = io.now()
      const child = io.spawn(io.claude(), plan.argv.slice(1), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout?.on('data', (b: Buffer) => (out += b))
      child.stderr?.on('data', (b: Buffer) => (out += b))
      child.on('error', err => {
        log.error('monitor not started', { id, cmd: ['claude', ...plan.argv.slice(1, -1)], err: err.message })
        done(err.message)
      })
      child.on('close', code => {
        const said = out.trim().split('\n')[0]?.slice(0, 160) ?? ''
        if (code === 0) log.info('monitor started', { id, skill: spec.skill, name: plan.name, cwd, model: spec.model, effort: spec.effort, ...more, ms: io.now() - ms })
        else log.error('monitor not started', { id, cmd: ['claude', ...plan.argv.slice(1, -1)], exit: code, err: said })
        done(code === 0 ? '' : said || `exit ${code}`)
      })
      child.unref()
    })
  }

  // Runs in the project's clone when there is one, else in Settings' Default folder.
  async function watchPipe(target: string): Promise<void> {
    const v = io.settings()
    const pt = parsePipeTarget(target)
    const cwd = (pt && [...s.checkouts.entries()].find(([k]) => k.endsWith(`/${pt.project.toLowerCase()}`) && (!pt.host || k.startsWith(`${pt.host}/`)))?.[1]) || defaultFolder(v)
    const label = pt ? targetLabel(pt) : target
    s.note = { text: t('monitors.notes.starting', { n: 1 }), tone: 'sub' }
    io.draw()
    const err = await spawnBg(
      {
        kind: 'monitor',
        skill: 'pipe',
        target,
        lines: ['Until: finished'],
        cwd,
        model: v['monitors.pipelines.model'],
        effort: v['monitors.pipelines.effort'],
        mode: 'auto',
      },
      target,
    )
    if (err) {
      s.note = { text: t('monitors.pipes.notes.watchFailed', { target: label, err }), tone: 'red' }
      return
    }
    startedOne(s, matchTarget(target))
    s.note = { text: t('monitors.pipes.notes.watching', { target: label }), tone: 'green' }
  }

  async function startLogs(spec: LogsSpec): Promise<void> {
    const v = io.settings()
    const name = logsName(spec.env)
    s.note = { text: t('monitors.notes.starting', { n: 1 }), tone: 'sub' }
    io.draw()
    const err = await spawnBg(
      {
        kind: 'monitor',
        skill: 'logs',
        target: '',
        lines: logsLines(spec),
        ...(spec.images?.length ? { images: spec.images } : {}),
        typed: { label: WATCH_FOR_LABEL, text: spec.watchFor },
        name,
        cwd: spec.folder,
        model: spec.model,
        effort: spec.effort,
        mode: v['newAgent.logs.mode'],
        chrome: v['newAgent.logs.chrome'] === 'on',
      },
      spec.env,
      { path: spec.folder, source: spec.source, level: spec.level, for: spec.for, protected: spec.protected },
    )
    if (err) {
      s.note = { text: t('monitors.logs.notes.startFailed', { env: spec.env, err }), tone: 'red' }
      return
    }
    s.logs.task = ''
    delete s.logs.at
    delete s.logs.images
    startedOne(s, matchName(name))
    s.note = { text: t('monitors.logs.notes.started', { env: spec.env }), tone: 'green' }
  }

  function fromPrs(on: boolean): void {
    try {
      io.setFromPrs(on)
      log.info('setting changed', { key: 'monitors.pipelines.fromPrs', value: on })
    } catch (err) {
      log.warn('setting not saved', { key: 'monitors.pipelines.fromPrs', err: errorMessage(err) })
      s.note = { text: t('settings.ui.cantSave', { err: errorMessage(err) }), tone: 'red' }
    }
  }

  function startOne(pr: Pr, o: AttachOptions, images: readonly Image[]): Promise<string> {
    const cwd = s.checkouts.get(repoKey(pr.host, pr.repo))
    if (!cwd) return Promise.resolve(t('monitors.notes.noCheckout', { repo: pr.repo }))
    const v = io.settings()
    const spec: MonitorSpec = {
      kind: 'monitor',
      skill: 'pr',
      target: pr.url,
      cwd,
      model: o.model,
      effort: o.effort,
      mode: v['newAgent.pr.mode'],
      chrome: v['newAgent.pr.chrome'] === 'on',
      extra: attachLine(o),
      ...(images.length ? { images: [...images] } : {}),
      typed: { label: BRIEF_LABEL, text: o.brief },
    }
    return spawnBg(spec, pr.url, { until: o.until })
  }

  async function startAll(prs: readonly Pr[], o: AttachOptions, images: readonly Image[] = []): Promise<void> {
    s.note = { text: t('monitors.notes.starting', { n: prs.length }), tone: 'sub' }
    io.draw()
    const ok: Pr[] = []
    const failed: string[] = []
    for (const pr of prs) {
      const err = await startOne(pr, o, images)
      if (err) failed.push(`${refLabel(pr.forge, pr.repo, pr.number)}: ${err}`)
      else ok.push(pr)
    }
    if (ok.length) {
      try {
        s.attached = recordAttached(
          ok.map(p => p.url),
          o,
          io.now(),
          io.attachedFile,
        )
      } catch (err) {
        log.warn('attach records not written', { path: io.attachedFile, err: errorMessage(err) })
      }
      started(s, ok.map(p => p.url))
    }
    const refs = ok.map(p => `${p.forge === 'gh' ? '#' : '!'}${p.number}`).join(', ')
    s.note = failed.length
      ? { text: [ok.length ? t('monitors.notes.started', { n: ok.length, refs }) : '', t('monitors.notes.startFailed', { what: failed.join('; ') })].filter(Boolean).join(' · '), tone: 'red' }
      : { text: t('monitors.notes.started', { n: ok.length, refs }), tone: 'green' }
  }

  return {
    load() {
      const { prs, pipes } = readCache(io.cacheFile)
      setHosts(s, prs)
      s.hosts = hostsNow()
      const want = configuredHosts(io.settings())
      s.pipes.hosts = pipes.hosts.filter(h => want.some(w => w.forge === h.forge && w.host === h.host))
      s.pipes.skipped = pipes.skipped
      s.pipes.dismissed = new Set(pipes.dismissed)
      s.attached = readAttached(io.attachedFile, log)
      agents()
      proposals()
    },
    findClones() {
      const ms = io.now()
      const known = [...io.known(), ...s.agents.map(a => a.cwd)]
      s.checkouts = findCheckouts(known, io.home)
      log.debug('clones found', { ms: io.now() - ms, n: s.checkouts.size })
    },
    agents,
    proposals,
    closeWhenDone: () => approvals()?.closeWhenDone(),
    refresh,
    refreshPipes,
    readLogsWorld,
    async run(act) {
      if (!act) return
      if (act.do === 'quit') return io.quit()
      // The panel's effects draw once they're done.
      if (act.do === 'approval') return approvals()?.run(act.e)
      if (act.do === 'open') await open(act.key)
      if (act.do === 'stop') stop(act.key, act.remember)
      if (act.do === 'browse') browse(act.url)
      if (act.do === 'refresh') await refresh()
      if (act.do === 'start') await startAll(act.prs, act.options, act.images)
      if (act.do === 'refreshPipes') await refreshPipes()
      if (act.do === 'gate') await runGate(act.pipe, act.gate)
      if (act.do === 'watchPipe') await watchPipe(act.target)
      if (act.do === 'logs') await startLogs(act.spec)
      if (act.do === 'savePipes') writeCache(io.cacheFile, s)
      if (act.do === 'fromPrs') {
        fromPrs(act.on)
        await refreshPipes()
      }
      io.draw()
    },
  }
}
