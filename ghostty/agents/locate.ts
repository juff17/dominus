// Picks the one repo a piece of work belongs in before its agent starts, so
// the agent starts in that repo and its sandbox covers it alone, not every
// repo under the folder. A claude -p with only Read, Grep and Glob does the
// picking: it can't write anything, and its answer must name a listed repo.

import { isRecord } from '../core/json.ts'
import { logger } from '../core/log.ts'
import type { Runner } from '../core/proc.ts'
import { scoutPrompt } from '../core/prompts/scout.ts'
import { reposUnder } from '../core/repos.ts'

const log = logger('locate')

export type LocateOptions = { model: string; effort: string; timeoutSecs: number; depth: number }
// `work` is what the agent will do, as the scout reads it: a ticket's key,
// summary and description, or a todo. `root` is the folder holding the repos.
export type LocateAsk = { id: string; work: string; root: string }
// `candidates` are the repos that might fit, best first. Every path in a
// result is one of the repos under root.
export type Located = { ok: true; repo: string; sure: boolean; candidates: string[] } | { ok: false; err: string; candidates: string[] }

const schema = (repos: readonly string[]) => ({
  type: 'object',
  additionalProperties: false,
  required: ['repo', 'sure', 'candidates'],
  properties: {
    repo: { type: 'string', enum: [...repos, ''] },
    sure: { type: 'boolean' },
    candidates: { type: 'array', items: { type: 'string', enum: [...repos] } },
  },
})

// --tools is variadic, so options that take one value come after it and the
// prompt goes last.
export function scoutArgv(work: string, repos: readonly string[], opts: LocateOptions): string[] {
  const argv = ['-p', '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--no-session-persistence', '--output-format', 'json']
  argv.push('--json-schema', JSON.stringify(schema(repos)))
  if (opts.model && opts.model !== 'default') argv.push('--model', opts.model)
  if (opts.effort && opts.effort !== 'default') argv.push('--effort', opts.effort)
  argv.push(scoutPrompt(work, repos))
  return argv
}

// claude -p --output-format json prints one object; the answer is in its
// structured_output, which a run that didn't finish leaves out.
export function readLocated(out: string, repos: readonly string[]): Located {
  let v: unknown
  try {
    v = JSON.parse(out)
  } catch {
    return { ok: false, err: 'not JSON from claude -p', candidates: [] }
  }
  const answer = isRecord(v) ? v.structured_output : undefined
  if (!isRecord(answer)) {
    const said = isRecord(v) && typeof v.result === 'string' ? v.result.trim().split('\n')[0]?.slice(0, 160) : ''
    return { ok: false, err: said || 'no answer from claude -p', candidates: [] }
  }
  const known = new Set(repos)
  const listed = Array.isArray(answer.candidates) ? answer.candidates : []
  const candidates = [...new Set(listed.filter((c): c is string => typeof c === 'string' && known.has(c)))]
  const repo = typeof answer.repo === 'string' && known.has(answer.repo) ? answer.repo : ''
  if (!repo) return { ok: false, err: 'no repo fits', candidates }
  return { ok: true, repo, sure: answer.sure === true, candidates }
}

// exit is null when claude didn't start or the timeout's signal ended it.
// With no stderr, execFile's message is the whole command, prompt and all,
// which stays out of the log.
function failure(err: string, exit: number | null, timeoutSecs: number): string {
  if (exit === null) return /ENOENT/.test(err) ? 'claude not found' : `gave up after ${timeoutSecs} s`
  const first = err.split('\n')[0] ?? ''
  return first && !first.startsWith('Command failed') ? first.slice(0, 160) : `exit ${exit}`
}

export async function locate(ask: LocateAsk, opts: LocateOptions, claude: string, run: Runner, now: () => number = Date.now): Promise<Located> {
  const repos = reposUnder(ask.root, opts.depth)
  // No choice to make: no scout.
  if (repos.length === 0) return { ok: false, err: 'no git repos in the folder', candidates: [] }
  if (repos.length === 1) return { ok: true, repo: repos[0], sure: true, candidates: repos }
  const started = now()
  log.debug('locate start', { id: ask.id, path: ask.root, n: repos.length, model: opts.model })
  const r = await run([claude, ...scoutArgv(ask.work, repos, opts)], { cwd: ask.root, timeout: opts.timeoutSecs * 1000, maxBuffer: 8 * 1024 * 1024 })
  const found: Located = r.ok ? readLocated(r.out, repos) : { ok: false, err: failure(r.err, r.exit, opts.timeoutSecs), candidates: [] }
  const ms = now() - started
  if (found.ok) log.info('repo located', { id: ask.id, path: found.repo, sure: found.sure, n: found.candidates.length, ms })
  else log.warn('repo not located', { id: ask.id, err: found.err, n: found.candidates.length, exit: r.exit, ms })
  return found
}
