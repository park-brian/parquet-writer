import { Bytes } from './binary.js'

/** Encode a raw Snappy block. @param {Uint8Array} input */
export function snappy(input) {
  const out = new Bytes()
  out.varint(input.length)
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const positions = new Int32Array(1 << 14).fill(-1)
  let start = 0
  let cursor = 0

  /** @param {number} end */
  function literal(end) {
    const length = end - start
    if (!length) return
    let size = length - 1
    if (size < 60) out.byte(size << 2)
    else {
      const width = Math.ceil((32 - Math.clz32(size)) / 8)
      out.byte((59 + width) << 2)
      for (let i = 0; i < width; i++) {
        out.byte(size & 255)
        size >>>= 8
      }
    }
    out.append(input.subarray(start, end))
  }

  while (cursor + 4 <= input.length) {
    const word = view.getUint32(cursor, true)
    const hash = Math.imul(word, 0x1e35a7bd) >>> 18
    const previous = positions[hash]
    positions[hash] = cursor
    const distance = cursor - previous
    if (previous < 0 || distance > 65535 || view.getUint32(previous, true) !== word) {
      cursor++
      continue
    }

    literal(cursor)
    let length = 4
    while (cursor + length < input.length && input[previous + length] === input[cursor + length]) length++
    cursor += length
    start = cursor
    while (length > 0) {
      const copy = Math.min(length, 64)
      out.byte(((copy - 1) << 2) | 2)
      out.byte(distance & 255)
      out.byte(distance >>> 8)
      length -= copy
    }
  }
  literal(input.length)
  return out.finish()
}
