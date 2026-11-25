// Decides the command only; the hub and the todo list run it.

import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skillCommand } from '../core/hub-skills.ts'
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
// A ticket from Tickets (Alt+J): the prompt starts with the ticket-work
// skill and the ticket's link, so the skill runs, then `lines` (the ticket's
// facts, viewer/tickets/tracker.ts factLines), one each, then your
// instructions for ticket agents (prompts/ticket.md).
export type TicketSpec = SpecBase & { kind: 'ticket'; url: string; lines: string[] }
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

// A skill like ticket-implement makes its own worktree, and EnterWorktree
// can't nest one in another, so the agent leaves that to the skill.
const OWN_WORKTREE =
  'Before anything else, make your own worktree with the EnterWorktree tool and do all the work in it. Name it for the task in a few kebab-case words, starting with the ticket key (like ENG-123) when the task gives a ticket. If a skill you run makes its own worktree, let it do so instead.'

// What an agent in the sandbox needs told: excluded commands match only when
// nothing is chained to them, and the sandbox's placeholders at the worktree
// root make git add -A fail. Throwaway scripts stay out of what gets staged.
export const SANDBOX_RULES =
  "Your shell commands run in a sandbox. Run gh, glab, docker and git fetch, pull and push as single commands, with nothing chained, piped or redirected, or they run without the user's login and network. Stage with git add -u or by folder: git add -A and git add . fail here. Write any script you make only to try something out in your scratchpad directory, never in the repo, so it isn't committed."

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
  if (spec.chrome) opts.push('--chrome')
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
    const own = [spec.sandbox && SANDBOX_RULES, instructions('ticket').replace(/\s*\n\s*/g, ' ').trim()].filter(Boolean).join(' ')
    const prompt = [`${skillCommand('ticket-work')} ${spec.url.trim()}`, ...spec.lines, own && `${HUB} ${own}`].filter(Boolean).join('\n')
    return { prompt, name: spec.name || slug(spec.url) }
  }
  const typed = spec.prompt ?? ''
  // A name given is a slug already: the todo list's hand-off sends one.
  const name = spec.name || slug(withoutImages(typed))
  // The spec may come from a file, so its images are checked. Their paths
  // are the hub's words, so they go in its paragraph.
  const images = imagesLine(imageList(spec.images))
  const prompt = spec.kind === 'task' ? compose(spec.agent ?? 'task', typed, [spec.worktree && OWN_WORKTREE, spec.sandbox && SANDBOX_RULES, ...(spec.hub ?? []), images]) : typed.trim()
  return { prompt, name }
}

export function launch(spec: LaunchSpec): LaunchPlan {
  const opts = options(spec)
  const { prompt: told, name } = job(spec)
  // A prompt that starts with - would read as an option.
  const prompt = told.startsWith('-') ? ` ${told}` : told
  return { cwd: spec.cwd, argv: ['claude', '--bg', '--name', name, ...opts, prompt], name }
}
