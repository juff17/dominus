// The hub's skills (pr-babysit, pipeline-watch, log-watcher, todo) come from
// its own Claude Code plugin, hub-plugin/, where a prompt names a skill as
// /dominus:<skill>. Sessions started before the plugin named them bare
// (/pr-babysit), so what reads a prompt back accepts both.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isRecord } from './json.ts'
import { errCode, errorMessage, logger } from './log.ts'
import { CLAUDE_DIR } from './paths.ts'
import { t } from './text.ts'

const log = logger('hub-skills')

export const HUB_PLUGIN = 'dominus'
// As install.sh installs it: the plugin from the marketplace of the same name.
export const HUB_PLUGIN_ID = `${HUB_PLUGIN}@${HUB_PLUGIN}`

type Read = { missing: true } | { missing: false; value?: unknown }

function readJson(path: string): Read {
  try {
    return { missing: false, value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (err) {
    if (errCode(err) === 'ENOENT') return { missing: true }
    log.warn('claude config unreadable', { path, err: errorMessage(err) })
    return { missing: false }
  }
}

// Without the plugin, a session started on /dominus:<skill> only says the
// command doesn't exist, so the todo filer and monitor starts check first.
// A file that can't be read or parsed counts as installed: a wrong "not
// installed" would block work that might run.
export function pluginInstalled(dir = CLAUDE_DIR): boolean {
  const list = readJson(join(dir, 'plugins', 'installed_plugins.json'))
  if (list.missing) return false
  const plugins = isRecord(list.value) && isRecord(list.value.plugins) ? list.value.plugins : undefined
  if (plugins && !(HUB_PLUGIN_ID in plugins)) return false
  const settings = readJson(join(dir, 'settings.json'))
  const value = settings.missing ? undefined : settings.value
  const enabled = isRecord(value) && isRecord(value.enabledPlugins) ? value.enabledPlugins[HUB_PLUGIN_ID] : undefined
  return enabled !== false
}

export const pluginMissing = (): string => t('hub.pluginMissing')

// The slash command that runs one of the hub's skills.
export const skillCommand = (skill: string): string => `/${HUB_PLUGIN}:${skill}`

// The slash command at the start of a prompt, as a pattern for one or more
// skills (an alternation such as 'log-watcher|logger'), with or without the
// plugin's name.
export const skillAt = (skills: string): string => `^/(?:${HUB_PLUGIN}:)?(?:${skills})\\b`
