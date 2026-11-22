import type { Fields, Logger } from '../core/log.ts'

export { logCrashes } from '../core/crash.ts'

export type Failing = {
  failed(key: string, message: string, fields?: Fields): void
  ok(key: string): void
}

// For what runs on a timer: a warn when a check starts failing, not on every
// poll while it stays down, and another once it has worked again.
export function failing(log: Pick<Logger, 'warn'>): Failing {
  const down = new Set<string>()
  return {
    failed(key, message, fields) {
      if (down.has(key)) return
      down.add(key)
      log.warn(message, fields)
    },
    ok(key) {
      down.delete(key)
    },
  }
}
