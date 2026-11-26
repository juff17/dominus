// Contract between pr-babysit and log-watcher (Python) and the hub and tray
// (Node): Settings keys, approval.py's proposal files (made for real against a
// fake gh/glab), notes, and watch_pr.py's event lines as Monitor notifications.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { CONF, REPO, sandbox } from '../harness.mjs'
import { HERE as FIXTURES, LOGGER, SCRIPTS, nodeJson, stubDir } from '../fixtures/shell/lib.mjs'

const settings = await import(join(CONF, 'settings/catalog.ts'))
const read = f => readFileSync(f, 'utf8')
const hasPython = spawnSync('python3', ['--version']).status === 0
const hasJq = spawnSync('jq', ['--version']).status === 0
const URL = 'https://github.com/u/gad/pull/91'
const GL_URL = 'https://gitlab.com/g/proj/-/merge_requests/5'

// ------------------------------------------------------------ settings

const pyValue = s => (s === 'True' ? true : s === 'False' ? false : s.startsWith('"') ? s.slice(1, -1) : Number(s))
const pyTuple = s =>
  s
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
    .map(pyValue)

// [file, kind, key, default, min/choices, max]
function pythonReads() {
  const out = []
  const files = { 'watch_pr.py': join(SCRIPTS, 'watch_pr.py'), 'approval.py': join(SCRIPTS, 'approval.py'), 'watch_logs.py': join(LOGGER, 'watch_logs.py'), 'watch_pipeline.py': join(REPO, 'hub-plugin/skills/pipeline-watch/scripts/watch_pipeline.py') }
  for (const [name, file] of Object.entries(files)) {
    const text = read(file)
    for (const m of text.matchAll(/\bsetting\("([\w.]+)", (\d+), (\d+), (\d+)\)/g)) out.push([name, 'number', m[1], Number(m[2]), Number(m[3]), Number(m[4])])
    for (const m of text.matchAll(/\b(?:w\.)?choice\((f?)"([\w.{}]+)", ([\w"]+), \(([^)]*)\)\)/g)) {
      if (m[1]) {
        // approval.py's policy(): approvals.{kind} for the kinds that don't return before it.
        const kinds = pyTuple(text.match(/^KINDS = \(([^)]*)\)/m)[1]).filter(k => k !== 'reply' && k !== 'deploy' && k !== 'comment')
        for (const k of kinds) out.push([name, 'choice', m[2].replace('{kind}', k), pyValue(m[3]), pyTuple(m[4])])
      } else out.push([name, 'choice', m[2], pyValue(m[3]), pyTuple(m[4])])
    }
  }
  return out
}

test('the Settings keys Python reads are these', () => {
  assert.deepEqual(
    pythonReads().map(r => r.slice(0, 3).join(' ')),
    [
      'watch_pr.py number prBabysit.interval',
      'watch_pr.py number prBabysit.stuckAfter',
      'watch_pr.py number prBabysit.errorAfter',
      'watch_pr.py choice prBabysit.autoFix',
      'watch_pr.py choice prBabysit.autoRebase',
      'watch_pr.py choice approvals.reply',
      'watch_pr.py choice prBabysit.notifyStage',
      'approval.py choice approvals.reply',
      'approval.py choice approvals.push',
      'approval.py choice approvals.retry',
      'approval.py choice approvals.manual',
      'approval.py choice approvals.move',
      'watch_logs.py number logger.traceLines',
      'watch_logs.py number logger.lineChars',
      'watch_logs.py number logger.floodLimit',
      'watch_logs.py number logger.dedup',
      'watch_pipeline.py number prBabysit.errorAfter',
    ],
  )
})

test('each key Python reads has the same default and range or choices in settings.ts', () => {
  for (const [file, kind, key, def, a, b] of pythonReads()) {
    const r = settings.row(key)
    assert.ok(r, `${file} reads ${key}, which settings.ts doesn't have`)
    assert.deepEqual(r.default, def, `${file}: ${key}'s default`)
    if (kind === 'number') {
      assert.equal(r.type, 'number', key)
      assert.deepEqual([r.min, r.max], [a, b], `${file}: ${key}'s range`)
    } else if (r.type === 'bool') assert.deepEqual(a, [true, false], key)
    else {
      assert.equal(r.type, 'choice', key)
      assert.deepEqual(new Set(r.choices.map(c => c.value)), new Set(a), `${file}: ${key}'s choices`)
    }
  }
})

const pyRead = (box, module, expr) => {
  const dir = module === 'watch_logs' ? LOGGER : SCRIPTS
  const r = spawnSync('python3', ['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(dir)}); import ${module} as m; print(json.dumps(${expr}))`], { env: box.env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
const nodeGet = (box, key) => nodeJson(box, `const s = await import(${JSON.stringify(join(CONF, 'settings/settings.ts'))}); console.log(JSON.stringify(s.get(${JSON.stringify(key)})))`)

test('Python and Node read the same file differently where their checks differ', { skip: !hasPython }, () => {
  const box = sandbox('contract-py')
  try {
    const both = (key, value, expr, module = 'watch_pr') => {
      box.settings({ [key]: value })
      return { node: nodeGet(box, key), python: pyRead(box, module, expr) }
    }
    const interval = 'm.setting("prBabysit.interval", 60, 15, 600)'
    assert.deepEqual(both('prBabysit.interval', 90, interval), { node: 90, python: 90 })
    assert.deepEqual(both('prBabysit.interval', 900, interval), { node: 60, python: 60 })
    assert.deepEqual(both('prBabysit.interval', true, interval), { node: 60, python: 60 })
    assert.deepEqual(both('prBabysit.interval', '90', interval), { node: 60, python: 60 })
    // watch_pr takes what Settings shows: any finite number in range.
    assert.deepEqual(both('prBabysit.interval', 60.5, interval), { node: 60.5, python: 60.5 })
    // Neither checks the step (15 s in Settings), so 61 reads as 61 in both.
    assert.deepEqual(both('prBabysit.interval', 61, interval), { node: 61, python: 61 })
    // watch_logs takes what Settings shows: any finite number in range, never a bool.
    const dedup = 'm.setting("logger.dedup", 120, 0, 3600)'
    assert.deepEqual(both('logger.dedup', 45.5, dedup, 'watch_logs'), { node: 45.5, python: 45.5 })
    assert.deepEqual(both('logger.dedup', 1, dedup, 'watch_logs'), { node: 1, python: 1 })
    assert.deepEqual(both('logger.dedup', true, dedup, 'watch_logs'), { node: 120, python: 120 })
    assert.deepEqual(both('logger.dedup', false, dedup, 'watch_logs'), { node: 120, python: 120 })
    assert.deepEqual(both('logger.dedup', 3600.5, dedup, 'watch_logs'), { node: 120, python: 120 })
    // A number is never a bool, as with Node's ===: both read the default.
    const autoFix = 'm.choice("prBabysit.autoFix", True, (True, False))'
    assert.deepEqual(both('prBabysit.autoFix', 0, autoFix), { node: true, python: true })
    assert.deepEqual(both('prBabysit.autoFix', false, autoFix), { node: false, python: false })
    const stage = 'm.choice("prBabysit.notifyStage", False, (True, False))'
    assert.deepEqual(both('prBabysit.notifyStage', 1, stage), { node: false, python: false })
    assert.deepEqual(both('approvals.retry', 'auto', 'm.choice("approvals.retry", "ask", ("ask", "auto"))'), { node: 'auto', python: 'auto' })
    assert.deepEqual(both('approvals.retry', 'yes', 'm.choice("approvals.retry", "ask", ("ask", "auto"))'), { node: 'ask', python: 'ask' })
    box.write(box.env.AGENT_HUB_SETTINGS, '{ broken')
    assert.deepEqual({ node: nodeGet(box, 'prBabysit.interval'), python: pyRead(box, 'watch_pr', interval) }, { node: 60, python: 60 })
  } finally {
    box.cleanup()
  }
})

// ------------------------------------------------------------ approvals → tray

// A sandbox where gh and glab are the fake forge, and python runs pr-babysit's scripts.
function forgeBox(name) {
  const box = sandbox(name)
  const bin = stubDir(box)
  for (const cli of ['gh', 'glab']) writeFileSync(join(bin, cli), `#!/bin/sh\nexec python3 -I ${JSON.stringify(join(REPO, 'hub-plugin/tests/fixtures/pr_babysit/fake_gh_argv.py'))} "$@"\n`, { mode: 0o755 })
  Object.assign(box.env, {
    FAKE_LOG: join(box.root, 'forge.log'),
    FAKE_REPLIES: join(box.root, 'replies.json'),
    CLAUDE_CODE_SESSION_ID: 'claude-1',
    TMUX_PANE: '%7',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GIT_CONFIG_NOSYSTEM: '1',
  })
  return box
}
const py = (box, script, ...args) => spawnSync('python3', ['-I', join(SCRIPTS, script), ...args], { env: box.env, encoding: 'utf8', cwd: box.home })
const git = (box, cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: box.env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

// approval_test.py's repo(): a bare remote with feat, and a clone on babysit/91 two commits past it.
function repo(box) {
  const remote = join(box.root, 'remote.git')
  const clone = join(box.root, 'clone')
  git(box, box.root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(box, box.root, 'clone', '-q', remote, clone)
  writeFileSync(join(clone, 'cache.py'), 'ttl = 300\n')
  git(box, clone, 'add', '.')
  git(box, clone, 'commit', '-qm', 'base')
  git(box, clone, 'push', '-q', 'origin', 'HEAD:feat')
  const lease = git(box, clone, 'rev-parse', 'HEAD')
  git(box, clone, 'checkout', '-qb', 'babysit/91')
  for (const [i, text] of ['ttl = 300\nvalid = True\n', 'cache_ttl_seconds = 300\nvalid = True\n'].entries()) {
    writeFileSync(join(clone, 'cache.py'), text)
    git(box, clone, 'commit', '-qam', `fix ${i}`)
  }
  const r = py(box, 'watch_pr.py', URL, '--session', 's1', '--set', `lease_sha=${lease}`, '--set', `worktree=${clone}`, '--set', 'branch=feat', '--set', 'remote=origin')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return clone
}

const proposed = r => {
  const m = r.stdout.match(/^\[(proposed|failed|auto)\] (\S+) /m)
  assert.ok(m, `approval.py said: ${r.stdout}${r.stderr}`)
  return m[2]
}

const AGENT = { id: 'claude-1', title: 'babysit', repo: 'gad', worktree: '', kind: 'tab', pane: { pane: '%7', tab: 2, win: 3 }, monitors: [], state: 'idle' }
const trayProbe = (box, extra = '') =>
  nodeJson(
    box,
    `const t = await import(${JSON.stringify(join(CONF, 'tray/tray.ts'))})
const approvals = t.readApprovals()
const out = t.trayItems([${JSON.stringify(AGENT)}], new Set(), new Set(), [], approvals)
console.log(JSON.stringify({ approvals, items: out.items.map(({ since, age, ...it }) => it), counts: out.counts, links: approvals.map(t.proposalLink) ${extra} }))`,
  )

test('approval.py’s proposals of each kind are the tray rows tray.ts makes of them', { skip: !hasPython }, () => {
  const box = forgeBox('contract-approvals')
  try {
    writeFileSync(
      box.env.FAKE_REPLIES,
      JSON.stringify({
        'repos/u/gad/pulls/comments/55': { user: { login: 'alice' }, path: 'src/auth.py', line: 42, body: 'Cache first?', html_url: `${URL}#discussion_r55` },
        'repos/u/gad/pulls/comments/56': { user: { login: 'bob' }, body: 'Why?', html_url: `${URL}#discussion_r56` },
        'repos/u/gad/actions/jobs/77': { name: 'build', run_id: 555 },
        'repos/u/gad/actions/jobs/78': { name: 'lint', run_id: 555 },
        'repos/u/gad/actions/jobs/78/rerun': 'fail',
        'repos/u/gad/actions/jobs/88': { name: 'deploy-prod', run_id: 556 },
        'repos/u/gad/actions/runs/556/pending_deployments': [{ environment: { id: 1, name: 'prod' }, current_user_can_approve: true }],
        'projects/g%2Fproj/jobs/99': { name: 'e2e', stage: 'test' },
      }),
    )
    const ids = {}
    ids.reply = proposed(py(box, 'approval.py', 'propose', 'reply', URL, '--session', 's1', '--comment', 'rc:55', '--body', 'Fixed in 3f9a1c2.'))
    ids.long = proposed(py(box, 'approval.py', 'propose', 'reply', URL, '--session', 's1', '--comment', 'rc:56', '--body', 'x'.repeat(201)))
    ids.retry = proposed(py(box, 'approval.py', 'propose', 'retry', URL, '--session', 's1', '--job', '77', '--name', 'build', '--reason', 'runner lost'))
    // A manual job on GitHub is a deployment approval.
    ids.deploy = proposed(py(box, 'approval.py', 'propose', 'manual', URL, '--session', 's1', '--job', '88', '--name', 'deploy-prod'))
    ids.manual = proposed(py(box, 'approval.py', 'propose', 'manual', GL_URL, '--session', 's2', '--job', '99', '--name', 'e2e', '--stage', 'test'))
    repo(box)
    ids.push = proposed(py(box, 'approval.py', 'propose', 'push', URL, '--session', 's1', '--check', 'lint=ok'))
    // Auto retry, whose rerun the forge refuses: a failed proposal.
    box.settings({ 'approvals.retry': 'auto' })
    const failed = py(box, 'approval.py', 'propose', 'retry', URL, '--session', 's1', '--job', '78', '--name', 'lint')
    assert.equal(failed.status, 1)
    ids.failed = proposed(failed)
    box.settings({})
    // A rejected one leaves the tray.
    assert.equal(py(box, 'approval.py', 'reject', ids.long).status, 0)

    const { approvals, items, counts, links } = trayProbe(box)
    assert.deepEqual(
      approvals.map(p => [p.id, p.kind, p.status]),
      [
        [ids.reply, 'reply', 'pending'],
        [ids.retry, 'retry', 'pending'],
        [ids.deploy, 'deploy', 'pending'],
        [ids.manual, 'manual', 'pending'],
        [ids.push, 'push', 'pending'],
        [ids.failed, 'retry', 'failed'],
      ],
    )
    const row = id => items.find(it => it.approval === id)
    assert.deepEqual(row(ids.reply), {
      section: 'you',
      glyph: '↩',
      id: `a:${ids.reply}`,
      agent: 'claude-1',
      title: 'Reply to @alice on src/auth.py:42',
      meta: 'gad #91 · babysit · reply',
      actions: ['post', 'edit', 'skip'],
      kind: 'reply',
      approval: ids.reply,
      link: { url: `${URL}#discussion_r55`, label: 'Comment' },
      preview: 'Fixed in 3f9a1c2.',
      new: true,
    })
    assert.deepEqual(row(ids.retry), {
      section: 'broke',
      glyph: '✗',
      id: `a:${ids.retry}`,
      agent: 'claude-1',
      title: 'build failed, looks flaky',
      meta: 'gad #91 · runner lost',
      actions: ['retry', 'go'],
      kind: 'retry',
      approval: ids.retry,
      link: { url: 'https://github.com/u/gad/actions/runs/555/job/77', label: 'Job' },
      preview: '',
      new: true,
    })
    assert.deepEqual(
      [row(ids.deploy).title, row(ids.deploy).meta, row(ids.deploy).actions, row(ids.deploy).link, row(ids.deploy).glyph, row(ids.deploy).section],
      ['Approve deploy-prod (prod)', 'gad #91 · deployment', ['approve', 'skip'], { url: 'https://github.com/u/gad/actions/runs/556', label: 'Run' }, '▶', 'you'],
    )
    assert.deepEqual(
      [row(ids.manual).title, row(ids.manual).meta, row(ids.manual).actions, row(ids.manual).link],
      ['Run e2e', 'proj !5 · test stage', ['run', 'skip'], { url: 'https://gitlab.com/g/proj/-/jobs/99', label: 'Job' }],
    )
    assert.deepEqual(
      [row(ids.push).title, row(ids.push).meta, row(ids.push).actions, row(ids.push).link, row(ids.push).glyph],
      ['Push 2 commits to feat', 'gad #91 · babysit/91 → feat · +2 −1', ['push', 'review', 'go'], { url: URL, label: 'PR' }, '↑'],
    )
    const f = items.find(it => it.id === `af:${ids.failed}`)
    assert.deepEqual([f.section, f.glyph, f.title, f.meta, f.actions], ['broke', '✗', 'Retry lint failed', 'gad #91 · HTTP 422: Unprocessable', ['again', 'go', 'dismiss']])
    assert.deepEqual(counts, { you: 4, broke: 2, work: 0, watch: 0, done: 0 })
    assert.equal(links.length, 6)
  } finally {
    box.cleanup()
  }
})

test('with Approvals › Also show buttons off, a proposal row only opens the popup or the session', { skip: !hasPython }, () => {
  const box = forgeBox('contract-approvals')
  try {
    writeFileSync(box.env.FAKE_REPLIES, JSON.stringify({ 'repos/u/gad/pulls/comments/55': { user: { login: 'alice' }, body: 'Hm', html_url: `${URL}#discussion_r55` } }))
    proposed(py(box, 'approval.py', 'propose', 'reply', URL, '--session', 's1', '--comment', 'rc:55', '--body', 'Done.'))
    box.settings({ 'approvals.trayButtons': false })
    assert.deepEqual(trayProbe(box).items[0].actions, ['review', 'go'])
  } finally {
    box.cleanup()
  }
})

// ------------------------------------------------------------ notes → tray

test('notify.sh’s and watch_pr.py’s notes are what readNotes reads; old ones go', { skip: !hasPython || !hasJq }, () => {
  const box = forgeBox('contract-notes')
  try {
    const r = spawnSync(join(SCRIPTS, 'notify.sh'), ['jstack !123', 'A fix is ready to push'], { env: box.env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const t = spawnSync(
      'python3',
      ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(SCRIPTS)}); import watch_pr; watch_pr.tray_note("feat: ci passed", "build ✓")`],
      { env: { ...box.env, CLAUDE_CODE_SESSION_ID: 'claude-9', TMUX_PANE: '' }, encoding: 'utf8' },
    )
    assert.equal(t.status, 0, t.stderr)
    const notes = join(box.runtime, 'agent-hub', 'notes')
    // A day and a bit old, past tray.noteHours (24).
    writeFileSync(join(notes, '0000-old.json'), JSON.stringify({ title: 'old', message: 'gone', at: Date.now() - 25 * 3600 * 1000 }))
    const got = nodeJson(
      box,
      `const t = await import(${JSON.stringify(join(CONF, 'tray/tray.ts'))})
const notes = t.readNotes()
const out = t.trayItems([${JSON.stringify(AGENT)}], new Set(), new Set(), notes, [])
console.log(JSON.stringify({ notes, items: out.items.map(({ since, age, ...it }) => it) }))`,
    )
    assert.equal(existsSync(join(notes, '0000-old.json')), false)
    assert.deepEqual(
      got.notes.map(({ at, file, ...n }) => [n, typeof at, /^\d+-\d+$/.test(file)]),
      [
        // tmux: the server the pane is on, unset here, so the tray won't match by pane.
        [{ title: 'jstack !123', message: 'A fix is ready to push', session: 'claude-1', pane: '%7', tmux: '' }, 'number', true],
        [{ title: 'feat: ci passed', message: 'build ✓', session: 'claude-9', pane: '', tmux: '' }, 'number', true],
      ],
    )
    assert.deepEqual(
      got.items.map(it => [it.id.startsWith('n:'), it.section, it.glyph, it.agent, it.title, it.meta, it.actions]),
      [
        // The session that wrote it is an agent the tray knows: Go and Dismiss.
        [true, 'you', '▲', 'claude-1', 'A fix is ready to push', 'jstack !123 · gad · tab 2', ['go', 'dismiss']],
        [true, 'you', '▲', '', 'build ✓', 'feat: ci passed', ['dismiss']],
      ],
    )
    assert.deepEqual(readdirSync(notes).filter(f => !f.endsWith('.json')), [])
  } finally {
    box.cleanup()
  }
})

// ------------------------------------------------------------ watch_pr events → hub and tray

const SHA = 'abcdef0123456789'
const check = (id, name, status, extra = {}) => ({
  id,
  name,
  group: 'ci',
  job: name,
  status,
  url: `https://github.com/u/gad/actions/runs/555/job/${id}`,
  waited: 0,
  started: null,
  finished: null,
  allow_failure: false,
  ...extra,
})

function report(box, snap) {
  const file = box.write('snap.json', { sha: SHA, branch: 'feat', base: 'main', reviews: [], comments: [], ...snap })
  const r = spawnSync('python3', ['-I', join(FIXTURES, 'watch_pr_report.py'), SCRIPTS, file, 'me'], { env: box.env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.split('\n').filter(Boolean)
}

// The notification Claude Code writes into the transcript for a Monitor
// event, its text HTML-escaped as it is there.
const htmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const notification = (task, lines) =>
  `<task-notification>\n<task-id>${task}</task-id>\n<summary>Monitor event: "babysit #91"</summary>\n<event>${htmlEscape(lines.join('\n'))}</event>\n</task-notification>`

test('watch_pr.py’s event lines survive parseNotification, and monitorLink finds each one’s address', { skip: !hasPython }, () => {
  const box = sandbox('contract-events')
  try {
    const lines = report(box, {
      checks: [check(77, 'build', 'failed'), check(78, 'deploy', 'manual'), check(79, 'test', 'pending', { waited: 45 })],
      comments: [{ id: 'rc:55', author: 'alice', where: 'src/a.py:3', body: 'Use "x" & <y>', url: `${URL}#discussion_r55`, resolved: false }],
    })
    assert.deepEqual(lines, [
      '[failed] build id=77 https://github.com/u/gad/actions/runs/555/job/77 | ci ✗',
      '[manual] deploy id=78 https://github.com/u/gad/actions/runs/555/job/78 | ci ✗',
      '[stuck] test has waited 45 min for a runner id=79 https://github.com/u/gad/actions/runs/555/job/79 | ci ✗',
      `[comment] @alice on src/a.py:3: "Use "x" & <y>" id=rc:55 ${URL}#discussion_r55`,
    ])
    const got = nodeJson(
      box,
      `const m = await import(${JSON.stringify(join(CONF, 'agents/model.ts'))})
const t = await import(${JSON.stringify(join(CONF, 'tray/tray.ts'))})
const n = m.parseNotification(${JSON.stringify(notification('bx7', lines))})
console.log(JSON.stringify({ n, links: n.lines.map(line => t.monitorLink({ event: { line } })), watched: t.monitorLink({ command: 'python3 watch_pr.py ${URL} --session s1' }) }))`,
    )
    assert.deepEqual(got.n, { id: 'bx7', ids: ['bx7'], summary: 'Monitor event: "babysit #91"', lines })
    assert.deepEqual(got.links, [
      { url: 'https://github.com/u/gad/actions/runs/555/job/77', label: 'Job' },
      { url: 'https://github.com/u/gad/actions/runs/555/job/78', label: 'Job' },
      { url: 'https://github.com/u/gad/actions/runs/555/job/79', label: 'Job' },
      { url: `${URL}#discussion_r55`, label: 'Comment' },
    ])
    assert.deepEqual(got.watched, { url: URL, label: 'PR' })
  } finally {
    box.cleanup()
  }
})

test('a [failed] event makes the babysit a ✗ row, which a retry proposal for the same id= replaces', { skip: !hasPython }, () => {
  const box = sandbox('contract-events')
  try {
    const [line] = report(box, { checks: [check(77, 'build', 'failed'), check(78, 'test', 'running')] })
    assert.equal(line, '[failed] build id=77 https://github.com/u/gad/actions/runs/555/job/77 | ci ✗')
    const at = '2026-11-09T12:00:00.000Z'
    const entries = [
      { type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Monitor', input: { description: 'babysit #91', command: `python3 watch_pr.py ${URL} --session s1` } }] } },
      { type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Monitor started as task bx7' }] } },
      { type: 'user', timestamp: '2026-11-09T12:01:00.000Z', message: { content: notification('bx7', [line]) } },
    ]
    const retry = { id: '1-retry-aa', kind: 'retry', status: 'pending', at: 1, title: 'Retry build', pr: { url: URL, project: 'u/gad', forge: 'github', repo: 'gad', ref: '#91' }, job: { id: '77', name: 'build', run_id: 555, reason: '' }, claude_session: 'claude-1' }
    const got = nodeJson(
      box,
      `const m = await import(${JSON.stringify(join(CONF, 'agents/model.ts'))})
const tray = await import(${JSON.stringify(join(CONF, 'tray/tray.ts'))})
const t = m.emptyTranscript()
for (const e of ${JSON.stringify(entries)}) m.addEntry(t, e)
const now = Date.parse('2026-11-09T12:02:00.000Z')
const a = m.classify({ session: { sessionId: 'claude-1', pid: 1, cwd: '/home/u/gad', status: 'idle', startedAt: 0, statusUpdatedAt: 0 }, t, alive: () => true, now })
const strip = out => out.items.map(({ since, age, agent, ...it }) => it)
console.log(JSON.stringify({
  agent: { state: a.state, need: a.need, cmd: a.cmd, monitor: a.monitors.map(x => ({ state: x.state, kind: x.kind, event: x.event })) },
  alone: strip(tray.trayItems([a], new Set(), new Set(), [], [], now)),
  proposed: strip(tray.trayItems([a], new Set(), new Set(), [], [${JSON.stringify(retry)}], now)),
}))`,
    )
    assert.deepEqual(got.agent, {
      state: 'needs',
      need: 'monitor',
      cmd: line,
      monitor: [{ state: 'action', kind: 'pr-babysit', event: { line, tag: 'failed', at: Date.parse('2026-11-09T12:01:00.000Z') } }],
    })
    assert.deepEqual(got.alone, [
      {
        section: 'broke',
        glyph: '✗',
        id: `m:claude-1:bx7:${Date.parse('2026-11-09T12:01:00.000Z')}`,
        title: line,
        meta: 'gad · babysit #91',
        actions: ['go'],
        link: { url: 'https://github.com/u/gad/actions/runs/555/job/77', label: 'Job' },
        new: true,
      },
    ])
    // The proposal stands in for the watcher's line about job 77.
    assert.deepEqual(
      got.proposed.map(it => it.id),
      ['a:1-retry-aa'],
    )
  } finally {
    box.cleanup()
  }
})

test('the tray hides only lines whose id= is a proposal’s job id, as a string', () => {
  // GitHub's job ids are numbers in watch_pr.py's events and strings in approval.py's files
  // (argparse); the tray compares them as strings.
  const tray = read(join(CONF, 'tray/items.ts'))
  assert.match(tray, /const proposed = new Set\(approvals\.map\(p => String\(p\.job\?\.id \?\? ''\)\)\.filter\(Boolean\)\)/)
  assert.match(tray, /m\.event\?\.line\?\.match\(\/\\bid=\(\\S\+\)\/\)/)
  const watch = read(join(SCRIPTS, 'watch_pr.py'))
  assert.match(watch, /emit\(tag, f"\{c\['name'\]\}\{note\} id=\{c\['id'\]\} \{c\['url'\]\}\{tail\}"\)/)
  assert.match(watch, /emit\("stuck", f"\{c\['name'\]\} has waited \{int\(c\['waited'\]\)\} min for a runner "\n\s+f"id=\{c\['id'\]\} \{c\['url'\]\}\{tail\}"\)/)
})
