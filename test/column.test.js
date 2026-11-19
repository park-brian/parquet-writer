import { compileSchema } from '../src/schema.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parquetMetadata, parquetReadObjects } from 'hyparquet'
import { writeParquetBuffer } from '../src/index.js'
import { dictionary, encodeBounds, mergeBounds, pageBounds } from '../src/column.js'

import { snappy } from '../src/snappy.js'

test('dictionary widths follow the highest present ID', () => {
  const [leaf] = compileSchema({ fields: [{ name: 'id', type: 'int32' }] }).leaves
  for (const [count, width] of [[1, 0], [2, 1], [255, 8], [256, 8], [257, 9]]) {
    const values = Array.from({ length: count }, (_, id) => id)
    const candidate = dictionary(leaf, values, 4 * count)
    assert.equal(candidate.width, width)
    assert.deepEqual(candidate.ids, values)
    assert.equal(dictionary(leaf, values, 4 * count - 1), undefined)
  }
})

test('binary dictionary resolves hash collisions by comparing bytes', () => {
  const [leaf] = compileSchema({ fields: [{ name: 'label', type: 'binary' }] }).leaves
  const a = Uint8Array.of(33, 18, 201, 71, 204, 132, 123, 227)
  const b = Uint8Array.of(207, 109, 179, 156, 38, 246, 42, 176)
  const candidate = dictionary(leaf, [a, b, a.slice(), b.slice()], 24)
  assert.deepEqual(candidate.entries, [a, b])
  assert.deepEqual(candidate.ids, [0, 1, 0, 1])
})

test('comparison preserves zero sign and handles unsafe pages separately from nulls', () => {
  const [leaf] = compileSchema({ fields: [{ name: 'x', type: 'double' }] }).leaves
  const bounds = pageBounds([Infinity, -Infinity, null], 4096)
  mergeBounds(bounds, pageBounds([null, null], 4096))
  const stats = encodeBounds(leaf, bounds)
  assert.equal(stats.nulls, 3n)
  assert.equal(new DataView(stats.min.buffer).getFloat64(0, true), -Infinity)
  assert.equal(new DataView(stats.max.buffer).getFloat64(0, true), Infinity)
  const zeros = encodeBounds(leaf, pageBounds([0, -0], 4096))
  assert.ok(Object.is(new DataView(zeros.min.buffer).getFloat64(0, true), -0))
  assert.ok(Object.is(new DataView(zeros.max.buffer).getFloat64(0, true), 0))
  mergeBounds(bounds, pageBounds([NaN], 4096))
  assert.deepEqual(encodeBounds(leaf, bounds), { nulls: 3n, nans: 1n })
})

test('string bounds follow unsigned UTF-8 bytes and omit oversized extremes', () => {
  const [leaf] = compileSchema({ fields: [{ name: 'label', type: 'string' }] }).leaves
  const text = new TextEncoder()
  const values = [text.encode('𐀀'), text.encode('\ue000')]
  const stats = encodeBounds(leaf, pageBounds(values, 4))
  assert.deepEqual(stats.min, values[1])
  assert.deepEqual(stats.max, values[0])
  assert.deepEqual(encodeBounds(leaf, pageBounds(values, 3)), { nulls: 0n })
})

test('dictionary offsets and async compression survive decoding', async () => {
  const schema = { fields: [{ name: 'label', type: 'string' }] }
  const rows = Array.from({ length: 100 }, (_, i) => ({ label: i < 20 ? null : 'long repeated string' }))
  let calls = 0
  const file = (await writeParquetBuffer({
    schema, rows, pageByteTarget: 120,
    codecs: { SNAPPY: async bytes => { calls++; return snappy(bytes) } },
  })).buffer
  const chunk = parquetMetadata(file).row_groups[0].columns[0].meta_data
  assert.equal(chunk.dictionary_page_offset, 4n)
  assert.ok(chunk.data_page_offset > 4n)
  assert.ok(calls > 2)
  assert.deepEqual((await parquetReadObjects({ file })).map(row => row.label ?? null), rows.map(row => row.label))
})
