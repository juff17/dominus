// node --test ghostty/tui/input.test.ts
// input.pin.test.ts pins what each view's tokenizer makes of a read; these
// are what a tokenizer carries from one read to the next.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { tokenizer } from './input.ts'

const cut = (s: string, at: number): [Buffer, Buffer] => {
  const b = Buffer.from(s, 'utf8')
  return [b.subarray(0, at), b.subarray(at)]
}

test('a character a read cuts in two comes whole from the next read, in a paste and as a key', () => {
  const t = tokenizer({ paste: true, unicode: true })
  const text = '\x1b[200~a—b\x1b[201~'
  const [one, two] = cut(text, text.indexOf('—') + 1)
  assert.deepEqual(t(one), [{ paste: 'a' }])
  assert.deepEqual(t(two), [{ paste: '—b' }])
  const [three, four] = cut('x🙂', 3)
  assert.deepEqual([...t(three), ...t(four)], [{ key: 'x' }, { key: '🙂' }])
})

test('a paste going on is settled when the read is tokenized, whether or not its tokens are looked at', () => {
  const t = tokenizer({ paste: true })
  t('\x1b[200~ab')
  assert.deepEqual(t('a\x1b[201~a'), [{ paste: 'a' }, { key: 'a' }], 'the next read is still the paste, not keys')
  const [first] = t('\x1b[200~x')
  assert.deepEqual(first, { paste: 'x' })
  assert.deepEqual(t('\x1b[201~q'), [{ key: 'q' }], 'stopping after the paste token still ends it')
})
