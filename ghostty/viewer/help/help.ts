// Each section's words and keys are in core/text.json under help.sections, by
// id; here are the ids, their order and colours. Change a key there and in the
// Keys table in docs/ghostty.md together.

import { text } from '../../core/text.ts'
import type { KeybindRow, KeyValues } from '../../settings/keybinds.ts'
import { P } from '../../tui/palette.ts'

// rare: easy to forget, drawn in peach.
export type HelpKey = { key: string; what: string; rare: boolean }
export type HelpSection = { id: string; name: string; color: string; where: string; keys: HelpKey[] }

type SectionWords = { name?: string; where?: string; keys?: [key: string, what: string, rare?: boolean][] }

const COLORS: [id: string, color: string][] = [
  ['any', P.blue],
  ['tabs', P.green],
  ['viewer', P.rose],
  ['diff', P.yellow],
  ['dv', P.sky],
  ['todo', P.mauve],
  ['hub', P.peach],
  ['new', P.pink],
  ['approvals', P.peach],
  ['monitors', P.rose],
  ['set', P.rose],
]

const WORDS = text<Record<string, SectionWords | undefined>>('help.sections')

export const SECTIONS: HelpSection[] = COLORS.map(([id, color]) => {
  const w: SectionWords = WORDS[id] ?? {}
  return {
    id,
    name: w.name ?? id,
    color,
    where: w.where ?? '',
    keys: (w.keys ?? []).map(([key, what, rare = false]) => ({ key, what, rare })),
  }
})

// Applied as the view starts, so text.json keeps the defaults and the tests
// and docs see those. A key unbound in Settings is left out.
export function rebind(values: KeyValues, rows: readonly Pick<KeybindRow, 'key' | 'default'>[]): void {
  const moved = rows.filter(r => values[r.key] !== r.default).map((r): [from: string, to: string | undefined] => [r.default, values[r.key]])
  if (!moved.length) return
  for (const s of SECTIONS)
    s.keys = s.keys.flatMap(k => {
      const hit = moved.find(([from]) => k.key === from)
      if (hit) return hit[1] ? [{ ...k, key: hit[1] }] : []
      let key = k.key
      for (const [from, to] of moved) key = key.replace(new RegExp(`(^|\\s)${from.replace(/\+/g, '\\+')}(?=\\s|$)`), `$1${to || ''}`)
      return [{ ...k, key: key.trim() }]
    })
}

// Keyed by the tmux window Alt+H was pressed in.
const PLACES: Record<string, string> = { hub: 'hub', diagrams: 'dv' }
export const startAt = (place: string | undefined): number => Math.max(0, SECTIONS.findIndex(s => s.id === (PLACES[place ?? ''] ?? 'any')))

export function filter(query: string, sections: HelpSection[] = SECTIONS): HelpSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return sections
  return sections
    .map(s => ({
      ...s,
      keys: s.keys.filter(k => {
        const text = `${k.key} ${k.what} ${s.name}`.toLowerCase()
        return words.every(w => text.includes(w))
      }),
    }))
    .filter(s => s.keys.length)
}
