const utf8 = new TextEncoder()

export class Bytes {
  #data = new Uint8Array(128)
  #view = new DataView(this.#data.buffer)
  length = 0

  /** @param {number} size */
  #reserve(size) {
    const offset = this.length
    const end = offset + size
    if (end > this.#data.length) {
      const next = new Uint8Array(Math.max(end, this.#data.length * 2))
      next.set(this.#data)
      this.#data = next
      this.#view = new DataView(next.buffer)
    }
    this.length = end
    return offset
  }

  /** @param {number} value */
  byte(value) {
    const offset = this.#reserve(1)
    this.#view.setUint8(offset, value)
  }
  /** @param {number} value */
  i32(value) {
    const offset = this.#reserve(4)
    this.#view.setInt32(offset, value, true)
  }
  /** @param {number} value */
  f64(value) {
    const offset = this.#reserve(8)
    this.#view.setFloat64(offset, value, true)
  }
  /** @param {number} value */
  f32(value) {
    const offset = this.#reserve(4)
    this.#view.setFloat32(offset, value, true)
  }

  /** @param {bigint} value */
  i64(value) {
    const offset = this.#reserve(8)
    this.#view.setBigInt64(offset, value, true)
  }
  /** @param {Uint8Array} value */
  append(value) {
    const offset = this.#reserve(value.length)
    this.#data.set(value, offset)
  }

  /** @param {number | bigint} value */
  varint(value) {
    let bits = BigInt(value)
    if (bits < 0n) throw new RangeError('Expected unsigned varint')
    while (bits >= 128n) {
      this.byte(Number(bits & 127n) | 128)
      bits >>= 7n
    }
    this.byte(Number(bits))
  }

  /** @param {number | bigint} value */
  signed(value) {
    const n = BigInt(value)
    this.varint(n < 0n ? -2n * n - 1n : 2n * n)
  }

  finish() { return this.#data.subarray(0, this.length) }
}

export const encodeText = (/** @type {string} */ value) => utf8.encode(value)
