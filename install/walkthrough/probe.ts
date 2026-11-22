// What this machine already has, for plan.ts: Debian packages, yazi, Claude
// Code and this repo's plugins, and whether KDE Plasma 6 is running. Only
// reads; every command that fails counts as "not there".

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type AptInfo, type Probe, parseAptShow } from './plan.ts'

export const PLUGIN = 'dominus@dominus'
export const DIAGRAMS = 'diagram-pane@dominus'
const DIAGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'diagram-plugin')
// mermaid.ts renders with it; puppeteer's own Chrome isn't downloaded.
export const CHROME = '/usr/bin/google-chrome'

const run = (cmd: string, args: string[]): { ok: boolean; out: string } => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] })
  return { ok: r.status === 0, out: r.stdout ?? '' }
}

export const onPath = (cmd: string): boolean => run('sh', ['-c', 'command -v "$1"', 'sh', cmd]).ok

// The claude Claude Code's installer puts in ~/.local/bin, which isn't always
// on PATH yet.
export function claudeCommand(): string | null {
  if (onPath('claude')) return 'claude'
  const local = join(homedir(), '.local', 'bin', 'claude')
  return existsSync(local) ? local : null
}

export function installed(pkgs: string[]): Set<string> {
  const r = run('dpkg-query', ['-W', '-f', '${Package} ${db:Status-Status}\\n', ...pkgs])
  return new Set(r.out.split('\n').flatMap(l => (/^(\S+) installed$/.exec(l.trim()) ? [l.split(' ')[0]] : [])))
}

export function aptInfo(pkg: string): AptInfo | undefined {
  const r = run('apt-cache', ['show', '--no-all-versions', pkg])
  return r.ok ? (parseAptShow(r.out) ?? undefined) : undefined
}

// The plugins installed at user scope; an unreadable list counts as none.
export function userPlugins(claude: string | null): Set<string> {
  if (!claude) return new Set()
  const r = run(claude, ['plugin', 'list', '--json'])
  try {
    const list: unknown = JSON.parse(r.out)
    if (!Array.isArray(list)) return new Set()
    return new Set(list.filter(p => (p?.scope ?? 'user') === 'user').map(p => String(p?.id)))
  } catch {
    return new Set()
  }
}

// npm ci has run since package-lock.json last changed (npm writes its own copy
// into node_modules).
export function packagesCurrent(dir: string): boolean {
  try {
    return statSync(join(dir, 'node_modules', '.package-lock.json')).mtimeMs >= statSync(join(dir, 'package-lock.json')).mtimeMs
  } catch {
    return false
  }
}

// plasmashell --version prints "plasmashell 6.6.6".
export function plasma6(): boolean {
  const m = /plasmashell (\d+)\./.exec(run('plasmashell', ['--version']).out)
  return !!m && Number(m[1]) >= 6
}

export function probe(pkgs: string[]): Probe {
  const apt = onPath('apt-get')
  const have = apt ? installed(pkgs) : new Set(pkgs.filter(onPath))
  const claude = claudeCommand()
  const plugins = userPlugins(claude)
  return {
    apt,
    installed: have,
    aptInfo: Object.fromEntries(pkgs.filter(p => apt && !have.has(p)).map(p => [p, aptInfo(p)])),
    yazi: onPath('yazi') || run('snap', ['list', 'yazi']).ok,
    claude: claude !== null,
    plugin: plugins.has(PLUGIN),
    diagrams: plugins.has(DIAGRAMS) && packagesCurrent(DIAGRAM_DIR),
    chrome: existsSync(CHROME),
  }
}
