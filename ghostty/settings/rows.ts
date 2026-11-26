// The kinds of row a setting can be, and the builders SECTIONS (catalog.ts)
// is written with: each row's key, type, values and default. Its words are
// core/text.json's settings.rows.

import { text } from '../core/text.ts'
import type { PromptId } from './prompts.ts'
import type { SettingRow } from './catalog.ts'

// name and cmd are only on a mode you added.
export type Mode = { id: string; on: boolean; name?: string; cmd?: string }
export type KeyKind = 'alt' | 'ghostty'
export type Choice<V extends string = string> = { value: V; label: string }

type Row<K extends string, T extends string, V> = { key: K; label: string; sub: string; type: T; default: V }
export type ChoiceRow<K extends string = string, V extends string = string> = Row<K, 'choice', V> & { choices: Choice<V>[] }
export type NumberRow<K extends string = string> = Row<K, 'number', number> & { min: number; max: number; step: number; unit: string }
export type BoolRow<K extends string = string> = Row<K, 'bool', boolean>
export type FlagsRow<K extends string = string> = Row<K, 'flags', string[]> & { choices: Choice[] }
// run is what Ghostty sends for a ghostty key, as config.ghostty has it.
export type KeyRow<K extends string = string> = Row<K, 'key', string> & { kind: KeyKind; run?: string }
export type ModesRow<K extends string = string> = Row<K, 'modes', Mode[]>
// `empty` is what the panel shows for '' (a default the reader fills in).
export type FileRow<K extends string = string> = Row<K, 'file', string> & { dir: boolean; empty: string }
export type HostsRow<K extends string = string> = Row<K, 'hosts', string[]> & { cli: 'gh' | 'glab' }
// `empty` is what the panel shows for none.
export type ListRow<K extends string = string> = Row<K, 'list', string[]> & { item: RegExp; max: number; keep: string[]; empty: string }
// One line of text, '' for none. `empty` is what the panel shows for ''.
export type TextRow<K extends string = string> = Row<K, 'text', string> & { item: RegExp; max: number; empty: string }
// Any setting. SettingRow, further down, is the ones there are, by key.
export type Setting = ChoiceRow | NumberRow | BoolRow | FlagsRow | KeyRow | ModesRow | FileRow | HostsRow | ListRow | TextRow
export type SettingValue = Setting['default']

// A FixedLine is a value set somewhere else (KDE, layout.conf) or not up to
// you, shown so the panel lists it with the rest.
export type Heading = { head: string }
export type PromptLine = { prompt: PromptId }
export type FixedLine = { fixed: string; label: string; sub: string }
// A value kept in .env rather than here (a tracker's credentials): the panel
// says only whether it's set, never what it holds.
export type EnvLine = { env: string; label: string; sub: string }
export type SectionRow = SettingRow | Heading | PromptLine | FixedLine | EnvLine
export type Section = { id: string; name: string; where: string; rows: SectionRow[] }

export const isSetting = <R extends object>(r: R): r is Extract<R, { key: string }> => 'key' in r

// What each setting is called and says, its choices' names and its unit
// are in core/text.json under settings.rows, by key; a section's name,
// note, headings, fixed rows and aliases under settings.sections, by id.
// Here are only the keys, the types, the values and the defaults.
type Named = { label?: string; sub?: string }
type RowWords = Named & { unit?: string; empty?: string; choices?: Record<string, string> }
export type SectionWords = {
  name?: string
  where?: string
  heads?: Record<string, string>
  fixed?: Record<string, Named & { value?: string }>
  aliases?: Record<string, Named>
  env?: Record<string, Named>
}
type SettingsText = { rows?: Record<string, RowWords>; sections?: Record<string, SectionWords>; modes?: Record<string, { name?: string; sub?: string }> }
export const T = text<SettingsText>('settings')
export const words = (key: string): RowWords => T.rows?.[key] ?? {}
const named = (key: string) => ({ label: words(key).label ?? key, sub: words(key).sub ?? '' })

// A choice is named in the text file (or by itself when it isn't); a
// model's [id, label] keeps the label models.ts gives it.
type Choosable<V extends string> = V | readonly [value: V, label: string]
const opts = <V extends string>(key: string, list: readonly Choosable<V>[]): Choice<V>[] =>
  list.map(c => (typeof c === 'string' ? { value: c, label: words(key).choices?.[c] ?? c } : { value: c[0], label: c[1] }))

// Each builder keeps its key's literal type, and a choice its values', so
// Settings below knows what every key holds.
export const choice = <K extends string, const V extends string>(key: K, choices: readonly Choosable<V>[], def: NoInfer<V>): ChoiceRow<K, V> => ({ key, ...named(key), type: 'choice', choices: opts(key, choices), default: def })
type Range = { min: number; max: number; step?: number }
export const number = <K extends string>(key: K, def: number, { min, max, step = 1 }: Range): NumberRow<K> => ({ key, ...named(key), type: 'number', min, max, step, unit: words(key).unit ?? '', default: def })
export const bool = <K extends string>(key: K, def: boolean): BoolRow<K> => ({ key, ...named(key), type: 'bool', default: def })
export const flags = <K extends string>(key: K, choices: readonly string[], def: string[]): FlagsRow<K> => ({ key, ...named(key), type: 'flags', choices: opts(key, choices), default: def })
// An alt key layout.conf binds, or a ctrl+shift key Ghostty sends `run` for
// (config.ghostty). '' is unbound.
export const keybind = <K extends string>(key: K, kind: KeyKind, def: string, run?: string): KeyRow<K> => ({ key, ...named(key), type: 'key', kind, default: def, run })
export const modes = <K extends string>(key: K, def: Mode[]): ModesRow<K> => ({ key, ...named(key), type: 'modes', default: def })
// '' is none.
type FileOptions = { dir?: boolean }
export const file = <K extends string>(key: K, { dir = false }: FileOptions = {}): FileRow<K> => ({ key, ...named(key), type: 'file', dir, empty: words(key).empty ?? '', default: '' })
export const hosts = <K extends string>(key: K, cli: HostsRow['cli'], def: string[]): HostsRow<K> => ({ key, ...named(key), type: 'hosts', cli, default: def })
// `keep` is in the list always: typing it out or clearing the row leaves it.
type ListOptions = { item: RegExp; max?: number; keep?: string[] }
export const list = <K extends string>(key: K, def: string[], { item, max = 12, keep = [] }: ListOptions): ListRow<K> => ({ key, ...named(key), type: 'list', item, max, keep, empty: words(key).empty ?? '', default: def })
type TextOptions = { item?: RegExp; max?: number }
export const textRow = <K extends string>(key: K, { item = /^.+$/, max = 200 }: TextOptions = {}): TextRow<K> => ({ key, ...named(key), type: 'text', item, max, empty: words(key).empty ?? '', default: '' })

// The lines below as written, before their section's words are put in:
// headings and fixed rows by their ids in the text file, and an alias, one
// setting shown in a second section under its own name there, by its key.
type FixedDef = { fixedId: string }
type AliasDef = { alias: string }
type EnvDef = { envKey: string }
type Def = Setting | Heading | PromptLine | FixedDef | AliasDef | EnvDef
export const head = (id: string): Heading => ({ head: id })
export const prompt = (id: PromptId): PromptLine => ({ prompt: id })
export const fixed = (id: string): FixedDef => ({ fixedId: id })
export const alias = (key: string): AliasDef => ({ alias: key })
export const envLine = (key: string): EnvDef => ({ envKey: key })
export const define = <D extends Def>(id: string, rows: D[]) => ({ id, rows })
