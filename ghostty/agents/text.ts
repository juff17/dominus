import { typedPart } from '../settings/prompts.ts'

export const firstLine = (s: unknown): string =>
  String(s ?? '')
    .split('\n')
    .map(l => l.trim())
    .find(Boolean) ?? ''

export const plain = (s: unknown): string =>
  firstLine(s)
    .replace(/^#+\s+|^[-*]\s+|^>\s+/, '')
    .replace(/\*\*|__|`/g, '')

export const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// The line the hub's card shows for a first prompt.
export const promptLine = (s: unknown): string => firstLine(typedPart(s)) || firstLine(s)
