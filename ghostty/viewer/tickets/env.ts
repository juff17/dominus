// The tracker's credentials live in .env at the install root, never in
// settings.json, argv or a log. Install copies .env.example there; you fill
// it in. Only a fetch reads a value, and the setup screen and Settings only
// ask whether each key is set.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CONF } from '../../core/paths.ts'

// The repo root: CONF is the real ghostty folder, as Node resolves the links
// install makes in ~/.config/ghostty.
export const envFile = (): string => process.env.DOMINUS_ENV_FILE || join(CONF, '..', '.env')

export const JIRA_KEYS = ['JIRA_SITE', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_TOKEN_KIND'] as const
export type JiraKey = (typeof JIRA_KEYS)[number]
// The ones a fetch can't do without.
export const JIRA_NEEDED: readonly JiraKey[] = ['JIRA_SITE', 'JIRA_EMAIL', 'JIRA_API_TOKEN']

// KEY=value lines. A value may be quoted; an unquoted one ends at " #".
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*export\s+/, '').trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    const q = value[0]
    if ((q === '"' || q === "'") && value.indexOf(q, 1) > 0) value = value.slice(1, value.indexOf(q, 1))
    else value = value.replace(/\s+#.*$/, '').trim()
    out[key] = value
  }
  return out
}

export type EnvSource = { file?: string; environ?: Record<string, string | undefined>; read?: (file: string) => string }

// A value already in the environment wins over the file's, so tests and CI
// need no file. A missing or unreadable file reads as empty.
export function readEnv({ file = envFile(), environ = process.env, read = f => readFileSync(f, 'utf8') }: EnvSource = {}): Record<string, string> {
  let fromFile: Record<string, string> = {}
  try {
    fromFile = parseEnv(read(file))
  } catch {
    // No .env yet: the setup screen says so, by key.
  }
  const out: Record<string, string> = { ...fromFile }
  for (const k of JIRA_KEYS) {
    const v = environ[k]
    if (v) out[k] = v
  }
  return out
}

// Whether each key has a value: what the setup screen and Settings show, so
// neither ever holds the values themselves.
export function envSet(source: EnvSource = {}): Record<JiraKey, boolean> {
  const env = readEnv(source)
  return Object.fromEntries(JIRA_KEYS.map(k => [k, !!env[k]])) as Record<JiraKey, boolean>
}
