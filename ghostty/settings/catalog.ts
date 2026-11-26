// Every setting, in the sections the Settings panel shows them in: a row's
// key, type, values and default (rows.ts builds them). The store
// (settings.ts) checks values against these rows.

import { FILER_MODELS, MODEL_IDS, type ModelId } from './models.ts'
import { type Mode, type Section, type SectionRow, type SectionWords, T, alias, bool, choice, define, envLine, file, fixed, flags, head, hosts, isSetting, keybind, list, modes, number, prompt, textRow } from './rows.ts'

// The viewer pane's modes (bin/ghostty-viewer): these four, and any you add,
// which run a command of yours in the pane and have an id that starts with x-.
const BUILTIN_IDS = ['files', 'diff', 'todo', 'diagrams'] as const
export type BuiltinMode = { id: (typeof BUILTIN_IDS)[number]; name: string; sub: string }
export const BUILTIN_MODES: BuiltinMode[] = BUILTIN_IDS.map(id => ({ id, name: T.modes?.[id]?.name ?? id, sub: T.modes?.[id]?.sub ?? '' }))
export const BUILTIN = new Map<string, BuiltinMode>(BUILTIN_MODES.map(m => [m.id, m]))
export const isAdded = (id: string): boolean => /^x-[a-z0-9-]{1,40}$/.test(id)
// The id stands in only for a mode no check let through.
export const modeName = (m: Mode): string => BUILTIN.get(m.id)?.name ?? m.name ?? m.id

const MODEL = ['default', ...MODEL_IDS] as const
const MODE = ['default', 'auto', 'acceptEdits', 'plan'] as const
const EFFORT = ['default', 'low', 'medium', 'high', 'xhigh'] as const
const ASK = ['ask', 'auto'] as const
const OFF_ON = ['off', 'on'] as const
const TRAY_SECTIONS = ['you', 'broke', 'work', 'watch', 'done']
const SOUNDS = ['message-new-instant', 'bell', 'complete', 'dialog-warning', 'message', 'custom'] as const
const agent = <P extends string>(prefix: P, model: ModelId) => [
  choice(`${prefix}.model`, MODEL, model),
  choice(`${prefix}.mode`, MODE, 'auto'),
  choice(`${prefix}.effort`, EFFORT, 'medium'),
  choice(`${prefix}.chrome`, OFF_ON, 'off'),
]
// The drawer's watch toggles and when a monitor stops (viewer/monitors/attach.ts
// has the same lists, which a test holds to these).
const WATCH = ['pipeline', 'comments', 'rebase', 'ping']
const UNTIL = ['merged', 'pipeline', '8h', '24h'] as const
// A project as host/group/…/name; a ref pattern (glob, or "default branch");
// an environment's name; one as a pattern.
const PROJECT = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(\/[\w.-]+){2,}$/i
const REF = /^(default branch|[\w./*+-]+)$/
const ENV = /^[\w.-]+$/
const ENV_GLOB = /^[\w.*?-]+$/
const EVENTS = ['failed', 'manual', 'stuck', 'conflict', 'error', 'crash', 'auth', 'setup', 'blocked']
const BROKE = ['failed', 'stuck', 'conflict', 'error', 'crash']
// A Jira board's id, a Team field's UUID, a site's cloud id.
const DIGITS = /^\d{1,12}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLOUD_ID = /^[\w-]{8,64}$/

const DEFINED = [
  define('general', [head('folders'), file('general.folder', { dir: true })]),
  define('newAgent', [
    head('task'),
    ...agent('newAgent.task', 'opus'),
    choice('newAgent.task.branch', ['worktree', 'current'], 'worktree'),
    bool('newAgent.task.sandbox', false),
    bool('worktree.fetch', true),
    prompt('task'),
    head('folders'),
    number('newAgent.recent', 8, { min: 1, max: 8 }),
    choice('newAgent.rankBy', ['frecency', 'recent'], 'frecency'),
    bool('newAgent.gitOnly', true),
    choice('newAgent.defaultFolder', ['tab', 'projects'], 'tab'),
  ]),
  // A PR or log monitor's model and effort keep their newAgent.* keys from
  // when New agent started them, so saved values carry over; they're set
  // here only, and PR babysit and Log watcher keep the mode and Chrome.
  define('monitors', [
    head('prs'),
    hosts('monitors.githubHosts', 'gh', ['github.com']),
    hosts('monitors.gitlabHosts', 'glab', []),
    choice('monitors.startOn', ['mine', 'reviewer'], 'mine'),
    bool('monitors.drafts', true),
    number('monitors.refreshSecs', 60, { min: 15, max: 600, step: 15 }),
    flags('monitors.watch', WATCH, ['pipeline', 'comments', 'rebase']),
    choice('monitors.until', UNTIL, 'merged'),
    choice('newAgent.pr.model', MODEL, 'sonnet'),
    choice('newAgent.pr.effort', EFFORT, 'medium'),
    head('key'),
    alias('keys.monitors'),
    head('pipelines'),
    bool('monitors.pipelines.fromPrs', true),
    list('monitors.pipelines.projects', [], { item: PROJECT, max: 20 }),
    list('monitors.pipelines.refs', ['default branch', 'v*'], { item: REF }),
    choice('monitors.pipelines.keepFinished', ['6h', '24h', '3d', '7d', 'always'], '24h'),
    choice('monitors.pipelines.model', MODEL, 'haiku'),
    choice('monitors.pipelines.effort', EFFORT, 'low'),
    head('logs'),
    list('monitors.logs.envs', ['local', 'qa', 'stage', 'eu', 'ca', 'us'], { item: ENV, keep: ['local'] }),
    file('monitors.logs.kubeconfig'),
    list('monitors.logs.protected', [], { item: ENV_GLOB }),
    choice('monitors.logs.level', ['warn', 'error', 'info'], 'warn'),
    choice('monitors.logs.for', ['30m', '1h', '2h', '4h', '8h', '24h'], '2h'),
    choice('newAgent.logs.model', MODEL, 'haiku'),
    choice('newAgent.logs.effort', EFFORT, 'low'),
  ]),
  define('prBabysit', [
    head('agent'),
    choice('newAgent.pr.mode', MODE, 'auto'),
    choice('newAgent.pr.chrome', OFF_ON, 'off'),
    head('watcher'),
    number('prBabysit.interval', 60, { min: 15, max: 600, step: 15 }),
    number('prBabysit.stuckAfter', 30, { min: 5, max: 240, step: 5 }),
    number('prBabysit.errorAfter', 5, { min: 1, max: 20 }),
    bool('prBabysit.notifyStage', false),
    bool('prBabysit.autoFix', true),
    head('actOnItsOwn'),
    alias('approvals.push'),
    choice('prBabysit.autoRebase', ['off', 'clean', 'always'], 'off'),
    alias('approvals.reply'),
  ]),
  define('approvals', [
    head('autoApprove'),
    choice('approvals.retry', ASK, 'ask'),
    choice('approvals.move', ASK, 'ask'),
    choice('approvals.manual', ASK, 'ask'),
    choice('approvals.push', ASK, 'ask'),
    choice('approvals.reply', ['off', 'draft', 'post'], 'draft'),
    fixed('approveADeployment'),
    head('whenYouApprove'),
    choice('approvals.edited', ['post', 'confirm'], 'post'),
    choice('approvals.editor', ['editor', 'inline'], 'editor'),
    alias('keys.approvals'),
    bool('approvals.trayButtons', true),
  ]),
  define('logger', [
    head('agent'),
    choice('newAgent.logs.mode', MODE, 'auto'),
    choice('newAgent.logs.chrome', OFF_ON, 'off'),
    head('watcher'),
    number('logger.dedup', 120, { min: 0, max: 3600, step: 30 }),
    number('logger.floodLimit', 25, { min: 5, max: 200, step: 5 }),
    number('logger.traceLines', 15, { min: 0, max: 100, step: 5 }),
    number('logger.lineChars', 400, { min: 80, max: 2000, step: 40 }),
  ]),
  define('todo', [
    head('handOff'),
    choice('todo.handoff.model', MODEL_IDS, 'opus'),
    choice('todo.handoff.mode', MODE, 'auto'),
    choice('todo.handoff.effort', EFFORT, 'medium'),
    choice('todo.handoff.branch', ['worktree', 'branch'], 'worktree'),
    choice('todo.handoff.merge', ['ask', 'never'], 'ask'),
    bool('todo.handoff.sandbox', false),
    prompt('todo-handoff'),
    head('filing'),
    choice('todo.filing.model', FILER_MODELS, 'haiku'),
    choice('todo.filing.effort', ['low', 'medium', 'high'], 'medium'),
    number('todo.filing.limit', 3, { min: 1, max: 10 }),
    head('list'),
    number('todo.keepDone', 7, { min: 1, max: 60 }),
    number('todo.noteSecs', 4, { min: 2, max: 30 }),
  ]),
  // Alt+J. Its credentials are in .env (viewer/tickets/env.ts), shown here
  // only as set or missing.
  define('tickets', [
    head('tracker'),
    choice('tickets.provider', ['jira'], 'jira'),
    envLine('JIRA_SITE'),
    envLine('JIRA_EMAIL'),
    envLine('JIRA_API_TOKEN'),
    envLine('JIRA_TOKEN_KIND'),
    head('board'),
    textRow('jira.team', { max: 100 }),
    textRow('jira.board', { item: DIGITS }),
    textRow('jira.teamId', { item: UUID }),
    textRow('jira.cloudId', { item: CLOUD_ID }),
    number('tickets.refreshSecs', 60, { min: 30, max: 600, step: 15 }),
    bool('tickets.showDone', false),
    alias('keys.jira'),
    head('agents'),
    file('tickets.folder', { dir: true }),
    bool('tickets.findRepo', true),
    choice('tickets.handoff.model', MODEL_IDS, 'opus'),
    choice('tickets.handoff.mode', MODE, 'auto'),
    choice('tickets.handoff.effort', EFFORT, 'medium'),
    bool('tickets.handoff.sandbox', false),
    prompt('ticket'),
  ]),
  // The read-only claude -p that picks the repo an agent starts in
  // (agents/locate.ts), shared by whatever starts agents in a folder of repos.
  define('repoFinder', [
    head('scout'),
    choice('locate.model', MODEL_IDS, 'haiku'),
    choice('locate.effort', EFFORT, 'low'),
    number('locate.timeoutSecs', 90, { min: 15, max: 300, step: 15 }),
    number('locate.depth', 3, { min: 1, max: 5 }),
  ]),
  define('hub', [
    head('lanes'),
    number('hub.doneCards', 2, { min: 0, max: 6 }),
    bool('hub.idleLane', true),
    number('hub.listCols', 46, { min: 36, max: 80, step: 2 }),
    number('hub.boardCols', 96, { min: 60, max: 200, step: 4 }),
    number('hub.noteSecs', 8, { min: 2, max: 60 }),
    head('stopped'),
    bool('hub.restartStopped', false),
    head('monitors'),
    number('hub.monitorRows', 5, { min: 1, max: 5 }),
    number('hub.endedFor', 5, { min: 1, max: 60 }),
    number('hub.maxEvents', 20, { min: 5, max: 100, step: 5 }),
    bool('hub.askStopMonitor', true),
    flags('hub.attention', EVENTS, EVENTS),
    flags('hub.broke', BROKE, BROKE),
  ]),
  define('tray', [
    head('panelChip'),
    flags('tray.count', TRAY_SECTIONS, TRAY_SECTIONS),
    number('tray.flash', 2, { min: 0, max: 10 }),
    bool('tray.ring', true),
    fixed('shortcut'),
    number('tray.pollSecs', 2, { min: 1, max: 10 }),
    head('inbox'),
    number('tray.noteHours', 24, { min: 1, max: 168 }),
    bool('tray.foldDone', true),
    alias('approvals.trayButtons'),
    bool('tray.desktop', false),
    number('tray.messageSecs', 6, { min: 2, max: 30 }),
    number('tray.inboxWidth', 600, { min: 400, max: 1200, step: 50 }),
    number('tray.inboxHeight', 540, { min: 300, max: 2400, step: 60 }),
    head('sounds'),
    bool('tray.soundYou', false),
    bool('tray.soundBroke', false),
    choice('tray.sound', SOUNDS, 'message-new-instant'),
    file('tray.soundFile'),
    bool('tray.quiet', true),
    bool('tray.tabBell', true),
  ]),
  define('editor', [
    head('opening'),
    choice('editor.app', ['code', 'zed'], 'code'),
    choice('editor.window', ['default', 'new', 'reuse'], 'default'),
    choice('editor.open', ['root', 'folder'], 'root'),
  ]),
  define('workspace', [
    head('viewerModes'),
    modes(
      'workspace.modes',
      BUILTIN_MODES.map(m => ({ id: m.id, on: true })),
    ),
    head('startup'),
    choice('workspace.viewerShown', ['hidden', 'shown'], 'hidden'),
    choice('workspace.startMode', ['first', ...BUILTIN_MODES.map(m => [m.id, m.name] as const)], 'first'),
    head('whenAModeIsOff'),
    choice('workspace.popupsWhenOff', ['works', 'off'], 'works'),
  ]),
  define('layout', [
    head('window'),
    bool('layout.header', true),
    bool('layout.sidePanel', true),
    number('layout.railCols', 6, { min: 5, max: 12 }),
    number('layout.diagramsPercent', 85, { min: 50, max: 100, step: 5 }),
    number('layout.viewerPercent', 30, { min: 20, max: 70, step: 5 }),
    number('layout.topRows', 10, { min: 4, max: 30 }),
    head('popups'),
    number('layout.todoWidth', 70, { min: 40, max: 100, step: 5 }),
    number('layout.todoHeight', 75, { min: 40, max: 100, step: 5 }),
    number('layout.helpPercent', 80, { min: 40, max: 100, step: 5 }),
    number('layout.settingsPercent', 80, { min: 40, max: 100, step: 5 }),
  ]),
  define('viewers', [
    head('diagrams'),
    number('viewer.zoomStep', 15, { min: 5, max: 50, step: 5 }),
    number('viewer.panPercent', 20, { min: 5, max: 50, step: 5 }),
    number('viewer.maxZoom', 16, { min: 2, max: 32 }),
    head('diff'),
    number('viewer.scrollLines', 3, { min: 1, max: 20 }),
  ]),
  define('keys', [
    head('anywhere'),
    keybind('keys.help', 'alt', 'alt+h'),
    keybind('keys.todo', 'alt', 'alt+t'),
    keybind('keys.settings', 'alt', 'alt+s'),
    keybind('keys.diagrams', 'alt', 'alt+d'),
    keybind('keys.approvals', 'alt', 'alt+a'),
    keybind('keys.viewer', 'alt', 'alt+v'),
    keybind('keys.newAgent', 'alt', 'alt+n'),
    keybind('keys.editor', 'alt', 'alt+e'),
    keybind('keys.monitors', 'alt', 'alt+m'),
    keybind('keys.jira', 'alt', 'alt+j'),
    head('ghostty'),
    keybind('keys.workspace', 'ghostty', 'ctrl+shift+w', 'csi:9009~'),
    keybind('keys.hub', 'ghostty', 'ctrl+shift+a', 'csi:9007~'),
    keybind('keys.board', 'ghostty', 'ctrl+shift+b', 'csi:9008~'),
    keybind('keys.newTab', 'ghostty', 'ctrl+shift+t', 'csi:9001~'),
    keybind('keys.closeTab', 'ghostty', 'ctrl+shift+x', 'csi:9002~'),
    keybind('keys.newWindow', 'ghostty', 'ctrl+shift+n', 'new_window'),
  ]),
]

type Defined = (typeof DEFINED)[number]['rows'][number]
export type SettingRow = Extract<Defined, { key: string }>
export type SettingKey = SettingRow['key']
export type RowOf<K extends SettingKey> = Extract<SettingRow, { key: K }>
export type Settings = { readonly [K in SettingKey]: RowOf<K>['default'] }

export const ROWS: SettingRow[] = DEFINED.flatMap(s => s.rows.filter(isSetting))
export const BY_KEY = new Map<string, SettingRow>(ROWS.map(r => [r.key, r]))

// A key known to be one gets its own row's type; any other string may not
// be a setting.
export function row<K extends SettingKey>(key: K): RowOf<K>
export function row(key: string): SettingRow | undefined
export function row(key: string): SettingRow | undefined {
  return BY_KEY.get(key)
}

// An alias becomes its setting's row under the alias's own name, so both
// sections change the one value.
export function section(id: string, defs: readonly Defined[]): Section {
  const w = T.sections?.[id] ?? {}
  return { id, name: w.name ?? id, where: w.where ?? '', rows: defs.map(d => sectionRow(d, w)) }
}

function sectionRow(d: Defined, w: SectionWords): SectionRow {
  if ('head' in d) return { head: w.heads?.[d.head] ?? d.head }
  if ('envKey' in d) return { env: d.envKey, label: w.env?.[d.envKey]?.label ?? d.envKey, sub: w.env?.[d.envKey]?.sub ?? '' }
  if ('fixedId' in d) {
    const f = w.fixed?.[d.fixedId] ?? {}
    return { fixed: f.value ?? '', label: f.label ?? d.fixedId, sub: f.sub ?? '' }
  }
  if ('alias' in d) {
    const label = w.aliases?.[d.alias]?.label ?? d.alias
    const r = BY_KEY.get(d.alias)
    if (!r) throw new Error(`No setting ${d.alias} for ${label}`)
    return { ...r, label, sub: w.aliases?.[d.alias]?.sub ?? '' }
  }
  return d
}

export const SECTIONS: Section[] = DEFINED.map(s => section(s.id, s.rows))
