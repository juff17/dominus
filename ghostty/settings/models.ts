// The Claude models every picker offers: New agent, Settings, the todo
// hand-off and the todo filer. Adding one here adds it everywhere.
//   id     what `claude --model` takes and Settings stores
//   api    the full model id, for the filer's `claude --model`
//   filer  whether the todo filer may use it (it writes one short item)
// The order is the pickers', most capable first.
export type Model = { id: string; label: string; api: string; filer?: boolean }

export const MODELS = [
  { id: 'fable', label: 'fable 5.2', api: 'claude-fable-5-2', filer: true },
  { id: 'opus', label: 'opus 5.5', api: 'claude-opus-5-5' },
  { id: 'sonnet', label: 'sonnet 5.5', api: 'claude-sonnet-5-5', filer: true },
  { id: 'haiku', label: 'haiku 5.5', api: 'claude-haiku-5-5', filer: true },
] as const satisfies readonly Model[]

export type ModelId = (typeof MODELS)[number]['id']

export const MODEL_IDS: ModelId[] = MODELS.map(m => m.id)

// Smallest first, as [id, label] for a Settings choice.
export const FILER_MODELS = MODELS.filter((m: Model) => m.filer)
  .reverse()
  .map(m => [m.id, m.label] as const)

export const model = (id: string): Model | undefined => MODELS.find(m => m.id === id)

export const modelLabel = (id: string): string => model(id)?.label ?? id

// "Haiku", for a sentence.
export const modelName = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1)

export const LONGEST_MODEL_ID: ModelId = MODEL_IDS.reduce((a, b) => (b.length > a.length ? b : a))
