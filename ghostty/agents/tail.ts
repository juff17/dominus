// Following transcripts: finding a session's, reading only what was appended,
// and the subagents it has running.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../core/json.ts'
import { warnOnce } from '../core/log.ts'
import { type Transcript, addEntry, emptyTranscript } from './transcript.ts'
import { log, str, type Session } from './daemon.ts'

type SessionRef = Pick<Session, 'sessionId' | 'cwd'>

export function findTranscript(projects: string, s: SessionRef): string | null {
  const guess = join(projects, s.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${s.sessionId}.jsonl`)
  if (existsSync(guess)) return guess
  try {
    for (const dir of readdirSync(projects)) {
      const p = join(projects, dir, `${s.sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch (err) {
    warnOnce(log, 'projects folder unreadable', err, { path: projects })
  }
  return null
}

// `rest` is the bytes of a line not yet whole.
type Tail = { path: string; offset: number; rest: Buffer; t: Transcript }

// subs by file name
type SessionTail = Tail & { subs: Map<string, Tail> }

export type Subagent = { description: string; t: Transcript }

export type TranscriptReader = {
  read(s: SessionRef): Transcript
  subagents(s: SessionRef): Subagent[]
  keep(live: Set<string>): void
  cached(): string[]
}

const newTail = (path: string): Tail => ({ path, offset: 0, rest: Buffer.alloc(0), t: emptyTranscript() })

// A chunk at a time, decoding only whole lines: a long session's file can be
// bigger than one string may be, and a character can straddle two reads.
function tail(tr: Tail, chunk: number): Transcript {
  let size: number
  try {
    size = statSync(tr.path).size
  } catch (err) {
    warnOnce(log, 'transcript unreadable', err, { path: tr.path })
    return tr.t
  }
  if (size < tr.offset) Object.assign(tr, { offset: 0, rest: Buffer.alloc(0), t: emptyTranscript() })
  if (size === tr.offset) return tr.t
  const fd = openSync(tr.path, 'r')
  try {
    const buf = Buffer.alloc(chunk)
    while (tr.offset < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - tr.offset), tr.offset)
      if (n <= 0) break
      tr.offset += n
      const data = Buffer.concat([tr.rest, buf.subarray(0, n)])
      const end = data.lastIndexOf(10)
      tr.rest = Buffer.from(end < 0 ? data : data.subarray(end + 1))
      if (end >= 0) readLines(tr.t, data.subarray(0, end).toString('utf8'), tr.path)
    }
  } finally {
    closeSync(fd)
  }
  return tr.t
}

// A background subagent asks for permission in its own transcript,
// subagents/agent-<id>.jsonl beside the session's, while the session's own
// turn may have ended long ago. Their .meta.json says which have finished.
// Kept in tr.subs, so the next wait reads just what was added.
function readSubagents(tr: SessionTail, chunk: number): Subagent[] {
  const dir = join(tr.path.replace(/\.jsonl$/, ''), 'subagents')
  let files: string[] = []
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
  } catch (err) {
    warnOnce(log, 'subagents folder unreadable', err, { path: dir })
    return []
  }
  const out: Subagent[] = []
  for (const f of files) {
    const path = join(dir, f)
    let meta: unknown = {}
    try {
      meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
    } catch (err) {
      warnOnce(log, 'subagent meta unreadable', err, { path })
    }
    if (isRecord(meta) && meta.finished) {
      tr.subs.delete(f)
      continue
    }
    let sub = tr.subs.get(f)
    if (!sub) {
      sub = newTail(path)
      tr.subs.set(f, sub)
    }
    out.push({ description: (isRecord(meta) && str(meta.description)) || '', t: tail(sub, chunk) })
  }
  return out
}

// `chunk` is the read size, a parameter so tests can make lines straddle reads.
export function transcriptReader(projects: string, chunk = 1 << 20): TranscriptReader {
  const transcripts = new Map<string, SessionTail>()
  return {
    read(s) {
      let tr = transcripts.get(s.sessionId)
      if (!tr) {
        const path = findTranscript(projects, s)
        if (!path) return emptyTranscript()
        tr = { ...newTail(path), subs: new Map() }
        transcripts.set(s.sessionId, tr)
      }
      return tail(tr, chunk)
    },
    // Call after read(s).
    subagents(s) {
      const tr = transcripts.get(s.sessionId)
      return tr ? readSubagents(tr, chunk) : []
    },
    // Forgets the sessions that are gone, so a new one with a reused id starts over.
    keep(live) {
      for (const id of transcripts.keys()) if (!live.has(id)) transcripts.delete(id)
    },
    cached: () => [...transcripts.keys()],
  }
}

// Lines that can't matter (the request snapshots, which are most of the file)
// skip JSON parsing.
const WANTED = ['"type":"assistant"', '"type":"user"', '"queue-operation"', '-title"', '"type":"agent-name"']

export function readLines(t: Transcript, text: string, path = ''): void {
  for (const line of text.split('\n')) {
    if (line.startsWith('{"type":"api-request')) continue
    if (!WANTED.some(w => line.includes(w))) continue
    try {
      addEntry(t, JSON.parse(line))
    } catch (err) {
      warnOnce(log, 'transcript line skipped', err, { path })
    }
  }
}
