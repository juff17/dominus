import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HUB_PROMPTS, agentText } from './agent-text.ts'

const GHOSTTY = join(HUB_PROMPTS, '..', '..')
const names = readdirSync(HUB_PROMPTS).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3))

// Every agentText('name', …) in the code, so a file nothing sends shows up.
function used(): Set<string> {
  const found = new Set<string>()
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'node_modules') walk(join(dir, e.name))
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) for (const m of readFileSync(join(dir, e.name), 'utf8').matchAll(/agentText\('([\w-]+)'/g)) found.add(m[1])
    }
  }
  walk(GHOSTTY)
  return found
}

test('each hub prompt file is one line with its comment left out, and something sends it', () => {
  const sent = used()
  assert.deepEqual([...sent].filter(n => !names.includes(n)), [], 'no code names a file that is missing')
  for (const name of names) {
    const line = agentText(name)
    assert.ok(line, name)
    assert.ok(!line.includes('\n') && !line.includes('<!--'), name)
    assert.ok(sent.has(name), `${name}.md is sent by nothing`)
  }
})

test('placeholders are filled from the values given, and one with none stays as written', () => {
  assert.equal(agentText('todo-done', { id: 'k2x' }), "Once it's finished, mark it done: ~/.config/ghostty/bin/ghostty-todo done k2x")
  assert.match(agentText('todo-done'), /done \{id\}$/)
  assert.equal(agentText('images', { list: '[Image #1] is /a.png' }), 'The prompt has images attached: [Image #1] is /a.png. Read each one with the Read tool before you start.')
})
