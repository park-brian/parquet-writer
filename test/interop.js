import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeParquetBuffer } from '../src/index.js'
import { schema, rows } from './fixture.js'

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
