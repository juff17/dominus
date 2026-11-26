// Decides the command, and startBg runs it for the hub, Todo, Tickets and
// Monitors.

import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skillCommand } from '../core/hub-skills.ts'
import { OWN_WORKTREE, SANDBOX } from '../core/prompts/shared.ts'
import { type Image, imageList, imagesLine, withoutImages } from '../core/images.ts'
import { HUB, type PromptId, compose, instructions, withTyped } from '../settings/prompts.ts'
import { short } from './text.ts'

// `model`, `mode` and `effort` are claude's --model, --permission-mode and
// --effort, left out at 'default'. `images` are those pasted into the
// prompt, which names each [Image #n] (core/images.ts). `sandbox` runs its
// shell commands in Claude Code's sandbox (sandbox.json), as Settings ask for
// New agent, todo hand-offs and tickets.
type SpecBase = {
  cwd: string
  model?: string
  mode?: string
  effort?: string
  chrome?: boolean
  sandbox?: boolean
  prompt?: string
  name?: string
  images?: Image[]
}
// `prompt` is what was typed, sent as typed. `hub` is sentences the code
// adds for this agent, sent before it with the worktree rule and your
// instructions.
export type TaskSpec = SpecBase & { kind: 'task'; worktree?: boolean; agent?: PromptId; hub?: string[] }
// `extra` goes on the skill's line after the target (pr-babysit's attach
// options). `lines` go after that line, one each, as the skill's SKILL.md
// reads them; a line may hold line breaks of its own. `typed` (a brief, what
// to watch for) goes last, as typed, under its label.
export type MonitorSpec = SpecBase & {
  kind: 'monitor'
  skill: MonitorId
  target: string
  extra?: string
  lines?: string[]
  typed?: { label: string; text: string }
}
// The agents Tickets (Alt+J) starts on a ticket: the worker builds it, the
// reviewer reviews its branch or PR, the tester runs the app and proves it.
export const Role = { Work: 'work', Review: 'review', Test: 'test' } as const
export type Role = (typeof Role)[keyof typeof Role]
export const ROLES: readonly Role[] = Object.values(Role)
// Each role's skill and the file of your instructions it gets.
export const ROLE_SKILL: Record<Role, string> = { work: 'ticket-work', review: 'review', test: 'test' }
export const ROLE_PROMPT: Record<Role, PromptId> = { work: 'ticket', review: 'review', test: 'test' }

// A ticket from Tickets: the prompt starts with the role's skill and the
// ticket's link, so the skill runs (a reviewer or tester also gets --fix or
// --feedback), then `lines` (the ticket's facts, viewer/tickets/tracker.ts
// factLines), one each, then your instructions for that role
// (~/.config/dominus/prompts/<ticket|review|test>.md). A tester always runs
// with --chrome, for the browser it tests in.
export type TicketSpec = SpecBase & { kind: 'ticket'; url: string; lines: string[]; role?: Role; fix?: boolean }
export type LaunchSpec = TaskSpec | MonitorSpec | TicketSpec

// Every agent runs in the background: `claude --bg`, which prints its id and
// returns. The hub opens it beside its list with `claude attach`.
export type LaunchPlan = { cwd: string; argv: string[]; name: string }

export const slug = (s: string): string =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 5)
    .join('-')
    .slice(0, 40) || 'agent'

export type MonitorId = 'pr' | 'pipe' | 'logs'
export type MonitorSkill = {
  id: MonitorId
  skill: string
  args: (target: string) => string
  name: (target: string) => string
}

// The Monitors popup's (Alt+M) skills. `id` is also its Settings prefix
// (newAgent.<id>.model …), a name kept from when New agent started them.
export const MONITORS: MonitorSkill[] = [
  {
    id: 'pr',
    skill: 'pr-babysit',
    args: t => t,
    name: t => {
      const num = t.match(/(?:pull|merge_requests)\/(\d+)/)?.[1]
      return num ? `#${num}` : basename(t)
    },
  },
  {
    id: 'pipe',
    skill: 'pipeline-watch',
    args: t => t,
    name: t => `pipeline ${short(t.replace(/^https?:\/\/[^/]+\//, '').replace(/\/(-\/pipelines|actions\/runs)\//, ' #'), 40)}`,
  },
  {
    id: 'logs',
    skill: 'log-watcher',
    args: t => `watch ${t}`,
    name: t => short(t, 30),
  },
]
export const monitor = (id: string): MonitorSkill | undefined => MONITORS.find(m => m.id === id)

// Claude Code's strict sandbox, for agents that write code unattended: writes
// stay in the folder they start in, and secrets stay unreadable. Monitors
// never get it: their scripts call gh, glab and docker, which need your login
// and can't work in the sandbox. Sessions you start yourself don't load it.
export const SANDBOX_SETTINGS = fileURLToPath(new URL('./sandbox.json', import.meta.url))

function options(spec: LaunchSpec): string[] {
  const opts: string[] = []
  const flags = [
    ['--model', spec.model],
    ['--permission-mode', spec.mode],
    ['--effort', spec.effort],
  ] as const
  for (const [flag, value] of flags) if (value && value !== 'default') opts.push(flag, value)
  if (spec.chrome || (spec.kind === 'ticket' && spec.role === Role.Test)) opts.push('--chrome')
  if (spec.sandbox && spec.kind !== 'monitor') opts.push('--settings', SANDBOX_SETTINGS)
  return opts
}

function job(spec: LaunchSpec): { prompt: string; name: string } {
  const mon = spec.kind === 'monitor' ? monitor(spec.skill) : undefined
  if (spec.kind === 'monitor' && mon) {
    const target = spec.target.trim()
    const extra = spec.extra?.replace(/\s+/g, ' ').trim()
    const first = [`${skillCommand(mon.skill)} ${mon.args(target)}`.trim(), extra].filter(Boolean).join(' ')
    const name = spec.name || (mon.id === 'pipe' ? mon.name(target) : `monitor ${mon.name(target)}`)
    // Images pasted into a brief or a Watch for go after the hub's lines,
    // before what was typed.
    const images = imagesLine(imageList(spec.images))
    const head = [first, ...(spec.lines ?? []), images].filter(Boolean).join('\n')
    return { prompt: spec.typed ? withTyped(head, spec.typed.label, spec.typed.text) : head, name }
  }
  if (spec.kind === 'ticket') {
    const role = spec.role ?? Role.Work
    const own = [spec.sandbox && SANDBOX, instructions(ROLE_PROMPT[role]).replace(/\s*\n\s*/g, ' ').trim()].filter(Boolean).join(' ')
    const mode = role === Role.Work ? '' : spec.fix ? ' --fix' : ' --feedback'
    const prompt = [`${skillCommand(ROLE_SKILL[role])} ${spec.url.trim()}${mode}`, ...spec.lines, own && `${HUB} ${own}`].filter(Boolean).join('\n')
    return { prompt, name: spec.name || slug(spec.url) }
  }
  const typed = spec.prompt ?? ''
  // A name given is a slug already: the todo list's hand-off sends one.
  const name = spec.name || slug(withoutImages(typed))
  // The spec may come from a file, so its images are checked. Their paths
  // are the hub's words, so they go in its paragraph.
  const images = imagesLine(imageList(spec.images))
  const prompt = spec.kind === 'task' ? compose(spec.agent ?? 'task', typed, [spec.worktree && OWN_WORKTREE, spec.sandbox && SANDBOX, ...(spec.hub ?? []), images]) : typed.trim()
  return { prompt, name }
}

export function launch(spec: LaunchSpec): LaunchPlan {
  const opts = options(spec)
  const { prompt: told, name } = job(spec)
  // A prompt that starts with - would read as an option.
  const prompt = told.startsWith('-') ? ` ${told}` : told
  return { cwd: spec.cwd, argv: ['claude', '--bg', '--name', name, ...opts, prompt], name }
}

// What a claude --bg run left. claude prints the job's id and returns once
// the agent runs, so exit 0 means it's running; `out` is what it printed, on
// stdout and stderr. `error` is set when claude couldn't be run at all.
export type BgRun = { exit: number | null; out: string; error?: Error }
type Chunks = { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
export type BgChild = {
  stdout: Chunks
  stderr: Chunks
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  unref(): void
}
export type BgSpawn = (cmd: string, args: string[], opts: { cwd: string; detached: true; stdio: ['ignore', 'pipe', 'pipe'] }) => BgChild

// Runs plan with `claude` (the binary to run it with), detached, so the
// agent outlives the screen that started it.
export function startBg(spawn: BgSpawn, claude: string, plan: LaunchPlan, cwd = plan.cwd): Promise<BgRun> {
  return new Promise(done => {
    let out = ''
    const collect = (b: Buffer | string) => {
      out += b.toString()
    }
    const child = spawn(claude, plan.argv.slice(1), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    // A claude that couldn't be run (ENOENT) emits 'error', then 'close' with
    // nothing said: the error says why, once.
    let failed = false
    child.on('error', error => {
      failed = true
      done({ exit: null, out, error })
    })
    child.on('close', exit => {
      if (!failed) done({ exit, out })
    })
    child.unref()
  })
}
