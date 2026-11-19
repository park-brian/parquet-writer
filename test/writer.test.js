import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parquetMetadata, parquetReadObjects } from 'hyparquet'
import { writeParquet, writeParquetBuffer } from '../src/index.js'

const schema = { fields: [
  { name: 'id', type: 'int32', nullable: false },
  { name: 'value', type: 'double', nullable: false },
  { name: 'label', type: 'string', nullable: false },
] }
const rows = Array.from({ length: 40 }, (_, id) => ({ id, value: id + 0.5, label: 'café 🌍' }))

test('writes readable pages and exact chunk offsets', async () => {
  const bytes = await writeParquetBuffer({ schema, rows })
  const file = bytes.buffer
  assert.deepEqual(await parquetReadObjects({ file }), rows)
  const metadata = parquetMetadata(file)
  let offset = 4n
  for (const { meta_data: chunk } of metadata.row_groups[0].columns) {
    assert.equal(chunk.dictionary_page_offset ?? chunk.data_page_offset, offset)
    offset += chunk.total_compressed_size
  }
  const view = new DataView(file)
  assert.equal(offset, BigInt(bytes.length - 8 - view.getUint32(bytes.length - 8, true)))
})

test('writes an empty table with its schema', async () => {
  const bytes = await writeParquetBuffer({ schema, rows: [] })
  const metadata = parquetMetadata(bytes.buffer)
  assert.equal(metadata.num_rows, 0n)
  assert.deepEqual(metadata.row_groups, [])
  assert.deepEqual(metadata.schema.slice(1).map(field => field.name), ['id', 'value', 'label'])
})

test('preserves sink failure and aborts without closing', async () => {
  const failure = new Error('sink failed')
  const events = []
  await assert.rejects(writeParquet({ schema, rows, sink: {
    write() { events.push('write'); throw failure },
    close() { events.push('close') },
    abort(reason) { events.push(reason) },
  } }), error => error === failure)
  assert.deepEqual(events, ['write', failure])
})
