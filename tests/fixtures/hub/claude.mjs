// In the shapes Claude Code writes (as daemon.test.ts feeds model.ts).
// agentd keeps only sessions whose pid is a live process, so the caller
// passes live pids: its own for most, a tmux pane's for the tab session.

import { join } from 'node:path'

const M = 60_000

export function claudeWorld(box, base, { runner, panePid, pane, deadPid, monitorCmd, goneCmd }) {
  const iso = mins => new Date(base - mins * M - 5000).toISOString()
  const ms = mins => base - mins * M - 5000
  const projects = join(box.claude, 'projects')
  const cwd = repo => join(box.root, 'projects', repo)
  const slug = p => p.replace(/[^a-zA-Z0-9]/g, '-')

  const user = (m, content, extra = {}) => ({ type: 'user', timestamp: iso(m), message: { role: 'user', content }, ...extra })
  const assistant = (m, content, extra = {}) => ({
    type: 'assistant',
    timestamp: iso(m),
    gitBranch: 'main',
    message: { role: 'assistant', model: 'claude-opus-5-5', content, usage: { input_tokens: 10, cache_read_input_tokens: 42_000, cache_creation_input_tokens: 0 }, ...extra },
  })
  const tool = (id, name, input) => ({ type: 'tool_use', id, name, input })
  const result = (id, content = 'ok') => ({ type: 'tool_result', tool_use_id: id, content })
  const note = (task, line) =>
    `<task-notification>\n<task-id>${task}</task-id>\n<summary>Monitor event: "watch"</summary>\n<event>${line}</event>\n</task-notification>`
  const text = s => [{ type: 'text', text: s }]

  const sessions = []
  const session = (name, s, entries, { project } = {}) => {
    const file = { sessionId: name, cwd: cwd('dotfiles'), kind: 'interactive', status: 'idle', startedAt: ms(120), statusUpdatedAt: ms(30), ...s }
    sessions.push(file)
    box.write(join(box.claude, 'sessions', `${name}.json`), file)
    if (entries) box.write(join(projects, project ?? slug(file.cwd), `${name}.jsonl`), `${entries.map(e => JSON.stringify(e)).join('\n')}\n`)
    return file
  }

  // A tab waiting on a permission prompt: Claude's own pane on the tab server.
  session('tabperm', { pid: panePid, tmux: pane, status: 'waiting', statusUpdatedAt: ms(7) }, [
    user(10, 'Fix the build'),
    assistant(8, [tool('b1', 'Bash', { command: 'npm run build' })]),
  ])
  // Working, with a tool running; its transcript in another project folder.
  session(
    'busy',
    { pid: runner, status: 'busy', cwd: cwd('jstack'), statusUpdatedAt: ms(12) },
    [{ type: 'custom-title', customTitle: 'Parser work', timestamp: iso(13) }, user(12, 'Refactor the parser'), assistant(2, [tool('r1', 'Read', { file_path: join(cwd('jstack'), 'src', 'parse.js') })])],
    { project: 'elsewhere' },
  )
  // Finished and not yet looked at; and one you looked at since.
  session('done', { pid: runner, statusUpdatedAt: ms(15) }, [user(20, 'Fix the login bug'), assistant(15, text('**Merged** the fix.'), { stop_reason: 'end_turn' })])
  session('seen', { pid: runner, statusUpdatedAt: ms(40) }, [user(45, 'Tidy up'), assistant(40, text('Tidied.'), { stop_reason: 'end_turn' })])
  // A background job and the tab parked on it: one agent.
  session('bgjob', { pid: runner, kind: 'bg', jobId: 'job1', status: 'busy', name: 'nightly', nameSource: 'flag', statusUpdatedAt: ms(5) }, [user(6, 'Run the nightly')])
  session('parkedtab', { pid: runner, parkedJobId: 'job1', status: 'idle' }, [user(50, 'old')])
  // A tab parked on a job that's gone is idle.
  session('orphanpark', { pid: runner, parkedJobId: 'gone-job', status: 'busy', statusUpdatedAt: ms(9) }, [user(9, 'orphan')])
  // A waiting session whose own turn ended, asked through a background subagent.
  session('subperm', { pid: runner, status: 'waiting', statusUpdatedAt: ms(3) }, [
    user(30, 'Review the PR'),
    assistant(29, [tool('a1', 'Agent', { description: 'Run the tests', run_in_background: true })]),
    user(29, [result('a1', 'started')]),
    assistant(28, text('Started.'), { stop_reason: 'end_turn' }),
  ])
  box.write(
    join(projects, slug(cwd('dotfiles')), 'subperm', 'subagents', 'agent-x.jsonl'),
    `${JSON.stringify(assistant(3, [tool('s1', 'Bash', { command: 'npm test' })]))}\n`,
  )
  box.write(join(projects, slug(cwd('dotfiles')), 'subperm', 'subagents', 'agent-x.meta.json'), { description: 'Run the tests' })
  session('ask', { pid: runner, status: 'waiting', statusUpdatedAt: ms(4) }, [
    user(5, 'Add a cache'),
    assistant(4, [tool('q1', 'AskUserQuestion', { questions: [{ question: 'Which database?\nPick one.' }] })]),
  ])
  // Monitors: one whose command runs (watching), one whose doesn't (stale),
  // one that expired; and a session whose monitor saw [failed].
  session('monwatch', { pid: runner, kind: 'bg', jobId: 'job2', statusUpdatedAt: ms(20), startedAt: ms(60) }, [
    user(30, 'watch things'),
    assistant(29, [tool('m1', 'Monitor', { command: `${monitorCmd} 2>&1`, description: 'live one' })]),
    user(29, [result('m1', 'Monitor started (task t1, expires in 30m)')]),
    assistant(28, [tool('m2', 'Monitor', { command: goneCmd, description: 'gone one' })]),
    user(28, [result('m2', 'Monitor started (task t2, expires in 30m)')]),
    assistant(27, [tool('m3', 'Monitor', { command: `${monitorCmd} again`, description: 'expired one' })]),
    user(27, [result('m3', 'Monitor started (task t3, expires in 30m)')]),
    user(2, note('t3', '[Monitor expired after 30m]')),
    user(1, note('t1', '[pipeline] running 3/9')),
    assistant(1, text('Watching.'), { stop_reason: 'end_turn' }),
  ])
  session('monfail', { pid: runner, statusUpdatedAt: ms(20), startedAt: ms(60) }, [
    user(30, 'babysit'),
    assistant(29, [tool('m1', 'Monitor', { command: `${monitorCmd} fail`, description: 'MR !1 pipeline' })]),
    user(29, [result('m1', 'Monitor started (task f1, expires in 30m)')]),
    user(3, note('f1', '[failed] test:unit id=9 https://gitlab.example.com/g/r/-/jobs/9')),
    assistant(3, text('It failed.'), { stop_reason: 'end_turn' }),
  ])
  // Left out: a dead pid, a reused pid (start time differs), a file without a pid.
  session('dead', { pid: deadPid, status: 'busy' }, [user(1, 'x')])
  session('reused', { pid: runner, procStart: '1', status: 'busy' }, [user(1, 'x')])
  box.write(join(box.claude, 'sessions', 'broken.json'), '{ not json')
  box.write(join(box.claude, 'sessions', 'nopid.json'), { sessionId: 'nopid' })
  return sessions
}
