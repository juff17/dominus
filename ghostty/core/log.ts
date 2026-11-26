// See docs/logging.md. It never writes to stdout or stderr, which are the
// TUIs' screens and the tray's JSON, and a log it can't write is dropped
// rather than break the program.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Level = 'debug' | 'info' | 'warn' | 'error'
// An Error under any key becomes err and stack.
export type Fields = Record<string, unknown>

export const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
// Past this a log moves to <component>.log.1, replacing the one there.
export const MAX_BYTES = 1024 * 1024
// Writes between checks of the file's size.
const CHECK_EVERY = 100

const isLevel = (name: string | undefined): name is Level => name !== undefined && Object.hasOwn(LEVELS, name)

// Read on each call, so a test can point them elsewhere after importing.
export const logDir = (): string =>
  process.env.AGENT_HUB_LOG_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agent-hub', 'logs')
export function threshold(): number {
  const name = process.env.AGENT_HUB_LOG_LEVEL
  if (isLevel(name)) return LEVELS[name]
  return process.env.AGENT_HUB_DEBUG === '1' ? LEVELS.debug : LEVELS.info
}

function fieldsOf(fields: Fields | undefined): Fields {
  const out: Fields = {}
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v === undefined) continue
    if (v instanceof Error) {
      out.err = v.message
      if (v.stack) out.stack = v.stack
    } else out[k] = typeof v === 'bigint' ? String(v) : v
  }
  return out
}

function json(fields: Fields | undefined): string {
  try {
    return JSON.stringify(fieldsOf(fields))
  } catch (e) {
    return JSON.stringify({ logError: `fields not serializable: ${errorMessage(e)}` })
  }
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))
export const errCode = (e: unknown): unknown => (typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined)

export function format(level: Level, component: string, message: string, fields: Fields = {}, now = new Date()): string {
  return `${now.toISOString()} ${level.toUpperCase()} ${component}: ${message} ${json(fields)}`
}

type Writer = { dir: string; count: number }
const writers = new Map<string, Writer>()

function writer(component: string): Writer {
  let w = writers.get(component)
  if (!w) {
    w = { dir: '', count: 0 }
    writers.set(component, w)
  }
  return w
}

function write(component: string, line: string): void {
  try {
    const dir = logDir()
    const w = writer(component)
    const file = join(dir, `${component}.log`)
    if (w.dir !== dir) {
      mkdirSync(dir, { recursive: true })
      w.dir = dir
      w.count = 0
    }
    if (w.count++ % CHECK_EVERY === 0) {
      try {
        if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
      } catch {
        // No file yet: nothing to rotate.
      }
    }
    try {
      appendFileSync(file, `${line}\n`)
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw e
      // The logs were cleared after this writer made the folder: make it again,
      // or every later line of a long-lived process is lost.
      mkdirSync(dir, { recursive: true })
      appendFileSync(file, `${line}\n`)
    }
  } catch {
    // A log that can't be written mustn't break what it describes.
  }
}

export type Logger = {
  component: string
  enabled(level: Level): boolean
  debug(message: string, fields?: Fields): void
  info(message: string, fields?: Fields): void
  warn(message: string, fields?: Fields): void
  error(message: string, fields?: Fields): void
  child(fields: Fields): Logger
  span<T>(name: string, fields: Fields, fn: () => T, opts?: { level?: Level }): T
}

// The Claude session a line was written under, so it leads back to the
// transcript. Only programs Claude runs (hooks, skill scripts) have one.
export function withSession(fields: Fields): Fields {
  const session = process.env.CLAUDE_CODE_SESSION_ID
  return session && fields.claude_session === undefined ? { ...fields, claude_session: session } : fields
}

// `enabled(level)` lets a hot path skip building fields.
export function logger(component: string, base: Fields = {}): Logger {
  const at = (level: Level, message: string, fields?: Fields) => {
    if (LEVELS[level] < threshold()) return
    write(component, format(level, component, message, withSession({ ...base, ...fields })))
  }
  return {
    component,
    enabled: level => LEVELS[level] >= threshold(),
    debug: (message, fields) => at('debug', message, fields),
    info: (message, fields) => at('info', message, fields),
    warn: (message, fields) => at('warn', message, fields),
    error: (message, fields) => at('error', message, fields),
    child: fields => logger(component, { ...base, ...fields }),
    // fn may be sync or async. `level` is the end's level; the start is always
    // debug, a failure always error.
    span(name, fields, fn, { level = 'info' } = {}) {
      const started = performance.now()
      const ms = () => Math.round(performance.now() - started)
      at('debug', `${name} start`, fields)
      const done = () => at(level, `${name} done`, { ...fields, ms: ms() })
      const failed = (e: unknown): never => {
        at('error', `${name} failed`, { ...fields, ms: ms(), err: errorMessage(e), stack: e instanceof Error ? e.stack : undefined })
        throw e
      }
      let out: ReturnType<typeof fn>
      try {
        out = fn()
      } catch (e) {
        return failed(e)
      }
      if (out instanceof Promise) {
        return out.then(v => {
          done()
          return v
        }, failed) as typeof out
      }
      done()
      return out
    },
  }
}

// For a failure hit again and again (agentd and the hub retry every second
// until it's fixed): a warning once per process and debug after that. ENOENT
// is how most such reads learn that something has gone, not a failure, so
// it's debug from the start.
const warned = new Set<string>()
const messageOf = (err: unknown): string =>
  String((typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined) ?? err)

export function warnOnce(log: Logger, message: string, err: unknown, fields: Fields = {}): void {
  const failure = { ...fields, err: messageOf(err) }
  if (errCode(err) === 'ENOENT') {
    log.debug(message, failure)
    return
  }
  const key = `${message}\0${fields.path ?? ''}\0${fields.cmd ?? ''}\0${failure.err}`
  if (warned.has(key)) {
    log.debug(message, failure)
    return
  }
  if (warned.size > 1000) warned.clear()
  warned.add(key)
  log.warn(message, failure)
}
