import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium, firefox, webkit } from 'playwright'
import { parquetReadObjects } from 'hyparquet'
import { rows, schema } from './fixture.js'

const modules = new Map()
for (const filename of ['index.js', 'binary.js', 'metadata.js']) {
  modules.set('/' + filename, await readFile(new URL('../src/' + filename, import.meta.url)))
}
const server = createServer((request, response) => {
  const module = modules.get(request.url)
  if (module) response.setHeader('Content-Type', 'text/javascript')
  response.end(module || '<!doctype html><title>Parquet writer test</title>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const url = `http://127.0.0.1:${server.address().port}`
  for (const engine of [chromium, firefox, webkit]) {
    const browser = await engine.launch()
    try {
      const page = await browser.newPage()
      await page.goto(url)
      const bytes = await page.evaluate(async input => {
        const { writeParquetBuffer } = await import('/index.js')
        return Array.from(await writeParquetBuffer(input))
      }, { schema, rows })
      assert.deepEqual(await parquetReadObjects({ file: Uint8Array.from(bytes).buffer }), rows)
      console.log(`${engine.name()}: wrote a readable file`)
    } finally {
      await browser.close()
    }
  }
} finally {
  server.close()
}
