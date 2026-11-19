import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parquetMetadata, parquetReadObjects } from 'hyparquet'
import { writeParquetBuffer } from '../src/index.js'
import { dictionary, encodeBounds, mergeBounds, pageBounds } from '../src/column.js'
import { compile } from '../src/pages.js'
import { snappy } from '../src/snappy.js'

test('dictionary widths follow the highest present ID', () => {
  const [leaf] = compile({ fields: [{ name: 'id', type: 'int32' }] })
  for (const [count, width] of [[1, 0], [2, 1], [255, 8], [256, 8], [257, 9]]) {
    const values = Array.from({ length: count }, (_, id) => id)
    const candidate = dictionary(leaf, values, 4 * count)
    assert.equal(candidate.width, width)
    assert.deepEqual(candidate.ids, values)
    assert.equal(dictionary(leaf, values, 4 * count - 1), undefined)
  }
})

test('comparison preserves zero sign and handles unsafe pages separately from nulls', () => {
  const [leaf] = compile({ fields: [{ name: 'x', type: 'double' }] })
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
  assert.deepEqual(encodeBounds(leaf, bounds), { nulls: 3n })
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
