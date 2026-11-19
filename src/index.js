import { Bytes, encodeText } from './binary.js'
import { footer, pageHeader } from './metadata.js'

const magic = Uint8Array.of(80, 65, 82, 49)
const physicalTypes = { int32: 1, double: 5, string: 6 }

/** @typedef {{ name: string, type: 'int32' | 'double' | 'string', nullable: false }} Field */
/** @typedef {{ schema: { fields: Field[] }, rows: Record<string, unknown>[] }} Input */
/** @typedef {{ write(bytes: Uint8Array): void | Promise<void>, close?(): void | Promise<void>, abort?(reason: unknown): void | Promise<void> }} Sink */

/** @param {Input & { sink: Sink }} input */
export async function writeParquet({ schema, rows, sink }) {
  let offset = 0n
  /** @param {Uint8Array} bytes */
  async function write(bytes) {
    await sink.write(bytes)
    offset += BigInt(bytes.length)
  }

  try {
    if (!Array.isArray(schema?.fields) || !schema.fields.length) throw new TypeError('Expected a nonempty schema')
    if (!Array.isArray(rows)) throw new TypeError('Expected an array of rows')
    const fields = schema.fields
    const names = new Set()
    const leaves = fields.map(({ name, type, nullable }) => {
      if (typeof name !== 'string' || !name || names.has(name)) throw new TypeError('Expected unique field names')
      if (!Object.hasOwn(physicalTypes, type) || nullable !== false) {
        throw new TypeError('Expected a required int32, double, or string field')
      }
      names.add(name)
      return { name, physical: physicalTypes[type], utf8: type === 'string' }
    })
    for (const [index, row] of rows.entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('Expected a row object')
      for (const name of Object.keys(row)) {
        if (!names.has(name)) throw new TypeError(`Unknown field ${name} in row ${index}`)
      }
      for (const field of fields) {
        if (!Object.hasOwn(row, field.name) || !valid(field.type, row[field.name])) {
          throw new TypeError(`Invalid ${field.type} value for ${field.name} in row ${index}`)
        }
      }
    }

    await write(magic.slice())
    const chunks = []
    if (rows.length) {
      for (const [index, leaf] of leaves.entries()) {
        const payload = plain(fields[index], rows)
        const header = pageHeader(payload.length, rows.length)
        chunks.push({ leaf, offset, size: BigInt(header.length + payload.length) })
        await write(header)
        await write(payload)
      }
    }
    const metadata = footer(leaves, chunks, rows.length)
    if (metadata.length > 0xffffffff) throw new RangeError('Footer exceeds Parquet uint32 limit')
    const trailer = new Bytes()
    trailer.i32(metadata.length)
    trailer.append(magic)
    await write(metadata)
    await write(trailer.finish())
    await sink.close?.()
    return { rowCount: BigInt(rows.length), byteLength: offset }
  } catch (error) {
    try { await sink.abort?.(error) } catch { /* Preserve the write error. */ }
    throw error
  }
}

/** @param {Field['type']} type @param {unknown} value */
function valid(type, value) {
  if (type === 'string') return typeof value === 'string'
  if (typeof value !== 'number') return false
  return type === 'double' || (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)
}

/** @param {Field} field @param {Input['rows']} rows */
function plain({ name, type }, rows) {
  const out = new Bytes()
  for (const row of rows) {
    const value = row[name]
    if (type === 'string') {
      const bytes = encodeText(/** @type {string} */ (value))
      out.i32(bytes.length)
      out.append(bytes)
    } else if (type === 'int32') {
      out.i32(/** @type {number} */ (value))
    } else {
      out.f64(/** @type {number} */ (value))
    }
  }
  return out.finish()
}

/** @param {Input} input */
export async function writeParquetBuffer(input) {
  /** @type {Uint8Array[]} */
  const chunks = []
  const { byteLength } = await writeParquet({
    ...input,
    sink: { write(bytes) { chunks.push(bytes) } },
  })
  const result = new Uint8Array(Number(byteLength))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
