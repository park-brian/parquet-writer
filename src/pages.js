import { Bytes, encodeText } from './binary.js'

/** @typedef {'boolean' | 'int32' | 'int64' | 'float' | 'double' | 'string' | 'binary' | 'fixedBinary'} Type */
/** @typedef {{name: string, type: Type, nullable?: boolean, length?: number}} Field */
/** @typedef {{fields: Field[]}} Schema */
/** @typedef {number | bigint | boolean | Uint8Array | null} Value */
/** @typedef {Field & {physical: number, utf8: boolean, width: number}} Leaf */

const types = { boolean: 0, int32: 1, int64: 2, float: 4, double: 5, binary: 6, string: 6, fixedBinary: 7 }
const widths = { boolean: 1, int32: 4, int64: 8, float: 4, double: 8, binary: 0, string: 0, fixedBinary: 0 }

/** @param {Schema} schema @returns {Leaf[]} */
export function compile(schema) {
  if (!Array.isArray(schema?.fields) || !schema.fields.length) throw new TypeError('Expected a nonempty schema')
  const names = new Set()
  return schema.fields.map(({ name, type, nullable = true, length }) => {
    if (typeof name !== 'string' || !name || names.has(name)) throw new TypeError('Expected unique field names')
    if (!Object.hasOwn(types, type)) throw new TypeError('Unsupported field type: ' + type)
    if (type === 'fixedBinary' && (!length || !Number.isInteger(length) || length < 1 || length > 0x7fffffff)) {
      throw new RangeError('Expected a positive fixed binary length')
    }
    names.add(name)
    return { name, type, nullable, length, physical: types[type], utf8: type === 'string', width: length && type === 'fixedBinary' ? length : widths[type] }
  })
}

/** @param {Leaf} leaf @param {unknown} value @returns {Value} */
export function normalize(leaf, value) {
  if (value == null && leaf.nullable) return null
  switch (leaf.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value
      break
    case 'int32':
      if (typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) return value
      break
    case 'int64':
      if (typeof value === 'number' && Number.isSafeInteger(value)) value = BigInt(value)
      if (typeof value === 'bigint' && value >= -(1n << 63n) && value < (1n << 63n)) return value
      break
    case 'float':
      if (typeof value === 'number') return Math.fround(value)
      break
    case 'double':
      if (typeof value === 'number') return value
      break
    case 'string':
      if (typeof value === 'string') return encodeText(value)
      break
    case 'binary':
    case 'fixedBinary':
      if (value instanceof Uint8Array && (leaf.type === 'binary' || value.length === leaf.width)) {
        return Uint8Array.from(value)
      }
      break
  }
  throw new TypeError(`Invalid ${leaf.type} value for ${leaf.name}`)
}

/** @param {Leaf} leaf @param {Value} value */
export function valueSize(leaf, value) {
  if (value === null) return 1
  return 1 + (leaf.width || (/** @type {Uint8Array} */ (value).length + 4))
}

/** @param {Bytes} out @param {number[]} values @param {number} width */
export function hybrid(out, values, width) {
  let start = 0
  while (start < values.length) {
    let end = start + 1
    while (end < values.length && values[end] === values[start]) end++
    if (end - start >= 8 || width === 0) {
      out.varint(2 * (end - start))
      let value = values[start]
      for (let byte = 0; byte < Math.ceil(width / 8); byte++) {
        out.byte(value & 255)
        value >>>= 8
      }
      start = end
      continue
    }
    // A literal run must end on a group of eight unless this is the last run.
    out.varint(3)
    let bits = 0
    let used = 0
    for (let i = 0; i < 8; i++) {
      const value = values[start + i] ?? 0
      for (let bit = 0; bit < width; bit++) {
        bits |= ((value >>> bit) & 1) << used++
        if (used === 8) {
          out.byte(bits)
          bits = 0
          used = 0
        }
      }
    }
    start += 8
  }
}

/** @param {Bytes} out @param {number[]} values @param {number} width */
export function levels(out, values, width) {
  if (!width) return
  const data = new Bytes()
  hybrid(data, values, width)
  out.i32(data.length)
  out.append(data.finish())
}

/**
 * @param {Leaf} leaf @param {Value[]} values
 * @param {number[]} [definitions] @param {number} [definitionWidth]
 * @param {number[]} [repetitions] @param {number} [repetitionWidth] @param {Uint8Array} [encoded]
 */
export function dataPage(leaf, values, definitions = [], definitionWidth = 0, repetitions = [], repetitionWidth = 0, encoded) {
  const payload = new Bytes()
  levels(payload, repetitions, repetitionWidth)
  levels(payload, definitions, definitionWidth)
  if (encoded) payload.append(encoded)
  else plain(payload, leaf, values)
  return payload.finish()
}

/** @param {Bytes} out @param {Leaf} leaf @param {Value[]} values */
export function plain(out, leaf, values) {
  if (leaf.type === 'boolean') {
    let byte = 0
    let bit = 0
    for (const value of values) {
      if (value === null) continue
      if (value) byte |= 1 << bit
      if (++bit === 8) {
        out.byte(byte)
        bit = byte = 0
      }
    }
    if (bit) out.byte(byte)
    return
  }
  for (const value of values) {
    if (value === null) continue
    switch (leaf.physical) {
      case 1: out.i32(/** @type {number} */ (value)); break
      case 2: out.i64(/** @type {bigint} */ (value)); break
      case 4: out.f32(/** @type {number} */ (value)); break
      case 5: out.f64(/** @type {number} */ (value)); break
      default: {
        const bytes = /** @type {Uint8Array} */ (value)
        if (leaf.physical === 6) out.i32(bytes.length)
        out.append(bytes)
      }
    }
  }
}
