// node --test ghostty/tui/gear.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { type Art, BOARD, RAIL_REST, RAIL_TURNED } from './gear-art.ts'
import { BOARD_ID, type Fit, RAIL_IDS, centredRow, fit, gearFile, gearRow, pixels, sendGear } from './gear.ts'
import { gridRow, placeGrid, transmitFile } from './kitty.ts'

// A 6-column rail of 9 × 19 px cells.
const CELL = { cw: 9, ch: 19 }
const RAIL = fit(RAIL_REST, CELL, 6, 8) as Fit
const lit = (art: Art) => art.join('').split('#').length - 1

test('the art is square, every pixel # or .', () => {
  for (const [art, size] of [[RAIL_REST, 24], [RAIL_TURNED, 24], [BOARD, 48]] as const) {
    assert.equal(art.length, size)
    for (const row of art) assert.match(row, new RegExp(`^[#.]{${size}}$`))
  }
})

test('the rail turns between two frames', () => {
  assert.notDeepEqual(RAIL_REST, RAIL_TURNED)
  assert.deepEqual(RAIL_IDS, [5, 6])
  assert.equal(BOARD_ID, 7)
})

test('fit takes the biggest whole-number scale the cells hold, and the cells that takes', () => {
  // 54 px across: 24 px goes in twice, onto 6 × 3 cells.
  assert.deepEqual(RAIL, { px: 24, scale: 2, cols: 6, rows: 3 })
  // 11 rows are 209 px: 48 px goes in 4 times.
  assert.deepEqual(fit(BOARD, CELL, 200, 11), { px: 48, scale: 4, cols: 22, rows: 11 })
  assert.equal(fit(BOARD, CELL, 3, 2), null)
})

test('the pixels fill the cells exactly: the art scaled and centred, the rest clear', () => {
  const { w, h, rgba } = pixels(RAIL_REST, RAIL, CELL, '#89b4fa')
  assert.deepEqual([w, h], [54, 57])
  const at = (x: number, y: number) => [...rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)]
  // 48 px in 54 × 57: 3 px in from the left, 4 down from the top. The art's
  // top row lights pixels 10 to 13, each 2 × 2 here.
  const blue = [0x89, 0xb4, 0xfa, 255]
  assert.deepEqual(at(3 + 20, 4), blue)
  assert.deepEqual(at(3 + 21, 5), blue)
  assert.deepEqual(at(3 + 19, 4), [0, 0, 0, 0])
  assert.deepEqual(at(0, 0), [0, 0, 0, 0])
  let on = 0
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) on++
  assert.equal(on, 4 * lit(RAIL_REST))
})

test('the PNG is written once, named by its art, size and colour, with no part file left', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gear-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = gearFile(dir, 'rail-0', RAIL_REST, RAIL, CELL, '#89b4fa')
  assert.match(basename(path), /^rail-0-[0-9a-f]{8}-2x-6x3-9x19-89b4fa\.png$/)
  // Other art, as after an edit to it, is another file.
  assert.notEqual(gearFile(dir, 'rail-0', RAIL_TURNED, RAIL, CELL, '#89b4fa'), path)
  rmSync(gearFile(dir, 'rail-0', RAIL_TURNED, RAIL, CELL, '#89b4fa'))
  assert.deepEqual([...readFileSync(path).subarray(1, 4)], [...Buffer.from('PNG')])
  writeFileSync(path, 'kept')
  assert.equal(gearFile(dir, 'rail-0', RAIL_REST, RAIL, CELL, '#89b4fa'), path)
  assert.equal(readFileSync(path, 'utf8'), 'kept')
  assert.deepEqual(readdirSync(dir), [basename(path)])
})

test('sending a gear places it on its cells every time', () => {
  assert.equal(sendGear(BOARD_ID, '/run/board.png', RAIL), transmitFile(BOARD_ID, '/run/board.png') + placeGrid(BOARD_ID, 1, 6, 3))
})

test('a gear row is its placeholder cells, centred on a full-width row of the fill', () => {
  const cells = gearRow(RAIL_IDS[1], RAIL, 2)
  assert.equal(cells, gridRow(6, 1, 2, 0, 6))
  assert.equal(centredRow(cells, 6, 10, '<fill>'), `<fill>${' '.repeat(10)}\x1b[3G<fill>${cells}\x1b[0m`)
})
