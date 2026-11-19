import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asyncProperty, assert as check, array, boolean, integer, oneof, option, string, tuple } from 'fast-check'
import { parquetReadObjects } from 'hyparquet'
import { writeParquetBuffer } from '../src/index.js'

const variants = [
  { field: { type: 'int32' }, values: integer() },
  { field: { type: 'boolean' }, values: boolean() },
  { field: { type: 'string' }, values: string({ maxLength: 120 }) },
  { field: { type: 'list', element: { type: 'int32' } }, values: array(option(integer()), { maxLength: 20 }) },
]

test('seeded tables survive independent decoding across pages and groups', async () => {
  const properties = variants.map(({ field, values }) =>
    tuple(array(option(values), { maxLength: 80 }), integer({ min: 1, max: 21 }),
      integer({ min: 1, max: 100 }), boolean()).map(([cells, group, page, snappy]) =>
      ({ field, cells, group, page, snappy })))
  await check(asyncProperty(oneof(...properties), async ({ field, cells, group, page, snappy }) => {
    const schema = { fields: [{ ...field, name: 'value' }] }
    const file = (await writeParquetBuffer({
      schema, rows: cells.map(value => ({ value })),
      rowGroupRows: group, pageByteTarget: page,
      codec: snappy ? 'SNAPPY' : 'UNCOMPRESSED',
    })).buffer
    const rows = await parquetReadObjects({ file })
    assert.deepEqual(rows.map(row => row.value ?? null), cells)
  }), { seed: Number(process.env.PARQUET_SEED ?? 24017), numRuns: Number(process.env.PARQUET_RUNS ?? 160) })
})

test('malformed integer inputs fail before the first sink write', async () => {
  const { writeParquet } = await import('../src/index.js')
  const schema = { fields: [{ name: 'value', type: 'int32', nullable: false }] }
  await check(asyncProperty(oneof(string(), boolean(), integer().map(n => n + 0.5)), async value => {
    let writes = 0
    await assert.rejects(writeParquet({ schema, rows: [{ value }], sink: { write() { writes++ } } }), /Invalid/)
    assert.equal(writes, 0)
  }), { seed: 24018, numRuns: 48 })
})
