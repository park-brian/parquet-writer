import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parquetMetadata, parquetReadObjects } from 'hyparquet'
import { writeParquetBuffer } from '../src/index.js'
import { nestedRows, nestedSchema } from './nested-fixture.js'

test('preserves list boundaries and required children under absent parents', async () => {
  const file = (await writeParquetBuffer({ schema: nestedSchema, rows: nestedRows,
    pageByteTarget: 2, rowGroupRows: 3, codec: 'UNCOMPRESSED' })).buffer
  const metadata = parquetMetadata(file)
  const group = metadata.row_groups[0]
  assert.equal(group.num_rows, 3n)
  const columns = group.columns.map(column => column.meta_data)
  assert.equal(columns[1].num_values, 5n)
  assert.deepEqual(columns[3].path_in_schema, ['record', 'a.b'])
  const rows = await parquetReadObjects({ file })
  assert.deepEqual(rows.map(row => row.numbers ?? null), [null, [], [1, null, 2]])
  assert.deepEqual(rows[2].matrix, nestedRows[2].matrix)
})

test('rejects null map keys, sparse lists, and cyclic schemas', async () => {
  for (const row of [{ id: 0, attributes: new Map([[null, 1]]) }, { id: 0, numbers: Array(1) }]) {
    await assert.rejects(writeParquetBuffer({ schema: nestedSchema, rows: [row] }), /Invalid row 0/)
  }
  const list = { type: 'list' }
  list.element = list
  await assert.rejects(writeParquetBuffer({ schema: { fields: [{ ...list, name: 'x' }] }, rows: [] }), /cyclic schema/)
})

test('rejects distinct JavaScript keys that encode to the same map key', async () => {
  const schema = { fields: [{
    name: 'pairs', type: 'map', key: { type: 'int64' }, value: { type: 'string' },
  }] }
  const rows = [{ pairs: new Map([[1, 'first'], [1n, 'second']]) }]
  await assert.rejects(writeParquetBuffer({ schema, rows }), /Duplicate encoded map key/)
})
