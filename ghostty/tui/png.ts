// A PNG from RGBA pixels. The kitty protocol takes pictures as PNG files the
// terminal reads itself (kitty.ts transmitFile), so drawn ones are written as PNG.

import { crc32, deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  typed.copy(out, 4)
  out.writeUInt32BE(crc32(typed) >>> 0, 8 + data.length)
  return out
}

// `rgba` holds w × h pixels, four bytes each, row by row.
export function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(w, 0)
  header.writeUInt32BE(h, 4)
  header[8] = 8 // bits per channel
  header[9] = 6 // RGBA
  // Each row is led by its filter type, 0: none.
  const stride = w * 4
  const rows = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) rows.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
