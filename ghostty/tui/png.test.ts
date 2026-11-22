// node --test ghostty/tui/png.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crc32, inflateSync } from 'node:zlib'
import { png } from './png.ts'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// The chunks after the signature, each checked against its CRC.
function chunks(file: Buffer): [string, Buffer][] {
  const out: [string, Buffer][] = []
  for (let at = 8; at < file.length; ) {
    const n = file.readUInt32BE(at)
    const typed = file.subarray(at + 4, at + 8 + n)
    assert.equal(file.readUInt32BE(at + 8 + n), crc32(typed) >>> 0, `${typed.subarray(0, 4)} CRC`)
    out.push([typed.subarray(0, 4).toString('ascii'), typed.subarray(4)])
    at += 12 + n
  }
  return out
}

test('a PNG is the signature, then a header, the pixels and the end', () => {
  const file = png(2, 1, new Uint8Array(8))
  assert.deepEqual([...file.subarray(0, 8)], SIGNATURE)
  assert.deepEqual(
    chunks(file).map(([type]) => type),
    ['IHDR', 'IDAT', 'IEND'],
  )
})

test('the header gives the size, 8 bits a channel, RGBA', () => {
  const [[, header]] = chunks(png(3, 2, new Uint8Array(24)))
  assert.equal(header.readUInt32BE(0), 3)
  assert.equal(header.readUInt32BE(4), 2)
  assert.deepEqual([...header.subarray(8)], [8, 6, 0, 0, 0])
})

test('each row is its filter, none, then its pixels as given', () => {
  const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
  const [, [, data]] = chunks(png(2, 2, rgba))
  assert.deepEqual([...inflateSync(data)], [0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 9, 10, 11, 12, 13, 14, 15, 16])
})
