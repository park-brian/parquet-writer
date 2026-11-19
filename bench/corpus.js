import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, resolve } from 'node:path'
import { stat, statfs } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { performance } from 'node:perf_hooks'
import { writeParquet } from '../src/index.js'
import { fileSink } from '../src/node.js'

const [source, output, limit = '1000000'] = process.argv.slice(2)
assert.ok(source && output && /^\d+$/.test(limit), 'Usage: npm run bench:corpus -- input.parquet output.parquet [rows; 0 for all]')
assert.notEqual(resolve(source), resolve(output))
const input = await stat(source)
const space = await statfs(dirname(resolve(output)))
if (limit === '0') assert.ok(space.bavail * space.bsize > input.size, 'Insufficient space for a full corpus run')
const start = performance.now()
const child = spawn(process.env.PYTHON || 'python', ['bench/read_corpus.py', source, limit], {
  stdio: ['ignore', 'pipe', 'inherit'],
})
const finished = once(child, 'close')
finished.catch(() => {})
const lines = createInterface({ input: child.stdout })
const iterator = lines[Symbol.asyncIterator]()
try {
  const first = await iterator.next()
  assert.ok(!first.done, 'Corpus reader returned no schema')
  const schema = JSON.parse(first.value)
  const wide = schema.fields.filter(field => field.type === 'uint64' || field.type === 'int64')
  async function* columns() {
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      const batch = JSON.parse(next.value)
      for (const { name } of wide) {
        batch.columns[name] = batch.columns[name].map(value => value === null ? null : BigInt(value))
      }
      yield batch
    }
    const [code] = await finished
    assert.equal(code, 0, 'Corpus reader failed')
  }
  const result = await writeParquet({ schema, columns: columns(), sink: await fileSink(output) })
  console.log(`Wrote ${result.rowCount} rows and ${result.byteLength} bytes in ${Math.round(performance.now() - start)} ms`)
} finally {
  lines.close()
  if (child.exitCode === null) child.kill()
}
