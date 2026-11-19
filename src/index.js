import { Bytes } from './binary.js'
import { dictionaryHeader, footer, pageHeader } from './metadata.js'
import { compile, dataPage, hybrid, normalize, plain, valueSize } from './pages.js'
import { dictionary, encodeBounds, mergeBounds, pageBounds } from './column.js'
import { snappy } from './snappy.js'

const magic = Uint8Array.of(80, 65, 82, 49)
const codecIds = { UNCOMPRESSED: 0, SNAPPY: 1, GZIP: 2, LZO: 3, BROTLI: 4, LZ4: 5, ZSTD: 6, LZ4_RAW: 7 }

/** @typedef {import('./pages.js').Schema} Schema */
/** @typedef {import('./pages.js').Value} Value */
/** @typedef {Record<string, unknown>} Row */
/** @typedef {ArrayLike<unknown>} Vector */
/** @typedef {{ rowCount: number, columns: Record<string, Vector | { values: Vector, validity?: Uint8Array }> }} Batch */
/** @template T @typedef {Iterable<T> | AsyncIterable<T>} Source */
/** @typedef {keyof typeof codecIds} Codec */
/** @typedef {(bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>} Compressor */
/** @typedef {{ schema: Schema, rowGroupRows?: number, rowGroupByteTarget?: number, pageByteTarget?: number, signal?: AbortSignal, codec?: Codec, codecs?: Partial<Record<Codec, Compressor>>, dictionary?: 'auto' | false, dictionaryByteLimit?: number, statistics?: boolean, statisticsMaxBytes?: number }} Options */
/** @typedef {Options & ({ rows: Source<Row>, columns?: never } | { columns: Batch | Source<Batch>, rows?: never })} Input */
/** @typedef {{ write(bytes: Uint8Array): void | Promise<void>, close?(): void | Promise<void>, abort?(reason: unknown): void | Promise<void> }} Sink */

export class ParquetWriter {
  #leaves
  #sink
  #signal
  #rowLimit
  #groupTarget
  #pageTarget
  #compress
  #codec
  #dictionaryLimit
  #statisticsLimit
  /** @type {Value[][]} */
  #columns
  #rows = 0
  #estimatedBytes = 0
  #offset = 0n
  #rowCount = 0n
  /** @type {import('./metadata.js').Group[]} */
  #groups = []
  /** @type {Promise<unknown> | undefined} */
  #pending
  /** @type {Promise<{ rowCount: bigint, byteLength: bigint }> | undefined} */
  #closing
  /** @type {Promise<void> | undefined} */
  #aborting
  /** @type {{ reason: unknown } | undefined} */
  #cancelled
  #finished = false

  /** @param {Options & { sink: Sink }} options */
  constructor({ schema, sink, signal, rowGroupRows = 65_536, rowGroupByteTarget = 64 * 1024 * 1024, pageByteTarget = 1024 * 1024,
    codec = 'SNAPPY', codecs, dictionary = 'auto', dictionaryByteLimit = 1024 * 1024, statistics = true, statisticsMaxBytes = 4096 }) {
    for (const size of [rowGroupRows, rowGroupByteTarget, pageByteTarget, dictionaryByteLimit, statisticsMaxBytes]) {
      if (!Number.isSafeInteger(size) || size < 1 || size > 0x7fffffff) {
        throw new RangeError('Expected positive size targets within the Parquet i32 limit')
      }
    }
    if (typeof sink?.write !== 'function') throw new TypeError('Expected a writable sink')
    if (!Object.hasOwn(codecIds, codec)) throw new TypeError('Unknown codec: ' + codec)
    const compressor = codecs && Object.hasOwn(codecs, codec) ? codecs[codec] : undefined
    this.#compress = codec === 'UNCOMPRESSED' ? undefined : compressor ?? (codec === 'SNAPPY' ? snappy : undefined)
    if (codec !== 'UNCOMPRESSED' && typeof this.#compress !== 'function') throw new TypeError('No compressor for ' + codec)
    this.#codec = codecIds[codec]
    this.#dictionaryLimit = dictionary === false ? 0 : dictionaryByteLimit
    this.#statisticsLimit = statistics ? statisticsMaxBytes : 0
    this.#leaves = compile(schema)
    this.#columns = this.#leaves.map(() => [])
    this.#sink = sink
    this.#signal = signal
    this.#rowLimit = rowGroupRows
    this.#groupTarget = rowGroupByteTarget
    this.#pageTarget = pageByteTarget
  }

  #check() {
    if (this.#cancelled) throw this.#cancelled.reason
    this.#signal?.throwIfAborted()
  }

  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  #run(work) {
    if (this.#pending || this.#finished || this.#cancelled) {
      return Promise.reject(new Error('Writer is busy or finished'))
    }
    const pending = Promise.resolve().then(async () => {
      try {
        this.#check()
        return await work()
      } catch (error) {
        this.#finished = true
        await this.#abortSink(error)
        throw error
      } finally {
        this.#pending = undefined
      }
    })
    this.#pending = pending
    return pending
  }

  /** @param {Uint8Array} bytes */
  async #write(bytes) {
    this.#check()
    await this.#sink.write(bytes)
    this.#offset += BigInt(bytes.length)
    this.#check()
  }

  /** @param {unknown} reason */
  async #abortSink(reason) {
    try { await this.#sink.abort?.(reason) } catch { /* Preserve the write error. */ }
  }

  /** @param {Source<Row>} rows */
  writeRows(rows) {
    return this.#run(async () => {
      const names = new Set(this.#leaves.map(leaf => leaf.name))
      for await (const row of rows) {
        this.#check()
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('Expected a row object')
        for (const name of Object.keys(row)) {
          if (!names.has(name)) throw new TypeError(`Unknown field ${name} in row ${this.#rowCount + BigInt(this.#rows)}`)
        }
        this.#append(leaf => Object.hasOwn(row, leaf.name) ? row[leaf.name] : undefined)
        if (this.#groupReady()) await this.#flush()
      }
    })
  }

  /** @param {Batch} batch */
  writeColumns(batch) {
    return this.#run(async () => {
      const { rowCount, columns } = batch
      if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new RangeError('Invalid row count')
      if (!columns || Object.keys(columns).length !== this.#leaves.length) throw new TypeError('Column names must match schema')
      const vectors = this.#leaves.map(({ name }) => {
        const column = Object.hasOwn(columns, name) ? columns[name] : undefined
        const wrapped = column && Object.hasOwn(column, 'values')
        const descriptor = /** @type {{values: Vector, validity?: Uint8Array}} */ (column)
        const values = wrapped ? descriptor.values : /** @type {Vector | undefined} */ (column)
        const validity = wrapped ? descriptor.validity : undefined
        if (!values || (!Array.isArray(values) && (!ArrayBuffer.isView(values) || values instanceof DataView)) || values.length !== rowCount) {
          throw new TypeError(`Invalid vector for ${name}`)
        }
        if (validity !== undefined && (!(validity instanceof Uint8Array) || validity.length !== Math.ceil(rowCount / 8))) {
          throw new TypeError(`Invalid validity bitmap for ${name}`)
        }
        return { values, validity }
      })
      for (let row = 0; row < rowCount; row++) {
        this.#check()
        this.#append((_, index) => {
          const { values, validity } = vectors[index]
          return !validity || validity[row >>> 3] & (1 << (row & 7)) ? values[row] : null
        })
        if (this.#groupReady()) await this.#flush()
      }
    })
  }

  /** @param {(leaf: import('./pages.js').Leaf, index: number) => unknown} read */
  #append(read) {
    for (const [index, leaf] of this.#leaves.entries()) {
      const value = normalize(leaf, read(leaf, index))
      this.#estimatedBytes += valueSize(leaf, value)
      this.#columns[index].push(value)
    }
    this.#rows++
  }

  #groupReady() {
    return this.#rows >= this.#rowLimit || this.#estimatedBytes >= this.#groupTarget
  }

  flush() {
    return this.#run(() => this.#flush())
  }

  async #flush() {
    if (!this.#rows) return
    if (!this.#offset) await this.#write(magic.slice())
    const chunks = []
    for (const [index, leaf] of this.#leaves.entries()) {
      chunks.push(await this.#writeColumn(leaf, this.#columns[index]))
    }
    this.#groups.push({ chunks, count: this.#rows })
    this.#rowCount += BigInt(this.#rows)
    for (const column of this.#columns) column.length = 0
    this.#rows = this.#estimatedBytes = 0
  }

  /** @param {import('./pages.js').Leaf} leaf @param {Value[]} values */
  async #writeColumn(leaf, values) {
    const ranges = []
    for (let start = 0; start < values.length;) {
      let end = start
      let estimate = 0
      do { estimate += valueSize(leaf, values[end++]) }
      while (end < values.length && estimate < this.#pageTarget)
      let present = 0
      for (let i = start; i < end; i++) if (values[i] !== null) present++
      ranges.push({ start, end, present })
      start = end
    }

    const chunkStart = this.#offset
    let rawSize = 0n
    let dictionaryOffset
    let indexes
    const candidate = this.#dictionaryLimit ? dictionary(leaf, values, this.#dictionaryLimit) : undefined
    if (candidate) {
      let cursor = 0
      const encoded = ranges.map(({ present }) => {
        const out = new Bytes()
        out.byte(candidate.width)
        hybrid(out, candidate.ids.slice(cursor, cursor + present), candidate.width)
        cursor += present
        return out.finish()
      })
      const bytes = new Bytes()
      plain(bytes, leaf, candidate.entries)
      const raw = bytes.finish()
      const addedBytes = dictionaryHeader(raw.length, raw.length, candidate.entries.length).length
      if (candidate.dictionarySize + addedBytes + encoded.reduce((sum, item) => sum + item.length, 0) < candidate.plainSize) {
        indexes = encoded
        dictionaryOffset = this.#offset
        const packed = await this.#pack(raw)
        const header = dictionaryHeader(raw.length, packed.length, candidate.entries.length)
        rawSize += BigInt(header.length + raw.length)
        await this.#write(header)
        await this.#write(packed)
      }
    }
    const offset = this.#offset
    const total = { nulls: 0n, nans: 0n, unsafe: false }
    for (const [index, { start, end, present }] of ranges.entries()) {
      const page = values.slice(start, end)
      const definitions = leaf.nullable ? page.map(value => value === null ? 0 : 1) : []
      const encoded = present ? indexes?.[index] : undefined
      const raw = dataPage(leaf, page, definitions, leaf.nullable ? 1 : 0, [], 0, encoded)
      const packed = await this.#pack(raw)
      const bounds = this.#statisticsLimit ? pageBounds(page, this.#statisticsLimit) : undefined
      if (bounds) mergeBounds(total, bounds)
      const header = pageHeader(raw.length, page.length, packed.length, encoded ? 8 : 0,
        bounds && encodeBounds(leaf, bounds))
      rawSize += BigInt(header.length + raw.length)
      await this.#write(header)
      await this.#write(packed)
    }
    const stats = this.#statisticsLimit ? encodeBounds(leaf, total) : undefined
    return { leaf, offset, size: this.#offset - chunkStart, rawSize, codec: this.#codec, dictionaryOffset, stats }
  }

  /** @param {Uint8Array} bytes */
  async #pack(bytes) {
    this.#check()
    const packed = this.#compress ? await this.#compress(bytes) : bytes
    if (!(packed instanceof Uint8Array)) throw new TypeError('Compressor must return Uint8Array')
    return packed
  }

  close() {
    if (this.#closing) return this.#closing
    if (this.#pending || this.#finished || this.#cancelled) return Promise.reject(new Error('Writer is busy or finished'))
    this.#closing = this.#run(async () => {
      await this.#flush()
      if (!this.#offset) await this.#write(magic.slice())
      const metadata = footer(this.#leaves, this.#groups, this.#rowCount)
      if (metadata.length > 0xffffffff) throw new RangeError('Footer exceeds Parquet uint32 limit')
      const trailer = new Bytes()
      trailer.i32(metadata.length)
      trailer.append(magic)
      await this.#write(metadata)
      await this.#write(trailer.finish())
      await this.#sink.close?.()
      this.#check()
      this.#finished = true
      return { rowCount: this.#rowCount, byteLength: this.#offset }
    })
    return this.#closing
  }

  /** @param {unknown} [reason] */
  abort(reason = new Error('Write aborted')) {
    if (this.#aborting) return this.#aborting
    if (this.#finished) return Promise.resolve()
    this.#cancelled = { reason }
    this.#aborting = (async () => {
      await this.#pending?.catch(() => {})
      if (this.#finished) return
      this.#finished = true
      await this.#abortSink(reason)
    })()
    return this.#aborting
  }
}

/** @param {Input & { sink: Sink }} input */
export async function writeParquet(input) {
  let writer
  try {
    if ((input.rows === undefined) === (input.columns === undefined)) {
      throw new TypeError('Provide exactly one of rows or columns')
    }
    writer = new ParquetWriter(input)
    if (input.rows !== undefined) {
      await writer.writeRows(input.rows)
    } else if (input.columns && 'rowCount' in input.columns) {
      await writer.writeColumns(input.columns)
    } else {
      for await (const batch of /** @type {Source<Batch>} */ (input.columns)) {
        await writer.writeColumns(batch)
      }
    }
    return await writer.close()
  } catch (error) {
    if (writer) await writer.abort(error)
    else {
      try { await input.sink.abort?.(error) } catch { /* Preserve the input error. */ }
    }
    throw error
  }
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
