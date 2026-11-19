import assert from 'node:assert/strict'
import { availableParallelism, cpus, platform, release } from 'node:os'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { writeParquet, writeParquetBuffer } from '../src/index.js'

const counts = {
  rows: Number(process.env.PARQUET_ROWS ?? 1_000_000),
  warmups: Number(process.env.PARQUET_WARMUPS ?? 3),
  runs: Number(process.env.PARQUET_RUNS ?? 5),
}
const { rows: count, warmups, runs } = counts
assert.ok(Number.isSafeInteger(count) && count > 0)
assert.ok(Number.isSafeInteger(runs) && runs > 0)
assert.ok(Number.isSafeInteger(warmups) && warmups >= 0)

const workloads = {
  numeric: () => [
    col('id', 'int32', 'INT32', Int32Array.from({ length: count }, (_, i) => i)),
    col('value', 'double', 'DOUBLE', Float64Array.from({ length: count }, (_, i) => i % 199 - 0.5)),
  ],
  categorical: () => [col('text', 'string', 'STRING', Array.from({ length: count }, (_, i) => 'group ' + i % 24))],
  unique: () => [col('text', 'string', 'STRING', Array.from({ length: count }, (_, i) => 'variable row ' + i + ' 🌍'))],
  text: () => {
    const labels = Array.from({ length: 20 }, (_, i) => `é${i} 🍃 `.repeat(32))
    return [col('text', 'string', 'STRING', Array.from({ length: count }, (_, i) => labels[i % 20]))]
  },
  nullable: () => [col('id', 'int32', 'INT32', Array.from({ length: count }, (_, i) => i % 4 ? null : i), true)],
  wide: () => Array.from({ length: 24 }, (_, j) =>
    col('c' + j, 'int32', 'INT32', Int32Array.from({ length: count }, (_, i) => (i + j) % 600))),
  temporal: () => [col('time', 'timestamp', 'TIMESTAMP',
    Array.from({ length: count }, (_, i) => new Date(i * 1000)), false, { unit: 'millis' })],
  decimal: () => [col('price', 'decimal', undefined, BigInt64Array.from({ length: count }, (_, i) => BigInt(i % 999999)),
    false, { precision: 12, scale: 3 })],
  nested: () => [col('events', 'list', undefined, Array.from({ length: count }, (_, i) => [
    { score: i % 41 }, null, { score: i % 7 },
  ]), false, { element: { type: 'struct', fields: [{ name: 'score', type: 'int32' }] } })],
}

function col(name, type, referenceType, data, nullable = false, parameters = {}) {
  return { name, type, referenceType, data, nullable, parameters }
}

console.log(JSON.stringify({ node: process.version, os: platform(), release: release(), cpu: cpus()[0]?.model,
  threads: availableParallelism(), ...counts, pageBytes: 1048576, rowGroupRows: 65536 }, null, 2))

const selected = process.argv.slice(2)
for (const name of selected.length ? selected : Object.keys(workloads)) {
  assert.ok(Object.hasOwn(workloads, name), 'Unknown workload: ' + name)
  const columns = workloads[name]()
  const schema = { fields: columns.map(({ name, type, nullable, parameters }) => ({ name, type, nullable, ...parameters })) }
  const batch = { rowCount: count, columns: Object.fromEntries(columns.map(({ name, data }) => [name, data])) }
  const rawBytes = rawSize(columns)
  await measure(name, 'columns-memory', rawBytes, async () => (await writeParquetBuffer({ schema, columns: batch })).length)
  if (columns.every(column => column.referenceType)) {
    const reference = columns.map(({ name, referenceType, nullable, data }) => ({
      name, type: referenceType, nullable, data, offsetIndex: false,
    }))
    await measure(name, 'hyparquet-memory', rawBytes, () => parquetWriteBuffer({
      columnData: reference, codec: 'SNAPPY', rowGroupSize: 65536, pageSize: 1048576,
      dictionarySize: 1048576, statisticsTruncateLength: Infinity,
    }).byteLength)
  }

  function* rows() {
    const row = Object.create(null)
    for (let i = 0; i < count; i++) {
      for (const { name, data } of columns) row[name] = data[i]
      yield row
    }
  }
  await measure(name, 'rows-counting-sink', rawBytes, async sample => {
    const result = await writeParquet({ schema, rows: rows(), sink: { write: sample } })
    return Number(result.byteLength)
  })
  if (name === 'numeric') {
    await measure(name, 'rows-slow-sink', rawBytes, async sample => {
      const result = await writeParquet({ schema, rows: rows(), sink: {
        async write() { sample(); await setTimeout(1) },
      } })
      return Number(result.byteLength)
    })
  }
}

function rawSize(columns) {
  let size = 0
  const text = new TextEncoder()
  for (const { type, data } of columns) {
    if (type === 'list') continue
    for (const value of data) {
      if (value === null) continue
      size += typeof value === 'string' ? 4 + text.encode(value).length : type === 'int32' ? 4 : 8
    }
  }
  return size
}

async function measure(workload, mode, rawBytes, write) {
  const mib = 1024 ** 2
  const samples = []
  let outputBytes
  let heapPeak = 0
  let rssPeak = 0
  const sample = () => {
    const { heapUsed, rss } = process.memoryUsage()
    heapPeak = Math.max(heapPeak, heapUsed)
    rssPeak = Math.max(rssPeak, rss)
  }
  for (let run = -warmups; run < runs; run++) {
    const start = performance.now()
    outputBytes = await write(sample)
    const duration = performance.now() - start
    sample()
    if (run >= 0) samples.push(duration)
  }
  samples.sort((a, b) => a - b)
  const median = samples.length % 2 ? samples[(samples.length - 1) / 2] :
    (samples[samples.length / 2 - 1] + samples[samples.length / 2]) / 2
  console.log(JSON.stringify({ workload, mode, medianMs: Math.round(median),
    rangeMs: [Math.round(samples[0]), Math.round(samples.at(-1))],
    rowsPerSecond: Math.round(count * 1000 / median),
    rawMiBPerSecond: rawBytes ? Math.round(rawBytes * 1000 / (mib * median)) : null,
    outputBytes, sampledHeapMiB: Math.round(heapPeak / mib), sampledRssMiB: Math.round(rssPeak / mib),
    processHighWaterRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
  }))
}
