import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadAnswers, saveAnswers } from './answers.ts'
import { type Current, type Prompts, runPages } from './pages.ts'

const now: Current = {
  header: true,
  sidePanel: true,
  widget: true,
  editor: 'code',
  editors: [
    { value: 'code', name: 'VS Code' },
    { value: 'zed', name: 'Zed' },
  ],
  restartStopped: false,
  folder: '',
  sandbox: false,
}

// Answers each page in turn and records what it was shown.
function fake(answers: { parts: string[]; editor: string; restart: boolean; folder: string; sandbox?: boolean }) {
  const shown: { pages: string[]; checkbox?: unknown[]; select?: unknown } = { pages: [] }
  const ask: Prompts = {
    checkbox: async c => {
      shown.checkbox = c.choices
      return answers.parts as never
    },
    select: async c => {
      shown.select = c.default
      return answers.editor as never
    },
    confirm: async c => (/sandbox/.test(c.message) ? (answers.sandbox ?? false) : answers.restart),
    input: async c => (answers.folder === 'enter' ? c.default : answers.folder),
    separator: text => ({ separator: text, type: 'separator' }),
  }
  const screen = { page: (n: number, of: number) => void shown.pages.push(`${n}/${of}`) }
  return { ask, screen, shown }
}

test('five pages, each saying where you are', async () => {
  const f = fake({ parts: ['header', 'sidePanel', 'widget'], editor: 'code', restart: false, folder: 'enter' })
  await runPages(f.ask, f.screen, now, true)
  assert.deepEqual(f.shown.pages, ['1/5', '2/5', '3/5', '4/5', '5/5'])
  assert.equal(f.shown.select, 'code')
})

test('the answers come back as picked; Enter on the folder keeps the hub’s default unset', async () => {
  const f = fake({ parts: ['sidePanel'], editor: 'zed', restart: true, folder: 'enter', sandbox: true })
  const picked = await runPages(f.ask, f.screen, now, true)
  assert.deepEqual(picked, { header: false, sidePanel: true, widget: false, editor: 'zed', restartStopped: true, folder: '', sandbox: true })
})

test('a folder typed is kept, trimmed', async () => {
  const f = fake({ parts: [], editor: 'code', restart: false, folder: '  ~/code  ' })
  assert.equal((await runPages(f.ask, f.screen, now, true)).folder, '~/code')
})

test('without Plasma 6 the widget is shown disabled with the reason, and stays off', async () => {
  const f = fake({ parts: ['header', 'widget'], editor: 'code', restart: false, folder: 'enter' })
  const picked = await runPages(f.ask, f.screen, now, false)
  const widget = (f.shown.checkbox as { value?: string; disabled?: string }[]).find(c => c.value === 'widget')
  assert.equal(widget?.disabled, '(skipped: needs KDE Plasma 6)')
  assert.equal(picked.widget, false)
})

test('answers are saved outside the repo, and a broken file reads as none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-answers-'))
  try {
    const file = join(dir, 'dominus', 'install.json')
    assert.deepEqual(loadAnswers(file), { asked: false, widget: null })
    saveAnswers({ asked: true, widget: false }, file)
    assert.deepEqual(loadAnswers(file), { asked: true, widget: false })
    assert.match(readFileSync(file, 'utf8'), /"version": 1/)
    saveAnswers({ asked: true, widget: true }, file)
    assert.deepEqual(loadAnswers(file), { asked: true, widget: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
