// Your own instructions for some kinds of agent, sent in the paragraph the hub
// puts before what was typed. Filing a todo has none: the todo skill does it.
//
// They're a Markdown file per agent in prompts/ beside hub/. Git ignores them:
// install copies each from the <name>.md.example the repo keeps. Node follows
// install.sh's links to this module's real path, so the path Settings shows is
// the repo's. HTML comments in a file are left out.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// AGENT_HUB_PROMPTS is for tests. It's read on every call.
export const promptsDir = (): string => process.env.AGENT_HUB_PROMPTS || join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

export const AGENTS = ['task', 'todo-handoff'] as const
export type PromptId = (typeof AGENTS)[number]

export const fileOf = (id: PromptId): string => join(promptsDir(), `${id}.md`)

export function instructions(id: PromptId): string {
  let body: string
  try {
    body = readFileSync(fileOf(id), 'utf8')
  } catch {
    // No file: no instructions.
    return ''
  }
  return body.replace(/<!--[\s\S]*?-->/g, '').trim()
}

// A first prompt the hub builds keeps your words apart from its own: its text
// in one paragraph that starts with HUB, then a label line (`My prompt:`,
// `Brief:`) and what you typed, as you typed it.
export const HUB = 'From the hub:'

export function withTyped(head: string, label: string, typed: string): string {
  const own = typed.replace(/\r\n?/g, '\n').trim()
  if (!own) return head
  return head ? `${head}\n\n${label}\n${own}` : own
}

// What you typed, without the hub's paragraph and the label under it.
export function typedPart(s: unknown): string {
  const text = String(s ?? '')
  if (!text.startsWith(HUB)) return text
  const at = text.indexOf('\n\n')
  return at < 0 ? '' : text.slice(at + 2).replace(/^[^\n]*:\n/, '')
}

const LABEL: Record<PromptId, string> ={ task: 'My prompt:', 'todo-handoff': 'My todo:' }

// The hub's sentences and your instructions make the first paragraph, kept to
// one line so a blank line in them can't split it; what was typed follows as
// typed.
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim()
export function compose(id: PromptId, typed: string, hub: readonly (string | false | undefined)[] = []): string {
  const head = [...hub, instructions(id)]
    .map(s => oneLine(s || ''))
    .filter(Boolean)
    .join(' ')
  return withTyped(head && `${HUB} ${head}`, LABEL[id], typed)
}
