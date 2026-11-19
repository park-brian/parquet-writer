import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, stat, statfs, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { writeParquet } from '../src/index.js'
import { fileSink } from '../src/node.js'

const gib = 1024 ** 3
const page = 1024 ** 2
const filename = process.argv[2] ?? `.tmp/large-${process.pid}.parquet`
const count = 4 * 1024 + 16
const schema = { fields: [
  { name: 'id', type: 'int32', nullable: false },
  { name: 'payload', type: 'binary', nullable: false },
] }

await mkdir('.tmp', { recursive: true })
const space = await statfs(dirname(resolve(filename)))
assert.ok(space.bavail * space.bsize > 5 * gib, 'Large test needs 5 GiB of available space')
const output = await fileSink(filename)
try {
  const payload = new Uint8Array(page)
  function* rows() {
    for (let id = 0; id < count; id++) {
      payload[0] = id & 255
      payload[page - 1] = (id >>> 8) & 255
      yield { id, payload }
    }
  }
  const result = await writeParquet({
    schema, rows: rows(), rowGroupRows: 16, rowGroupByteTarget: 32 * page,
    codec: 'UNCOMPRESSED', dictionary: false, sink: output,
  })
  assert.equal(result.rowCount, BigInt(count))
  assert.equal(result.byteLength, BigInt((await stat(filename)).size))
  assert.ok(result.byteLength > BigInt(4 * gib))
  execFileSync(process.env.PYTHON || 'python', ['test/inspect_large.py', filename, String(count)], { stdio: 'inherit' })
  console.log(`Wrote and verified ${result.byteLength} bytes`)
} finally {
  if (!process.argv[2]) await unlink(filename)
}
