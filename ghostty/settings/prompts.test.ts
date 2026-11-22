import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'

import { launch } from '../agents/model.ts'
import { AGENTS, type PromptId, compose, fileOf, instructions, promptsDir } from './prompts.ts'
import { handoffSpec } from '../viewer/todo/todo.ts'

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-'))
  process.env.AGENT_HUB_SETTINGS = join(dir, 'settings.json')
  process.env.AGENT_HUB_PROMPTS = join(dir, 'prompts')
})
const write = (id: PromptId, text: string) => {
  mkdirSync(promptsDir(), { recursive: true })
  writeFileSync(fileOf(id), text)
}

test('instructions leave out comments and blank space, and read as none when missing', () => {
  assert.equal(instructions('task'), '')
  write('task', '<!-- about this file -->\n\n  Be brief.\n<!-- more\nnotes -->\n')
  assert.equal(instructions('task'), 'Be brief.')
})

test('compose puts the hub’s words and your instructions in one paragraph before what you typed', () => {
  assert.equal(compose('task', ' fix the page\n'), 'fix the page', 'nothing to add: only what you typed')
  write('task', 'Run the tests.\n\nKeep it small.')
  assert.equal(compose('task', 'fix the page\n\nand the footer'), 'From the hub: Run the tests. Keep it small.\n\nMy prompt:\nfix the page\n\nand the footer')
  assert.equal(compose('task', 'x', ['Use a worktree.', false]), 'From the hub: Use a worktree. Run the tests. Keep it small.\n\nMy prompt:\nx')
  assert.equal(compose('todo-handoff', 'Fix it', ['About todo k2x.']), 'From the hub: About todo k2x.\n\nMy todo:\nFix it')
})

test('launch adds a task’s or a hand-off’s instructions, and nothing to a monitor', () => {
  write('task', 'TASK RULES')
  write('todo-handoff', 'HANDOFF RULES')
  const task = launch({ kind: 'task', cwd: '/p', prompt: 'write docs' })
  assert.equal(task.argv!.at(-1), 'From the hub: TASK RULES\n\nMy prompt:\nwrite docs')
  assert.equal(task.name, 'write-docs', 'the name comes from what you typed')
  const item = { id: 'k2x', title: 'Fix it', note: '', cat: 'bug', repo: 'dot', branch: '', root: '/r', worktree: '', cwd: '/r', created: 0, done: null }
  const handoff = launch(handoffSpec(item, {}, () => true)!)
  assert.match(handoff.argv!.at(-1)!, /^From the hub: Before anything else, make your own worktree [^\n]* Work on todo k2x [^\n]* HANDOFF RULES\n\nMy todo:\nFix it$/)
  assert.doesNotMatch(handoff.argv!.at(-1)!, /TASK RULES/, 'a hand-off isn’t a task from New agent')
  assert.equal(launch({ kind: 'monitor', skill: 'pr', cwd: '/p', target: 'https://x/pull/1' }).argv!.at(-1), '/dominus:pr-babysit https://x/pull/1')
  assert.equal(launch({ kind: 'monitor', skill: 'logs', cwd: '/p', target: 'docker logs api' }).argv!.at(-1), '/dominus:log-watcher watch docker logs api')
})

const REPO_PROMPTS = fileURLToPath(new URL('../prompts', import.meta.url))

test('the repo keeps an example for each agent’s instructions, with nothing to send', () => {
  for (const id of AGENTS) {
    const example = join(REPO_PROMPTS, `${id}.md.example`)
    assert.ok(existsSync(example), example)
    process.env.AGENT_HUB_PROMPTS = mkdtempSync(join(tmpdir(), 'prompts-'))
    writeFileSync(fileOf(id), readFileSync(example))
    assert.equal(instructions(id), '', `${id}.md.example is only a comment`)
  }
})

test('install copies the examples once, leaving your own files alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-'))
  writeFileSync(join(dir, 'task.md.example'), 'example task')
  writeFileSync(join(dir, 'todo-handoff.md.example'), 'example hand-off')
  writeFileSync(join(dir, 'todo-handoff.md'), 'mine')
  const lib = fileURLToPath(new URL('../bin/ghostty-lib.sh', import.meta.url))
  const copy = () => execFileSync('bash', ['-c', 'source "$1"; copy_prompt_examples "$2"', 'bash', lib, dir])
  copy()
  assert.equal(readFileSync(join(dir, 'task.md'), 'utf8'), 'example task')
  assert.equal(readFileSync(join(dir, 'todo-handoff.md'), 'utf8'), 'mine')
  writeFileSync(join(dir, 'task.md'), 'edited')
  copy()
  assert.equal(readFileSync(join(dir, 'task.md'), 'utf8'), 'edited', 'a second install keeps your edits')
})
