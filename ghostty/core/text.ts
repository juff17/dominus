// Every word a screen shows lives in text.json. A path that isn't in the file
// draws as the path itself and is logged, so a typo shows on screen rather
// than crashing the view; tests/contract/text.test.mjs fails on any path the
// code names that the file doesn't have.

import { readFileSync } from 'node:fs'

import { logger } from './log.ts'

// The text contract test checks text.json holds only these shapes, so it's
// read as this type without checking each value here.
export type Plural = { one?: string; other: string }
export type TextNode = string | string[] | Plural | TextTree
export type TextTree = { [key: string]: TextNode }
// `n` also picks a Plural's one or other.
export type Vars = Record<string, string | number>

export const TEXT: TextTree = JSON.parse(readFileSync(new URL('./text.json', import.meta.url), 'utf8'))

const log = logger('text')
const missing = new Set<string>()

export function lookup(path: string, from: TextNode = TEXT): TextNode | undefined {
  let at: TextNode = from
  for (const part of path.split('.')) {
    if (typeof at !== 'object' || Array.isArray(at) || !Object.hasOwn(at, part)) return undefined
    at = (at as TextTree)[part]
  }
  return at
}

// The caller names the shape it expects, which the text contract test pins.
export function text<T = TextTree>(path: string): T {
  const v = lookup(path)
  if (v === undefined) warnMissing(path)
  return (v ?? {}) as T
}

function warnMissing(id: string): void {
  if (missing.has(id)) return
  missing.add(id)
  log.warn('text missing', { id })
}

// A name with no value is left as written.
export const fill = (s: string, vars: Vars = {}): string =>
  s.replace(/\{(\w+)\}/g, (all, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : all))

const isPlural = (v: TextNode | undefined): v is Plural => typeof v === 'object' && !Array.isArray(v) && typeof v.other === 'string'

export function t(path: string, vars?: Vars): string {
  let v = lookup(path)
  if (isPlural(v)) v = vars?.n === 1 && v.one !== undefined ? v.one : v.other
  if (typeof v !== 'string') {
    warnMissing(path)
    return path
  }
  return vars ? fill(v, vars) : v
}

// For shell scripts: node text.ts <path> [name=value …]
if (import.meta.main) {
  const [path, ...pairs] = process.argv.slice(2)
  const vars = Object.fromEntries(pairs.map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))
  process.stdout.write(`${t(path, vars)}\n`)
}
