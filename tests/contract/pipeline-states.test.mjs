// Contract between agent_hub.forge (pipeline-watch and pr-babysit, Python)
// and the Alt+M Pipelines view (viewer/monitors/pipelines.ts): the same jobs
// get the same job and stage states on both sides. Where they group GitHub
// jobs differently (forge by the name before " / ", Alt+M one stage per job)
// each GitHub job is compared on its own.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { CONF, REPO } from '../harness.mjs'

const { gitlabJobState, githubJobState, stageOf } = await import(join(CONF, 'viewer/monitors/pipelines.ts'))
const hasPython = spawnSync('python3', ['--version']).status === 0

// What agent_hub.forge makes of `input`: each GitLab status, each GitHub
// status and conclusion, and the state of each stage of GitLab jobs.
function python(input) {
  const code = `
import json, sys
from agent_hub.forge import GitHub, GitLab, stages
d = json.load(sys.stdin)
gl = {s: GitLab.JOB_STATUS.get(s, "waiting") for s in d["gitlab"]}
gh = [GitHub.check_status({"status": s, "conclusion": c}) for s, c in d["github"]]
checks = [{"id": i, "group": g, "job": f"j{i}", "status": GitLab.JOB_STATUS.get(s, "waiting"), "allow_failure": o}
          for g, jobs in d["stages"] for i, (s, o) in enumerate(jobs)]
st = {s["name"]: s["status"] for s in stages(checks)}
print(json.dumps({"gitlab": gl, "github": gh, "stages": st}))
`
  const r = spawnSync('python3', ['-c', code], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: join(REPO, 'hub-plugin/lib/py') },
  })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

const GITLAB = ['created', 'pending', 'preparing', 'waiting_for_resource', 'scheduled', 'running', 'success', 'failed', 'canceled', 'canceling', 'skipped', 'manual', 'something_new']
const GITHUB = [
  ['queued', null],
  ['requested', null],
  ['pending', null],
  ['waiting', null],
  ['in_progress', null],
  ...['success', 'neutral', 'skipped', 'cancelled', 'stale', 'action_required', 'failure', 'timed_out', 'startup_failure', null, 'something_new'].map(c => ['completed', c]),
]
// [stage, [[status, allow_failure]…]]
const STAGES = [
  ['all-passed', [['success', false], ['success', false]]],
  ['one-failed', [['success', false], ['failed', false]]],
  ['optional-failed', [['success', false], ['failed', true]]],
  ['only-optional-failed', [['failed', true]]],
  ['running', [['success', false], ['running', false]]],
  ['queued', [['pending', false], ['created', false]]],
  ['manual', [['success', false], ['manual', false]]],
  ['not-started', [['created', false], ['scheduled', false]]],
  ['canceled', [['success', false], ['canceled', false]]],
  ['canceled-and-skipped', [['canceled', false], ['skipped', false]]],
  ['failed-beats-running', [['failed', false], ['running', false]]],
  ['optional-still-running', [['success', false], ['running', true]]],
]

test('agent_hub.forge and Alt+M give each GitLab and GitHub job the same state', { skip: !hasPython }, () => {
  const py = python({ gitlab: GITLAB, github: GITHUB, stages: [] })
  assert.deepEqual(Object.fromEntries(GITLAB.map(s => [s, gitlabJobState(s)])), py.gitlab)
  assert.deepEqual(
    GITHUB.map(([s, c]) => githubJobState(s, c ?? '')),
    py.github,
  )
})

test('agent_hub.forge and Alt+M give each GitLab stage the same state', { skip: !hasPython }, () => {
  const py = python({ gitlab: [], github: [], stages: STAGES })
  const node = Object.fromEntries(STAGES.map(([name, jobs]) => [name, stageOf(jobs.map(([s, o]) => ({ state: gitlabJobState(s), optional: o })))]))
  assert.deepEqual(node, py.stages)
  // forge leaves out a stage whose jobs were all skipped; Alt+M draws it skipped.
  const skipped = [['skipped', false], ['skipped', false]]
  assert.deepEqual(python({ gitlab: [], github: [], stages: [['all-skipped', skipped]] }).stages, {})
  assert.equal(stageOf(skipped.map(([s, o]) => ({ state: gitlabJobState(s), optional: o }))), 'skipped')
})
