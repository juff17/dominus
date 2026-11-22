export type JsonRecord = Record<string, unknown>

export const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null && !Array.isArray(v)
