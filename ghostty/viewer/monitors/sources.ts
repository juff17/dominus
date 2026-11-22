// Where the Logs view's environments can be watched from: Docker for local,
// Kubernetes or Elastic for the rest. Only files are read: PATH for kubectl,
// the kubeconfig's, and Claude Code's MCP settings for an Elastic server.
// Nothing reaches a cluster or Elastic, and the skill picks the kube context.

import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { errorMessage, logger } from '../../core/log.ts'
import { expandHome } from '../../core/paths.ts'

const log = logger('monitors')

export type Source = 'docker' | 'kubernetes' | 'elastic'
export type Remote = Exclude<Source, 'docker'>
export const REMOTES: readonly Remote[] = ['kubernetes', 'elastic']
export const LOCAL = 'local'

// Why a remote source is grayed out; a source missing from it can be used.
export type Blocked = Partial<Record<Remote, 'kubectl' | 'kubeconfig' | 'elastic'>>

// Globs with * and ?.
export const matchesAny = (name: string, patterns: readonly string[]): boolean =>
  patterns.some(p => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(name))

export const onPath = (cmd: string, path: string | undefined): boolean =>
  (path ?? '').split(delimiter).some(dir => {
    if (!dir) return false
    try {
      accessSync(join(dir, cmd), constants.X_OK)
      return true
    } catch {
      return false
    }
  })

// As kubectl reads them: Settings' file and every one $KUBECONFIG names,
// else ~/.kube/config.
export function kubeconfigs(setting: string, env: string | undefined, home: string): string[] {
  const files = [setting ? expandHome(setting) : '', ...(env ?? '').split(delimiter)].filter(Boolean)
  return files.length ? [...new Set(files)] : [join(home, '.kube', 'config')]
}

const ELASTIC = /elastic|kibana/i

// Servers' names from Claude Code's three scopes: user and local in
// ~/.claude.json (local under the folder's project), project in the folder's
// .mcp.json. A file that is missing or broken has none.
export function mcpServers(claudeJson: string, folder: string): string[] {
  const names = (file: string, pick: (o: Record<string, unknown>) => unknown): string[] => {
    if (!existsSync(file)) return []
    try {
      const servers = pick(JSON.parse(readFileSync(file, 'utf8')))
      return servers && typeof servers === 'object' ? Object.keys(servers) : []
    } catch (err) {
      // Elastic shows as not set up, which this file may be why.
      log.warn('mcp settings unreadable', { path: file, err: errorMessage(err) })
      return []
    }
  }
  const at = (o: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o)
  return [
    ...names(claudeJson, o => o.mcpServers),
    ...(folder ? names(claudeJson, o => at(o, 'projects', folder, 'mcpServers')) : []),
    ...(folder ? names(join(folder, '.mcp.json'), o => o.mcpServers) : []),
  ]
}

export type SourcesInput = { path: string | undefined; kubeconfigs: readonly string[]; claudeJson: string; folder: string }

export function blockedSources({ path, kubeconfigs: files, claudeJson, folder }: SourcesInput): Blocked {
  const blocked: Blocked = {}
  if (!onPath('kubectl', path)) blocked.kubernetes = 'kubectl'
  else if (!files.some(f => existsSync(f))) blocked.kubernetes = 'kubeconfig'
  if (!mcpServers(claudeJson, folder).some(n => ELASTIC.test(n))) blocked.elastic = 'elastic'
  return blocked
}
