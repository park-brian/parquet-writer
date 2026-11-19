import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parquetMetadata, parquetReadObjects } from 'hyparquet'
import { writeParquet, writeParquetBuffer } from '../src/index.js'

test('infers the entire in-memory table with nested hints', async () => {
  const rows = [{ x: 1, tags: [], address: null }, { x: 1.25, tags: [], address: { zip: null, city: 'Paris' } }]
  const file = (await writeParquetBuffer({ rows, schemaHints: { fields: [
    { name: 'tags', type: 'list', element: { type: 'string' } },
    { name: 'address', type: 'struct', fields: [{ name: 'zip', type: 'int32' }] },
  ] } })).buffer
  const read = await parquetReadObjects({ file })
  assert.equal(read[1].x, 1.25)
  assert.equal(read[1].address.city, 'Paris')
  assert.deepEqual(read[0].tags, [])
})

test('typed vectors provide type evidence even when their only slot is null', async () => {
  const bytes = await writeParquetBuffer({ columns: { rowCount: 1, columns: {
    value: { values: new Uint16Array(1), validity: Uint8Array.of(0) },
  } }, metadata: [{ key: 'case', value: 'inferred' }], createdBy: 'writer test' })
  const metadata = parquetMetadata(bytes.buffer)
  assert.equal(metadata.schema[1].converted_type, 'UINT_16')
  assert.equal(metadata.created_by, 'writer test')
  assert.equal(metadata.key_value_metadata[0].value, 'inferred')
})

test('writes its bounded sample before pulling more from a stream', async () => {
  let pulls = 0
  const reused = { amount: 0 }
  const chunks = []
  async function* rows() {
    for (let i = 0; i < 5; i++) {
      pulls++
      reused.amount = i + 0.5
      yield reused
    }
  }
  await writeParquet({ rows: rows(), rowGroupRows: 2, sink: {
    write(bytes) {
      if (!chunks.length) assert.equal(pulls, 2)
      chunks.push(bytes)
    },
  } })
  const file = Uint8Array.from(Buffer.concat(chunks)).buffer
  assert.deepEqual((await parquetReadObjects({ file })).map(row => row.amount), [0.5, 1.5, 2.5, 3.5, 4.5])
})

test('freezes the inferred schema and closes the source on mismatch', async () => {
  for (const row of [{ amount: 'wrong' }, { amount: 2, extra: true }]) {
    let closed = false
    async function* rows() {
      try { yield { amount: 1 }; yield row; yield { amount: 3 } }
      finally { closed = true }
    }
    await assert.rejects(writeParquetBuffer({ rows: rows(), rowGroupRows: 1 }), /row 1/)
    assert.ok(closed)
  }
})

test('rejects empty or ambiguous input without a schema', async () => {
  for (const rows of [[], [{ x: null }], [{ x: [] }], [{ x: 1 }, { x: '1' }]]) {
    await assert.rejects(writeParquetBuffer({ rows }), /schema|Mixed types/)
  }
})

test('infers streamed column widths after empty leading batches', async () => {
  async function* columns() {
    yield { rowCount: 0, columns: { id: new BigUint64Array(0) } }
    yield { rowCount: 2, columns: { id: new BigUint64Array([0n, (1n << 64n) - 1n]) } }
    yield { rowCount: 0, columns: {} }
  }
  const file = (await writeParquetBuffer({ columns: columns(), rowGroupRows: 1 })).buffer
  assert.deepEqual((await parquetReadObjects({ file })).map(row => row.id), [0n, (1n << 64n) - 1n])
})

test('requires consistent column names inside and beyond the sample', async () => {
  for (const rowGroupRows of [1, 10]) {
    await assert.rejects(writeParquetBuffer({ rowGroupRows, columns: [
      { rowCount: 1, columns: { x: [1] } },
      { rowCount: 1, columns: { y: [2] } },
    ] }), /Invalid vector for x/)
  }
})
