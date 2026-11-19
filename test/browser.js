import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium, firefox, webkit } from 'playwright'
import { parquetReadObjects } from 'hyparquet'
import { rows, schema } from './fixture.js'
import { nestedRows, nestedSchema } from './nested-fixture.js'

const modules = new Map()
for (const filename of await readdir(new URL('../src/', import.meta.url))) {
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
      const nested = await page.evaluate(async input => {
        const { writeParquet } = await import('/index.js')
        const { webSink } = await import('/web.js')
        input.rows[1].attributes = new Map()
        input.rows[2].attributes = new Map([['a', null], ['b', 2]])
        const chunks = []
        const stream = new WritableStream({ write(chunk) { chunks.push(...chunk) } })
        await writeParquet({ ...input, sink: webSink(stream), rowGroupRows: 2 })
        return chunks
      }, { schema: nestedSchema, rows: nestedRows.map(row => ({ ...row, attributes: null })) })
      const decoded = await parquetReadObjects({ file: Uint8Array.from(nested).buffer })
      assert.deepEqual(decoded.map(row => row.numbers ?? null), [null, [], [1, null, 2]])
      console.log(`${engine.name()}: wrote a readable file`)
    } finally {
      await browser.close()
    }
  }
} finally {
  server.close()
}
