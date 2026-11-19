import { writeParquet, writeParquetBuffer } from 'parquet-writer'
import { fileSink } from 'parquet-writer/node'
import { webSink } from 'parquet-writer/web'

export async function writeScores() {
  return writeParquetBuffer({
    columns: { rowCount: 3, columns: {
      id: new Int32Array([1, 2, 3]),
      score: { values: new Float64Array([7, 0, 9]), validity: Uint8Array.of(0b101) },
    } },
  })
}

const schema = { fields: [
  { name: 'id', type: /** @type {const} */ ('int32'), nullable: false },
  { name: 'labels', type: /** @type {const} */ ('list'), element: { type: /** @type {const} */ ('string') } },
] }

/** @param {string} path */
export async function exportFile(path) {
  return writeParquet({
    schema,
    rows: [{ id: 1, labels: ['first'] }, { id: 2, labels: [] }],
    sink: await fileSink(path),
  })
}

/** @param {WritableStream<Uint8Array>} writable */
export async function exportStream(writable) {
  return writeParquet({
    schema,
    rows: [{ id: 1, labels: null }],
    sink: webSink(writable),
  })
}
