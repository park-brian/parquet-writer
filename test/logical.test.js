import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parquetMetadata, parquetReadObjects } from 'hyparquet'
import { writeParquetBuffer } from '../src/index.js'
import { Bytes } from '../src/binary.js'
import { compile, normalize, plain } from '../src/pages.js'
import { encodeBounds, pageBounds } from '../src/column.js'

test('preserves unsigned integer bits and decimal numeric order', async () => {
  const schema = { fields: [
    { name: 'id', type: 'uint64' },
    { name: 'amount', type: 'decimal', precision: 38, scale: 4 },
  ] }
  const rows = [{ id: 18446744073709551615n, amount: 10n ** 38n - 1n }, { id: 0n, amount: -1n }]
  const file = (await writeParquetBuffer({ schema, rows })).buffer
  const [first, second] = await parquetReadObjects({ file })
  assert.equal(first.id, rows[0].id)
  assert.equal(second.id, 0n)
  const metadata = parquetMetadata(file)
  assert.equal(metadata.schema[2].type_length, 16)
  const [, leaf] = compile(schema)
  const bounds = encodeBounds(leaf, pageBounds(rows.map(row => row.amount), 4096))
  assert.equal(Buffer.from(bounds.min).toString('hex'), 'ff'.repeat(16))
  const out = new Bytes()
  plain(out, leaf, [rows[0].amount])
  assert.deepEqual(bounds.max, out.finish())
})

test('rejects values outside their declared analytical type', () => {
  const examples = [
    [{ type: 'uint8' }, 256],
    [{ type: 'int8' }, -129],
    [{ type: 'int64' }, Number.MAX_SAFE_INTEGER + 1],
    [{ type: 'uint64' }, -1n],
    [{ type: 'time', unit: 'millis' }, 86_400_000],
    [{ type: 'time', unit: 'micros' }, 86_400_000_000n],
    [{ type: 'timestamp', unit: 'millis' }, new Date(NaN)],
    [{ type: 'timestamp', unit: 'millis', isAdjustedToUTC: false }, new Date(0)],
    [{ type: 'decimal', precision: 38 }, 10n ** 38n],
    [{ type: 'uuid' }, 'not a uuid'],
  ]
  for (const [field, value] of examples) {
    const [leaf] = compile({ fields: [{ name: 'v', ...field }] })
    assert.throws(() => normalize(leaf, value), /Invalid/)
  }
})
