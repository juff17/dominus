// agentd and the hub hit the same fallback failure every second until it's
// fixed, so each is a warning once per process and debug after that. ENOENT
// is how most of these reads learn that something has gone, not a failure,
// so it's debug from the start.

import { type Fields, type Logger, errCode } from '../core/log.ts'

const messageOf = (err: unknown): string =>
  String((typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined) ?? err)

const said = new Set<string>()

export function warnOnce(log: Logger, message: string, err: unknown, fields: Fields = {}): void {
  const failure = { ...fields, err: messageOf(err) }
  if (errCode(err) === 'ENOENT') {
    log.debug(message, failure)
    return
  }
  const key = `${message}\0${fields.path ?? ''}\0${fields.cmd ?? ''}\0${failure.err}`
  if (said.has(key)) {
    log.debug(message, failure)
    return
  }
  if (said.size > 1000) said.clear()
  said.add(key)
  log.warn(message, failure)
}
