import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bytes } from '../src/binary.js'
import { encodeCompact, pageHeader } from '../src/metadata.js'

const hex = bytes => Buffer.from(bytes).toString('hex')

test('packs Compact Protocol fields and terminates each struct', () => {
  assert.equal(hex(pageHeader(4, 1)), '1500150815082c15021500150615060000')
  assert.equal(hex(encodeCompact([[16, 5, -1], [17, 5, 1]])), '052001150200')
})

test('switches to an explicit varint at fifteen list entries', () => {
  for (const [length, header] of [[14, '19e5'], [15, '19f50f']]) {
    assert.equal(hex(encodeCompact([[1, 9, [5, Array(length).fill(0)]]])), header + '00'.repeat(length + 1))
  }
})

test('encodes 64-bit extrema without rounding', () => {
  const bytes = new Bytes()
  bytes.signed(-(1n << 63n))
  bytes.signed((1n << 63n) - 1n)
  bytes.varint(128)
  assert.equal(hex(bytes.finish()), 'ffffffffffffffffff01feffffffffffffffff018001')
})

test('writes floating-point NaN counts even when zero', () => {
  const header = pageHeader(8, 1, 8, 0, { nulls: 0n, nans: 0n, min: Uint8Array.of(1), max: Uint8Array.of(2) })
  assert.equal(hex(header), '1500151015102c15021500150615061c360028010218010111111600000000')
})
