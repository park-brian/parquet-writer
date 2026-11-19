import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeParquetBuffer } from '../src/index.js'
import { schema, rows } from './fixture.js'
import { nestedRows, nestedSchema } from './nested-fixture.js'

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', ...options })
  } catch (cause) {
    throw new Error(`Could not run ${command}. See docs/README.md for the interoperability setup.`, { cause })
  }
}

mkdirSync('.tmp', { recursive: true })
const directory = mkdtempSync('.tmp/interop-').replaceAll('\\', '/')
const optionalSchema = { fields: schema.fields.map(field => ({ ...field, nullable: true })) }
const nullable = rows.map((row, i) => i % 3 ? row : { ...row, value: null, label: null })
await check('populated', schema, rows)
await check('empty', schema, [])
await check('nullable', optionalSchema, nullable, { rowGroupRows: 13, pageByteTarget: 18 })
await check('plain', optionalSchema, nullable, { codec: 'UNCOMPRESSED', dictionary: false })
await check('dictionary', schema, rows, { codec: 'UNCOMPRESSED' }, true)
await check('snappy-plain', schema, rows, { dictionary: false })

const logicalFile = join(directory, 'logical.parquet').replaceAll('\\', '/')
writeFileSync(logicalFile, await writeParquetBuffer({
  schema: { fields: [
    { name: 'u', type: 'uint64' },
    { name: 'small', type: 'int8' },
    { name: 'd', type: 'date' },
    { name: 'tm', type: 'time', unit: 'millis' },
    { name: 'tu', type: 'time', unit: 'micros' },
    { name: 'tn', type: 'time', unit: 'nanos' },
    { name: 'instant', type: 'timestamp', unit: 'micros' },
    { name: 'local', type: 'timestamp', unit: 'nanos', isAdjustedToUTC: false },
    { name: 'money', type: 'decimal', precision: 38, scale: 4 },
    { name: 'money32', type: 'decimal', precision: 8, scale: 3 },
    { name: 'money64', type: 'decimal', precision: 15, scale: 3 },
    { name: 'key', type: 'uuid' },
  ] },
  rows: [{
    u: 18446744073709551615n, small: -128, d: -1, tm: 1234, tu: 1234567n,
    tn: 1234567890n, instant: -1234n, local: -123456789n,
    money: -(10n ** 38n - 1n), money32: -1234n, money64: 1234567898765n,
    key: '00112233-4455-6677-8899-aabbccddeeff',
  }],
}))
run(process.env.PYTHON || 'python', ['test/inspect_logical.py', logicalFile])
const logical = run(process.env.DUCKDB || 'duckdb', ['-json', '-c',
  `SELECT u::VARCHAR AS u, money::VARCHAR AS money, key::VARCHAR AS key FROM read_parquet('${logicalFile}')`])
assert.deepEqual(JSON.parse(logical), [{
  u: '18446744073709551615', money: '-9999999999999999999999999999999999.9999',
  key: '00112233-4455-6677-8899-aabbccddeeff',
}])
console.log('logical: DuckDB and PyArrow preserved exact values')

const nestedFile = join(directory, 'nested.parquet').replaceAll('\\', '/')
writeFileSync(nestedFile, await writeParquetBuffer({
  schema: nestedSchema, rows: nestedRows, rowGroupRows: 2, pageByteTarget: 2,
}))
const nestedExpected = nestedRows.map(row => ({
  ...row, attributes: row.attributes === null ? null : [...row.attributes],
}))
run(process.env.PYTHON || 'python', ['test/inspect_nested.py', nestedFile], {
  input: JSON.stringify(nestedExpected),
})
const nested = run(process.env.DUCKDB || 'duckdb', ['-json', '-c',
  `SELECT id, numbers, matrix, record, map_entries(attributes) AS attributes FROM read_parquet('${nestedFile}') ORDER BY id`])
assert.deepEqual(JSON.parse(nested), nestedExpected.map(row => ({
  ...row, attributes: row.attributes?.map(([key, value]) => ({ key, value })) ?? null,
})))
console.log('nested: DuckDB and PyArrow preserved null, empty, and repeated values')

async function check(name, schema, data, options = {}, inspectDictionary = false) {
  const filename = join(directory, name + '.parquet').replaceAll('\\', '/')
  const bytes = await writeParquetBuffer({ schema, rows: data, ...options })
  const groupCount = Math.ceil(data.length / (options.rowGroupRows || 65_536))
  writeFileSync(filename, bytes)

  const result = run(process.env.DUCKDB || 'duckdb', [
    '-json', '-c', `SELECT * FROM read_parquet('${filename}') ORDER BY id`,
  ])
  assert.deepEqual(JSON.parse(result.trim() || '[]'), data)
  const filtered = run(process.env.DUCKDB || 'duckdb', [
    '-json', '-c', `SELECT * FROM read_parquet('${filename}') WHERE value >= 10 ORDER BY id`,
  ])
  assert.deepEqual(JSON.parse(filtered.trim() || '[]'), data.filter(row => row.value >= 10))

  run(process.env.PYTHON || 'python', ['test/inspect_parquet.py', filename], {
    input: JSON.stringify({ data, groupCount }),
  })

  const jar = process.env.PARQUET_CLI_JAR ||
    '_references/cbiit-parquet-cli/bin/parquet-cli-1.15.2.jar'
  const java = (command, ...args) => run('java', ['-jar', jar, command, filename, ...args])
  const footer = JSON.parse(java('footer'))
  assert.equal(footer.blocks.length, groupCount)
  assert.deepEqual(footer.fileMetaData.schema.fields.map(field => field.name), schema.fields.map(field => field.name))
  if (data.length) {
    const pages = java('pages')
    for (const field of schema.fields) assert.ok(pages.includes('Column: ' + field.name))
  }
  if (inspectDictionary) assert.match(java('dictionary', '-c', 'label'), /caf/)
  console.log(`${name}: DuckDB, PyArrow, and Parquet Java agree`)
}
