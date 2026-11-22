// What the install walkthrough keeps of its own: whether it has asked yet,
// and the answers that aren't hub Settings (those go to settings.ts, where
// the hub's Settings screen can change them later). Kept out of the repo, in
// $XDG_CONFIG_HOME/dominus/install.json.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { isRecord } from '../../ghostty/core/json.ts'

export type Answers = {
  // The pages have been through once; later runs skip them unless
  // --reconfigure.
  asked: boolean
  // The KDE panel widget; null before anyone answered.
  widget: boolean | null
}

export const answersFile = (): string =>
  process.env.DOMINUS_ANSWERS || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dominus', 'install.json')

// A missing or broken file is no answers yet.
export function loadAnswers(file = answersFile()): Answers {
  let saved: unknown
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { asked: false, widget: null }
  }
  if (!isRecord(saved)) return { asked: false, widget: null }
  return { asked: saved.asked === true, widget: typeof saved.widget === 'boolean' ? saved.widget : null }
}

// Written whole through a rename, so a reader never sees half of it.
export function saveAnswers(answers: Answers, file = answersFile()): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, ...answers }, null, 2)}\n`)
  renameSync(tmp, file)
}
