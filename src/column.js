import { Bytes } from './binary.js'
import { plain } from './pages.js'

/** @typedef {import('./pages.js').Value} Value */
/** @typedef {import('./pages.js').Leaf} Leaf */
/** @typedef {Exclude<Value, null>} Present */
/** @typedef {{nulls: bigint, unsafe: boolean, min?: Present, max?: Present}} Bounds */

/** @param {Present} a @param {Present} b */
function compare(a, b) {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] - b[i]
    }
    return a.length - b.length
  }
  if (a === 0 && b === 0) return Number(Object.is(b, -0)) - Number(Object.is(a, -0))
  if (a < b) return -1
  return a > b ? 1 : 0
}

/** @param {Bounds} bounds @param {Present} value */
function include(bounds, value) {
  if (bounds.min === undefined || compare(value, bounds.min) < 0) bounds.min = value
  if (bounds.max === undefined || compare(value, bounds.max) > 0) bounds.max = value
}

/** @param {Value[]} values @param {number} limit @returns {Bounds} */
export function pageBounds(values, limit) {
  /** @type {Bounds} */
  const bounds = { nulls: 0n, unsafe: false }
  for (const value of values) {
    if (value === null) bounds.nulls++
    else if (Number.isNaN(value)) bounds.unsafe = true
    else include(bounds, value)
  }
  if ((bounds.min instanceof Uint8Array && bounds.min.length > limit) ||
      (bounds.max instanceof Uint8Array && bounds.max.length > limit)) bounds.unsafe = true
  return bounds
}

/** @param {Bounds} total @param {Bounds} page */
export function mergeBounds(total, page) {
  total.nulls += page.nulls
  total.unsafe ||= page.unsafe
  if (page.min !== undefined) include(total, page.min)
  if (page.max !== undefined) include(total, page.max)
}

/** @param {Leaf} leaf @param {Bounds} bounds */
export function encodeBounds(leaf, { nulls, unsafe, min, max }) {
  /** @param {Present} value */
  function encode(value) {
    if (value instanceof Uint8Array) return value
    const out = new Bytes()
    plain(out, leaf, [value])
    return out.finish()
  }
  if (unsafe || min === undefined || max === undefined) return { nulls }
  return { nulls, min: encode(min), max: encode(max) }
}

/** @param {Uint8Array} bytes */
function hashBytes(bytes) {
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193)
  return hash
}

/** @param {Leaf} leaf @param {Value[]} values @param {number} limit */
export function dictionary(leaf, values, limit) {
  if (![1, 2, 6, 7].includes(leaf.physical)) return
  /** @type {Map<Present, number>} */
  const scalar = new Map()
  /** @type {Map<number, number[]>} */
  const binary = new Map()
  /** @type {Present[]} */
  const entries = []
  /** @type {number[]} */
  const ids = []
  let dictionarySize = 0
  let plainSize = 0
  for (const value of values) {
    if (value === null) continue
    const size = value instanceof Uint8Array ? value.length + (leaf.physical === 6 ? 4 : 0) : leaf.width
    plainSize += size
    let id
    if (value instanceof Uint8Array) {
      const hash = hashBytes(value)
      const bucket = binary.get(hash) ?? []
      id = bucket.find(index => compare(entries[index], value) === 0)
      if (id === undefined) {
        bucket.push(entries.length)
        binary.set(hash, bucket)
      }
    } else {
      id = scalar.get(value)
      if (id === undefined) scalar.set(value, entries.length)
    }
    if (id === undefined) {
      dictionarySize += size
      if (dictionarySize > limit || entries.length === 65536) return
      id = entries.length
      entries.push(value)
    }
    ids.push(id)
  }
  if (!entries.length) return
  const width = 32 - Math.clz32(entries.length - 1)
  return { entries, ids, width, dictionarySize, plainSize }
}
