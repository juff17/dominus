// Background agents with no process: Claude Code still lists them as active
// (`claude agents --json`), but they have no session file agentd could read,
// as after a reboot or when the background service went away. They show in
// Idle, marked stopped, until they're restarted or stopped for good.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { isRecord } from '../core/json.ts'
import { logger, warnOnce } from '../core/log.ts'
import { t } from '../core/text.ts'
import { type Agent, repoOf } from './classify.ts'
import { findTranscript } from './daemon.ts'
import { promptLine } from './text.ts'
import { addEntry, emptyTranscript } from './transcript.ts'

const log = logger('agentd')
// Enough of a transcript's start to hold the prompt it began with.
const HEAD_BYTES = 256 * 1024

// One background session as `claude agents --json` lists it.
export type Job = { id: string; sessionId: string; name: string; cwd: string; startedAt: number; live: boolean }

// What isn't a background job, or lacks an id, is left out.
export function parseJobs(json: unknown): Job[] | null {
  if (!Array.isArray(json)) return null
  return json.flatMap((v): Job[] => {
    if (!isRecord(v) || v.kind !== 'background') return []
    const { id, sessionId } = v
    if (typeof id !== 'string' || !id || typeof sessionId !== 'string' || !sessionId) return []
    return [
      {
        id,
        sessionId,
        name: typeof v.name === 'string' ? v.name : '',
        cwd: typeof v.cwd === 'string' ? v.cwd : '',
        startedAt: typeof v.startedAt === 'number' ? v.startedAt : 0,
        live: typeof v.pid === 'number' && v.pid > 0,
      },
    ]
  })
}

// A session that agentd reads live is never also stopped, even when the
// listing was taken before its process came up.
export const stoppedJobs = (jobs: readonly Job[], live: ReadonlySet<string>): Job[] => jobs.filter(j => !j.live && !live.has(j.sessionId))

// The first prompt you typed, from whole lines of the transcript's start. A
// session started as a monitor (/pr-babysit …) is known by it, which keeps
// it out of Idle as a live one is (board.ts lanes).
function firstPrompt(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, head, 0, HEAD_BYTES, 0)
    const lines = head.subarray(0, n).toString('utf8').split('\n')
    // A read that filled the buffer may have cut its last line.
    if (n === HEAD_BYTES) lines.pop()
    const tr = emptyTranscript()
    for (const line of lines) {
      if (tr.prompt) break
      if (line.trim()) addEntry(tr, JSON.parse(line))
    }
    return promptLine(tr.prompt?.text)
  } finally {
    closeSync(fd)
  }
}

function fromTranscript(path: string | null): { prompt: string; at: number } {
  if (!path) return { prompt: '', at: 0 }
  const at = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0
  try {
    return { prompt: firstPrompt(path), at }
  } catch (err) {
    warnOnce(log, 'transcript head unreadable', err, { path })
    return { prompt: '', at }
  }
}

export function stoppedAgent(projects: string, j: Job): Agent {
  const { repo, worktree } = repoOf(j.cwd)
  const { prompt, at } = fromTranscript(findTranscript(projects, { sessionId: j.sessionId, cwd: j.cwd }))
  // When it last did anything: its transcript's last write, else its start.
  const since = at || j.startedAt
  return {
    id: j.sessionId,
    pid: 0,
    kind: 'bg',
    title: j.name || repo,
    repo,
    worktree,
    cwd: j.cwd,
    branch: '',
    state: 'idle',
    need: null,
    via: '',
    cmd: t('agents.cmd.stopped'),
    since,
    stateSince: since,
    prompt,
    ctx: 0,
    model: '',
    jobId: j.id,
    pane: null,
    monitor: false,
    monitors: [],
    stopped: true,
  }
}
