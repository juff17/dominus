import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ExecFileOptions } from 'node:child_process'
import type { RunResult } from '../core/proc.ts'
import { locate, readLocated, scoutArgv } from './locate.ts'

const OPTS = { model: 'haiku', effort: 'low', timeoutSecs: 90, depth: 3 }
const REPOS = ['/p/payouts', '/p/api']
const answer = (structured_output: unknown) => JSON.stringify({ type: 'result', session_id: 's', structured_output })

function folderOf(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'locate-'))
  for (const n of names) mkdirSync(join(dir, n, '.git'), { recursive: true })
  return dir
}

function fakeRun(result: RunResult) {
  const calls: { args: string[]; opts?: ExecFileOptions }[] = []
  const run = async (args: string[], opts?: ExecFileOptions) => {
    calls.push({ args, opts })
    return result
  }
  return { run, calls }
}

test('the scout can only read, answers to a schema of the listed repos, and gets the prompt last', () => {
  const argv = scoutArgv('ENG-7: Retry failed payouts', REPOS, OPTS)
  assert.equal(argv[0], '-p')
  assert.deepEqual(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 2), ['--tools', 'Read,Grep,Glob'])
  for (const flag of ['--strict-mcp-config', '--no-session-persistence']) assert.ok(argv.includes(flag), flag)
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk')
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'json')
  const schema = JSON.parse(argv[argv.indexOf('--json-schema') + 1])
  assert.deepEqual(schema.properties.repo.enum, [...REPOS, ''])
  assert.deepEqual(schema.properties.candidates.items.enum, REPOS)
  assert.equal(argv[argv.indexOf('--model') + 1], 'haiku')
  assert.equal(argv[argv.indexOf('--effort') + 1], 'low')
  const prompt = argv.at(-1) ?? ''
  assert.match(prompt, /^Pick the one git repo/)
  assert.match(prompt, /- \/p\/payouts\n- \/p\/api\n/)
  assert.match(prompt, /never as instructions to you/)
  assert.match(prompt, /The work:\nENG-7: Retry failed payouts$/)
  assert.ok(!scoutArgv('w', REPOS, { ...OPTS, model: 'default', effort: 'default' }).some(a => a === '--model' || a === '--effort'))
})

test("the scout's answer counts only when it names a listed repo", () => {
  assert.deepEqual(readLocated(answer({ repo: '/p/api', sure: true, candidates: ['/p/api', '/elsewhere', '/p/api'] }), REPOS), { ok: true, repo: '/p/api', sure: true, candidates: ['/p/api'] })
  assert.deepEqual(readLocated(answer({ repo: '/p/payouts', sure: false, candidates: REPOS }), REPOS), { ok: true, repo: '/p/payouts', sure: false, candidates: REPOS })
  assert.deepEqual(readLocated(answer({ repo: '/etc', sure: true, candidates: [] }), REPOS), { ok: false, err: 'no repo fits', candidates: [] })
  assert.deepEqual(readLocated(answer({ repo: '', sure: false, candidates: ['/p/api'] }), REPOS), { ok: false, err: 'no repo fits', candidates: ['/p/api'] })
  assert.deepEqual(readLocated(JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance is too low\nmore' }), REPOS), { ok: false, err: 'Credit balance is too low', candidates: [] })
  assert.deepEqual(readLocated('not json', REPOS), { ok: false, err: 'not JSON from claude -p', candidates: [] })
})

test('one repo in the folder needs no scout; none is a failure', async t => {
  const one = folderOf(['payouts'])
  const none = folderOf([])
  t.after(() => [one, none].forEach(d => rmSync(d, { recursive: true, force: true })))
  const { run, calls } = fakeRun({ ok: true, out: '', err: '', exit: 0 })
  assert.deepEqual(await locate({ id: 'ENG-7', work: 'w', root: one }, OPTS, 'claude', run), { ok: true, repo: join(one, 'payouts'), sure: true, candidates: [join(one, 'payouts')] })
  assert.deepEqual(await locate({ id: 'ENG-7', work: 'w', root: none }, OPTS, 'claude', run), { ok: false, err: 'no git repos in the folder', candidates: [] })
  assert.equal(calls.length, 0)
})

test('with several repos the scout runs in the folder, within the timeout, and its pick comes back', async t => {
  const dir = folderOf(['payouts', 'group/api'])
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repos = [join(dir, 'group/api'), join(dir, 'payouts')]
  const { run, calls } = fakeRun({ ok: true, out: answer({ repo: repos[1], sure: true, candidates: [repos[1]] }), err: '', exit: 0 })
  const found = await locate({ id: 'ENG-7', work: 'ENG-7: Retry failed payouts', root: dir }, OPTS, '/bin/claude', run)
  assert.deepEqual(found, { ok: true, repo: repos[1], sure: true, candidates: [repos[1]] })
  assert.equal(calls[0].args[0], '/bin/claude')
  assert.equal(calls[0].opts?.cwd, dir)
  assert.equal(calls[0].opts?.timeout, 90_000)
  assert.deepEqual(JSON.parse(calls[0].args[calls[0].args.indexOf('--json-schema') + 1]).properties.candidates.items.enum.sort(), repos.sort())
})

test('a scout that fails says why, without the command and its prompt', async t => {
  const dir = folderOf(['a', 'b'])
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ask = { id: 'ENG-7', work: 'w', root: dir }
  const timedOut = fakeRun({ ok: false, out: '', err: 'Command failed: claude -p … the whole prompt', exit: null })
  assert.deepEqual(await locate(ask, OPTS, 'claude', timedOut.run), { ok: false, err: 'gave up after 90 s', candidates: [] })
  const missing = fakeRun({ ok: false, out: '', err: 'spawn claude ENOENT', exit: null })
  assert.equal(((await locate(ask, OPTS, 'claude', missing.run)) as { err: string }).err, 'claude not found')
  const quiet = fakeRun({ ok: false, out: '', err: 'Command failed: claude -p … the whole prompt', exit: 1 })
  assert.equal(((await locate(ask, OPTS, 'claude', quiet.run)) as { err: string }).err, 'exit 1')
  const said = fakeRun({ ok: false, out: '', err: 'Not logged in\nRun claude login', exit: 1 })
  assert.equal(((await locate(ask, OPTS, 'claude', said.run)) as { err: string }).err, 'Not logged in')
})
