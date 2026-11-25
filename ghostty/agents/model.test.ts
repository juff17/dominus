// node --test ghostty/agents/model.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type AgentState, type Session, type Transcript, addEntry, brokeTags, cardHeights, classify, counts, describeTool, emptyTranscript, eventTag, lanes, launch, monitorProcess, monitorsOf, pairParked, parseNotification, permissionTool, repoOf, scrollTo, showsPermission } from './model.ts'
import { clean, render, width } from '../tui/term.ts'
import { promptLine } from './text.ts'
import { SANDBOX_SETTINGS } from './launch.ts'
import { agentText } from '../core/agent-text.ts'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { set as setSetting } from '../settings/settings.ts'

// No settings file, so every setting reads as its default.
process.env.AGENT_HUB_SETTINGS = '/nonexistent/agent-hub/settings.json'
process.env.AGENT_HUB_PROMPTS = '/nonexistent/agent-hub/prompts'

const ts = (s: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, s)).toISOString()
const at = (s: number) => Date.parse(ts(s))
const user = (s: number, content: unknown, extra = {}) => ({ type: 'user', timestamp: ts(s), message: { role: 'user', content }, ...extra })
const assistant = (s: number, content: unknown, extra = {}) => ({
  type: 'assistant',
  timestamp: ts(s),
  message: { role: 'assistant', model: 'claude-opus-5-5', content, usage: { input_tokens: 10, cache_read_input_tokens: 84000, cache_creation_input_tokens: 0 }, ...extra },
})
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input })
const result = (id: string, content: unknown = 'ok') => ({ type: 'tool_result', tool_use_id: id, content })
const feed = (entries: unknown[]) => entries.reduce<Transcript>((t, e) => (addEntry(t, e), t), emptyTranscript())
const session = (status: string, extra: Partial<Session> = {}): Session => ({ sessionId: 's1', pid: 1, cwd: '/home/u/projects/jstack', kind: 'interactive', status, statusUpdatedAt: at(0), startedAt: at(0), ...extra })

const notification = (task: string, line: string) =>
  `<task-notification>\n<task-id>${task}</task-id>\n<summary>Monitor event: "PR #1 pipeline"</summary>\n<event>${line}</event>\n</task-notification>`

const babysit = [
  user(1, 'babysit https://github.com/u/r/pull/1'),
  assistant(2, [tool('m1', 'Monitor', { command: 'python3 -u /s/watch_pr.py https://github.com/u/r/pull/1 --session 1 2>&1', description: 'PR #1 pipeline' })]),
  user(3, [result('m1', 'Monitor started (task b5sky, expires in 30m unless the source ends first)')]),
  { type: 'queue-operation', operation: 'enqueue', timestamp: ts(4), content: notification('b5sky', '[watch] attached https://github.com/u/r/pull/1 -&gt; main') },
  user(5, notification('b5sky', '[watch] attached https://github.com/u/r/pull/1 -&gt; main')),
  assistant(6, [{ type: 'text', text: 'Watching PR #1.' }], { stop_reason: 'end_turn' }),
]

test('the transcript gives the prompt, the running tool and the context', () => {
  const t = feed([
    user(1, 'let rm in worktrees skip the prompt'),
    assistant(2, [{ type: 'text', text: 'I will read the guard.' }]),
    assistant(3, [tool('t1', 'Bash', { command: 'bats test/rm-guard.bats\nexit' })]),
  ])
  assert.equal(t.prompt!.text, 'let rm in worktrees skip the prompt')
  assert.deepEqual(t.tools.map(c => c.name), ['Bash'])
  assert.equal(t.ctx, 84010)
  assert.equal(describeTool(t.tools[0]), 'Bash(bats test/rm-guard.bats)')
  addEntry(t, user(4, [result('t1')]))
  assert.deepEqual(t.tools, [])
})

test('calls made together stay pending until each one’s own result, and a prompt ends them all', () => {
  const t = feed([user(1, 'go'), assistant(2, [tool('a', 'Bash', { command: 'rm -rf build' }), tool('b', 'Read', { file_path: '/x' })])])
  assert.deepEqual(t.tools.map(c => c.id), ['a', 'b'])
  addEntry(t, user(3, [result('b')]))
  assert.deepEqual(t.tools.map(c => c.id), ['a'], 'the later call finishing leaves the earlier one pending')
  addEntry(t, user(4, '[Request interrupted by user]'))
  assert.deepEqual(t.tools, [])
})

test('slash commands count as prompts, tool results that carry text do not', () => {
  const t = feed([user(1, '<command-name>/fork</command-name>\n<command-args>now</command-args>')])
  assert.equal(t.prompt!.text, '/fork now')
  addEntry(t, user(2, [result('x', 'Launching skill'), { type: 'text', text: 'Base directory for this skill' }]))
  assert.equal(t.prompt!.text, '/fork now')
  addEntry(t, user(3, '<system-reminder>hi</system-reminder>'))
  assert.equal(t.prompt!.text, '/fork now')
})

test('file tools show their path relative to the session folder', () => {
  assert.equal(describeTool({ name: 'Edit', input: { file_path: '/home/u/projects/jstack/hooks/a.sh' } }, '/home/u/projects/jstack'), 'Edit(hooks/a.sh)')
  assert.equal(describeTool({ name: 'mcp__diagram-pane__show', input: {} }), 'show (MCP)')
  assert.equal(describeTool({ name: 'AskUserQuestion', input: { questions: [{ question: 'Which one?' }] } }), '? Which one?')
})

test('a Monitor is armed by its result and collects events once each', () => {
  const t = feed(babysit)
  const m = t.monitors.b5sky
  assert.equal(m.description, 'PR #1 pipeline')
  assert.equal(m.events.length, 1, 'the queued copy and the delivered copy are one event')
  assert.equal(m.events[0].tag, 'watch')
  assert.equal(m.events[0].line, '[watch] attached https://github.com/u/r/pull/1 -> main')
  addEntry(t, user(7, notification('b5sky', '[Monitor expired after 30m with 3 events delivered.]')))
  assert.equal(m.ended!.reason, 'expired')
})

test('the same event happening again counts again', () => {
  const t = feed([...babysit, user(8, notification('b5sky', '[error] TimeoutError')), user(9, notification('b5sky', '[error] TimeoutError'))])
  assert.equal(t.monitors.b5sky.events.length, 3)
})

test('parseNotification reads the task, summary and event lines', () => {
  const n = parseNotification(notification('abc', '[failed] lint\n[comment] @a: &quot;why&quot;'))!
  assert.equal(n.id, 'abc')
  assert.deepEqual(n.ids, ['abc'])
  assert.deepEqual(n.lines, ['[failed] lint', '[comment] @a: "why"'])
})

test('a waiting session needs you: permission, question or input', () => {
  const pending = feed([user(1, 'go'), assistant(2, [tool('t1', 'Bash', { command: 'rm -rf .next' })])])
  let a = classify({ session: session('waiting'), t: pending })
  assert.equal(a.state, 'needs')
  assert.equal(a.need, 'permission')
  assert.equal(a.cmd, 'Allow Bash(rm -rf .next)?')
  const asking = feed([user(1, 'go'), assistant(2, [tool('q', 'AskUserQuestion', { questions: [{ question: 'Replace btop?' }] })])])
  a = classify({ session: session('waiting'), t: asking })
  assert.equal(a.need, 'question')
  a = classify({ session: session('waiting', { waitingFor: 'dialog open' }), t: feed([user(1, 'go')]) })
  assert.equal(a.need, 'input')
  assert.equal(a.cmd, 'Waiting: dialog open')
})

test('the tool call comes back out of a permission line, whatever its brackets hold', () => {
  assert.equal(permissionTool('Allow Bash(rm -rf .next)?'), 'Bash(rm -rf .next)')
  assert.equal(permissionTool('Allow Bash(echo "a?")?'), 'Bash(echo "a?")')
  assert.equal(permissionTool('Waiting: dialog open'), 'Waiting: dialog open')
})

test('a and d only answer the dialog for the line’s own call, with its first choice near the bottom', () => {
  const cmd = 'Allow Bash(rm -rf build)?'
  const dialog = 'Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n'
  assert.equal(showsPermission(dialog, cmd), true)
  assert.equal(showsPermission(dialog.replace('❯ 1. Yes', '  1. Yes'), cmd), false)
  assert.equal(showsPermission('> type here\n', cmd), false)
  // Blank lines don't count against the 15, so padding below doesn't hide it.
  assert.equal(showsPermission(`${dialog}${'\n'.repeat(40)}`, cmd), true)
  assert.equal(showsPermission(`${dialog}${'output\n'.repeat(13)}`, cmd), true)
  assert.equal(showsPermission(`${dialog}${'output\n'.repeat(14)}`, cmd), false)
  // Another dialog whose first choice is Yes: the next call, or a plan.
  assert.equal(showsPermission(dialog, 'Allow Bash(npm test)?'), false)
  assert.equal(showsPermission('Ready to code?\n❯ 1. Yes, and auto-accept edits\n', cmd), false)
  // The same call shown above the dialog's top rule is the conversation's.
  assert.equal(showsPermission(`⏺ Bash(rm -rf build)\n${'─'.repeat(40)}\nEdit file\nDo you want to make this edit to a.ts?\n❯ 1. Yes\n`, cmd), false)
  // A command the dialog wraps, and a file it names by its name alone.
  assert.equal(showsPermission('Bash command\n  npm run build --\n  workspace=web\n❯ 1. Yes\n', 'Allow Bash(npm run build --workspace=web)?'), true)
  assert.equal(showsPermission('Edit file\nDo you want to make this edit to board.ts?\n❯ 1. Yes\n', 'Allow Edit(ghostty/hub/board.ts)?'), true)
  assert.equal(showsPermission('Tool use\n  github - search_code(q: "x") (MCP)\n❯ 1. Yes\n', 'Allow search_code (MCP)?'), true)
})

test('a background subagent asking for permission is a permission prompt, not input', () => {
  // The session's own turn ended; the subagent it left running asks.
  const ended = feed([user(1, 'go'), assistant(2, [{ type: 'text', text: 'One agent still running.' }], { stop_reason: 'end_turn' })])
  const sub = feed([user(1, 'test the hub keys'), assistant(3, [tool('s1', 'Bash', { command: 'rm -f /tmp/x; echo ok' })])])
  const a = classify({ session: session('waiting', { waitingFor: 'permission prompt' }), t: ended, subs: [{ description: 'Test hub.ts key handling', t: sub }] })
  assert.equal(a.need, 'permission')
  assert.equal(a.cmd, 'Allow Bash(rm -f /tmp/x; echo ok)?')
  assert.equal(a.via, 'Test hub.ts key handling')
})

test('inside an Agent call, the subagent\'s tool is the prompt, not the Agent call', () => {
  const running = feed([user(1, 'go'), assistant(2, [tool('ag', 'Agent', { description: 'Fix lint' })])])
  const sub = feed([user(2, 'fix lint'), assistant(4, [tool('s1', 'Edit', { file_path: '/home/u/projects/jstack/a.js' })])])
  let a = classify({ session: session('waiting'), t: running, subs: [{ description: 'Fix lint', t: sub }] })
  assert.equal(a.cmd, 'Allow Edit(a.js)?')
  // No subagent call pending: the Agent call is all there is to show.
  a = classify({ session: session('waiting'), t: running })
  assert.equal(a.cmd, 'Allow Agent(Fix lint)?')
  assert.equal(a.via, '')
})

test('a call still pending beside the one asking makes the prompt unclear: input, never another call’s permission', () => {
  // A subagent asks about a force push; another runs npm test, which needed
  // no permission and started later. Either could be the dialog on screen.
  const asking = feed([user(1, 'x'), assistant(3, [tool('s1', 'Bash', { command: 'git push --force' })])])
  const running = feed([user(1, 'y'), assistant(5, [tool('s2', 'Bash', { command: 'npm test' })])])
  const parent = feed([user(1, 'go'), assistant(2, [tool('a1', 'Agent', { description: 'Push' }), tool('a2', 'Agent', { description: 'Test' })])])
  const waiting = session('waiting', { waitingFor: 'permission prompt' })
  let a = classify({ session: waiting, t: parent, subs: [{ description: 'Push', t: asking }, { description: 'Test', t: running }] })
  assert.deepEqual([a.need, a.cmd, a.via], ['input', 'Waiting: permission prompt', ''])
  // The session asking while a background subagent runs a tool.
  const own = feed([user(1, 'go'), assistant(5, [tool('t1', 'Bash', { command: 'git push' })])])
  a = classify({ session: waiting, t: own, subs: [{ description: 'bg', t: running }] })
  assert.equal(a.need, 'input')
  // Once the other call is done, the one left is the prompt.
  addEntry(running, user(6, [result('s2')]))
  a = classify({ session: waiting, t: own, subs: [{ description: 'bg', t: running }] })
  assert.deepEqual([a.need, a.cmd], ['permission', 'Allow Bash(git push)?'])
})

test('calls made together: the one left pending is the prompt, two are unclear', () => {
  // Bash(rm) asks; Read, run beside it, finished.
  const t = feed([user(1, 'go'), assistant(2, [tool('a', 'Bash', { command: 'rm -rf build' }), tool('b', 'Read', { file_path: '/x' })])])
  assert.equal(classify({ session: session('waiting'), t }).need, 'input', 'both pending: either could be asking')
  addEntry(t, user(3, [result('b')]))
  const a = classify({ session: session('waiting'), t })
  assert.deepEqual([a.need, a.cmd], ['permission', 'Allow Bash(rm -rf build)?'])
})

test('a call left pending by the last process neither asks nor makes the prompt unclear', () => {
  // A subagent killed mid-call with the session's last process.
  const dead = feed([user(1, 'x'), assistant(2, [tool('s1', 'Bash', { command: 'npm test' })])])
  const own = feed([user(5, 'go'), assistant(6, [tool('t1', 'Bash', { command: 'git push' })])])
  const restarted = session('waiting', { startedAt: at(4) })
  const a = classify({ session: restarted, t: own, subs: [{ description: 'old', t: dead }] })
  assert.deepEqual([a.need, a.cmd, a.via], ['permission', 'Allow Bash(git push)?', ''])
  assert.equal(classify({ session: restarted, t: feed([user(5, 'go')]), subs: [{ description: 'old', t: dead }] }).need, 'input')
})

test('busy is working, with the running tool', () => {
  const t = feed([user(1, 'go'), assistant(2, [tool('t1', 'Bash', { command: 'npm test' })])])
  const a = classify({ session: session('busy'), t })
  assert.equal(a.state, 'working')
  assert.equal(a.cmd, 'Bash(npm test)')
  assert.equal(a.since, at(2))
  assert.equal(classify({ session: session('busy'), t: feed([user(1, 'go')]) }).cmd, 'Thinking…')
})

test('a finished turn is done until you review it, then idle', () => {
  const t = feed([user(1, 'go'), assistant(5, [{ type: 'text', text: '**Done.** All `3` tests pass.' }], { stop_reason: 'end_turn' })])
  let a = classify({ session: session('idle'), t })
  assert.equal(a.state, 'done')
  assert.equal(a.cmd, 'Done. All 3 tests pass.')
  a = classify({ session: session('idle'), t, reviewedAt: at(6) })
  assert.equal(a.state, 'idle')
  // A new prompt after the reply means the turn in flight isn't finished.
  addEntry(t, user(7, 'and another thing'))
  assert.equal(classify({ session: session('idle'), t }).state, 'idle')
})

test('a monitoring session sits in the strip, not the lanes', () => {
  const a = classify({ session: session('idle'), t: feed(babysit), alive: () => true, now: at(10) })
  assert.equal(a.monitor, true)
  assert.equal(a.monitors[0].state, 'watching')
  assert.equal(a.monitors[0].kind, 'pr-babysit')
  const l = lanes([a])
  assert.equal(l.done.length + l.idle.length + l.needs.length, 0)
  assert.equal(monitorsOf([a]).length, 1)
  assert.equal(counts([a]).watching, 1)
})

test('a monitor needs action when its last event needs a person', () => {
  const t = feed([...babysit, user(8, notification('b5sky', '[failed] lint on job 4/9'))])
  const a = classify({ session: session('idle'), t, alive: () => true, now: at(10) })
  assert.equal(a.monitors[0].state, 'action')
  assert.equal(a.state, 'needs')
  assert.equal(a.need, 'monitor')
  assert.equal(a.cmd, '[failed] lint on job 4/9')
  assert.equal(lanes([a]).needs.length, 1)
  const seen = classify({ session: session('idle'), t, alive: () => true, reviewedAt: at(9), now: at(10) })
  assert.equal(seen.monitors[0].state, 'watching')
  assert.notEqual(seen.state, 'needs')
})

// The [status] lines watch_logs.py prints, as it words them.
test('a logger’s crash, OOM, restart or BackOff is a crash event; its other status lines stay status', () => {
  const crashes = [
    '[status] api: exited, exit code 137 (OOM killed)',
    '[status] api: exited, exit code 1',
    '[status] api-7d9f-x2: CrashLoopBackOff',
    '[status] api-7d9f-x2: Error, OOMKilled',
    '[status] api-7d9f-x2: restarted (3 total)',
    '[status] api-7d9f-x2: ErrImagePull, ImagePullBackOff',
    '[status] api-7d9f-x2: CreateContainerConfigError',
  ]
  for (const line of crashes) assert.equal(eventTag(line), 'crash', line)
  const calm = [
    '[status] api: exited, exit code 0',
    '[status] api: container not found, waiting for it',
    '[status] api: container removed',
    '[status] pod added: error-reporter-7d9f-x2 (Pending)',
    '[status] pod gone: api-7d9f-x2',
    '[status] api-7d9f-x2: ContainerCreating',
    '[status] no pods match app=api in dev/default',
  ]
  for (const line of calm) assert.equal(eventTag(line), 'status', line)
  assert.equal(eventTag('[error] api: Traceback (most recent call last):'), 'error')
  assert.equal(eventTag('[watch] attached to api (since 2026-11-10T12:00:00Z)'), 'watch')
  assert.ok(brokeTags().has('crash'))

  const logger = [
    user(1, 'watch the api logs'),
    assistant(2, [tool('m1', 'Monitor', { command: 'python3 -u /s/watch_logs.py docker api 2>&1', description: 'api logs' })]),
    user(3, [result('m1', 'Monitor started (task lg1, expires in 30m unless the source ends first)')]),
    user(5, notification('lg1', '[status] api: exited, exit code 137 (OOM killed)')),
  ]
  const a = classify({ session: session('idle'), t: feed(logger), alive: () => true, now: at(10) })
  assert.deepEqual([a.monitors[0].kind, a.monitors[0].event!.tag, a.monitors[0].state, a.state], ['log-watcher', 'crash', 'action', 'needs'])
})

test('a tag left out of Settings’ Count as needing you doesn’t raise a monitor', () => {
  const before = process.env.AGENT_HUB_SETTINGS
  process.env.AGENT_HUB_SETTINGS = join(mkdtempSync(join(tmpdir(), 'hub-attention-')), 'settings.json')
  try {
    setSetting('hub.attention', ['stuck'])
    const t = feed([...babysit, user(8, notification('b5sky', '[failed] lint on job 4/9'))])
    assert.equal(classify({ session: session('idle'), t, alive: () => true, now: at(10) }).monitors[0].state, 'watching')
    const stuck = feed([...babysit, user(8, notification('b5sky', '[stuck] build waiting for a runner'))])
    assert.equal(classify({ session: session('idle'), t: stuck, alive: () => true, now: at(10) }).monitors[0].state, 'action')
  } finally {
    process.env.AGENT_HUB_SETTINGS = before
  }
})

test('the line that came with a watcher’s end is its last event', () => {
  const closed =
    '<task-notification>\n<task-id>b5sky</task-id>\n<status>completed</status>\n<summary>Monitor "PR #1 pipeline" stream ended</summary>\n<event>[closed] https://github.com/o/r/pull/1</event>\n</task-notification>'
  const a = classify({ session: session('idle'), t: feed([...babysit, user(9, closed)]), now: at(10) })
  assert.equal(a.monitors[0].state, 'ended')
  assert.deepEqual([a.monitors[0].event?.tag, a.monitors[0].event?.line], ['closed', '[closed] https://github.com/o/r/pull/1'])
})

test('a monitor whose command is gone is stale; an expired one ends', () => {
  let a = classify({ session: session('idle'), t: feed(babysit), alive: () => false, now: at(10) })
  assert.equal(a.monitors[0].state, 'stale')
  assert.match(a.monitors[0].command, /watch_pr\.py/, 'the hub finds its process by its command')
  const exited = '<task-notification>\n<task-id>b5sky</task-id>\n<status>failed</status>\n<summary>Monitor "PR #1 pipeline" exited with code 143</summary>\n</task-notification>'
  a = classify({ session: session('idle'), t: feed([...babysit, user(9, exited)]), now: at(10) })
  assert.equal(a.monitors[0].state, 'ended', 'a monitor the hub stopped ends')
  const t = feed([...babysit, user(9, notification('b5sky', '[Monitor expired after 30m]'))])
  a = classify({ session: session('idle'), t, alive: () => false, now: at(10) })
  assert.equal(a.monitors[0].state, 'ended')
  assert.equal(a.monitor, false)
  a = classify({ session: session('idle'), t, now: at(9) + 4 * 60 * 1000 })
  assert.equal(a.monitors.length, 1, 'an ended monitor stays a while, so you see it went')
  a = classify({ session: session('idle'), t, now: at(9) + 6 * 60 * 1000 })
  assert.equal(a.monitors.length, 0, 'and leaves after five minutes')
})

test('a stopped monitor leaves at once: by the hub, or by TaskStop', () => {
  let a = classify({ session: session('idle'), t: feed(babysit), alive: () => true, stopped: new Set(['b5sky']), now: at(10) })
  assert.equal(a.monitors.length, 0, 'the hub stopped it, before or after its exit is reported')
  assert.equal(a.monitor, false)
  const t = feed([...babysit, assistant(8, [tool('s1', 'TaskStop', { task_id: 'b5sky' })])])
  a = classify({ session: session('idle'), t, now: at(10) })
  assert.equal(a.monitors.length, 0)
})

test('a monitor armed before its session\'s process started ended with the last one', () => {
  const resumed = session('idle', { startedAt: at(20), statusUpdatedAt: at(20) })
  let a = classify({ session: resumed, t: feed(babysit), alive: () => true, now: at(30) })
  assert.equal(a.monitors[0].state, 'ended', 'even when its command line happens to still match')
  assert.equal(a.monitors[0].ended!.reason, 'restarted')
  a = classify({ session: resumed, t: feed(babysit), now: at(20) + 6 * 60 * 1000 })
  assert.equal(a.monitors.length, 0)
})

test('a notification for several tasks ends each of them', () => {
  const t = feed([
    ...babysit,
    assistant(7, [tool('m2', 'Monitor', { command: 'tail -f a.log', description: 'a.log errors' })]),
    user(8, [result('m2', 'Monitor started (task c7, expires in 30m)')]),
    user(9, '<task-notification>\n<task-id>b5sky</task-id>\n<task-id>c7</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>2 background shell command tasks didn\'t finish before the previous session ended.</summary>\n</task-notification>'),
  ])
  assert.ok(t.monitors.b5sky.ended)
  assert.ok(t.monitors.c7.ended)
})

test('a re-armed monitor shows once', () => {
  const t = feed([
    ...babysit,
    user(9, notification('b5sky', '[Monitor expired after 30m]')),
    assistant(10, [tool('m2', 'Monitor', { command: 'python3 -u /s/watch_pr.py x', description: 'PR #1 pipeline' })]),
    user(11, [result('m2', 'Monitor started (task c7, expires in 30m)')]),
  ])
  const a = classify({ session: session('idle'), t, alive: () => true, now: at(12) })
  assert.equal(a.monitors.length, 1)
  assert.equal(a.monitors[0].task, 'c7')
})

test('an older monitor of the same name still running shows once the newer one is stopped or has ended', () => {
  // Armed again without stopping the first.
  const twice = [
    ...babysit,
    assistant(10, [tool('m2', 'Monitor', { command: 'python3 -u /s/watch_pr.py x', description: 'PR #1 pipeline' })]),
    user(11, [result('m2', 'Monitor started (task c7, expires in 30m)')]),
  ]
  const tasks = (t: Transcript, stopped = new Set<string>()) =>
    classify({ session: session('idle'), t, alive: () => true, stopped, now: at(20) }).monitors.map(m => [m.task, m.state])
  assert.deepEqual(tasks(feed(twice)), [['c7', 'watching']], 'the newer one stands for both')
  assert.deepEqual(tasks(feed(twice), new Set(['c7'])), [['b5sky', 'watching']], 'stopped from the hub')
  assert.deepEqual(tasks(feed([...twice, assistant(12, [tool('s1', 'TaskStop', { task_id: 'c7' })])])), [['b5sky', 'watching']], 'stopped by TaskStop')
  assert.deepEqual(tasks(feed([...twice, user(12, notification('c7', '[Monitor expired after 30m]'))])), [['b5sky', 'watching']], 'expired')
})

test('a monitor\'s process is the newest shell under its session running its command', () => {
  const cmd = `tail -f app.log | grep --line-buffered 'ERROR'`
  const evald = (c: string) => `/usr/bin/zsh -c source snap.sh && eval '${c.replaceAll("'", `'"'"'`)}' && pwd -P`
  const procs = [
    { pid: 10, ppid: 1, pgid: 10, start: 100, cmdline: evald(cmd) },
    { pid: 11, ppid: 1, pgid: 11, start: 200, cmdline: evald(cmd) },
    { pid: 12, ppid: 2, pgid: 12, start: 300, cmdline: evald(cmd) }, // another session's
    { pid: 13, ppid: 1, pgid: 13, start: 400, cmdline: evald('while true; do sleep 60; done') },
    { pid: 14, ppid: 11, pgid: 11, start: 210, cmdline: 'tail -f app.log' }, // the pipeline, not the shell
    { pid: 15, ppid: 1, pgid: 15, start: 500, cmdline: evald(`pgrep -f "${cmd}"`) }, // a Bash call that mentions it
  ]
  assert.equal(monitorProcess(procs, 1, cmd)!.pid, 11)
  assert.equal(monitorProcess(procs, 2, cmd)!.pid, 12)
  assert.equal(monitorProcess(procs, 1, 'python3 watch.py'), null)
  assert.equal(monitorProcess(procs, 0, cmd), null)
  assert.equal(monitorProcess([{ pid: 20, ppid: 1, pgid: 20, start: 1, cmdline: `bash -c ${cmd}` }], 1, cmd)!.pid, 20)
})

test('a tab parked on a background job is one agent with it, shown in the tab', () => {
  const tab = session('busy', { sessionId: 'tab1', pid: 5, parkedJobId: 'job1', tmux: 'ghostty-1:@3.%4' })
  const job = session('idle', { sessionId: 'job1', pid: 6, kind: 'bg', jobId: 'job1' })
  const other = session('busy', { sessionId: 's9', pid: 7 })
  const out = pairParked([tab, job, other])
  assert.deepEqual(out.map(e => e.session.sessionId), ['job1', 's9'], 'the tab is not an agent of its own')
  assert.equal(out[0].viewer, tab, 'the job shows in the tab')
  assert.equal(out[1].viewer, null)
  const [alone] = pairParked([tab])
  assert.equal(alone.session.sessionId, 'tab1', 'a tab whose job is gone stays')
  assert.equal(alone.session.status, 'idle', 'not stuck at the status it parked with')
})

test('worktree sessions know their repo and worktree', () => {
  assert.deepEqual(repoOf('/p/gad/.claude/worktrees/comments'), { repo: 'gad', worktree: 'comments' })
  const a = classify({ session: session('idle', { cwd: '/p/gad/.claude/worktrees/comments' }), t: emptyTranscript() })
  assert.equal(a.repo, 'gad')
  assert.equal(a.worktree, 'comments')
  assert.equal(a.title, 'New session')
})

test('an agent is named by /rename, then --name, then Claude\'s title, then its first prompt', () => {
  const name = (entries: unknown[], extra?: Partial<Session>) => classify({ session: session('idle', extra), t: feed(entries) }).title
  const ai = { type: 'ai-title', aiTitle: 'Steam pixel art app' }
  const agent = { type: 'agent-name', agentName: 'gad-components' }
  const custom = { type: 'custom-title', customTitle: 'Sprite exporter' }
  assert.equal(name([user(1, 'make the sprites export\nand more')]), 'make the sprites export')
  assert.equal(name([user(1, 'go'), ai]), 'Steam pixel art app')
  assert.equal(name([user(1, 'go'), ai], { name: 'jstack-12', nameSource: 'derived' }), 'Steam pixel art app')
  assert.equal(name([user(1, 'go'), ai], { kind: 'bg', name: 'babysit #91' }), 'babysit #91')
  assert.equal(name([user(1, 'go'), ai, agent]), 'gad-components')
  assert.equal(name([user(1, 'go'), ai, agent, custom]), 'Sprite exporter')
})

test('lanes: needs and idle oldest first, working and done newest first', () => {
  const mk = (id: string, state: AgentState, since: number) => ({ id, state, since, monitor: false, monitors: [], prompt: 'go' })
  const l = lanes([mk('a', 'needs', 5), mk('b', 'needs', 1), mk('c', 'working', 1), mk('d', 'working', 5), mk('e', 'idle', 9), mk('f', 'idle', 2)])
  assert.deepEqual(l.needs.map(a => a.id), ['b', 'a'])
  assert.deepEqual(l.working.map(a => a.id), ['d', 'c'])
  assert.deepEqual(l.idle.map(a => a.id), ['f', 'e'])
})

test('lanes: a session started as a monitor stays out of Done and Idle once its watcher ended', () => {
  const mk = (id: string, state: AgentState, prompt: string) => ({ id, state, since: 1, monitor: false, monitors: [], prompt })
  const l = lanes([
    mk('pr', 'done', '/dominus:pr-babysit https://github.com/o/r/pull/1'),
    mk('pipe', 'idle', '/dominus:pipeline-watch github.com/o/r@main'),
    mk('ask', 'needs', '/dominus:pr-babysit https://github.com/o/r/pull/2'),
    mk('task', 'done', 'fix the build'),
  ])
  assert.deepEqual([l.done.map(a => a.id), l.idle.map(a => a.id), l.needs.map(a => a.id)], [['task'], [], ['ask']])
})

test('overflow: working compacts, done folds, needs never shrinks', () => {
  assert.deepEqual(cardHeights('working', 3, 20), [4, 4, 4])
  assert.deepEqual(cardHeights('working', 8, 20), Array(8).fill(3))
  assert.deepEqual(cardHeights('done', 5, 20), [4, 4, 1, 1, 1])
  assert.deepEqual(cardHeights('done', 5, 20, 3), [4, 4, 4, 1, 1], 'Settings can keep more done cards')
  assert.deepEqual(cardHeights('done', 2, 20, 0), [1, 1])
  assert.deepEqual(cardHeights('needs', 9, 10), Array(9).fill(4))
  assert.deepEqual(cardHeights('idle', 3, 10), [1, 1, 1])
})

test('scrollTo keeps the selected card on screen', () => {
  const h = Array(9).fill(4)
  assert.equal(scrollTo(h, 20, 0), 0)
  assert.equal(scrollTo(h, 20, 3), 0)
  assert.ok(scrollTo(h, 20, 8) > 0)
  const top = scrollTo(h, 20, 8)
  assert.ok(h.slice(top, 9).reduce((a, b) => a + b, 0) <= 20 - 2)
  assert.equal(scrollTo(h, 20, 2, 5), 2, 'scrolls back up to a card above')
})

test('launch: every task is a background agent, its options as claude --bg flags', () => {
  const p = launch({ kind: 'task', cwd: '/p/gad', prompt: "fix the user's page", model: 'sonnet', mode: 'default', effort: 'high' })
  assert.deepEqual(p.argv, ['claude', '--bg', '--name', 'fix-the-user-s-page', '--model', 'sonnet', '--effort', 'high', "fix the user's page"])
  const b = launch({ kind: 'task', cwd: '/p', prompt: 'write docs', mode: 'plan' })
  assert.deepEqual(b.argv, ['claude', '--bg', '--name', 'write-docs', '--permission-mode', 'plan', 'write docs'])
  const bw = launch({ kind: 'task', cwd: '/p', prompt: 'write docs', worktree: true })
  assert.deepEqual(bw.argv.slice(0, 4), ['claude', '--bg', '--name', 'write-docs'])
  assert.match(bw.argv.at(-1)!, /^From the hub: Before anything else, make your own worktree with the EnterWorktree tool [^\n]*\n\nMy prompt:\nwrite docs$/)
  assert.match(bw.argv.at(-1)!, /starting with the ticket key/, 'a ticket names the worktree')
})

test('launch: images pasted into a task follow its prompt with their paths, and stay out of its name', () => {
  const images = [{ n: 1, path: '/s/images/agent/a.png' }]
  const p = launch({ kind: 'task', cwd: '/p', prompt: 'fix [Image #1] layout', images })
  assert.deepEqual(p.argv.slice(0, 4), ['claude', '--bg', '--name', 'fix-layout'])
  // Their paths are the hub's words, in its paragraph; what was typed follows as typed.
  assert.equal(p.argv.at(-1), 'From the hub: The prompt has images attached: [Image #1] is /s/images/agent/a.png. Read each one with the Read tool before you start.\n\nMy prompt:\nfix [Image #1] layout')
  // A spec read from a file may hold anything there.
  const odd = launch({ kind: 'task', cwd: '/p', prompt: 'go', images: [{ n: 'x' }] as never })
  assert.equal(odd.argv.at(-1), 'go')
})

test('launch: PR babysitters and log watchers', () => {
  const pr = launch({ kind: 'monitor', skill: 'pr', cwd: '/p', target: ' https://github.com/u/gad/pull/91 ' })
  assert.deepEqual(pr.argv, ['claude', '--bg', '--name', 'monitor #91', '/dominus:pr-babysit https://github.com/u/gad/pull/91'])
  // The Monitors popup's attach options go after the target, on one line.
  const attached = launch({ kind: 'monitor', skill: 'pr', cwd: '/p', target: 'https://github.com/u/gad/pull/91', extra: 'until: merged;\n brief: be  quick ' })
  assert.equal(attached.argv.at(-1), '/dominus:pr-babysit https://github.com/u/gad/pull/91 until: merged; brief: be quick')
  const shot = launch({ kind: 'monitor', skill: 'pr', cwd: '/p', target: 'https://github.com/u/gad/pull/91', extra: 'brief: like [Image #1]', images: [{ n: 1, path: '/i/a.png' }] })
  assert.equal(shot.argv.at(-1), '/dominus:pr-babysit https://github.com/u/gad/pull/91 brief: like [Image #1]\nThe prompt has images attached: [Image #1] is /i/a.png. Read each one with the Read tool before you start.')
  const logs = launch({ kind: 'monitor', skill: 'logs', cwd: '/p', target: 'docker compose logs api' })
  assert.equal(logs.argv.at(-1), '/dominus:log-watcher watch docker compose logs api')
  assert.equal(launch({ kind: 'task', cwd: '/p', prompt: '-rf everything' }).argv.at(-1), ' -rf everything')
})

test('launch: what you typed is sent as typed, after the hub’s paragraph, and a monitor’s goes last', () => {
  const two = launch({ kind: 'task', cwd: '/p', prompt: '  fix the page\r\n\n  and the footer \n', worktree: true })
  assert.match(two.argv.at(-1)!, /\n\nMy prompt:\nfix the page\n\n {2}and the footer$/)
  assert.equal(two.argv.at(-1)!.split('\n\n').length, 3, 'the hub’s text is one paragraph')
  const brief = launch({ kind: 'monitor', skill: 'pr', cwd: '/p', target: 'https://github.com/u/gad/pull/91', extra: 'Attach options: until merged or closed.', typed: { label: 'Brief:', text: ' flaky e2e,\nretry once ' } })
  assert.equal(brief.argv.at(-1), '/dominus:pr-babysit https://github.com/u/gad/pull/91 Attach options: until merged or closed.\n\nBrief:\nflaky e2e,\nretry once')
  const none = launch({ kind: 'monitor', skill: 'pr', cwd: '/p', target: 'https://github.com/u/gad/pull/91', typed: { label: 'Brief:', text: '  ' } })
  assert.equal(none.argv.at(-1), '/dominus:pr-babysit https://github.com/u/gad/pull/91', 'no brief, no paragraph')
})

test('the card’s prompt line skips the hub’s paragraph and its label', () => {
  assert.equal(promptLine('From the hub: Before anything else, make a worktree.\n\nMy prompt:\nfix the page\nand more'), 'fix the page')
  assert.equal(promptLine('fix the page\n\nMy prompt:\nnot this'), 'fix the page', 'a prompt you typed yourself is left alone')
  assert.equal(promptLine('From the hub: only hub text'), 'From the hub: only hub text')
  assert.equal(promptLine('/dominus:pr-babysit https://x/pull/1\n\nBrief:\nquick'), '/dominus:pr-babysit https://x/pull/1', 'a monitor is still known by its command')
})

test('render clips to the width in cells, wide characters included', () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  assert.equal(strip(render([['hello']], 8)), 'hello   ')
  assert.equal(strip(render([['hello world']], 8)), 'hello w…')
  assert.equal(width(strip(render([['日本語のテキスト']], 7))), 7)
  assert.equal(strip(render([['▲ 5']], 3)), '▲ 5')
})

test('clean strips escape sequences from other people\'s text', () => {
  assert.equal(clean('ok\x1b]52;c;evil\x07 done\n'), 'ok ]52;c;evil  done ')
})

test('an agent runs in the sandbox only when its spec asks, and a monitor never does', () => {
  const settings = (argv: string[]) => argv[argv.indexOf('--settings') + 1]
  assert.ok(!launch({ kind: 'task', cwd: '/p', prompt: 'go' }).argv.includes('--settings'))
  assert.equal(settings(launch({ kind: 'task', cwd: '/p', prompt: 'go', sandbox: true }).argv), SANDBOX_SETTINGS)
  assert.equal(settings(launch({ kind: 'ticket', cwd: '/p', url: 'https://x/browse/A-1', lines: [], sandbox: true }).argv), SANDBOX_SETTINGS)
  assert.ok(!launch({ kind: 'monitor', skill: 'pr', cwd: '/p', target: 'https://x/pull/1', sandbox: true }).argv.includes('--settings'))
  const told = launch({ kind: 'task', cwd: '/p', prompt: 'go', sandbox: true }).argv.at(-1) ?? ''
  assert.match(told, /^From the hub: Your shell commands run in a sandbox\..*\n\nMy prompt:\ngo$/s, 'the rules go first, the prompt last')
  assert.ok(!(launch({ kind: 'task', cwd: '/p', prompt: 'go' }).argv.at(-1) ?? '').includes(agentText('sandbox')), 'no rules without the sandbox')
  const ticket = launch({ kind: 'ticket', cwd: '/p', url: 'https://x/browse/A-1', lines: ['Repo: /p'], sandbox: true }).argv.at(-1) ?? ''
  assert.equal(ticket.split('\n').at(-1), `From the hub: ${agentText('sandbox')}`)
  assert.ok(!(launch({ kind: 'monitor', skill: 'pr', cwd: '/p', target: 'https://x/pull/1', sandbox: true }).argv.at(-1) ?? '').includes(agentText('sandbox')))
})

test('the sandbox settings are strict, and tell rm-guard', () => {
  const s = JSON.parse(readFileSync(SANDBOX_SETTINGS, 'utf8'))
  assert.equal(s.sandbox.enabled, true)
  assert.equal(s.sandbox.autoAllowBashIfSandboxed, true)
  assert.equal(s.sandbox.allowUnsandboxedCommands, false, 'no retries outside the sandbox')
  assert.equal(s.sandbox.failIfUnavailable, true, 'no unsandboxed agent when bubblewrap is missing')
  assert.equal(s.env.DOMINUS_SANDBOX, '1', "jstack's rm-guard reads it")
})
