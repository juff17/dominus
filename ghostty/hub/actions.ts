// What the hub's keys do to the world: answer a permission prompt, close an
// agent, stop a monitor, and New agent (the form in a popup, then starting
// what it returns). Everything they touch comes in as deps, so tests can run
// them with a fake tmux and claude (actions.test.ts).

import { spawn as spawnProc } from 'node:child_process'
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { type CloseHow, type Monitored, closeQuestion, shq } from './board.ts'
import type { HubLog, OpenTarget, Say } from './peek.ts'
import type { Tmux } from '../core/tmux.ts'
import { type Agent, type LaunchSpec, type Proc, launch, monitorsOf, permissionTool, watches } from '../agents/model.ts'
import { processes, stopMonitor as stopMonitorProcess } from '../agents/stop.ts'
import { markStopped as markStoppedIn } from '../agents/client.ts'
import { type Fields, errCode, errorMessage } from '../core/log.ts'
import { CLAUDE_DIR, RUN, conf } from '../core/paths.ts'
import { t } from '../core/text.ts'
import { type RunResult, type Runner, run as runProc } from '../core/proc.ts'
import { load as settings, set as setSettingIn } from '../settings/settings.ts'
import { P, clean } from '../tui/term.ts'
import { startBg } from '../agents/launch.ts'
import { answerKey, promptShown, sessionWaiting } from '../agents/permission.ts'

// The setting that turns a question off, when it can be ("don't ask again").
export type AskSetting = 'hub.askStopMonitor'
// A question for the footer: pressing its key again runs `yes`.
export type Question = { text: string; yes: () => unknown; skip?: AskSetting }
// A question as the hub holds it: `key` is the key that asked it.
export type Asked = Question & { key: string }

// What start reads of a spawned claude --bg.
export type Child = {
  stdout: Readable
  stderr: Readable
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  unref(): void
}
export type SpawnOptions = { cwd: string; detached: boolean; stdio: ['ignore', 'pipe', 'pipe'] }
export type Spawn = (cmd: string, args: string[], opts: SpawnOptions) => Child

export type ActionsDeps = {
  outer: Tmux
  tabs: Tmux
  say: Say
  noteMs: () => number
  openSession: (a: OpenTarget) => Promise<void>
  // The latest agents from agentd, for checking a question still holds when
  // it's answered.
  agents: () => Agent[]
  // The selected agent's folder, where New agent starts.
  focusedFolder: () => string
  recents: () => string[]
  remember: (dir: string) => void
  // HUB_WIN, the Ghostty window; 0 outside a layout.
  win: number
  CONF: string
  claude: string
  log: HubLog
  // For tests:
  run?: Runner
  spawn?: Spawn
  processes?: () => Proc[]
  kill?: (pid: number, signal: NodeJS.Signals) => unknown
  markStopped?: (id: string, task: string, command: string) => void
  setSetting?: (key: AskSetting, value: boolean) => unknown
  askStopMonitor?: () => boolean
  // Settings › New agent › Run in the sandbox.
  sandbox?: () => boolean
  claudeDir?: string
  resultFile?: string
  env?: Record<string, string | undefined>
  now?: () => number
}
// `answered`: the screen each agent's last permission answer went to.
type State = {
  answering: Set<string>
  answered: Map<string, { screen: string; at: number }>
  asking: boolean
}
type Ctx = Required<ActionsDeps> & { state: State }

export type Actions = {
  answer(a: Agent | null, allow: boolean): Promise<void>
  closeAgent(a: Agent | null, place: string | null, before?: () => unknown): Question | null
  restart(a: Agent | null): Promise<void>
  restartAll(): Question | null
  stopMonitor(m: Monitored): Question | null
  dontAsk(key: AskSetting): void
  newAgent(): Promise<void>
  start(spec: LaunchSpec): Promise<void>
  adoptResult(): Promise<void>
}

// The processes on the machine, for finding a monitor's (agents/stop.ts).
export { processes }

const missing = (err: unknown) => errCode(err) === 'ENOENT'
// An error's code (EPERM) when it has one, for a footer note.
const codeOf = (err: unknown) => String(errCode(err) ?? errorMessage(err))

// Whether the file went; one that was never there counts.
function drop(path: string, log: Pick<HubLog, 'warn'>): boolean {
  try {
    unlinkSync(path)
    return true
  } catch (err) {
    if (!missing(err)) log.warn('new agent result not removed', { path, err })
    return missing(err)
  }
}

// A result older than this was left by a hub long gone (its pane closed, or
// named after a pid as results once were), and is no choice made now.
const RESULT_STALE_MS = 10 * 60_000

// A hub's New agent form writes its result named after the hub's pane
// (resultPath), which the next hub in that pane picks up (adoptResult). A
// result exists only from the form's write to that read, so one long left
// in `dir` has no hub to read it, and a hub starting removes those.
export function pruneResults(dir: string, now: number, log: Pick<HubLog, 'info' | 'warn'>): void {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch (err) {
    if (!missing(err)) log.warn('run folder unreadable', { path: dir, err })
    return
  }
  for (const name of names) {
    if (!/^new-agent-\d+\.json$/.test(name)) continue
    const path = join(dir, name)
    let age: number
    try {
      age = now - statSync(path).mtimeMs
    } catch (err) {
      if (!missing(err)) log.warn('new agent result unreadable', { path, err })
      continue
    }
    if (age >= RESULT_STALE_MS && drop(path, log)) log.info('stale new agent result removed', { path, ageMs: Math.round(age) })
  }
}

// ------------------------------------------------------------ answer

// a and d answer a permission prompt by pressing its keys in the agent's
// pane: 1 for Yes, Esc for No. Only while Claude says it's waiting right now
// and the dialog at the bottom of its screen is for the card's tool call
// (showsPermission), so a key never lands in Claude's input box, cancels a
// running turn or answers another dialog because the board was a second old.
async function answer(c: Ctx, a: Agent | null, allow: boolean): Promise<void> {
  const answered = (fields: Fields) => c.log.info('permission answered', { id: a?.id, allow, ...fields })
  if (a?.need !== 'permission') {
    answered({ ok: false, reason: 'not a permission prompt' })
    return c.say(t('hub.notes.answerKeys'), P.sub)
  }
  if (!a.pane) {
    answered({ ok: false, reason: 'background agent' })
    return c.say(t('hub.notes.openToAnswer', { key: '↵' }), P.peach)
  }
  // A double tap, or key repeat, sends a second press while the first is
  // still checking: both would see the prompt and both press, and the
  // second key answers the next prompt unseen or lands in the input box.
  const { answering } = c.state
  if (answering.has(a.id)) return answered({ ok: false, reason: 'already answering' })
  answering.add(a.id)
  try {
    await press(c, a, a.pane.pane, allow, answered)
  } finally {
    answering.delete(a.id)
  }
}

// How long a prompt that was answered still counts as answered while its
// screen hasn't changed: Claude redraws well within it once it takes the
// key, so a screen the same after that means the key was lost, and a press
// then may try again.
const ANSWER_SETTLE_MS = 2000

async function press(c: Ctx, a: Agent, pane: string, allow: boolean, answered: (fields: Fields) => void): Promise<void> {
  const { screen, why } = await promptShown(c.tabs, pane, a.cmd, sessionWaiting(c.claudeDir, a, c.log))
  if (why) {
    answered({ ok: false, reason: why })
    return c.say(t('hub.notes.noPrompt', { title: a.title }), P.peach)
  }
  // The prompt just answered, not yet redrawn away; the session file lags
  // the screen too, so it can't tell.
  const last = c.state.answered.get(a.id)
  if (last && last.screen === screen && c.now() - last.at < ANSWER_SETTLE_MS) return answered({ ok: false, reason: 'already answered' })
  const sent = await c.tabs('send-keys', '-t', pane, answerKey(allow))
  if (sent.ok) c.state.answered.set(a.id, { screen, at: c.now() })
  answered({ ok: sent.ok, ...(sent.ok ? {} : { err: sent.err }) })
  const what = permissionTool(a.cmd)
  if (!sent.ok) return c.say(t(allow ? 'hub.notes.allowFailed' : 'hub.notes.denyFailed', { what, err: clean(sent.err).trim().slice(0, 120) }), P.red, c.noteMs())
  c.say(t(allow ? 'hub.notes.allowed' : 'hub.notes.denied', { what }), allow ? P.green : P.peach)
}

// ------------------------------------------------------------ close

// x closes a done or idle agent, stopped with its conversation kept
// (`claude attach <id>` resumes it). A tab parked on a background job loses
// the job first, so the tab isn't left showing a job that's still running.
// The card leaves once agentd sees it gone. `before` runs once y is sure to
// close, ahead of the close itself.
function closeAgent(c: Ctx, a: Agent | null, place: string | null, before?: () => unknown): Question | null {
  if (!a) return null
  const q = closeQuestion(a, place ?? '')
  if (q.refuse !== undefined) {
    c.say(q.refuse, P.sub)
    return null
  }
  const done = (r: RunResult, what = '') => {
    c.log.info('agent closed', { id: a.id, how: q.how, ok: r.ok, ...(r.ok ? {} : { err: r.err }) })
    c.say(r.ok ? what : t('hub.notes.closeFailed', { title: a.title, err: clean(r.err).slice(0, 120) }), r.ok ? P.green : P.red, c.noteMs())
  }
  const words = { place: place ?? '', title: a.title, resume: `claude attach ${a.jobId}` }
  // closeQuestion only offers a way the agent has: a tab its pane, a job its id.
  const stopJob = () => c.run([c.claude, 'stop', a.jobId!])
  // Through ghostty-tabs (close_tab in bin/lib/tabs.sh) rather than a bare
  // kill-window: a workspace whose only tab this was gets a fresh one first
  // (`keep`), so closing a Claude tab from the hub never closes the window.
  const killTab = () => c.run([join(c.CONF, 'bin', 'ghostty-tabs'), '--close', a.pane!.session, a.pane!.window, 'keep'])
  const yes = {
    'tab+job': async () => {
      const stop = await stopJob()
      if (!stop.ok) return done(stop)
      done(await killTab(), t('hub.notes.closedTabJob', words))
    },
    tab: async () => done(await killTab(), t('hub.notes.closedTab', words)),
    job: async () => done(await stopJob(), t('hub.notes.stoppedJob', words)),
  }[q.how]
  return {
    text: q.text,
    yes: async () => {
      if (!stillCloses(c, a, q.how, place)) return
      await before?.()
      await yes()
    },
  }
}

// A stopped background agent (agents/stopped.ts) comes back from its saved
// conversation; agentd's next scan finds its process and moves its card on.
async function restartJob(c: Ctx, a: Agent): Promise<RunResult> {
  const r = await c.run([c.claude, 'respawn', a.jobId!])
  c.log.info('agent restarted', { id: a.jobId, title: a.title, ok: r.ok, ...(r.ok ? {} : { err: r.err }) })
  return r
}

async function restart(c: Ctx, a: Agent | null): Promise<void> {
  if (!a) return
  if (!a.stopped || !a.jobId) return c.say(t('hub.notes.notStopped', { title: a.title }), P.sub)
  c.say(t('hub.notes.restarting', { title: a.title }), P.sub)
  const r = await restartJob(c, a)
  if (r.ok) c.say(t('hub.notes.restarted', { title: a.title }), P.green, c.noteMs())
  else c.say(t('hub.notes.restartFailed', { title: a.title, err: clean(r.err).trim().slice(0, 120) }), P.red, c.noteMs())
}

// One at a time, so the note can say how many came back.
function restartAll(c: Ctx): Question | null {
  // As the board shows them: a monitor's session is in no lane.
  const stopped = c.agents().filter(a => a.stopped && a.jobId && !watches(a))
  if (!stopped.length) {
    c.say(t('hub.notes.noneStopped'), P.sub)
    return null
  }
  const yes = async () => {
    // Only those still stopped when you answer.
    const still = c.agents().filter(a => a.stopped && a.jobId && stopped.some(s => s.id === a.id))
    let ok = 0
    for (const a of still) if ((await restartJob(c, a)).ok) ok++
    c.say(t('hub.notes.restartedAll', { ok, n: still.length }), ok === still.length ? P.green : P.red, c.noteMs())
  }
  return { text: t('hub.notes.restartAllAsk', { n: stopped.length }), yes }
}

// The question waits in the footer for the next key, which can be minutes:
// meanwhile a monitor's event can start a new turn, or the agent can go. So
// y closes only an agent that would still be asked the same: there, Done or
// Idle, and on the same tab and job the question named.
function stillCloses(c: Ctx, a: Agent, how: CloseHow, place: string | null): boolean {
  const now = c.agents().find(x => x.id === a.id)
  const again = now ? closeQuestion(now, place ?? '') : null
  if (now && again?.how === how && now.pane?.window === a.pane?.window && now.jobId === a.jobId) return true
  const reason = !now ? 'gone' : again?.refuse !== undefined ? 'busy' : 'changed'
  c.log.info('agent closed', { id: a.id, how, ok: false, reason })
  // One that's gone has left the board already, which says enough.
  if (again?.refuse !== undefined) c.say(again.refuse, P.sub)
  return false
}

// ------------------------------------------------------------ stop monitor

// x on a monitor stops only that monitor: it ends the monitor's own process
// group, which leaves the session and its other monitors running. The
// session sees only that its watcher died and re-arms it, so markStopped
// leaves word for the re-armed watcher to say the user stopped it.
function stopMonitor(c: Ctx, m: Monitored): Question | null {
  const words = { name: clean(m.description), title: m.agent.title }
  if (m.state === 'ended') {
    c.say(t('hub.notes.monitorEnded', words), P.sub)
    return null
  }
  // The monitor as agentd has it when y comes, which can be minutes after
  // x: it may have ended, or its session restarted under a new pid, which
  // finding its process goes by. One no longer listed is left to that
  // search, which says when it finds nothing.
  const stop = () => {
    const now = monitorsOf(c.agents()).find(x => x.key === m.key) ?? m
    if (now.state === 'ended') {
      c.log.info('monitor stopped', { id: m.agent.id, task: m.task, ok: false, reason: 'ended' })
      return c.say(t('hub.notes.monitorEnded', words), P.sub)
    }
    killMonitor(c, now, words)
  }
  if (!c.askStopMonitor()) {
    stop()
    return null
  }
  return { text: t('hub.notes.stopMonitorAsk', words), yes: stop, skip: 'hub.askStopMonitor' }
}

function killMonitor(c: Ctx, m: Monitored, words: { name: string; title: string }) {
  const stopped = (fields: Fields) => c.log.info('monitor stopped', { id: m.agent.id, task: m.task, ...fields })
  const r = stopMonitorProcess(m, c)
  if (r.unreadable !== undefined) c.log.warn('processes unreadable', { err: r.unreadable })
  if (r.ok) {
    stopped({ ok: true, pid: r.pid, group: r.group })
    return c.say(t('hub.notes.monitorStopped', words), P.green, c.noteMs())
  }
  if (r.reason === 'no process') {
    stopped({ ok: false, reason: 'no process' })
    return c.say(t('hub.notes.monitorNoProcess', words), P.peach, c.noteMs())
  }
  stopped({ ok: false, pid: r.pid, err: errorMessage(r.err) })
  c.say(t('hub.notes.monitorStopFailed', { ...words, err: codeOf(r.err) }), P.red, c.noteMs())
}

// "Don't ask again" turns the question's setting off, which Settings can
// turn back on.
function dontAsk(c: Ctx, key: AskSetting): void {
  try {
    c.setSetting(key, false)
  } catch (err) {
    c.log.warn('setting not saved', { key, err })
    c.say(t('hub.notes.choiceNotSaved', { err: codeOf(err) }), P.red, c.noteMs())
  }
}

// ------------------------------------------------------------ new agent

// The form runs as an overlay over the whole window (newagent.ts,
// tui/overlay.ts), so it has room beside an open session as well as over the
// board. It writes what you chose to a file; the hub starts the agent from
// that.
async function askForm(c: Ctx): Promise<LaunchSpec | null> {
  const result = c.resultFile
  drop(result, c.log)
  const under = await windowOf(c)
  const opts = JSON.stringify({ folder: c.focusedFolder(), recents: c.recents() })
  // ghostty-backdrop draws the window dimmed while Node loads the form, and
  // the popup's own background is the dimmed window's until it does.
  const cmd = [conf('bin/ghostty-backdrop'), process.execPath, conf('hub/newagent/newagent.ts'), result, opts].map(shq).join(' ')
  // display-popup returns once the popup closes.
  const shown = await c.outer(
    'display-popup', '-E', '-B', '-t', c.env.TMUX_PANE ?? '', '-w', '100%', '-h', '100%',
    '-s', `bg=${P.crust}`, '-e', `OV_UNDER=${under}`, cmd,
  )
  if (!shown.ok) {
    c.log.info('new agent form closed', { ok: false, err: shown.err })
    c.say(t('hub.notes.newAgentFailed', { err: clean(shown.err).slice(0, 120) }), P.red)
    return null
  }
  const spec = readResult(c, result)
  drop(result, c.log)
  c.log.info('new agent form closed', { ok: true, chose: Boolean(spec) })
  return spec
}

// The hub's window, which the form's overlay dims behind its frame; none
// when tmux won't say, and the overlay is then drawn on a blank screen.
async function windowOf(c: Ctx): Promise<string> {
  const r = await c.outer('display', '-p', '-t', c.env.TMUX_PANE ?? '', '#{window_id}')
  return r.ok ? r.out.trim() : ''
}

// No file is Esc: nothing chosen.
function readResult(c: Ctx, path: string): LaunchSpec | null {
  try {
    const spec: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (isLaunchSpec(spec)) return spec
    c.log.warn('new agent result unreadable', { path, err: 'not a launch spec' })
  } catch (err) {
    if (!missing(err)) c.log.warn('new agent result unreadable', { path, err })
  }
  return null
}

// The form's result is a task in a folder; launch() reads the rest as
// optional. Monitors start from Alt+M, never from here.
function isLaunchSpec(v: unknown): v is LaunchSpec {
  return typeof v === 'object' && v !== null && 'cwd' in v && typeof v.cwd === 'string' && 'kind' in v && v.kind === 'task'
}

async function newAgent(c: Ctx): Promise<void> {
  if (c.state.asking) return
  if (!c.env.TMUX) return c.say(t('hub.notes.noTmuxNewAgent'), P.red)
  c.state.asking = true
  try {
    const spec = await askForm(c)
    if (spec) await start(c, spec)
  } finally {
    c.state.asking = false
  }
}

// The form's file, named after the hub's pane rather than its process: the
// popup belongs to tmux and outlives a hub that crashes while it's up, and
// the hub the restart loop starts in the same pane is then the one to read
// it.
export const resultPath = (env: Record<string, string | undefined>, dir = RUN): string =>
  join(dir, `new-agent-${env.TMUX_PANE?.replace(/\D/g, '') || process.pid}.json`)

// A result younger than this may still be being written.
const RESULT_SETTLE_MS = 500

// On the hub's tick: a result no form of this hub is waiting on was written
// for the hub before it, which a restart replaced while its form was up.
// It's started as that hub would have; without this the choice was lost
// with no word.
async function adoptResult(c: Ctx): Promise<void> {
  if (c.state.asking || !c.env.TMUX) return
  const path = c.resultFile
  let age: number
  try {
    age = c.now() - statSync(path).mtimeMs
  } catch (err) {
    if (!missing(err)) c.log.warn('new agent result unreadable', { path, err })
    return
  }
  if (age < RESULT_SETTLE_MS) return
  // So n, or the next tick, waits until this one's started.
  c.state.asking = true
  try {
    const stale = age >= RESULT_STALE_MS
    const spec = stale ? null : readResult(c, path)
    drop(path, c.log)
    if (stale) return c.log.info('stale new agent result removed', { path, ageMs: Math.round(age) })
    c.log.info('new agent result adopted', { path, chose: Boolean(spec) })
    if (spec) await start(c, spec)
  } finally {
    c.state.asking = false
  }
}

// claude --bg prints the job's id and returns; the footer says it's starting
// until then.
async function start(c: Ctx, spec: LaunchSpec): Promise<void> {
  const plan = launch(spec.kind === 'task' ? { ...spec, sandbox: c.sandbox() } : spec)
  c.remember(spec.cwd)
  const started = (fields: Fields) => c.log.info('agent started', { kind: spec.kind, name: plan.name, ...fields })
  c.say(t('hub.notes.startingBg', { name: plan.name }), P.sub, 30000)
  const argv = plan.argv.slice(1)
  // The prompt can be pages long; the log has the rest of the command.
  const cmd = [c.claude, ...argv.slice(0, -1), '<prompt>']
  // Not awaited: the footer says it's starting until claude returns.
  void startBg(c.spawn, c.claude, plan, spec.cwd).then(({ exit, out: said, error }) => {
    if (error) {
      started({ ok: false, cmd, err: error.message })
      return c.say(t('hub.notes.startFailed', { err: error.message }), P.red)
    }
    const out = clean(said).trim()
    started({ ok: exit === 0, exit, ...(exit === 0 ? {} : { cmd, err: out.slice(0, 200) }) })
    if (exit === 0) c.say(t('hub.notes.startedBg', { name: plan.name, out: out.slice(0, 60) }), P.green, c.noteMs())
    else c.say(t('hub.notes.bgFailed', { err: out.slice(0, 120) }), P.red, c.noteMs())
  })
}

export function actionsOf(deps: ActionsDeps): Actions {
  const c: Ctx = {
    run: runProc,
    spawn: (cmd, args, opts) => spawnProc(cmd, args, opts),
    processes,
    kill: (pid, signal) => process.kill(pid, signal),
    markStopped: markStoppedIn,
    setSetting: setSettingIn,
    askStopMonitor: () => settings()['hub.askStopMonitor'],
    sandbox: () => settings()['newAgent.task.sandbox'],
    claudeDir: CLAUDE_DIR,
    resultFile: resultPath(deps.env ?? process.env),
    env: process.env,
    now: Date.now,
    ...deps,
    // `asking`: whether the form is up, so a second n while it is does nothing.
    state: { answering: new Set(), answered: new Map(), asking: false },
  }
  return {
    answer: (a, allow) => answer(c, a, allow),
    closeAgent: (a, place, before) => closeAgent(c, a, place, before),
    restart: a => restart(c, a),
    restartAll: () => restartAll(c),
    stopMonitor: m => stopMonitor(c, m),
    dontAsk: key => dontAsk(c, key),
    newAgent: () => newAgent(c),
    start: spec => start(c, spec),
    adoptResult: () => adoptResult(c),
  }
}
