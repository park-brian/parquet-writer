import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bytes } from '../src/binary.js'
import { encodeCompact, footer, pageHeader, trailer } from '../src/metadata.js'
import { compileSchema } from '../src/schema.js'
import { parquetMetadata } from 'hyparquet'

const hex = bytes => Buffer.from(bytes).toString('hex')

test('packs Compact Protocol fields and terminates each struct', () => {
  assert.equal(hex(pageHeader(4, 1)), '1500150815082c15021500150615060000')
  assert.equal(hex(encodeCompact([[16, 5, -1], [17, 5, 1]])), '052001150200')
})

test('switches to an explicit varint at fifteen list entries', () => {
  for (const [length, header] of [[14, '19e5'], [15, '19f50f']]) {
    assert.equal(hex(encodeCompact([[1, 9, [5, Array(length).fill(0)]]])), header + '00'.repeat(length + 1))
  }
})

test('encodes 64-bit extrema without rounding', () => {
  const bytes = new Bytes()
  bytes.signed(-(1n << 63n))
  bytes.signed((1n << 63n) - 1n)
  bytes.varint(128)
  assert.equal(hex(bytes.finish()), 'ffffffffffffffffff01feffffffffffffffff018001')
})

test('writes floating-point NaN counts even when zero', () => {
  const header = pageHeader(8, 1, 8, 0, { nulls: 0n, nans: 0n, min: Uint8Array.of(1), max: Uint8Array.of(2) })
  assert.equal(hex(header), '1500151015102c15021500150615061c360028010218010111111600000000')
})

test('keeps file metadata offsets exact beyond the safe number range', () => {
  const compiled = compileSchema({ fields: [{ name: 'id', type: 'int32' }] })
  const offset = 2n ** 53n + 17n
  const rawSize = 2n ** 32n + 1n
  const metadata = footer(compiled, [{ count: 1, chunks: [
    { leaf: compiled.leaves[0], count: 1, offset, size: 128n, rawSize, codec: 1 },
  ] }], 1n, [], 'boundary fixture')
  const file = new Bytes()
  file.append(Uint8Array.of(80, 65, 82, 49))
  file.append(metadata)
  file.i32(metadata.length)
  file.append(Uint8Array.of(80, 65, 82, 49))
  const chunk = parquetMetadata(file.finish().slice().buffer).row_groups[0].columns[0].meta_data
  assert.equal(chunk.data_page_offset, offset)
  assert.equal(chunk.total_uncompressed_size, rawSize)
  assert.throws(() => pageHeader(2 ** 31, 1), /i32 limit/)
  assert.equal(hex(trailer(2 ** 32 - 1)), 'ffffffff50415231')
  assert.throws(() => trailer(2 ** 32), /uint32 limit/)
})
