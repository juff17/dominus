// node --test ghostty/tui/line.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as line from './line.ts'
import type { CaretParts } from './line.ts'
import { width } from './term.ts'

test('the arrows move the caret, and keys type and delete where it is', () => {
  const run = (text: string, at: number | undefined, ...keys: string[]) =>
    keys.reduce<{ text: string; at: number | undefined }>((s, k) => line.editLine(s.text, s.at, k), { text, at })
  assert.deepEqual(run('fix', undefined, '\x1b[D'), { text: 'fix', at: 2 })
  assert.deepEqual(run('fix', undefined, '\x1b[D', '\x1b[D', 'o'), { text: 'foix', at: 2 })
  assert.deepEqual(run('fix', 0, '\x1b[D'), { text: 'fix', at: 0 }, 'left stops at the start')
  assert.deepEqual(run('fix', undefined, '\x1b[C'), { text: 'fix', at: 3 }, 'right stops at the end')
  assert.deepEqual(run('fix', 1, '\x7f'), { text: 'ix', at: 0 })
  assert.deepEqual(run('fix', 0, '\x7f'), { text: 'fix', at: 0 })
  assert.deepEqual(run('fix', 1, '\x1b[3~'), { text: 'fx', at: 1 }, 'Delete takes the one under the caret')
  assert.deepEqual(run('fix', 1, '\x1b[H'), { text: 'fix', at: 0 })
  assert.deepEqual(run('fix', 1, '\x01'), { text: 'fix', at: 0 })
  assert.deepEqual(run('fix', 1, '\x1b[F'), { text: 'fix', at: 3 })
  assert.deepEqual(run('fix', 1, '\x05'), { text: 'fix', at: 3 })
  assert.deepEqual(run('fix the bug', 8, '\x15'), { text: 'bug', at: 0 }, 'Ctrl+U clears what is before the caret')
  assert.deepEqual(run('fix the bug', 3, '\x0b'), { text: 'fix', at: 3 }, 'Ctrl+K clears what is after it')
  assert.deepEqual(run('fix the bug', 8, '\x17'), { text: 'fix bug', at: 4 })
  assert.deepEqual(run('fix the bug', undefined, '\x1b[1;5D'), { text: 'fix the bug', at: 8 })
  assert.deepEqual(run('fix the bug', 8, '\x1bb'), { text: 'fix the bug', at: 4 })
  assert.deepEqual(run('fix the bug', 0, '\x1b[1;5C', '\x1bf'), { text: 'fix the bug', at: 7 })
})

test('an image placeholder is one character: the caret steps over it, Backspace and Delete take it whole', () => {
  const run = (text: string, at: number | undefined, ...keys: string[]) =>
    keys.reduce<{ text: string; at: number | undefined }>((s, k) => line.editLine(s.text, s.at, k), { text, at })
  const text = 'see [Image #1] here'
  assert.deepEqual(run(text, 14, '\x7f'), { text: 'see  here', at: 4 })
  assert.deepEqual(run('[Image #1]', undefined, '\x7f'), { text: '', at: 0 })
  assert.deepEqual(run(text, 4, '\x1b[3~'), { text: 'see  here', at: 4 })
  assert.deepEqual(run(text, 4, '\x1b[C'), { text, at: 14 })
  assert.deepEqual(run(text, 14, '\x1b[D'), { text, at: 4 })
  assert.deepEqual(run(text, 14, '\x17'), { text: 'see  here', at: 4 }, 'Ctrl+W takes it as one word')
  assert.deepEqual(run(text, 0, '\x1bf', '\x1bf'), { text, at: 14 })
  assert.deepEqual(run(text, undefined, '\x1bb', '\x1bb'), { text, at: 4 })
  assert.deepEqual(run('[Image #1][Image #2]', undefined, '\x7f'), { text: '[Image #1]', at: 10 })
  assert.deepEqual(line.caretParts(text, 4, 40), { before: 'see ', under: '[Image #1]', after: ' here' })
  assert.deepEqual(run('[Image one]', undefined, '\x7f'), { text: '[Image one', at: 10 }, 'only a numbered placeholder')
})

test('the caret steps over a wide character whole, and never onto a zero-width mark', () => {
  const run = (text: string, at: number | undefined, ...keys: string[]) =>
    keys.reduce<{ text: string; at: number | undefined }>((s, k) => line.editLine(s.text, s.at, k), { text, at })
  assert.deepEqual(run('漢字', undefined, '\x1b[D'), { text: '漢字', at: 1 })
  assert.deepEqual(run('漢字', undefined, '\x1b[D', 'x'), { text: '漢x字', at: 2 })
  assert.deepEqual(run('ok 😀!', undefined, '\x1b[D', '\x7f'), { text: 'ok !', at: 3 })
  assert.deepEqual(run('éx', 0, '\x1b[C'), { text: 'éx', at: 2 }, 'over the accent with its letter')
  assert.deepEqual(run('éx', 2, '\x1b[D'), { text: 'éx', at: 0 })
})

test('a joined emoji is one step and is deleted whole, never leaving its joiner behind', () => {
  const run = (text: string, at: number | undefined, ...keys: string[]) =>
    keys.reduce<{ text: string; at: number | undefined }>((s, k) => line.editLine(s.text, s.at, k), { text, at })
  const family = '👩‍👧'
  assert.deepEqual(run(`a${family}`, undefined, '\x7f'), { text: 'a', at: 1 })
  assert.deepEqual(run(`a${family}`, undefined, '\x7f', 'x'), { text: 'ax', at: 2 })
  assert.deepEqual(run(`a${family}b`, undefined, '\x1b[D', '\x1b[D'), { text: `a${family}b`, at: 1 }, 'left goes over it in one step')
  assert.deepEqual(run(`a${family}b`, 1, '\x1b[C'), { text: `a${family}b`, at: 4 })
  assert.deepEqual(run(`a${family}b`, 1, '\x1b[3~'), { text: 'ab', at: 1 }, 'Delete takes it whole')
  assert.deepEqual(run('éx', 2, '\x7f'), { text: 'x', at: 0 }, 'a letter goes with its accent')
})

test('the caret is drawn over the character it is on, or after the end', () => {
  const draw = (text: string, at: number | undefined, w = 40) => {
    const { before, under, after } = line.caretParts(text, at, w)
    return `${before}\x1b[7m${under}\x1b[27m${after}`
  }
  const cells = (p: CaretParts) => width(p.before + p.under + p.after)
  assert.equal(draw('fix', 1), 'f\x1b[7mi\x1b[27mx')
  assert.equal(draw('fix', undefined), 'fix\x1b[7m \x1b[27m')
  assert.equal(draw('漢字', 1), '漢\x1b[7m字\x1b[27m', 'a wide character whole')
  assert.equal(draw('éx', 0), '\x1b[7mé\x1b[27mx', 'with its accent')
  // Too long: the caret stays in sight wherever it is.
  const long = 'abcdefghijklmnopqrstuvwxyz'
  assert.equal(draw(long, undefined, 6), 'vwxyz\x1b[7m \x1b[27m')
  assert.equal(draw(long, 0, 6), '\x1b[7ma\x1b[27mbcdef')
  assert.equal(draw(long, 13, 6), 'jklm\x1b[7mn\x1b[27mo')
  assert.equal(draw('ab漢字cd', 3, 5), '漢\x1b[7m字\x1b[27mc', 'wide characters by their cells')
  for (const text of [long, '漢字かなカナ漢字かな'])
    for (const at of [0, 3, 5, 9, undefined]) assert.ok(cells(line.caretParts(text, at, 6)) <= 6, `${text} at ${at}`)
  assert.equal(line.caretShown(line.withCaret('fix', 1)), 'f\x1b[7mi\x1b[27mx')
  assert.equal(line.caretShown(line.withCaret('fix', 3)), 'fix\x1b[7m \x1b[27m')
  // Drawn with a style, the caret at the end sits before the span's reset,
  // which stays whole.
  assert.equal(line.caretShown(`${line.withCaret('fix', 3)}\x1b[0m  `), 'fix\x1b[7m \x1b[27m\x1b[0m  ')
})

test('pasted text goes in at the caret, an emoji as one step', () => {
  assert.deepEqual(line.insertAt('fix', 1, 'oo'), { text: 'fooix', at: 3 })
  assert.deepEqual(line.insertAt('ab', undefined, '😀'), { text: 'ab😀', at: 3 })
  assert.deepEqual(line.splitAt('a😀b', 2), ['a😀', 'b'])
  assert.deepEqual(line.splitAt('ab', undefined), ['ab', ''])
})

test('head and tail keep a joined emoji whole, never a lone half of it', () => {
  const family = '👩‍👧'
  assert.equal(line.head(`${family}ab`, 2), family)
  assert.equal(line.head(`${family}ab`, 1), '')
  assert.equal(line.tail(`ab${family}`, 3), `b${family}`)
  assert.equal(line.tail(`ab${family}`, 1), '')
  assert.equal(width(line.tail(`a${family}`, 2)), 2)
})

test('a wrapped field breaks after a space, keeping the last cell for the caret', () => {
  // Rows are 6 cells, 5 for text.
  const rows = (text: string, w = 6) => {
    const starts = line.wrapRows(text, w)
    return starts.map((s, i) => [...text].slice(s, starts[i + 1]).join(''))
  }
  assert.deepEqual(rows(''), [''])
  assert.deepEqual(rows('fix it'), ['fix ', 'it'])
  assert.deepEqual(rows('abcdefgh'), ['abcde', 'fgh'], 'a long word at the edge')
  assert.deepEqual(rows('abcde'), ['abcde'], 'the caret after it fits')
  assert.deepEqual(rows('abcde '), ['abcde ', ''], 'a space at the edge starts a row for the next word')
  assert.deepEqual(rows('abcde f'), ['abcde ', 'f'])
  assert.deepEqual(rows('ab漢字cd'), ['ab漢', '字cd'], 'wide characters by their cells')
  assert.deepEqual(rows('ab [Image #1] cd', 8), ['ab ', '[Image #1]', ' cd'], 'a placeholder is never split')
})

test('up and down move the caret a row, near its column', () => {
  // 'fix the ' over 'bug now'.
  const text = 'fix the bug now'
  assert.deepEqual(line.wrapRows(text, 9), [0, 8])
  assert.equal(line.rowOf([0, 8], 8), 1, 'a caret at a row start is on that row')
  assert.equal(line.rowStep(text, 2, 9, -1), null)
  assert.equal(line.rowStep(text, 2, 9, 1), 10)
  assert.equal(line.rowStep(text, 15, 9, -1), 7, "onto the row's last character, not the next row's start")
  assert.equal(line.rowStep(text, 7, 9, 1), 15, 'onto the end of the last row')
  assert.equal(line.rowStep(text, 10, 9, 1), null)
  assert.equal(line.rowStep('a [Image #1] b', 13, 20, -1), null)
})
