import { Bytes, encodeText } from './binary.js'

// Compact Protocol type tags. Field IDs below follow parquet.thrift.
const I32 = 5
const I64 = 6
const TRUE = 1
const FALSE = 2
const BINARY = 8
const LIST = 9
const STRUCT = 12

/** @typedef {[number, number, unknown]} Field */

/** @param {Bytes} out @param {number} type @param {unknown} value */
function writeValue(out, type, value) {
  switch (type) {
    case TRUE:
    case FALSE:
      break
    case I32:
    case I64:
      out.signed(/** @type {number | bigint} */ (value))
      break
    case BINARY: {
      const bytes = value instanceof Uint8Array ? value : encodeText(/** @type {string} */ (value))
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

/** @typedef {{nulls: bigint, min?: Uint8Array, max?: Uint8Array}} Statistics */

/** @param {Statistics} stats @returns {Field[]} */
function statistics({ nulls, min, max }) {
  const fields = /** @type {Field[]} */ ([[3, I64, nulls]])
  if (min && max) fields.push([5, BINARY, max], [6, BINARY, min], [7, TRUE, true], [8, TRUE, true])
  return fields
}

/** @param {number} size @param {number} count @param {number} compressed @param {number} encoding @param {Statistics} [stats] */
export function pageHeader(size, count, compressed = size, encoding = 0, stats) {
  checkPage(size, compressed, count)
  const header = /** @type {Field[]} */ ([[1, I32, count], [2, I32, encoding], [3, I32, 3], [4, I32, 3]])
  if (stats) header.push([5, STRUCT, statistics(stats)])
  return encodeCompact([
    [1, I32, 0], [2, I32, size], [3, I32, compressed], [5, STRUCT, header],
  ])
}

/** @param {number} size @param {number} compressed @param {number} count */
export function dictionaryHeader(size, compressed, count) {
  checkPage(size, compressed, count)
  return encodeCompact([
    [1, I32, 2], [2, I32, size], [3, I32, compressed],
    [7, STRUCT, [[1, I32, count], [2, I32, 0], [3, FALSE, false]]],
  ])
}

/** @param {number[]} sizes */
function checkPage(...sizes) {
  if (sizes.some(size => size > 0x7fffffff)) throw new RangeError('Page exceeds Parquet i32 limit')
}

/** @typedef {import('./pages.js').Leaf} Leaf */
/** @typedef {{ leaf: Leaf, offset: bigint, size: bigint, rawSize: bigint, codec: number, dictionaryOffset?: bigint, stats?: Statistics }} Chunk */
/** @typedef {{ chunks: Chunk[], count: number }} Group */

/** @param {Leaf[]} leaves @param {Group[]} rowGroups @param {bigint} count */
export function footer(leaves, rowGroups, count) {
  /** @type {Field[][]} */
  const schema = [[[4, BINARY, 'schema'], [5, I32, leaves.length]]]
  for (const leaf of leaves) {
    /** @type {Field[]} */
    const field = [[1, I32, leaf.physical]]
    if (leaf.physical === 7) field.push([2, I32, leaf.length])
    field.push([3, I32, leaf.nullable ? 1 : 0], [4, BINARY, leaf.name])
    if (leaf.utf8) field.push([6, I32, 0], [10, STRUCT, [[1, STRUCT, []]]])
    schema.push(field)
  }
  const groups = rowGroups.map(({ chunks, count }) => {
    const columns = chunks.map(({ leaf, offset, size, rawSize, codec, dictionaryOffset, stats }) => {
      const encodings = leaf.nullable ? [0, 3] : [0]
      if (dictionaryOffset !== undefined) encodings.push(8)
      const metadata = /** @type {Field[]} */ ([
        [1, I32, leaf.physical], [2, LIST, [I32, encodings]],
        [3, LIST, [BINARY, [leaf.name]]], [4, I32, codec], [5, I64, count],
        [6, I64, rawSize], [7, I64, size], [9, I64, offset],
      ])
      if (dictionaryOffset !== undefined) metadata.push([11, I64, dictionaryOffset])
      if (stats) metadata.push([12, STRUCT, statistics(stats)])
      return [[2, I64, 0n], [3, STRUCT, metadata]]
    })
    const rawSize = chunks.reduce((sum, chunk) => sum + chunk.rawSize, 0n)
    const size = chunks.reduce((sum, chunk) => sum + chunk.size, 0n)
    return [[1, LIST, [STRUCT, columns]], [2, I64, rawSize], [3, I64, count], [6, I64, size]]
  })
  const metadata = /** @type {Field[]} */ ([
    [1, I32, 1], [2, LIST, [STRUCT, schema]], [3, I64, count],
    [4, LIST, [STRUCT, groups]], [6, BINARY, 'parquet-writer version 0.0.1'],
  ])
  if (rowGroups.some(group => group.chunks.some(chunk => chunk.stats))) {
    metadata.push([7, LIST, [STRUCT, leaves.map(() => [[1, STRUCT, []]])]])
  }
  return encodeCompact(metadata)
}
