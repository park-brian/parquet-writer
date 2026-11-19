import { Bytes, encodeText } from './binary.js'

// Compact Protocol type tags. Field IDs below follow parquet.thrift.
const I32 = 5
const I64 = 6
const BINARY = 8
const LIST = 9
const STRUCT = 12

/** @typedef {[number, number, unknown]} Field */

/** @param {Bytes} out @param {number} type @param {unknown} value */
function writeValue(out, type, value) {
  switch (type) {
    case I32:
    case I64:
      out.signed(/** @type {number | bigint} */ (value))
      break
    case BINARY: {
      const bytes = encodeText(/** @type {string} */ (value))
      out.varint(bytes.length)
      out.append(bytes)
      break
    }
    case LIST: {
      const [itemType, items] = /** @type {[number, unknown[]]} */ (value)
      out.byte((Math.min(items.length, 15) << 4) | itemType)
      if (items.length >= 15) out.varint(items.length)
      for (const item of items) writeValue(out, itemType, item)
      break
    }
    case STRUCT:
      writeStruct(out, /** @type {Field[]} */ (value))
      break
    default:
      throw new Error('Unsupported Compact Protocol type')
  }
}

/** @param {Bytes} out @param {Field[]} fields */
function writeStruct(out, fields) {
  let previous = 0
  for (const [id, type, value] of fields) {
    const delta = id - previous
    if (delta > 0 && delta <= 15) {
      out.byte((delta << 4) | type)
    } else {
      out.byte(type)
      out.signed(id)
    }
    writeValue(out, type, value)
    previous = id
  }
  out.byte(0)
}

/** @param {Field[]} fields */
export function encodeCompact(fields) {
  const out = new Bytes()
  writeStruct(out, fields)
  return out.finish()
}

/** @param {number} size @param {number} count */
export function pageHeader(size, count) {
  if (size > 0x7fffffff || count > 0x7fffffff) throw new RangeError('Page exceeds Parquet i32 limit')
  return encodeCompact([
    [1, I32, 0], [2, I32, size], [3, I32, size],
    [5, STRUCT, [[1, I32, count], [2, I32, 0], [3, I32, 3], [4, I32, 3]]],
  ])
}

/** @typedef {{ name: string, physical: number, utf8: boolean }} Leaf */
/** @typedef {{ leaf: Leaf, offset: bigint, size: bigint }} Chunk */

/** @param {Leaf[]} leaves @param {Chunk[]} chunks @param {number} count */
export function footer(leaves, chunks, count) {
  /** @type {Field[][]} */
  const schema = [[[4, BINARY, 'schema'], [5, I32, leaves.length]]]
  for (const leaf of leaves) {
    /** @type {Field[]} */
    const field = [[1, I32, leaf.physical], [3, I32, 0], [4, BINARY, leaf.name]]
    if (leaf.utf8) field.push([6, I32, 0], [10, STRUCT, [[1, STRUCT, []]]])
    schema.push(field)
  }
  const columns = chunks.map(({ leaf, offset, size }) => [
    [2, I64, 0n],
    [3, STRUCT, [
      [1, I32, leaf.physical], [2, LIST, [I32, [0]]], [3, LIST, [BINARY, [leaf.name]]],
      [4, I32, 0], [5, I64, count], [6, I64, size], [7, I64, size], [9, I64, offset],
    ]],
  ])
  const size = chunks.reduce((sum, chunk) => sum + chunk.size, 0n)
  const groups = count ? [[[1, LIST, [STRUCT, columns]], [2, I64, size], [3, I64, count]]] : []
  return encodeCompact([
    [1, I32, 1], [2, LIST, [STRUCT, schema]], [3, I64, count],
    [4, LIST, [STRUCT, groups]], [6, BINARY, 'parquet-writer version 0.0.1'],
  ])
}
