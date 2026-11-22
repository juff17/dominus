// 'uncaughtExceptionMonitor' runs ahead of Node's own handling without
// replacing it, and sees unhandled rejections too, so stderr and the exit code
// stay Node's: bin/ghostty-hub and bin/ghostty-viewer rely on them.

import type { Logger } from './log.ts'

type CrashSource = Pick<NodeJS.Process, 'on'>

export function logCrashes(log: Logger, on: CrashSource = process): void {
  on.on('uncaughtExceptionMonitor', (err: unknown, origin: string) => {
    const error = err instanceof Error ? err : new Error(String(err))
    log.error('crashed', { origin, err: error.message, stack: error.stack })
  })
}
