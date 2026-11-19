import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parquetMetadata, parquetReadObjects } from 'hyparquet'
import { ParquetWriter, writeParquet, writeParquetBuffer } from '../src/index.js'
import { compile, dataPage } from '../src/pages.js'
import { webSink } from '../src/web.js'
import { streamSink } from '../src/node.js'
import { Writable } from 'node:stream'

const schema = { fields: [{ name: 'score', type: 'int32' }] }

test('writes nullable and repeated V1 level streams in wire order', () => {
  const [leaf] = compile(schema)
  const nullable = dataPage(leaf, [7, 9], [1, 0, 1], 1)
  assert.equal(Buffer.from(nullable).toString('hex'), '0200000003050700000009000000')
  const repeated = dataPage(leaf, [1, 2], [0, 1, 3, 2, 3], 2, [0, 0, 0, 1, 1], 1)
  assert.equal(Buffer.from(repeated).toString('hex'), '0200000003180300000003b4030100000002000000')
})

test('reused column buffers fill groups across batch boundaries', async () => {
  async function* columns() {
    const backing = new Int32Array(3)
    const values = backing.subarray(1, 2)
    const validity = new Uint8Array(1)
    for (let i = 0; i < 11; i++) {
      values[0] = i
      validity[0] = i % 2
      yield { rowCount: 1, columns: { score: { values, validity } } }
    }
  }
  const bytes = await writeParquetBuffer({ schema, columns: columns(), rowGroupRows: 5, pageByteTarget: 5 })
  assert.deepEqual(parquetMetadata(bytes.buffer).row_groups.map(group => group.num_rows), [5n, 5n, 1n])
  const output = await parquetReadObjects({ file: bytes.buffer })
  assert.deepEqual(output.map(row => row.score ?? null), [null, 1, null, 3, null, 5, null, 7, null, 9, null])
})

test('a pending sink write stops source pulls', async () => {
  const { promise: entered, resolve: start } = Promise.withResolvers()
  const { promise: released, resolve: release } = Promise.withResolvers()
  let pulls = 0
  async function* rows() {
    for (let score = 0; score < 3; score++) {
      pulls++
      yield { score }
    }
  }
  const done = writeParquet({ schema, rows: rows(), rowGroupRows: 1, sink: {
    async write() { start(); await released },
  } })
  await entered
  assert.equal(pulls, 1)
  release()
  assert.equal((await done).rowCount, 3n)
})

test('rejects overlap and shares a successful close', async () => {
  const stream = new WritableStream({ write() {} })
  const writer = new ParquetWriter({ schema, sink: webSink(stream) })
  const write = writer.writeRows([{ score: 1 }])
  await assert.rejects(writer.flush(), /busy/)
  await write
  const close = writer.close()
  assert.equal(writer.close(), close)
  assert.equal((await close).rowCount, 1n)
  assert.equal(stream.locked, false)
})

test('aborts once when cancellation interrupts a write', async () => {
  const { promise, resolve } = Promise.withResolvers()
  const { promise: entered, resolve: start } = Promise.withResolvers()
  const events = []
  const writer = new ParquetWriter({ schema, rowGroupRows: 1, sink: {
    async write() { start(); await promise },
    abort(reason) { events.push(reason) },
  } })
  const write = writer.writeRows([{ score: 1 }])
  await entered
  const reason = new Error('stop')
  const abort = writer.abort(reason)
  assert.equal(writer.abort(), abort)
  resolve()
  await assert.rejects(write, reason)
  await abort
  assert.deepEqual(events, [reason])
})

test('preserves primitive widths and an all-null page through a Node stream', async () => {
  const schema = { fields: [
    { name: 'flag', type: 'boolean' },
    { name: 'amount', type: 'int64' },
    { name: 'ratio', type: 'float' },
    { name: 'bytes', type: 'binary' },
    { name: 'fixed', type: 'fixedBinary', length: 2 },
  ] }
  const rows = [{ flag: false, amount: -9223372036854775808n, ratio: 0.5,
    bytes: Uint8Array.of(255, 0, 2), fixed: Uint8Array.of(7, 8) }, {}]
  const chunks = []
  const stream = new Writable({
    write(chunk, _encoding, callback) { chunks.push(chunk); callback() },
  })
  await writeParquet({ schema, rows, pageByteTarget: 1, sink: streamSink(stream) })
  const file = Uint8Array.from(Buffer.concat(chunks)).buffer
  const [present, missing] = await parquetReadObjects({ file, utf8: false })
  assert.deepEqual(present, rows[0])
  for (const field of schema.fields) assert.equal(missing[field.name] ?? null, null)
})

test('source failure skips the footer and close failure still rejects', async () => {
  const sourceError = new Error('source failed')
  async function* rows() { yield { score: 1 }; throw sourceError }
  const sourceBytes = []
  await assert.rejects(writeParquet({ schema, rows: rows(), rowGroupRows: 1, sink: {
    write(bytes) { sourceBytes.push(bytes) },
  } }), sourceError)
  assert.notDeepEqual(sourceBytes.at(-1).slice(-4), Uint8Array.of(80, 65, 82, 49))

  const closeError = new Error('close failed')
  const chunks = []
  await assert.rejects(writeParquet({ schema, rows: [{ score: 1 }], sink: {
    write(bytes) { chunks.push(bytes) },
    close() { throw closeError },
  } }), closeError)
  const file = Uint8Array.from(Buffer.concat(chunks)).buffer
  assert.deepEqual(await parquetReadObjects({ file }), [{ score: 1 }])
})
