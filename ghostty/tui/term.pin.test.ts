// Pins term.ts as it was ahead of the hub refactor, with its fixes since.
// term.test.ts covers wrap.
//   node --test ghostty/tui/term.pin.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BOLD, CAP_L, CAP_R, P, RESET, ago, bar, bg, charWidth, clean, enter, fg, leave, mix, paint, pieces, pill, render, split, tokens, width } from './term.ts'

const plain = (s: string): string => s.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '')

test('fg and bg are truecolor SGR sequences', () => {
  assert.equal(fg('#89b4fa'), '\x1b[38;2;137;180;250m')
  assert.equal(bg('#1e1e2e'), '\x1b[48;2;30;30;46m')
})

test('render: exactly cols cells, cut with … when too long, padded when short', () => {
  assert.equal(render([['abc']], 0), '')
  assert.equal(render([['abc']], -3), '')
  assert.equal(plain(render([['abc']], 3)), 'abc')
  assert.equal(plain(render([['abcd']], 3)), 'ab…')
  assert.equal(plain(render([['ab'], ['cd']], 3)), 'ab…')
  assert.equal(plain(render([['a']], 4)), 'a   ')
  assert.equal(plain(render([], 2)), '  ')
  assert.equal(plain(render([['ab']], 1)), '…')
})

test('render: styles wrap each span, fill restarts after each and ends the line', () => {
  assert.equal(render([['a', BOLD]], 2, 'F'), `F${BOLD}a${RESET}F ${RESET}`)
  assert.equal(render([['a'], ['b', 'S']], 2), `a${RESET}Sb${RESET}${RESET}`)
  assert.equal(render([['', BOLD], ['x']], 1), `x${RESET}${RESET}`)
})

test('render: a wide character is two cells and is never split at the edge', () => {
  assert.equal(width('日本'), 4)
  // 本 doesn't fit beside the …, so a cell is left blank.
  assert.equal(plain(render([['日本語']], 4)), '日… ')
  assert.equal(plain(render([['a日']], 2)), 'a…')
  assert.equal(plain(render([['日']], 3)), '日 ')
})

test('charWidth: wide CJK and emoji are 2, combining marks and ZWJ-like marks 0, the rest 1', () => {
  assert.equal(charWidth('a'), 1)
  assert.equal(charWidth('日'), 2)
  assert.equal(charWidth('가'), 2)
  assert.equal(charWidth('🙂'), 2)
  assert.equal(charWidth('́'), 0)
  assert.equal(charWidth('​'), 0)
  assert.equal(charWidth('️'), 0)
  assert.equal(charWidth('▲'), 1)
  assert.equal(charWidth(CAP_L), 1)
  assert.equal(width('é'), 1)
  // A zero-width joiner draws what follows it inside the emoji before.
  assert.equal(charWidth('\u200d'), 0)
  assert.equal(width('👩‍👧'), 2)
  assert.equal(width('👨‍👩‍👧‍👦 x'), 4)
})

test('a narrow symbol with VS16 after it is its emoji, two cells wide', () => {
  const warn = '⚠️'
  assert.equal(width('⚠'), 1, 'without VS16 it stays text, one cell')
  assert.equal(width(warn), 2)
  assert.equal(width('\u{1f642}️'), 2, 'an emoji already wide stays two')
  assert.deepEqual(pieces(`${warn}x`), [[warn, 2], ['x', 1]])
  assert.equal(plain(render([[`${warn} Potential issue`]], 6)), `${warn} Po…`)
})

test('render and the cuts keep a joined emoji whole and two cells wide', () => {
  const family = '👩‍👧'
  assert.equal(plain(render([[family]], 2)), family)
  assert.equal(plain(render([[`${family}ab`]], 4)), `${family}ab`)
  // Cut, it goes whole, never leaving a lone joiner behind.
  assert.equal(plain(render([[`a${family}b`]], 3)), 'a… ')
  assert.deepEqual(pieces(`a${family}é`), [['a', 1], [family, 2], ['é', 1]])
})

test('split: the left part is cut first; a right part as wide as the line is all there is', () => {
  assert.equal(plain(split([['left']], [['R']], 6)), 'left R')
  assert.equal(plain(split([['left side']], [['R']], 6)), 'left…R')
  assert.equal(plain(split([['l']], [['right']], 5)), 'right')
  assert.equal(plain(split([['l']], [['right!']], 5)), 'righ…')
  assert.equal(plain(split([], [['r']], 3)), '  r')
})

test('bar: rounded caps around a tinted split line, w cells in all', () => {
  const b = bar([['L']], [['R']], 6, P.blue, P.base)
  assert.equal(plain(b), `${CAP_L}L  R${CAP_R}`)
  assert.ok(b.startsWith(fg(P.blue) + bg(P.base)))
  assert.ok(b.includes(bg(P.blue)))
})

test('pill: three spans, caps in the color on the outer background', () => {
  assert.deepEqual(pill(' x ', P.green, P.base, BOLD), [
    [CAP_L, fg(P.green) + bg(P.base)],
    [' x ', BOLD + bg(P.green)],
    [CAP_R, fg(P.green) + bg(P.base)],
  ])
  assert.deepEqual(pill('y', P.red, P.base)[1], ['y', bg(P.red)])
})

test('mix: t of a over b, per channel, rounded', () => {
  assert.equal(mix('#ffffff', '#000000', 0.5), '#808080')
  assert.equal(mix('#ff0000', '#0000ff', 1), '#ff0000')
  assert.equal(mix('#ff0000', '#0000ff', 0), '#0000ff')
  assert.equal(mix(P.peach, P.mantle, 0.2), '#402e1e')
})

test('ago: empty for no time, then s, m, h with minutes, d; the future is 0s', () => {
  const now = 1_000_000_000_000
  assert.equal(ago(0, now), '')
  assert.equal(ago(now, now), '0s')
  assert.equal(ago(now + 5000, now), '0s')
  assert.equal(ago(now - 59_400, now), '59s')
  // Seconds round, so 59.5 s is a minute.
  assert.equal(ago(now - 59_500, now), '1m')
  assert.equal(ago(now - 60_000 * 59 - 59_000, now), '59m')
  assert.equal(ago(now - 3_600_000, now), '1h')
  assert.equal(ago(now - 3_600_000 - 60_000, now), '1h 1m')
  assert.equal(ago(now - 24 * 3_600_000 + 1000, now), '23h 59m')
  assert.equal(ago(now - 24 * 3_600_000, now), '1d')
  assert.equal(ago(now - 47 * 3_600_000, now), '1d')
  assert.equal(ago(now - 9 * 24 * 3_600_000, now), '9d')
})

test('clean turns runs of control characters into one space each run, C1 included', () => {
  assert.equal(clean('a\x1b[31mb'), 'a [31mb')
  assert.equal(clean('a\n\n\tb'), 'a b')
  assert.equal(clean('a\x9bb\x7fc'), 'a b c')
  assert.equal(clean(null), '')
  assert.equal(clean(undefined), '')
  assert.equal(clean(42), '42')
})

test('tokens: keys, CSI and SS3 sequences, alt-keys, pastes and SGR mouse reports', () => {
  const t = (s: string) => [...tokens(s)]
  assert.deepEqual(t('ab'), [{ key: 'a' }, { key: 'b' }])
  assert.deepEqual(t('\x1b[A\x1bOP\x1b[9100~'), [{ key: '\x1b[A' }, { key: '\x1bOP' }, { key: '\x1b[9100~' }])
  assert.deepEqual(t('\x1bx'), [{ key: '\x1bx' }])
  assert.deepEqual(t('\x1b'), [{ key: '\x1b' }])
  assert.deepEqual(t('\x1b[200~hi\nthere\x1b[201~z'), [{ paste: 'hi\nthere' }, { key: 'z' }])
  assert.deepEqual(t('\x1b[<0;12;7M\x1b[<64;1;2m'), [
    { mouse: { button: 0, x: 12, y: 7, up: false } },
    { mouse: { button: 64, x: 1, y: 2, up: true } },
  ])
  // A paste whose end comes in a later read stays a paste, keys and all.
  assert.deepEqual(t('\x1b[200~ab'), [{ paste: 'ab' }])
  assert.deepEqual(t('\rq\x1b[201~z'), [{ paste: '\rq' }, { key: 'z' }])
  assert.deepEqual(t('\x13日'), [{ key: '\x13' }, { key: '日' }])
})

test('enter, leave and paint write what the terminal needs', () => {
  const out: string[] = []
  const write = process.stdout.write
  process.stdout.write = (s: string | Uint8Array) => (out.push(String(s)), true)
  try {
    enter()
    paint(['one', 'two'])
    leave()
  } finally {
    process.stdout.write = write
  }
  assert.deepEqual(out, [
    // What a crashed view before it may have left on goes off first.
    '\x1b[?1049h\x1b[?25l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1016l\x1b[?1000h\x1b[?1006h\x1b[?2004h',
    '\x1b[?2026h\x1b[1;1Hone\x1b[2;1Htwo\x1b[?2026l',
    '\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l',
  ])
})
