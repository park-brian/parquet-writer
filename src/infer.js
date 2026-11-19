import { encodeText } from './binary.js'

/** @typedef {import('./pages.js').Field} Field */
/** @typedef {import('./pages.js').FieldType} FieldType */
/** @typedef {import('./pages.js').Type} Type */
/** @typedef {{hint?: FieldType, type?: FieldType['type'], fields?: Map<string, Evidence>, element?: Evidence, key?: Evidence, value?: Evidence, date?: boolean}} Evidence */

/** @type {Map<Function, Type>} */
const typed = new Map(/** @type {[Function, Type][]} */ ([
  [Int8Array, 'int8'], [Uint8Array, 'uint8'], [Uint8ClampedArray, 'uint8'],
  [Int16Array, 'int16'], [Uint16Array, 'uint16'], [Int32Array, 'int32'], [Uint32Array, 'uint32'],
  [BigInt64Array, 'int64'], [BigUint64Array, 'uint64'], [Float32Array, 'float'], [Float64Array, 'double'],
]))

/** @param {ArrayLike<unknown>} values */
export function vectorType(values) {
  return typed.get(values.constructor)
}

/** @param {Field[]} [hints] */
function fieldsFrom(hints) {
  /** @type {Map<string, Evidence>} */
  const fields = new Map()
  for (const hint of hints ?? []) {
    if (fields.has(hint.name)) throw new TypeError('Duplicate schema hint: ' + hint.name)
    fields.set(hint.name, { hint })
  }
  return fields
}

/** @param {unknown} value @returns {FieldType['type'] | undefined} */
function kind(value) {
  if (typeof value === 'number') return 'double'
  if (typeof value === 'bigint') return 'int64'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  if (value instanceof Uint8Array) return 'binary'
  if (value instanceof Date) return 'timestamp'
  if (value instanceof Map) return 'map'
  if (Array.isArray(value)) return 'list'
  if (record(value)) return 'struct'
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * @param {Evidence} item @param {unknown} value @param {string} path
 * @param {Set<object>} active @param {Type} [vector]
 */
function observe(item, value, path, active, vector) {
  const hint = item.hint
  const inferred = hint?.type ?? vector ?? kind(value)
  if (inferred) {
    if (item.type && item.type !== inferred) throw new TypeError('Mixed types at ' + path)
    item.type = inferred
  }
  if (value == null) return 1
  if (!inferred) throw new TypeError('Cannot infer a type at ' + path)
  if (inferred !== 'struct' && inferred !== 'list' && inferred !== 'map') {
    if (inferred === 'timestamp' && value instanceof Date) item.date = true
    if (typeof value === 'string') return 5 + encodeText(value).length
    if (value instanceof Uint8Array) return 5 + value.length
    return 9
  }
  if (typeof value !== 'object' || active.has(value)) throw new TypeError('Invalid or cyclic value at ' + path)
  active.add(value)
  let bytes = 1
  if (inferred === 'struct') {
    if (!record(value)) throw new TypeError('Expected a struct at ' + path)
    item.fields ??= fieldsFrom(hint?.type === 'struct' ? hint.fields : undefined)
    bytes += observeFields(item.fields, value, path, active)
  } else if (inferred === 'list') {
    if (!Array.isArray(value)) throw new TypeError('Expected an array at ' + path)
    item.element ??= { hint: hint?.type === 'list' ? hint.element : undefined }
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new TypeError('Sparse list at ' + path)
      bytes += observe(item.element, value[i], path + '.element', active)
    }
  } else {
    if (!(value instanceof Map)) throw new TypeError('Expected a Map at ' + path)
    item.key ??= { hint: hint?.type === 'map' ? hint.key : undefined }
    item.value ??= { hint: hint?.type === 'map' ? hint.value : undefined }
    for (const [key, entry] of value) {
      bytes += observe(item.key, key, path + '.key', active)
      bytes += observe(item.value, entry, path + '.value', active)
    }
  }
  active.delete(value)
  return bytes
}

/** @param {Map<string, Evidence>} fields @param {Record<string, unknown>} row @param {string} path @param {Set<object>} active @param {Record<string, Type | undefined>} [vectors] */
function observeFields(fields, row, path, active, vectors) {
  let bytes = 0
  for (const name of Object.keys(row)) {
    let field = fields.get(name)
    if (!field) fields.set(name, field = {})
    bytes += observe(field, row[name], path + '.' + name, active, vectors?.[name])
  }
  return bytes
}

/** @param {Evidence} item @param {string} path @returns {FieldType} */
function finish(item, path) {
  const { hint } = item
  const type = item.type ?? hint?.type
  if (!type) throw new TypeError('Cannot infer a type at ' + path + '. Provide a schema hint.')
  const nullable = hint?.nullable ?? true
  switch (type) {
    case 'struct':
      return { type, nullable, fields: finishFields(item.fields ?? fieldsFrom(hint?.type === 'struct' ? hint.fields : undefined), path) }
    case 'list':
      return { type, nullable, element: finish(item.element ?? { hint: hint?.type === 'list' ? hint.element : undefined }, path + '.element') }
    case 'map': {
      const key = finish(item.key ?? { hint: hint?.type === 'map' ? hint.key : undefined }, path + '.key')
      if (key.type === 'struct' || key.type === 'list' || key.type === 'map') throw new TypeError('Map keys must be scalar at ' + path)
      return { type, nullable, key: { ...key, nullable: false },
        value: finish(item.value ?? { hint: hint?.type === 'map' ? hint.value : undefined }, path + '.value') }
    }
    case 'timestamp':
      if (!hint && item.date) return { type, nullable, unit: 'millis', isAdjustedToUTC: true }
      break
  }
  return /** @type {FieldType} */ ({ ...hint, type, nullable })
}

/** @param {Map<string, Evidence>} fields @param {string} path @returns {Field[]} */
function finishFields(fields, path) {
  return [...fields].map(([name, item]) => ({ ...finish(item, path + '.' + name), name }))
}

/** @param {import('./pages.js').Schema} [hints] */
export function schemaInference(hints) {
  const fields = fieldsFrom(hints?.fields)
  let rows = 0
  return {
    /** @param {unknown} row @param {Record<string, Type | undefined>} [vectors] */
    observe(row, vectors) {
      if (!record(row)) throw new TypeError('Expected a row object during inference')
      rows++
      return observeFields(fields, row, 'schema', new Set([row]), vectors)
    },
    finish() {
      if (!rows) throw new TypeError('Empty input needs an explicit schema')
      return { fields: finishFields(fields, 'schema') }
    },
  }
}
