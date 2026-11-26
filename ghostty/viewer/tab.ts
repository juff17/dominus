// What the viewer's modes watch besides their own files: the tab session
// touches TAB_CHANGED when its active tab changes (tmux.conf).

import { watch } from 'node:fs'
import { basename, dirname } from 'node:path'

import { type Logger, errorMessage } from '../core/log.ts'
import { TAB_CHANGED } from '../core/paths.ts'

// fn each time `name` in `folder` changes. A folder that isn't there yet is
// logged and left: the mode's own refresh catches up.
export function watchName(folder: string, name: string, fn: () => void, log: Pick<Logger, 'warn'>): void {
  try {
    watch(folder, (_, changed) => {
      if (changed === name) fn()
    })
  } catch (err) {
    log.warn('not watching a folder', { path: folder, err: errorMessage(err) })
  }
}

// Outside the layout there's no such folder, and nothing changes tabs.
export const onTabChanged = (fn: () => void, log: Pick<Logger, 'warn'>): void => watchName(dirname(TAB_CHANGED), basename(TAB_CHANGED), fn, log)
