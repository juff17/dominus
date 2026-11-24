// One flat JSON file of key → value, holding only the ones changed from their
// default, so the watcher (Python) and the tray widget (QML, through tray.ts)
// can read it too. A value that's missing, of the wrong type or out of range
// reads as its default, so a hand-edited file can't break anything that
// reads it.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { isRecord } from '../core/json.ts'
import { errorMessage, logger } from '../core/log.ts'
import { expandHome } from '../core/paths.ts'
import { t, text } from '../core/text.ts'
import { FILER_MODELS, MODEL_IDS, type ModelId } from './models.ts'
import type { PromptId } from './prompts.ts'

const log = logger('settings')

// AGENT_HUB_SETTINGS points everything at another file. It's read on each
// call, so a test can set it after importing a module that reads settings.
export const settingsFile = (): string =>
  process.env.AGENT_HUB_SETTINGS || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agent-hub', 'settings.json')

// name and cmd are only on a mode you added.
export type Mode = { id: string; on: boolean; name?: string; cmd?: string }
export type KeyKind = 'alt' | 'ghostty'
export type Choice<V extends string = string> = { value: V; label: string }

type Row<K extends string, T extends string, V> = { key: K; label: string; sub: string; type: T; default: V }
export type ChoiceRow<K extends string = string, V extends string = string> = Row<K, 'choice', V> & { choices: Choice<V>[] }
export type NumberRow<K extends string = string> = Row<K, 'number', number> & { min: number; max: number; step: number; unit: string }
export type BoolRow<K extends string = string> = Row<K, 'bool', boolean>
export type FlagsRow<K extends string = string> = Row<K, 'flags', string[]> & { choices: Choice[] }
// run is what Ghostty sends for a ghostty key, as config.ghostty has it.
export type KeyRow<K extends string = string> = Row<K, 'key', string> & { kind: KeyKind; run?: string }
export type ModesRow<K extends string = string> = Row<K, 'modes', Mode[]>
// `empty` is what the panel shows for '' (a default the reader fills in).
export type FileRow<K extends string = string> = Row<K, 'file', string> & { dir: boolean; empty: string }
export type HostsRow<K extends string = string> = Row<K, 'hosts', string[]> & { cli: 'gh' | 'glab' }
// `empty` is what the panel shows for none.
export type ListRow<K extends string = string> = Row<K, 'list', string[]> & { item: RegExp; max: number; keep: string[]; empty: string }
// One line of text, '' for none. `empty` is what the panel shows for ''.
export type TextRow<K extends string = string> = Row<K, 'text', string> & { item: RegExp; max: number; empty: string }
// Any setting. SettingRow, further down, is the ones there are, by key.
export type Setting = ChoiceRow | NumberRow | BoolRow | FlagsRow | KeyRow | ModesRow | FileRow | HostsRow | ListRow | TextRow
export type SettingValue = Setting['default']

// A FixedLine is a value set somewhere else (KDE, layout.conf) or not up to
// you, shown so the panel lists it with the rest.
export type Heading = { head: string }
export type PromptLine = { prompt: PromptId }
export type FixedLine = { fixed: string; label: string; sub: string }
// A value kept in .env rather than here (a tracker's credentials): the panel
// says only whether it's set, never what it holds.
export type EnvLine = { env: string; label: string; sub: string }
export type SectionRow = SettingRow | Heading | PromptLine | FixedLine | EnvLine
export type Section = { id: string; name: string; where: string; rows: SectionRow[] }

export const isSetting = <R extends object>(r: R): r is Extract<R, { key: string }> => 'key' in r

// What each setting is called and says, its choices' names and its unit
// are in core/text.json under settings.rows, by key; a section's name,
// note, headings, fixed rows and aliases under settings.sections, by id.
// Here are only the keys, the types, the values and the defaults.
type Named = { label?: string; sub?: string }
type RowWords = Named & { unit?: string; empty?: string; choices?: Record<string, string> }
type SectionWords = {
  name?: string
  where?: string
  heads?: Record<string, string>
  fixed?: Record<string, Named & { value?: string }>
  aliases?: Record<string, Named>
  env?: Record<string, Named>
}
type SettingsText = { rows?: Record<string, RowWords>; sections?: Record<string, SectionWords>; modes?: Record<string, { name?: string; sub?: string }> }
const T = text<SettingsText>('settings')
const words = (key: string): RowWords => T.rows?.[key] ?? {}
const named = (key: string) => ({ label: words(key).label ?? key, sub: words(key).sub ?? '' })

// A choice is named in the text file (or by itself when it isn't); a
// model's [id, label] keeps the label models.ts gives it.
type Choosable<V extends string> = V | readonly [value: V, label: string]
const opts = <V extends string>(key: string, list: readonly Choosable<V>[]): Choice<V>[] =>
  list.map(c => (typeof c === 'string' ? { value: c, label: words(key).choices?.[c] ?? c } : { value: c[0], label: c[1] }))

// Each builder keeps its key's literal type, and a choice its values', so
// Settings below knows what every key holds.
const choice = <K extends string, const V extends string>(key: K, choices: readonly Choosable<V>[], def: NoInfer<V>): ChoiceRow<K, V> => ({ key, ...named(key), type: 'choice', choices: opts(key, choices), default: def })
type Range = { min: number; max: number; step?: number }
const number = <K extends string>(key: K, def: number, { min, max, step = 1 }: Range): NumberRow<K> => ({ key, ...named(key), type: 'number', min, max, step, unit: words(key).unit ?? '', default: def })
const bool = <K extends string>(key: K, def: boolean): BoolRow<K> => ({ key, ...named(key), type: 'bool', default: def })
const flags = <K extends string>(key: K, choices: readonly string[], def: string[]): FlagsRow<K> => ({ key, ...named(key), type: 'flags', choices: opts(key, choices), default: def })
// An alt key layout.conf binds, or a ctrl+shift key Ghostty sends `run` for
// (config.ghostty). '' is unbound.
const keybind = <K extends string>(key: K, kind: KeyKind, def: string, run?: string): KeyRow<K> => ({ key, ...named(key), type: 'key', kind, default: def, run })
const modes = <K extends string>(key: K, def: Mode[]): ModesRow<K> => ({ key, ...named(key), type: 'modes', default: def })
// '' is none.
type FileOptions = { dir?: boolean }
const file = <K extends string>(key: K, { dir = false }: FileOptions = {}): FileRow<K> => ({ key, ...named(key), type: 'file', dir, empty: words(key).empty ?? '', default: '' })
const hosts = <K extends string>(key: K, cli: HostsRow['cli'], def: string[]): HostsRow<K> => ({ key, ...named(key), type: 'hosts', cli, default: def })
// `keep` is in the list always: typing it out or clearing the row leaves it.
type ListOptions = { item: RegExp; max?: number; keep?: string[] }
const list = <K extends string>(key: K, def: string[], { item, max = 12, keep = [] }: ListOptions): ListRow<K> => ({ key, ...named(key), type: 'list', item, max, keep, empty: words(key).empty ?? '', default: def })
type TextOptions = { item?: RegExp; max?: number }
const textRow = <K extends string>(key: K, { item = /^.+$/, max = 200 }: TextOptions = {}): TextRow<K> => ({ key, ...named(key), type: 'text', item, max, empty: words(key).empty ?? '', default: '' })

// The lines below as written, before their section's words are put in:
// headings and fixed rows by their ids in the text file, and an alias, one
// setting shown in a second section under its own name there, by its key.
type FixedDef = { fixedId: string }
type AliasDef = { alias: string }
type EnvDef = { envKey: string }
type Def = Setting | Heading | PromptLine | FixedDef | AliasDef | EnvDef
const head = (id: string): Heading => ({ head: id })
const prompt = (id: PromptId): PromptLine => ({ prompt: id })
const fixed = (id: string): FixedDef => ({ fixedId: id })
const alias = (key: string): AliasDef => ({ alias: key })
const envLine = (key: string): EnvDef => ({ envKey: key })
const define = <D extends Def>(id: string, rows: D[]) => ({ id, rows })

// The viewer pane's modes (bin/ghostty-viewer): these four, and any you add,
// which run a command of yours in the pane and have an id that starts with x-.
const BUILTIN_IDS = ['files', 'diff', 'todo', 'diagrams'] as const
export type BuiltinMode = { id: (typeof BUILTIN_IDS)[number]; name: string; sub: string }
export const BUILTIN_MODES: BuiltinMode[] = BUILTIN_IDS.map(id => ({ id, name: T.modes?.[id]?.name ?? id, sub: T.modes?.[id]?.sub ?? '' }))
const BUILTIN = new Map<string, BuiltinMode>(BUILTIN_MODES.map(m => [m.id, m]))
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
    choice('tickets.handoff.model', MODEL_IDS, 'opus'),
    choice('tickets.handoff.mode', MODE, 'auto'),
    choice('tickets.handoff.effort', EFFORT, 'medium'),
    prompt('ticket'),
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
const BY_KEY = new Map<string, SettingRow>(ROWS.map(r => [r.key, r]))

// A key known to be one gets its own row's type; any other string may not
// be a setting.
export function row<K extends SettingKey>(key: K): RowOf<K>
export function row(key: string): SettingRow | undefined
export function row(key: string): SettingRow | undefined {
  return BY_KEY.get(key)
}

// An alias becomes its setting's row under the alias's own name, so both
// sections change the one value.
function section(id: string, defs: readonly Defined[]): Section {
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

export const KEY_PATTERN: Record<KeyKind, RegExp> = { alt: /^alt\+[a-z0-9]$/, ghostty: /^ctrl\+shift\+[a-z0-9]$/ }
// A host as gh and glab take it: a name, and a port when it has one.
export const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/
export const MAX_HOSTS = 8

export function valid<R extends Setting>(r: R, v: unknown): v is R['default'] {
  switch (r.type) {
    case 'choice':
      return r.choices.some(c => c.value === v)
    case 'bool':
      return typeof v === 'boolean'
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) && v >= r.min && v <= r.max
    case 'flags':
      return Array.isArray(v) && v.every((x: unknown) => r.choices.some(c => c.value === x))
    case 'key':
      return v === '' || (typeof v === 'string' && KEY_PATTERN[r.kind].test(v))
    case 'modes':
      return validModes(v)
    case 'file':
      return v === '' || (isText(v, 500) && /^(\/|~\/)/.test(v))
    case 'hosts':
      return validHosts(v)
    case 'list':
      return validList(r, v)
    case 'text':
      return v === '' || (isText(v, r.max) && r.item.test(v))
  }
}

function validList(r: ListRow, v: unknown): v is string[] {
  if (!Array.isArray(v) || v.length > r.max) return false
  return v.every((w: unknown) => typeof w === 'string' && w.length <= 200 && r.item.test(w)) && new Set(v).size === v.length && r.keep.every(k => v.includes(k))
}

export function parseList(r: ListRow, text: string): string[] | null {
  const typed = text.split(',').map(w => w.trim().replace(/\s+/g, ' ')).filter(Boolean)
  const words = [...new Set([...r.keep.filter(k => !typed.includes(k)), ...typed])]
  return validList(r, words) ? words : null
}

function validHosts(v: unknown): v is string[] {
  if (!Array.isArray(v) || v.length > MAX_HOSTS) return false
  return v.every((h: unknown) => typeof h === 'string' && h.length <= 253 && HOST_PATTERN.test(h)) && new Set(v).size === v.length
}

// A pasted address keeps only its host.
const hostOf = (h: string): string => (/^\w+:\/\//.test(h) ? h.replace(/^\w+:\/\//, '').replace(/\/.*$/, '') : h).toLowerCase()
export function parseHosts(text: string): string[] | null {
  const list = [...new Set(text.split(/[\s,]+/).filter(Boolean).map(hostOf))]
  return validHosts(list) ? list : null
}

const isText = (v: unknown, most: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= most && !/[\t\n\r]/.test(v)


const isMode = (m: unknown): m is Mode =>
  isRecord(m) && typeof m.on === 'boolean' && typeof m.id === 'string' && (BUILTIN.has(m.id) || (isAdded(m.id) && isText(m.name, 24) && isText(m.cmd, 500)))

function validModes(v: unknown): v is Mode[] {
  return Array.isArray(v) && v.every(isMode) && new Set(v.map(m => m.id)).size === v.length && v.some(m => m.on)
}

// The saved list's good entries, the first of each id. A bad one (a hand
// edit, or a built-in a later version drops) costs only itself: were the
// whole list to read as the default, the panel's next edit of it would save
// that default over every mode you added.
function savedModes(v: unknown, fallback: Mode[]): Mode[] {
  const kept: Mode[] = []
  const entries = Array.isArray(v) ? v : []
  for (const m of entries) if (isMode(m) && !kept.some(k => k.id === m.id)) kept.push(m)
  // Said, as the panel's next mode edit saves the list without them.
  if (kept.length < entries.length) log.warn('modes dropped', { kept: kept.length, saved: entries.length })
  const list = withBuiltins(kept)
  return list.some(m => m.on) ? list : withBuiltins(fallback)
}

// A built-in mode the list doesn't have (one a later version adds) goes on at
// its end.
const withBuiltins = (list: Mode[]): Mode[] => [
  ...list,
  ...BUILTIN_MODES.filter(b => !list.some(m => m.id === b.id)).map(b => ({ id: b.id, on: true })),
]

export function addedId(name: string, list: readonly { id: string }[]): string {
  const base = `x-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'mode'}`
  let id = base
  for (let n = 2; list.some(m => m.id === id); n++) id = `${base}-${n}`
  return id
}

const isMissing = (e: unknown): boolean => e instanceof Error && 'code' in e && e.code === 'ENOENT'

// {} when it's missing; throws when it's there but unreadable, broken or not
// an object.
function readObjectStrict(file: string): Record<string, unknown> {
  let v: unknown
  try {
    v = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    if (isMissing(e)) return {}
    throw e
  }
  if (!isRecord(v)) throw new Error(`${basename(file)} holds no JSON object`)
  return v
}

// {} for a broken file too, so a hand edit can't break what reads it.
export function readObject(file: string): Record<string, unknown> {
  try {
    return readObjectStrict(file)
  } catch (e) {
    log.warn('file unreadable', { path: file, err: errorMessage(e) })
    return {}
  }
}

// Values carried over from prefs.json, beside the file, which is where the
// hub kept "don't ask again" before there were settings.
function legacy(file: string): Record<string, unknown> {
  const skip = readObject(join(dirname(file), 'prefs.json')).skip
  return isRecord(skip) && skip['stop-monitor'] ? { 'hub.askStopMonitor': false } : {}
}

// A setting that moved to another key reads the old one's value until the
// new one is saved.
const RENAMED: Record<string, string> = { 'todo.handoff.defaultRepo': 'general.folder' }
const renamed = (saved: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(RENAMED).flatMap(([from, to]) => (from in saved && !(to in saved) ? [[to, saved[from]]] : [])))

const raw = (file: string): Record<string, unknown> => {
  const saved = readObject(file)
  return { ...legacy(file), ...renamed(saved), ...saved }
}

function savedOrDefault(r: SettingRow, saved: Record<string, unknown>): SettingValue {
  const v = saved[r.key]
  if (r.type === 'modes') return savedModes(v, r.default)
  return valid(r, v) ? v : r.default
}

// Not the mtime alone: two writes in one clock tick share it, and a reader that read between them would keep the first.
// Every write here renames a new inode into place, and an editor writing in
// place changes the size or the ctime.
function versionOf(file: string): string {
  try {
    const s = statSync(file)
    return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
  } catch {
    // No file yet: every value is its default.
    return ''
  }
}

// The hub and agentd read it often, so it's read again only when the file
// changes.
let cache: { file: string; version: string; values: Settings } | undefined
export function load(file = settingsFile()): Settings {
  const version = versionOf(file)
  if (cache?.file === file && cache.version === version) return cache.values
  const saved = raw(file)
  // Built from ROWS, which has every key, each value checked against its row.
  const values = Object.freeze(Object.fromEntries(ROWS.map(r => [r.key, savedOrDefault(r, saved)]))) as Settings
  cache = { file, version, values }
  return values
}

// At run time a key there isn't reads as undefined,
// which the shell's `setting` (bin/lib/core.sh) takes as its cue to fall back.
export const get = <K extends SettingKey>(key: K, file = settingsFile()): Settings[K] => load(file)[key]

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// Written whole, through a rename, so a reader never sees half of it.
function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, file)
}

// A value back at its default is left out, so a default changed here later
// reaches everyone who never changed it. Keys this version doesn't know are
// kept. A file that's there but won't read as an object throws: it reads as
// every default, so writing it back with one value would lose all the others
// for good.
export function set<K extends SettingKey>(key: K, value: RowOf<K>['default'], file = settingsFile()): Settings {
  const r = BY_KEY.get(key)
  if (!r || !valid(r, value)) throw new Error(`Not a value for ${key}: ${JSON.stringify(value)}`)
  let saved: Record<string, unknown>
  try {
    const strict = readObjectStrict(file)
    saved = { ...legacy(file), ...renamed(strict), ...strict }
    for (const from of Object.keys(RENAMED)) delete saved[from]
  } catch (e) {
    throw new Error(`${basename(file)} is broken, fix it by hand first: ${errorMessage(e)}`, { cause: e })
  }
  // Unless a carried-over value would come back in its place.
  if (same(value, r.default) && !(key in legacy(file))) delete saved[key]
  else saved[key] = value
  writeJson(file, saved)
  // The new file can take the old one's freed inode, at the same size in the
  // same tick, which versionOf can't tell apart.
  cache = undefined
  return load(file)
}

// Where an agent starts when nothing names a folder: General's Default
// folder, else ~/projects.
export const defaultFolderSetting = (v: Settings = load()): string => v['general.folder'] || '~/projects'

// Home when that folder isn't on disk, so a start never fails over it.
export function defaultFolder(v: Settings = load(), isDir = (d: string): boolean => !!statSync(d, { throwIfNoEntry: false })?.isDirectory()): string {
  const folder = expandHome(defaultFolderSetting(v))
  return isDir(folder) ? folder : homedir()
}

export const reset = (key: SettingKey, file = settingsFile()): Settings => set(key, row(key).default, file)

export function step(r: Setting, value: SettingValue, dir: -1 | 1): SettingValue {
  switch (r.type) {
    case 'choice': {
      const i = r.choices.findIndex(c => c.value === value)
      return r.choices[(i + dir + r.choices.length) % r.choices.length].value
    }
    case 'number':
      return Math.min(r.max, Math.max(r.min, Number(value) + dir * r.step))
    case 'bool':
      return !value
    default:
      return value
  }
}

export const toggleFlag = (r: FlagsRow, value: readonly string[], flag: string): string[] =>
  r.choices.map(c => c.value).filter(v => (v === flag ? !value.includes(v) : value.includes(v)))

export { expandHome } from '../core/paths.ts'

// v is r's own value, so the row's type says what it is.
export function show(r: Setting, v: SettingValue): string {
  switch (r.type) {
    case 'key':
      return String(v) || t('settings.ui.unbound')
    case 'file':
      return String(v) || r.empty || t('settings.ui.none')
    case 'modes':
      return (v as Mode[])
        .filter(m => m.on)
        .map(modeName)
        .join(', ')
    case 'number':
      return `${v}${r.unit}`
    case 'bool':
      return t(v ? 'settings.ui.on' : 'settings.ui.off')
    case 'choice':
      return r.choices.find(c => c.value === v)?.label ?? String(v)
    case 'flags':
      return (v as string[]).join(', ')
    case 'hosts':
      return (v as string[]).join(', ') || t('settings.ui.none')
    case 'list':
      return (v as string[]).join(', ') || r.empty || t('settings.ui.none')
    case 'text':
      return String(v) || r.empty || t('settings.ui.none')
  }
}
