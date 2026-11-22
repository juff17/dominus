// Pins today's tokenizers ahead of their merge into tui/input.ts. Each row
// feeds the same bytes to all four and records what each one makes of them,
// quirks included, so merging them can't change what any view sees. Since
// then a sequence never runs on into the next one, whichever view reads it.
//   node --test ghostty/tui/input.pin.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseInput as diagrams } from '../viewer/diagrams/diagram.ts'
import { parseInput as diff } from '../viewer/diff/diff.ts'
import { parseInput as todo } from '../viewer/todo/todo-ui.ts'
import { tokens as term } from './term.ts'

const TOKENIZERS = { term, todo, diff, diagrams }
type Name = keyof typeof TOKENIZERS

// [what, input, { tokenizer: tokens }]
const ROWS: [string, string | string[], Record<Name, unknown[]>][] = [
  [
    'plain keys',
    'ab',
    {
      term: [{ key: 'a' }, { key: 'b' }],
      todo: [{ key: 'a' }, { key: 'b' }],
      diff: [{ key: 'a' }, { key: 'b' }],
      diagrams: [{ key: 'a' }, { key: 'b' }],
    },
  ],
  [
    'enter, ctrl+c, tab, space, ctrl+s',
    '\r\x03\t \x13',
    {
      term: [{ key: '\r' }, { key: '\x03' }, { key: '\t' }, { key: ' ' }, { key: '\x13' }],
      todo: [{ key: '\r' }, { key: '\x03' }, { key: '\t' }, { key: ' ' }, { key: '\x13' }],
      diff: [{ key: '\r' }, { key: '\x03' }, { key: '\t' }, { key: ' ' }, { key: '\x13' }],
      diagrams: [{ key: '\r' }, { key: '\x03' }, { key: '\t' }, { key: ' ' }, { key: '\x13' }],
    },
  ],
  [
    'arrows',
    '\x1b[A\x1b[B\x1b[C\x1b[D',
    {
      term: [{ key: '\x1b[A' }, { key: '\x1b[B' }, { key: '\x1b[C' }, { key: '\x1b[D' }],
      todo: [{ key: '\x1b[A' }, { key: '\x1b[B' }, { key: '\x1b[C' }, { key: '\x1b[D' }],
      diff: [{ key: '\x1b[A' }, { key: '\x1b[B' }, { key: '\x1b[C' }, { key: '\x1b[D' }],
      diagrams: [{ key: '\x1b[A' }, { key: '\x1b[B' }, { key: '\x1b[C' }, { key: '\x1b[D' }],
    },
  ],
  [
    'keys around an arrow',
    'j\x1b[Bk',
    {
      term: [{ key: 'j' }, { key: '\x1b[B' }, { key: 'k' }],
      todo: [{ key: 'j' }, { key: '\x1b[B' }, { key: 'k' }],
      diff: [{ key: 'j' }, { key: '\x1b[B' }, { key: 'k' }],
      diagrams: [{ key: 'j' }, { key: '\x1b[B' }, { key: 'k' }],
    },
  ],
  [
    'SS3 F1 and SS3 up',
    '\x1bOP\x1bOA',
    {
      term: [{ key: '\x1bOP' }, { key: '\x1bOA' }],
      todo: [{ key: '\x1bO' }, { key: 'P' }, { key: '\x1bO' }, { key: 'A' }],
      diff: [{ key: '\x1bO' }, { key: 'P' }, { key: '\x1bO' }, { key: 'A' }],
      diagrams: [{ key: '\x1b' }, { key: 'O' }, { key: 'P' }, { key: '\x1b' }, { key: 'O' }, { key: 'A' }],
    },
  ],
  [
    'page keys, shift+tab, the hub key codes',
    '\x1b[5~\x1b[6~\x1b[Z\x1b[9100~',
    {
      term: [{ key: '\x1b[5~' }, { key: '\x1b[6~' }, { key: '\x1b[Z' }, { key: '\x1b[9100~' }],
      todo: [{ key: '\x1b[5~' }, { key: '\x1b[6~' }, { key: '\x1b[Z' }, { key: '\x1b[9100~' }],
      diff: [{ key: '\x1b[5~' }, { key: '\x1b[6~' }, { key: '\x1b[Z' }, { key: '\x1b[9100~' }],
      diagrams: [{ key: '\x1b[5~' }, { key: '\x1b[6~' }, { key: '\x1b[Z' }, { key: '\x1b[9100~' }],
    },
  ],
  [
    // Alt+D in the diagrams window while the wheel turns: the close key
    // stays whole, not run on into the report (or a key) after it.
    'the diagrams close key then a mouse report or a key',
    ['\x1b[9104~\x1b[<65;10;5M', '\x1b[9104~x'],
    {
      term: [{ key: '\x1b[9104~' }, { mouse: { button: 65, x: 10, y: 5, up: false } }, { key: '\x1b[9104~' }, { key: 'x' }],
      todo: [{ key: '\x1b[9104~' }, { mouse: { button: 65, x: 10, y: 5, released: false } }, { key: '\x1b[9104~' }, { key: 'x' }],
      diff: [{ key: '\x1b[9104~' }, { mouse: { button: 65, x: 10, y: 5, released: false } }, { key: '\x1b[9104~' }, { key: 'x' }],
      diagrams: [{ key: '\x1b[9104~' }, { mouse: { button: 65, x: 10, y: 5, released: false } }, { key: '\x1b[9104~' }, { key: 'x' }],
    },
  ],
  [
    'ctrl+right with parameters',
    '\x1b[1;5C',
    {
      term: [{ key: '\x1b[1;5C' }],
      todo: [{ key: '\x1b[1;5C' }],
      diff: [{ key: '\x1b[1;5C' }],
      diagrams: [{ key: '\x1b[1;5C' }],
    },
  ],
  [
    'a ~ key then an arrow',
    '\x1b[5~\x1b[A',
    {
      term: [{ key: '\x1b[5~' }, { key: '\x1b[A' }],
      todo: [{ key: '\x1b[5~' }, { key: '\x1b[A' }],
      diff: [{ key: '\x1b[5~' }, { key: '\x1b[A' }],
      diagrams: [{ key: '\x1b[5~' }, { key: '\x1b[A' }],
    },
  ],
  [
    'a ~ key then a mouse report',
    '\x1b[6~\x1b[<0;3;4M',
    {
      term: [{ key: '\x1b[6~' }, { mouse: { button: 0, x: 3, y: 4, up: false } }],
      todo: [{ key: '\x1b[6~' }, { mouse: { button: 0, x: 3, y: 4, released: false } }],
      diff: [{ key: '\x1b[6~' }, { mouse: { button: 0, x: 3, y: 4, released: false } }],
      diagrams: [{ key: '\x1b[6~' }, { mouse: { button: 0, x: 3, y: 4, released: false } }],
    },
  ],
  [
    'alt+lower letter',
    '\x1bq\x1bt\x1bd',
    {
      term: [{ key: '\x1bq' }, { key: '\x1bt' }, { key: '\x1bd' }],
      todo: [{ key: '\x1bq' }, { key: '\x1bt' }, { key: '\x1bd' }],
      diff: [{ key: '\x1bq' }, { key: '\x1bt' }, { key: '\x1bd' }],
      diagrams: [{ key: '\x1bq' }, { key: '\x1bt' }, { key: '\x1bd' }],
    },
  ],
  [
    'alt+capital letter',
    '\x1bQ',
    {
      term: [{ key: '\x1bQ' }],
      todo: [{ key: '\x1bQ' }],
      diff: [{ key: '\x1bQ' }],
      diagrams: [{ key: '\x1b' }, { key: 'Q' }],
    },
  ],
  [
    'alt+digit',
    '\x1b1',
    {
      term: [{ key: '\x1b1' }],
      todo: [{ key: '\x1b' }, { key: '1' }],
      diff: [{ key: '\x1b1' }],
      diagrams: [{ key: '\x1b' }, { key: '1' }],
    },
  ],
  [
    'alt+space',
    '\x1b ',
    {
      term: [{ key: '\x1b ' }],
      todo: [{ key: '\x1b' }, { key: ' ' }],
      diff: [{ key: '\x1b ' }],
      diagrams: [{ key: '\x1b' }, { key: ' ' }],
    },
  ],
  [
    'alt+punctuation',
    '\x1b[',
    {
      term: [{ key: '\x1b[' }],
      todo: [{ key: '\x1b' }, { key: '[' }],
      diff: [{ key: '\x1b[' }],
      diagrams: [{ key: '\x1b' }, { key: '[' }],
    },
  ],
  [
    'escape alone',
    '\x1b',
    {
      term: [{ key: '\x1b' }],
      todo: [{ key: '\x1b' }],
      diff: [{ key: '\x1b' }],
      diagrams: [{ key: '\x1b' }],
    },
  ],
  [
    'a key then escape',
    'a\x1b',
    {
      term: [{ key: 'a' }, { key: '\x1b' }],
      todo: [{ key: 'a' }, { key: '\x1b' }],
      diff: [{ key: 'a' }, { key: '\x1b' }],
      diagrams: [{ key: 'a' }, { key: '\x1b' }],
    },
  ],
  [
    'two escapes',
    '\x1b\x1b',
    {
      term: [{ key: '\x1b' }, { key: '\x1b' }],
      todo: [{ key: '\x1b' }, { key: '\x1b' }],
      diff: [{ key: '\x1b' }, { key: '\x1b' }],
      diagrams: [{ key: '\x1b' }, { key: '\x1b' }],
    },
  ],
  [
    // Esc then a click or an arrow before the view reads: Esc is still Esc,
    // and the report isn't typed as text.
    'escape then a mouse report, escape then an arrow',
    '\x1b\x1b[<0;30;5M\x1b\x1b[A',
    {
      term: [{ key: '\x1b' }, { mouse: { button: 0, x: 30, y: 5, up: false } }, { key: '\x1b' }, { key: '\x1b[A' }],
      todo: [{ key: '\x1b' }, { mouse: { button: 0, x: 30, y: 5, released: false } }, { key: '\x1b' }, { key: '\x1b[A' }],
      diff: [{ key: '\x1b' }, { mouse: { button: 0, x: 30, y: 5, released: false } }, { key: '\x1b' }, { key: '\x1b[A' }],
      diagrams: [{ key: '\x1b' }, { mouse: { button: 0, x: 30, y: 5, released: false } }, { key: '\x1b' }, { key: '\x1b[A' }],
    },
  ],
  [
    'bracketed paste',
    '\x1b[200~hi\nthere\x1b[201~z',
    {
      term: [{ paste: 'hi\nthere' }, { key: 'z' }],
      todo: [{ paste: 'hi\nthere' }, { key: 'z' }],
      diff: [{ key: '\x1b[200~' }, { key: 'h' }, { key: 'i' }, { key: '\n' }, { key: 't' }, { key: 'h' }, { key: 'e' }, { key: 'r' }, { key: 'e' }, { key: '\x1b[201~' }, { key: 'z' }],
      diagrams: [{ key: '\x1b[200~' }, { key: 'h' }, { key: 'i' }, { key: '\n' }, { key: 't' }, { key: 'h' }, { key: 'e' }, { key: 'r' }, { key: 'e' }, { key: '\x1b[201~' }, { key: 'z' }],
    },
  ],
  [
    // A paste the terminal sends in two reads, its end marker split too: the
    // second read goes on with the paste rather than as keys.
    'a paste split across reads',
    ['\x1b[200~ab', 'c\nd\x1b[20', '1~z'],
    {
      term: [{ paste: 'ab' }, { paste: 'c\nd' }, { key: 'z' }],
      todo: [{ paste: 'ab' }, { paste: 'c\nd' }, { key: 'z' }],
      diff: [{ key: '\x1b[200~' }, { key: 'a' }, { key: 'b' }, { key: 'c' }, { key: '\n' }, { key: 'd' }, { key: '\x1b[' }, { key: '2' }, { key: '0' }, { key: '1' }, { key: '~' }, { key: 'z' }],
      diagrams: [{ key: '\x1b[200~' }, { key: 'a' }, { key: 'b' }, { key: 'c' }, { key: '\n' }, { key: 'd' }, { key: '\x1b' }, { key: '[' }, { key: '2' }, { key: '0' }, { key: '1' }, { key: '~' }, { key: 'z' }],
    },
  ],
  [
    'an empty paste',
    '\x1b[200~\x1b[201~',
    {
      term: [{ paste: '' }],
      todo: [{ paste: '' }],
      diff: [{ key: '\x1b[200~' }, { key: '\x1b[201~' }],
      diagrams: [{ key: '\x1b[200~' }, { key: '\x1b[201~' }],
    },
  ],
  [
    'mouse press and release',
    '\x1b[<0;12;7M\x1b[<0;12;7m',
    {
      term: [{ mouse: { button: 0, x: 12, y: 7, up: false } }, { mouse: { button: 0, x: 12, y: 7, up: true } }],
      todo: [{ mouse: { button: 0, x: 12, y: 7, released: false } }, { mouse: { button: 0, x: 12, y: 7, released: true } }],
      diff: [{ mouse: { button: 0, x: 12, y: 7, released: false } }, { mouse: { button: 0, x: 12, y: 7, released: true } }],
      diagrams: [{ mouse: { button: 0, x: 12, y: 7, released: false } }, { mouse: { button: 0, x: 12, y: 7, released: true } }],
    },
  ],
  [
    'wheel and drag',
    '\x1b[<64;1;2M\x1b[<65;1;2M\x1b[<32;5;5M',
    {
      term: [{ mouse: { button: 64, x: 1, y: 2, up: false } }, { mouse: { button: 65, x: 1, y: 2, up: false } }, { mouse: { button: 32, x: 5, y: 5, up: false } }],
      todo: [{ mouse: { button: 64, x: 1, y: 2, released: false } }, { mouse: { button: 65, x: 1, y: 2, released: false } }, { mouse: { button: 32, x: 5, y: 5, released: false } }],
      diff: [{ mouse: { button: 64, x: 1, y: 2, released: false } }, { mouse: { button: 65, x: 1, y: 2, released: false } }, { mouse: { button: 32, x: 5, y: 5, released: false } }],
      diagrams: [{ mouse: { button: 64, x: 1, y: 2, released: false } }, { mouse: { button: 65, x: 1, y: 2, released: false } }, { mouse: { button: 32, x: 5, y: 5, released: false } }],
    },
  ],
  [
    'cell size reply',
    '\x1b[6;20;10t',
    {
      term: [{ key: '\x1b[6;20;10t' }],
      todo: [{ key: '\x1b[6;20;10t' }],
      diff: [{ key: '\x1b[6;20;10t' }],
      diagrams: [{ cell: { ch: 20, cw: 10 } }],
    },
  ],
  [
    'cell size reply with zeros',
    '\x1b[6;0;0t',
    {
      term: [{ key: '\x1b[6;0;0t' }],
      todo: [{ key: '\x1b[6;0;0t' }],
      diff: [{ key: '\x1b[6;0;0t' }],
      diagrams: [{ cell: { ch: 0, cw: 0 } }],
    },
  ],
  [
    'DECRQM replies for pixel mouse',
    '\x1b[?1016;1$y\x1b[?1016;2$y\x1b[?1016;3$y',
    {
      term: [{ key: '\x1b[?1016;1$y' }, { key: '\x1b[?1016;2$y' }, { key: '\x1b[?1016;3$y' }],
      todo: [{ key: '\x1b[?1016;1$y' }, { key: '\x1b[?1016;2$y' }, { key: '\x1b[?1016;3$y' }],
      diff: [{ key: '\x1b[?1016;1$y' }, { key: '\x1b[?1016;2$y' }, { key: '\x1b[?1016;3$y' }],
      diagrams: [{ pixels: true }, { pixels: false }, { pixels: true }],
    },
  ],
  [
    'a wide character and an emoji',
    '日🙂',
    {
      term: [{ key: '日' }, { key: '🙂' }],
      todo: [{ key: '日' }, { key: '🙂' }],
      diff: [{ key: '日' }, { key: '\ud83d' }, { key: '\ude42' }],
      diagrams: [{ key: '日' }, { key: '\ud83d' }, { key: '\ude42' }],
    },
  ],
  [
    'combining mark',
    'é',
    {
      term: [{ key: 'é' }],
      todo: [{ key: 'é' }],
      diff: [{ key: 'é' }],
      diagrams: [{ key: 'é' }],
    },
  ],
  [
    'DEL and backspace',
    '\b',
    {
      term: [{ key: '' }, { key: '\b' }],
      todo: [{ key: '' }, { key: '\b' }],
      diff: [{ key: '' }, { key: '\b' }],
      diagrams: [{ key: '' }, { key: '\b' }],
    },
  ],
]

// An input is one read, or a list of reads in turn.
for (const [name, input, want] of ROWS)
  test(`tokens: ${name}`, () => {
    for (const [tokenizer, parse] of Object.entries(TOKENIZERS) as [Name, (read: string) => Iterable<unknown>][])
      assert.deepEqual([input].flat().flatMap(read => [...parse(read)]), want[tokenizer], tokenizer)
  })

// A tokenizer settles a read when it's called, so what it carries to the
// next read doesn't hang on the caller looking at every token.
test('every tokenizer returns its tokens as an array', () => {
  for (const parse of [term, todo, diff, diagrams]) assert.ok(Array.isArray(parse('a')))
})
