import { Bytes, encodeText } from './binary.js'

/** @typedef {'boolean' | 'int8' | 'int16' | 'int32' | 'int64' | 'uint8' | 'uint16' | 'uint32' | 'uint64' | 'float' | 'double' | 'string' | 'binary' | 'fixedBinary' | 'date' | 'time' | 'timestamp' | 'decimal' | 'uuid'} Type */
/** @typedef {'millis' | 'micros' | 'nanos'} Unit */
/** @typedef {{type: Type, nullable?: boolean, length?: number, unit?: Unit, isAdjustedToUTC?: boolean, precision?: number, scale?: number}} Primitive */
/** @typedef {Primitive | {type: 'struct', nullable?: boolean, fields: Field[]} | {type: 'list', nullable?: boolean, element: FieldType} | {type: 'map', nullable?: boolean, key: Primitive, value: FieldType}} FieldType */
/** @typedef {{name: string} & FieldType} Field */
/** @typedef {{fields: Field[]}} Schema */
/** @typedef {number | bigint | boolean | Uint8Array | null} Value */
/** @typedef {Int32Array | Uint32Array | BigInt64Array | BigUint64Array | Float32Array | Float64Array} DirectVector */
/** @typedef {Value[] | DirectVector} Values */
/** @typedef {{name: string} & Primitive & {physical: number, width: number, integerBits?: number, signed?: boolean, path?: string[], definitionWidth?: number, repetitionWidth?: number}} Leaf */

const types = { boolean: 0, int8: 1, int16: 1, int32: 1, int64: 2,
  uint8: 1, uint16: 1, uint32: 1, uint64: 2, float: 4, double: 5,
  binary: 6, string: 6, fixedBinary: 7, date: 1, time: 2, timestamp: 2, decimal: 7, uuid: 7 }
const widths = [1, 4, 8, 0, 4, 8, 0, 0]
const day = { millis: 86_400_000, micros: 86_400_000_000n, nanos: 86_400_000_000_000n }
const littleEndian = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1

/** @param {Leaf} leaf @param {ArrayLike<unknown>} values @returns {values is DirectVector} */
export function directVector(leaf, values) {
  switch (leaf.type) {
    case 'int32': return values instanceof Int32Array
    case 'uint32': return values instanceof Uint32Array
    case 'int64': return values instanceof BigInt64Array
    case 'uint64': return values instanceof BigUint64Array
    case 'float': return values instanceof Float32Array
    case 'double': return values instanceof Float64Array
    default: return false
  }
}

/** @param {{name: string} & Primitive} field @returns {Leaf} */
export function compileLeaf(field) {
  const { type, nullable = true, unit, isAdjustedToUTC = type === 'timestamp', precision, scale = 0 } = field
  if (!Object.hasOwn(types, type)) throw new TypeError('Unsupported field type: ' + type)
  let physical = types[type]
  let length = type === 'fixedBinary' ? field.length : undefined
  const integer = /^(u?)int(8|16|32|64)$/.exec(type)
  if (type === 'time' || type === 'timestamp') {
    if (!unit || !Object.hasOwn(day, unit)) throw new RangeError('Expected millis, micros, or nanos')
    if (typeof isAdjustedToUTC !== 'boolean') throw new TypeError('Expected a boolean UTC adjustment')
    if (type === 'time' && unit === 'millis') physical = 1
  }
  if (type === 'decimal') {
    if (precision === undefined || !Number.isInteger(precision) || precision < 1 || precision > 38 ||
        !Number.isInteger(scale) || scale < 0 || scale > precision) {
      throw new RangeError('Expected decimal precision 1–38 and scale within precision')
    }
    if (precision <= 9) physical = 1
    else if (precision <= 18) physical = 2
    else length = Math.ceil(((10n ** BigInt(precision) - 1n).toString(2).length + 1) / 8)
  }
  if (type === 'uuid') length = 16
  if (physical === 7 && (!length || !Number.isInteger(length) || length < 1 || length > 0x7fffffff)) {
    throw new RangeError('Expected a positive fixed binary length')
  }
  return { ...field, nullable, length, physical, width: length ?? widths[physical],
    isAdjustedToUTC, scale, integerBits: integer ? Number(integer[2]) : undefined, signed: integer?.[1] === '' }
}

/** @param {unknown} value @param {number} bits @param {boolean} signed */
function integer(value, bits, signed) {
  if (bits < 64) {
    const bound = 2 ** (signed ? bits - 1 : bits)
    if (typeof value === 'number' && Number.isInteger(value) && value >= (signed ? -bound : 0) && value < bound) return value
    return
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = BigInt(value)
  const bound = 1n << (signed ? 63n : 64n)
  if (typeof value === 'bigint' && value >= (signed ? -bound : 0n) && value < bound) return value
}

/** @param {Leaf} leaf @param {unknown} value @param {Map<string, Uint8Array>} [strings] @returns {Value} */
export function normalize(leaf, value, strings) {
  if (value == null && leaf.nullable) return null
  if (leaf.integerBits) {
    const result = integer(value, leaf.integerBits, !!leaf.signed)
    if (result !== undefined) return result
  }
  switch (leaf.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value
      break
    case 'date': {
      const result = integer(value, 32, true)
      if (result !== undefined) return result
      break
    }
    case 'time': {
      const limit = day[/** @type {Unit} */ (leaf.unit)]
      if (typeof limit === 'number' && typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < limit) return value
      if (typeof limit === 'bigint' && typeof value === 'bigint' && value >= 0n && value < limit) return value
      break
    }
    case 'timestamp': {
      if (value instanceof Date && leaf.unit === 'millis' && leaf.isAdjustedToUTC) value = value.getTime()
      const result = integer(value, 64, true)
      if (result !== undefined) return result
      break
    }
    case 'decimal': {
      const bound = 10n ** BigInt(/** @type {number} */ (leaf.precision))
      if (typeof value === 'bigint' && value > -bound && value < bound) return value
      break
    }
    case 'uuid':
      if (value instanceof Uint8Array && value.length === 16) return Uint8Array.from(value)
      if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        const pairs = value.replaceAll('-', '').match(/../g) ?? []
        return Uint8Array.from(pairs, pair => parseInt(pair, 16))
      }
      break
    case 'float':
      if (typeof value === 'number') return Math.fround(value)
      break
    case 'double':
      if (typeof value === 'number') return value
      break
    case 'string':
      if (typeof value === 'string') {
        const cached = strings?.get(value)
        if (cached) return cached
        const bytes = encodeText(value)
        if (strings && strings.size < 1024 && bytes.length <= 1024) strings.set(value, bytes)
        return bytes
      }
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
 * @param {Leaf} leaf @param {Values} values
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

/** @param {Bytes} out @param {Leaf} leaf @param {Values} values */
export function plain(out, leaf, values) {
  if (littleEndian && directVector(leaf, values)) {
    out.append(new Uint8Array(values.buffer, values.byteOffset, values.byteLength))
    return
  }
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
      case 1: out.i32(Number(value)); break
      case 2: out.i64(/** @type {bigint} */ (value)); break
      case 4: out.f32(/** @type {number} */ (value)); break
      case 5: out.f64(/** @type {number} */ (value)); break
      default: {
        if (leaf.type === 'decimal') {
          const n = /** @type {bigint} */ (value)
          for (let i = leaf.width - 1; i >= 0; i--) out.byte(Number((n >> BigInt(i * 8)) & 255n))
          break
        }
        const bytes = /** @type {Uint8Array} */ (value)
        if (leaf.physical === 6) out.i32(bytes.length)
        out.append(bytes)
      }
    }
  }
}
