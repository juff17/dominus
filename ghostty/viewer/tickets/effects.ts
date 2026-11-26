// Everything the Tickets popup does to the world: reading .env and Settings,
// fetching the board, the cache, opening a ticket, starting its agent and
// going to it. ticketsEffects() takes the world, so tests hand it fakes.

import { type ChildProcess, type SpawnOptions, type SpawnSyncReturns, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { readState } from '../../agents/client.ts'
import { type Agent, type TicketSpec, launch } from '../../agents/model.ts'
import { slug } from '../../agents/launch.ts'
import { locate } from '../../agents/locate.ts'
import { pluginInstalled, pluginMissing } from '../../core/hub-skills.ts'
import { isRecord } from '../../core/json.ts'
import { errorMessage, logger } from '../../core/log.ts'
import { bin, claudeBin, tilde } from '../../core/paths.ts'
import { type Runner, run } from '../../core/proc.ts'
import { t } from '../../core/text.ts'
import { type Settings, defaultFolder, load as loadSettings, set as setSetting, settingsFile } from '../../settings/settings.ts'
import { type Reachable, type Shown, go } from '../../tray/navigate.ts'
import { type JiraKey, envFile, envSet, readEnv } from './env.ts'
import { type FetchLike, type JiraConfig, jiraClient, trimSite } from './jira.ts'
import { type Act, type Link, type Prefs, type Setup, type TicketsState, screenFor, setBoard } from './state.ts'
import { type Board, type BoardChoice, type Person, type Ticket, type Tracker, factLines, handoffFacts, scoutText } from './tracker.ts'

const log = logger('tickets')

export const ticketsDir = (): string => join(dirname(settingsFile()), 'tickets')

export type JiraTracker = Tracker & { base(): Promise<string> }

export type World = {
  env: () => Record<string, string>
  envSet: () => Record<JiraKey, boolean>
  envFile: string
  settings: () => Settings
  setSetting: (key: 'jira.board' | 'jira.team' | 'jira.cloudId', value: string) => void
  tracker: (config: JiraConfig) => JiraTracker
  run: Runner
  spawn: (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess
  agents: () => Agent[] | null
  go: (a: Reachable, layout: string) => Promise<Shown>
  claude: () => string
  plugin: () => boolean
  cacheFile: string
  linksFile: string
  now: () => number
  later: (fn: () => void, ms: number) => void
}

// outside runs a program on the whole terminal ($EDITOR on .env).
export type ViewIo = { draw: () => void; quit: () => void; outside: (cmd: string, args: string[]) => SpawnSyncReturns<Buffer> }
export type Where = { client: string; layout: string }

const readText = (path: string): string => readFileSync(path, 'utf8')

export const world = (runner: Runner = run): World => ({
  env: () => readEnv(),
  envSet: () => envSet(),
  envFile: envFile(),
  settings: loadSettings,
  setSetting: (key, value) => setSetting(key, value),
  tracker: config => jiraClient({ config, fetch: fetch as unknown as FetchLike, log, onCloudId: id => setSetting('jira.cloudId', id) }),
  run: runner,
  spawn,
  agents: () => readState()?.agents ?? null,
  go,
  claude: () => claudeBin(),
  plugin: pluginInstalled,
  cacheFile: join(ticketsDir(), 'cache.json'),
  linksFile: join(ticketsDir(), 'links.json'),
  now: Date.now,
  later: (fn, ms) => void setTimeout(fn, ms).unref(),
})

// ------------------------------------------------------------ files

// Written whole, through a rename, so a reader never sees half of it.
function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value)}\n`)
  renameSync(tmp, file)
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readText(file))
  } catch {
    // None yet, or broken: start without it.
    return null
  }
}

// What the popup keeps between openings: the last board, for the board it was,
// and when the MCP was last found.
export type Cache = { boardId: string; board: Board | null; fetchedAt: number; me: Person | null; mcp: { ok: boolean; at: number } | null }

export function readCache(file: string): Cache | null {
  const v = readJson(file)
  if (!isRecord(v) || typeof v.boardId !== 'string') return null
  const board = isRecord(v.board) && Array.isArray(v.board.columns) && Array.isArray(v.board.unassigned) && Array.isArray(v.board.mine) ? (v.board as Board) : null
  const me = isRecord(v.me) && typeof v.me.id === 'string' ? (v.me as Person) : null
  const mcp = isRecord(v.mcp) && typeof v.mcp.ok === 'boolean' && typeof v.mcp.at === 'number' ? { ok: v.mcp.ok, at: v.mcp.at } : null
  return { boardId: v.boardId, board, fetchedAt: typeof v.fetchedAt === 'number' ? v.fetchedAt : 0, me, mcp }
}

export function readLinks(file: string): Record<string, Link> {
  const v = readJson(file)
  if (!isRecord(v)) return {}
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, Link] => isRecord(e[1]) && typeof e[1].name === 'string' && typeof e[1].at === 'number'))
}

// A ticket's link is kept 30 days after its agent started.
const LINK_DAYS = 30

// ------------------------------------------------------------ what Settings and .env say

export function configOf(env: Record<string, string>, v: Settings): JiraConfig {
  return {
    site: trimSite(env.JIRA_SITE ?? ''),
    email: env.JIRA_EMAIL ?? '',
    token: env.JIRA_API_TOKEN ?? '',
    kind: env.JIRA_TOKEN_KIND === 'classic' ? 'classic' : 'scoped',
    cloudId: v['jira.cloudId'],
    boardId: v['jira.board'],
    teamId: v['jira.teamId'],
  }
}

export const setupOf = (w: Pick<World, 'envSet' | 'settings'>, mcp: boolean | null = null): Setup => {
  const v = w.settings()
  return { env: w.envSet(), board: v['jira.board'], team: v['jira.team'], mcp, check: { state: 'idle' } }
}

export const prefsOf = (v: Settings): Prefs => ({
  showDone: v['tickets.showDone'],
  folder: tilde(v['tickets.folder'] || defaultFolder(v)),
  model: v['tickets.handoff.model'],
  effort: v['tickets.handoff.effort'],
})

const DAY = 24 * 3600 * 1000

// ------------------------------------------------------------ the effects

export function ticketsEffects(s: TicketsState, io: World & ViewIo, where: Where) {
  // One client while the config stays the same, so it keeps its cached
  // columns, sprint and cloud id between refreshes.
  let client: { key: string; tracker: JiraTracker } | null = null
  function tracker(): JiraTracker {
    const config = configOf(io.env(), io.settings())
    const key = JSON.stringify({ ...config, token: config.token.length })
    if (!client || client.key !== key) client = { key, tracker: io.tracker(config) }
    return client.tracker
  }
  let mcp: Cache['mcp'] = null

  function saveCache(): void {
    try {
      writeJson(io.cacheFile, { boardId: s.setup.board, board: s.board, fetchedAt: s.fetchedAt, me: s.me, mcp } satisfies Cache)
    } catch (err) {
      log.warn('cache not written', { path: io.cacheFile, err: errorMessage(err) })
    }
  }

  function saveLinks(): void {
    const keep = io.now() - LINK_DAYS * DAY
    const links = Object.fromEntries(Object.entries(s.links).filter(([, l]) => l.at >= keep))
    try {
      writeJson(io.linksFile, links)
    } catch (err) {
      log.warn('links not written', { path: io.linksFile, err: errorMessage(err) })
    }
  }

  function load(): void {
    const c = readCache(io.cacheFile)
    s.links = readLinks(io.linksFile)
    s.agents = io.agents() ?? []
    if (c?.mcp && io.now() - c.mcp.at < DAY) {
      mcp = c.mcp
      s.setup.mcp = c.mcp.ok
    }
    if (c && c.boardId === s.setup.board && c.board) {
      s.me = c.me
      setBoard(s, c.board, c.fetchedAt)
    }
    s.screen = screenFor(s)
  }

  // claude mcp get answers slowly, so the answer is kept a day.
  async function checkMcp(force = false): Promise<void> {
    if (!force && mcp && io.now() - mcp.at < DAY) return
    const cmd = [io.claude(), 'mcp', 'get', 'atlassian']
    const r = await io.run(cmd, { timeout: 20000 })
    mcp = { ok: r.ok, at: io.now() }
    s.setup.mcp = r.ok
    log.info('mcp checked', { ok: r.ok, exit: r.exit })
    saveCache()
    io.draw()
  }

  // Settings or .env may have changed while the popup was closed or $EDITOR
  // was open.
  function reread(): void {
    const fresh = setupOf(io, s.setup.mcp)
    const boardChanged = fresh.board !== s.setup.board
    s.setup = { ...fresh, check: boardChanged ? { state: 'idle' } : s.setup.check }
    s.prefs = prefsOf(io.settings())
    if (boardChanged) {
      s.board = null
      s.fetchedAt = 0
    }
  }

  // The setup screen's r: .env and Settings read again, then one /myself call
  // once the three .env values are there.
  async function check(): Promise<void> {
    reread()
    void checkMcp()
    const e = s.setup.env
    if (!e.JIRA_SITE || !e.JIRA_EMAIL || !e.JIRA_API_TOKEN) {
      s.screen = screenFor(s)
      return io.draw()
    }
    s.setup.check = { state: 'running' }
    s.screen = screenFor(s)
    io.draw()
    const r = await tracker().me()
    if (r.ok) {
      s.me = r.value
      s.setup.check = { state: 'ok', name: r.value.name }
      log.info('setup checked', { ok: true })
    } else {
      s.setup.check = { state: 'failed', why: r.why, err: r.err }
      log.warn('setup check failed', { why: r.why, err: r.err })
    }
    s.screen = screenFor(s)
    io.draw()
  }

  let busy = false
  async function refresh({ fresh = false, reconcile = [] as string[] } = {}): Promise<void> {
    if (busy) return
    reread()
    if (screenFor(s) === 'setup' && !s.board) {
      s.screen = 'setup'
      return
    }
    busy = true
    s.fetch = { ...s.fetch, state: 'loading' }
    io.draw()
    try {
      const tr = tracker()
      if (!s.me) {
        const me = await tr.me()
        if (me.ok) s.me = me.value
      }
      const r = await tr.board({ fresh, reconcile })
      if (r.ok) {
        setBoard(s, r.value, io.now())
        if (s.setup.check.state !== 'ok') s.setup.check = { state: 'ok', name: s.me?.name ?? '' }
        saveCache()
      } else {
        s.fetch = { state: 'failed', why: r.why, err: r.err, retryAfter: r.retryAfter, at: io.now() }
        if (r.why === 'auth' && !s.board) s.setup.check = { state: 'failed', why: r.why, err: r.err }
      }
    } finally {
      busy = false
      s.screen = screenFor(s)
      io.draw()
    }
  }

  async function search(query: string): Promise<void> {
    const r = await tracker().boards(query)
    const p = s.picker
    if (!p || p.searched !== query) return
    if (r.ok) Object.assign(p, { state: 'ok', boards: r.value, sel: 0, err: undefined, why: undefined })
    else Object.assign(p, { state: 'failed', boards: [], err: r.err, why: r.why })
    io.draw()
  }

  function pick(board: BoardChoice, query: string): void {
    try {
      io.setSetting('jira.board', board.id)
      if (!s.setup.team) io.setSetting('jira.team', query || board.name)
    } catch (err) {
      log.error('board not saved', { id: board.id, err: errorMessage(err) })
      s.note = { text: t('tickets.notes.notSaved', { err: errorMessage(err) }), tone: 'bad' }
      return
    }
    log.info('board picked', { id: board.id, project: board.project })
    s.picker = null
    s.board = null
    s.fetchedAt = 0
    s.firstCol = 0
    s.note = { text: t('tickets.notes.boardPicked', { name: board.name }), tone: 'ok' }
    void refresh({ fresh: true })
  }

  function open(url: string, key: string): void {
    const child = io.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
    child.on('error', err => {
      log.warn('ticket not opened', { id: key, err: err.message })
      s.note = { text: t('tickets.notes.noOpener'), tone: 'bad' }
      io.draw()
    })
    child.unref()
    log.info('ticket opened', { id: key })
    s.note = { text: t('tickets.notes.opened', { key }), tone: 'ok' }
  }

  // claude --bg prints the job's id and returns once the agent runs: '' then,
  // or what went wrong.
  function spawnBg(spec: TicketSpec, key: string): Promise<{ err: string; name: string }> {
    const plan = launch(spec)
    return new Promise(done => {
      let out = ''
      const ms = io.now()
      const child = io.spawn(io.claude(), plan.argv.slice(1), { cwd: spec.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout?.on('data', (b: Buffer) => (out += b))
      child.stderr?.on('data', (b: Buffer) => (out += b))
      child.on('error', err => {
        log.error('agent not started', { id: key, err: err.message })
        done({ err: err.message, name: plan.name })
      })
      child.on('close', code => {
        const said = out.trim().split('\n')[0]?.slice(0, 160) ?? ''
        if (code === 0) log.info('agent started', { id: key, name: plan.name, cwd: spec.cwd, model: spec.model, effort: spec.effort, ms: io.now() - ms })
        else log.error('agent not started', { id: key, exit: code, err: said })
        done({ err: code === 0 ? '' : said || `exit ${code}`, name: plan.name })
      })
      child.unref()
    })
  }

  // The repo the ticket belongs in, so its agent's sandbox covers that repo
  // alone. null when the finder isn't sure: the agent then starts in the
  // folder and looks itself.
  async function findRepo(tr: Tracker, ticket: Ticket, folder: string, v: Settings): Promise<string | null> {
    s.note = { text: t('tickets.notes.findingRepo', { key: ticket.key }), tone: 'working' }
    io.draw()
    const more = await tr.details(ticket.key)
    const opts = { model: v['locate.model'], effort: v['locate.effort'], timeoutSecs: v['locate.timeoutSecs'], depth: v['locate.depth'] }
    const found = await locate({ id: ticket.key, work: scoutText(ticket, more.ok ? more.value : null), root: folder }, opts, io.claude(), io.run, io.now)
    return found.ok && found.sure ? found.repo : null
  }

  async function startAgent(ticket: Ticket): Promise<void> {
    if (!io.plugin()) {
      s.note = { text: pluginMissing(), tone: 'bad' }
      return
    }
    const b = s.board
    if (!b) return
    const tr = tracker()
    if (!s.me) {
      const me = await tr.me()
      if (!me.ok) {
        s.note = { text: t('tickets.notes.noMe', { err: me.err }), tone: 'bad' }
        return io.draw()
      }
      s.me = me.value
    }
    const v = io.settings()
    const folder = v['tickets.folder'] ? v['tickets.folder'].replace(/^~(?=\/|$)/, process.env.HOME ?? '~') : defaultFolder(v)
    const facts = handoffFacts(tr.id, configOf(io.env(), v).site, ticket, s.me, b)
    const repo = v['tickets.findRepo'] ? await findRepo(tr, ticket, folder, v) : null
    const cwd = repo ?? folder
    const spec: TicketSpec = {
      kind: 'ticket',
      cwd,
      model: v['tickets.handoff.model'],
      mode: v['tickets.handoff.mode'],
      effort: v['tickets.handoff.effort'],
      sandbox: v['tickets.handoff.sandbox'],
      url: ticket.url,
      lines: [...factLines(facts), repo ? `Repo: ${tilde(repo)}` : `Folder: ${tilde(folder)}`],
      name: `${ticket.key}-${slug(ticket.title)}`.slice(0, 60),
    }
    s.note = { text: t('tickets.notes.starting', { key: ticket.key }), tone: 'working' }
    io.draw()
    const { err, name } = await spawnBg(spec, ticket.key)
    if (err) {
      // Trusting a folder doesn't cover the git repos inside it, so the
      // first agent in a repo the finder picked can meet this.
      const untrusted = /Workspace not trusted/i.test(err)
      s.note = { text: untrusted ? t('tickets.notes.untrusted', { key: ticket.key, dir: tilde(cwd) }) : t('tickets.notes.startFailed', { key: ticket.key, err }), tone: 'bad' }
      return io.draw()
    }
    s.links[ticket.key] = { name, at: io.now() }
    saveLinks()
    s.agents = io.agents() ?? s.agents
    s.note = { text: t('tickets.notes.started', { key: ticket.key }), tone: 'working' }
    io.draw()
    // The agent assigns and moves the ticket through the MCP; search lags a
    // write, so these ask Jira to reconcile it.
    const id = ticket.key
    for (const ms of [30_000, 120_000]) io.later(() => void refresh({ reconcile: [id] }), ms)
  }

  async function goTo(agent: Agent, key: string): Promise<void> {
    const shown = await io.go(agent, where.layout)
    log.info('agent opened', { id: key, ok: shown.ok })
    if (shown.ok) return io.quit()
    s.note = { text: shown.message || t('tickets.notes.notOpened'), tone: 'bad' }
    io.draw()
  }

  // Settings can't open over this popup (tmux has one popup a client), so it
  // opens once this one has closed.
  function settings(): void {
    const script = bin('ghostty-settings')
    const child = io.spawn('sh', ['-c', 'sleep 0.3; exec "$0" "$1" tickets', script, where.client], { detached: true, stdio: 'ignore' })
    child.on('error', err => log.warn('settings not opened', { err: err.message }))
    child.unref()
    log.info('settings asked', { client: where.client })
    io.quit()
  }

  // .env from its example when there's none yet, kept to you alone.
  function editEnv(): void {
    const file = io.envFile
    try {
      const example = join(dirname(file), '.env.example')
      if (!existsSync(file) && existsSync(example)) {
        copyFileSync(example, file)
        chmodSync(file, 0o600)
      }
    } catch (err) {
      log.warn('env not copied', { path: file, err: errorMessage(err) })
    }
    const editor = process.env.VISUAL || process.env.EDITOR || 'nano'
    const r = io.outside(editor, [file])
    if (r.error) {
      log.warn('editor not run', { cmd: [editor], err: r.error.message })
      s.note = { text: t('tickets.notes.noEditor', { editor }), tone: 'bad' }
    }
    void check().then(() => refresh())
  }

  return {
    load,
    check,
    refresh,
    checkMcp,
    agents(): void {
      const a = io.agents()
      if (a) s.agents = a
    },
    async run(act: Act | null): Promise<void> {
      if (!act) return
      switch (act.do) {
        case 'open':
          return open(act.url, act.key)
        case 'start':
          return startAgent(act.ticket)
        case 'go':
          return goTo(act.agent, act.key)
        case 'refresh':
          return refresh({ fresh: true })
        case 'settings':
          return settings()
        case 'env':
          return editEnv()
        case 'check':
          return check()
        case 'search':
          return search(act.query)
        case 'pick':
          return pick(act.board, act.query)
        case 'quit':
          return io.quit()
      }
    },
  }
}
