import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const node = process.execPath
const npm = process.env.npm_execpath
assert.ok(npm, 'Run this check with npm run test:package')
const scratch = resolve('.tmp')
mkdirSync(scratch, { recursive: true })
const directory = mkdtempSync(join(scratch, 'package-'))
const run = (args, cwd = process.cwd()) => execFileSync(node, args, { cwd, encoding: 'utf8' })
try {
  const packed = run([npm, 'pack', '--json', '--pack-destination', directory])
  const manifest = JSON.parse(packed)
  const archive = Array.isArray(manifest) ? manifest[0] : manifest['parquet-writer']
  writeFileSync(resolve(directory, 'package.json'), '{"type":"module","private":true}')
  run([npm, 'install', '--ignore-scripts', '--offline', resolve(directory, archive.filename)], directory)
  const source = `
import assert from 'node:assert/strict'
import { writeParquetBuffer } from 'parquet-writer'
import { fileSink } from 'parquet-writer/node'
import { webSink } from 'parquet-writer/web'
assert.equal(typeof fileSink, 'function')
assert.equal(typeof webSink, 'function')
const bytes = await writeParquetBuffer({ rows: [{ id: 1 }] })
assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'PAR1')
`
  writeFileSync(resolve(directory, 'consumer.js'), source)
  run(['consumer.js'], directory)
  run([resolve('node_modules/typescript/bin/tsc'), '--types', 'node', '--allowJs', '--checkJs', '--strict', '--noEmit',
    '--target', 'es2022', '--module', 'nodenext', 'consumer.js'], directory)
  console.log('Packed package imports and declarations work in an isolated consumer')
} finally {
  if (dirname(directory) === scratch) rmSync(directory, { recursive: true, force: true })
}
