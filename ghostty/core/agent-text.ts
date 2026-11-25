// The hub's own words to agents, as against the words on screen (text.json):
// one Markdown file each in prompts/hub/, kept in the repo. Your own
// instructions for each kind of agent sit beside them in prompts/<agent>.md
// (settings/prompts.ts). HTML comments in a file are left out, and its lines
// are joined into one, so a wrapped file still sends one line.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HUB_PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'hub')

// {name} is filled from `vars`; one with no value stays as written, which a
// test catches. A missing file throws: it ships with the hub.
export function agentText(name: string, vars: Readonly<Record<string, string | number>> = {}): string {
  const body = readFileSync(join(HUB_PROMPTS, `${name}.md`), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
  return body.replace(/\{(\w+)\}/g, (all, key: string) => (key in vars ? String(vars[key]) : all))
}
