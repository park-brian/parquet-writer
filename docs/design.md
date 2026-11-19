# Isomorphic writer design

Status: implementation specification. Examples below describe the intended API.
See [the roadmap](implementation-plan.md) for implementation order and acceptance gates.

## Product contract

Build an independent JavaScript writer for large analytical tables. V1 writes
flat and nested data incrementally, works in Node and browsers, and interoperates
with hyparquet, DuckDB, and PyArrow. The runtime has no mandatory dependencies.
Compression can be accelerated through an optional hook without changing format semantics.

Use ESM JavaScript, JSDoc type checking, and generated `.d.ts` declarations.
Target ES2022, Node 22+, and current Chromium, Firefox, and WebKit. Deno/Bun may
consume the portable entry point but are not certified v1 targets.
The package root must have no Node imports, Buffer/process assumptions, filesystem
access, or environment-specific export substitution. Provide explicit `/node` and
`/web` adapters. Development builds may generate declarations; runtime JS needs no build step.

## Public API

```javascript
const schema = { fields: [
  { name: 'id', type: 'int64', nullable: false },
  { name: 'label', type: 'string' },
] }

const bytes = await writeParquetBuffer({
  schema,
  columns: { rowCount: 2, columns: {
    id: new BigInt64Array([1n, 2n]),
    label: ['first', null],
  } },
})

await writeParquet({ schema, rows: databaseCursor, sink })

const writer = new ParquetWriter({ schema, sink })
await writer.writeRows([{ id: 3n, label: 'third' }])
await writer.flush()
const result = await writer.close() // { rowCount: bigint, byteLength: bigint }
```

### Inputs and results

- Convenience functions require exactly one of `rows` or `columns`. `rows` is an
  array, iterable, or async iterable of objects. `columns` is a batch or an
  iterable/async iterable of batches. Prefer async iteration when both protocols exist.
- A column batch is `{ rowCount: number, columns: Record<string, ColumnVector> }`.
  Every vector has exactly rowCount entries and the supplied names exactly match
  the root schema. Reject negative/nonintegral counts. Skip zero-row batches.
- A vector is an array, supported numeric typed array, or
  `{ values, validity?: Uint8Array }`. Bitmap bit i is 1 for a present value,
  LSB-first. Validate bitmap length; ignore unused trailing bits. Invalid slots
  do not inspect their stored values. Nested cells use objects, arrays, and Maps.
- Row objects may omit nullable fields: missing, undefined, and null mean null.
  Reject unknown fields and missing required fields, including nested fields.
- `writeParquetBuffer` resolves to Uint8Array only after successful finalization;
  `writeParquet` and `close` resolve to `{ rowCount, byteLength }`, both BigInt.
- `ParquetWriter` requires a complete schema. Its constructor validates options
  without writing bytes. `writeRows` accepts an array batch; `writeColumns` accepts
  one column batch. Both append to the same current row group. `flush` finishes
  that group without closing the file. All four writing methods return promises.
- Memory output uses the same writer with a chunk collector and one final
  concatenation. It is intentionally unsuitable for files beyond available memory.

### Schema

`Schema` contains an ordered `fields` array. Every field has a name, type, and
`nullable` (default true). Reject duplicate sibling names and empty structs/root
schemas. A struct adds `fields`; a list adds `element` (a field type without a
name); a map adds `key` and `value` (unnamed field types, key always required).
Primitive parameters are `length` for fixed binary, `precision`/`scale` for
decimal, and `unit`/`isAdjustedToUTC` for time/timestamp. Unit is `millis`,
`micros`, or `nanos`; UTC adjustment defaults true for timestamp, false for time.
Compile these nodes to physical leaves and canonical wrappers, not public Thrift objects.

| Type | Accepted non-null values | Physical storage |
| --- | --- | --- |
| boolean | boolean | BOOLEAN, packed LSB-first |
| int8/16/32, uint8/16/32 | integral number in declared range | INT32 with integer annotation |
| int64, uint64 | BigInt, or exactly representable safe integral number | INT64 with integer annotation; unsigned bits preserved |
| float, double | number, including NaN/infinities | FLOAT / DOUBLE |
| string | string | UTF-8 BYTE_ARRAY |
| binary, fixedBinary | Uint8Array; exact length for fixedBinary | BYTE_ARRAY / FIXED_LEN_BYTE_ARRAY |
| date | integral epoch-day number | INT32 DATE |
| time | millis: number; micros/nanos: BigInt | INT32 / INT64 TIME |
| timestamp | BigInt in declared units; safe integer number; Date only for UTC millis | INT64 TIMESTAMP |
| decimal | unscaled BigInt | INT32 through precision 9, INT64 through 18, minimum-width fixed binary through 38 |
| uuid | 16 bytes or canonical hyphenated hexadecimal UUID string | FIXED_LEN_BYTE_ARRAY(16) |
| struct, list, map | object, array, Map respectively | canonical nested schema |

Reject coercions from numeric strings, invalid dates, out-of-range integers,
decimal precision overflow, invalid scale (0 <= scale <= precision), and time
outside a day. Timestamp integer range is signed 64-bit. Date is a day count,
not a locale-dependent string or automatic Date truncation. Local timestamps use
explicit integer units; never reinterpret them through the host timezone.
Decimal fixed bytes use big-endian two's complement; ordinary integer storage is
little endian. Metadata emits logical annotations and compatible converted
annotations where specified by the pinned format, including decimal scale/precision.

Map keys in v1 are supported scalar types except float/double, with no null keys;
values may be nested. Preserve insertion order. Reject distinct JavaScript keys
that encode to the same Parquet key. Cyclic input is rejected. Reject
sparse list arrays; explicit null list elements remain supported.

### Options and inference

Shared options are `schema`, `schemaHints`, `codec`, `codecs`, `dictionary`,
`dictionaryByteLimit`, `rowGroupRows`, `rowGroupByteTarget`, `pageByteTarget`,
`statistics`, `statisticsMaxBytes`, `metadata`, `createdBy`, and `signal`.
Hints are a partial schema tree in the same shape; hinted field types determine
ambiguous nodes while unhinted nodes are inferred. A complete schema and hints
are mutually exclusive. Invalid sizes/unknown codec identifiers fail before output.
Dictionary is `auto` (default) or `false`; statistics default true. Metadata is an
ordered array of `{ key: string, value?: string }`; createdBy defaults to package
name and version. Defaults for size settings are below. Codec defaults SNAPPY;
UNCOMPRESSED is built in. Hook entries are keyed by supported Parquet codec name.

Inference is optional when schema is omitted. Arrays/in-memory batches are
examined completely before writing, without copying the entire input. Iterables
buffer up to the first row-group target, infer once, replay that batch, then freeze
the schema. Empty leading batches supply no evidence. Empty input needs a schema.

- Numbers infer double, including integral samples, so later fractions remain valid.
- Numeric typed arrays preserve their width/sign; Uint8ClampedArray maps to uint8.
  BigInt64Array/BigUint64Array preserve sign; float typed arrays preserve width.
- Scalar BigInt infers int64; uint64 values beyond int64 need a hint. Date infers
  UTC millisecond timestamp; string infers string; Uint8Array cells infer binary.
  A Uint8Array used as an entire column vector is uint8, not one binary cell.
- Objects infer structs from the union of sampled field names, in first-seen order.
  Arrays infer homogeneous lists; Maps infer homogeneous key and value types.
  Map keys supplied as numbers need an integer schema hint.
  All nonempty column batches must have the same field names.
- Inferred fields/elements/values are nullable; map keys are required. Typed-array
  width evidence is usable even without non-null values.
- Null-only fields, empty collections without element evidence, mixed incompatible
  types, or unsupported objects require hints. Do not infer decimal, UUID, date,
  or narrower temporal units from strings or magnitudes.
- Later batches cannot add fields or widen/change types. Errors identify row/batch
  and schema path. Earlier streamed bytes may already exist; there is no rollback.

## Internal architecture and ownership

Use private modules for binary operations/Thrift, schema/inference, column
preparation/levels, encodings/pages/statistics, compression, and file assembly.
Do not expose raw intermediate structures or build a class hierarchy per physical type.

Compile each schema once to ordered leaf descriptors: physical type, logical
parameters, path segments, maximum definition/repetition levels, validation,
PLAIN encoding function, and comparison rule. Share that compiled representation
between schema serialization and the encoder. Path identity is an array, not a
dot-joined string (field names may contain dots).

Flat columns go directly to page planning using index ranges/typed-array views.
Rows become bounded column buffers. Traverse each nested root value once and
distribute its slots to the leaves during ingestion. Keep slot values and levels
in parallel arrays. The group byte estimate includes the expanded slots, and
page output releases group data once all its chunks have been written.

Every leaf yields packed present values, definition levels, repetition levels,
and row boundaries. Null placeholders contribute levels and num_values but no
physical value. Use typed level/index buffers with geometric growth. Keep page
boundaries on complete root rows in v1, allowing an oversized row when legal.

The file writer alone owns offsets and metadata accumulation. It serializes
column chunks contiguously, pages in order, row groups in input order, then the
footer. Pure encoders do not access sinks; codecs consume page payload bytes.
Use a small audited table of supported Thrift structures/field IDs plus a Compact
Protocol writer. No general Thrift compiler or reader is required. Audit the table
against the pinned IDL and verify bytes through independent metadata readers.

### Buffering and performance

| Setting | Initial default |
| --- | --- |
| rowGroupRows | 65,536 |
| rowGroupByteTarget | 64 MiB estimated uncompressed content |
| pageByteTarget | 1 MiB uncompressed payload |
| dictionaryByteLimit | 1 MiB serialized dictionary values |
| statisticsMaxBytes | 4 KiB per binary/string bound |

End groups at the first row/byte target reached; targets are positive integers.
Estimate bytes from physical widths, actual UTF-8 lengths, nested elements, and
levels. Record estimator limitations; these targets are not JavaScript heap caps.
An individual row may exceed targets; reject a row/page exceeding wire size limits
before allocating an impossible page. Bound dictionary entries as well as bytes
to 65,536 entries. Account for map/index overhead separately in measurements.

Do not enqueue more source input while output is backpressured. Split large
column batches into ranges; do not clone them wholesale. Apart from caller-owned
input, peak memory is current row-group/subtree state plus active page, dictionary,
compression, and output buffers. Footer metadata grows with groups times leaves.
Do not retain per-page indexes/statistics after merging chunk statistics in v1.

Input passed to the incremental writer is borrowed until `flush`/`close` finishes
the containing group. Callers must not mutate it before that point. Convenience
iterable APIs fully consume each supplied column batch before requesting the next.
Write complete groups and copy only the pending tail into writer-owned storage
before advancing the iterator. Producer batch boundaries do not force a flush.
This lets producers reuse their buffers while small batches fill normal groups.
Row iterable APIs snapshot consumed
values into owned group buffers before advancing the iterator, including binary
and nested values. Memory already owned by the caller is reported separately.

### Output and failures

`Sink.write(bytes)` may return void or Promise<void>; optional close/abort follow
the same rule. Resolve write only after consuming the bytes; the writer may then
reuse the buffer. The writer owns sink finalization. Web adapters acquire one
WritableStream writer and release its lock after close/abort. Node adapters honor
backpressure and write-all semantics. File sinks create exclusively by default;
overwriting requires an explicit adapter option.

Lifecycle is OPEN -> CLOSING -> CLOSED, or terminal FAILED/ABORTED. Acquire the
single-operation busy flag before the first await. Reject overlapping write/flush
calls without failing the already active operation. Close rejects when another
operation is active; repeated admitted close calls share its promise/result.
Writes reject once closing starts. Abort marks cancellation immediately, waits
for active work to settle, then aborts the sink once; repeated abort is harmless.
Codec/source/sink errors fail the writer and abort the sink, preserving the
original error if cleanup also fails. Close the source iterator with return()
when consumption stops early. Check AbortSignal between pulls and page writes;
synchronous encoding is not preemptible. Check cancellation before footer output.

Do not retry partial writes or codecs automatically. A failed streaming operation
can leave incomplete bytes; file adapters close handles but do not promise atomic
replacement or automatically delete caller data. Cleanup and atomic destination
publication belong to callers. Return success only after sink close succeeds.
A sink close failure can leave a complete, readable file after the footer has
been written. The operation still rejects because sink completion failed.

## Wire-format decisions

- File layout is PAR1, column chunks, Compact Thrift FileMetaData, uint32 LE
  footer length, PAR1. Metadata version is 1; data pages initially use V1.
- For V1, concatenate repetition levels, definition levels, and encoded values,
  then compress the entire payload. Omit a level stream when its maximum is zero.
  Present V1 level streams have a uint32 LE byte-length prefix. Dictionary index
  streams have a bit-width byte and no four-byte length prefix.
- Hybrid RLE/bit-packing uses the specified run headers, widths, eight-value groups,
  and padding. Values are PLAIN unless an eligible dictionary saves total encoded
  bytes. BOOLEAN uses PLAIN bit packing. Floating values remain PLAIN to avoid
  dictionary equality merging negative/positive zero or NaNs.
- Build dictionaries in a bounded prepass per leaf/chunk for strings, binary,
  and integers. Compare serialized dictionary plus index bytes with PLAIN bytes;
  use dictionary only when smaller. If limits are exceeded, discard it and use
  PLAIN for the whole chunk. No mid-chunk dictionary growth/fallback in v1.
  Deduplicate binary values by content with exact collision checking, not identity.
  Reset dictionaries per row group. All-null chunks need no dictionary.
- Emit one PLAIN dictionary page before RLE_DICTIONARY data pages. Snappy hooks
  must produce raw Snappy blocks, not framed streams. Codecs receive Uint8Array
  and return Uint8Array or a promise; unsupported codecs reject rather than fall
  back under an incorrect codec identifier.
- Page payload size excludes its Thrift header; column compressed/uncompressed
  sizes include all page headers. Track file offsets, row counts, and cumulative
  sizes as BigInt; page-local sizes/counts must fit their signed i32 wire fields.
  Footer length must fit uint32. Never use JS bitwise operators for file offsets.
- ColumnChunk.file_offset is 0; required column metadata is in the footer.
  Record actual dictionary/data offsets separately. Leaf order matches flattened
  schema order. Empty files have a schema, zero rows, and no row groups.
- Statistics store null_count and modern min_value/max_value with column_orders.
  Use logical ordering: unsigned integers, UTF-8/binary unsigned bytes, numeric
  decimal, UUID bytes, and signed temporal values. Bounds omit BYTE_ARRAY length
  prefixes. All-null ranges have no bounds. NaN-containing page/chunk ranges omit
  bounds. Emit nan_count for floating-point statistics, including zero, and
  write a zero minimum as -0 and a zero maximum as +0. If either binary
  bound exceeds statisticsMaxBytes, omit both. Merge bounds from pages with safe
  bounds and skip all-null pages. A page with non-null values and unsafe bounds
  makes chunk bounds unsafe. Sum null counts independently of bounds.

## Worked wire traces

These examples fix the expected levels and payloads before implementation.
Exact Compact Thrift golden bytes will be established and independently checked
in slice 1; a second local decoder is not the source of truth.

### Nullable INT32

For optional `score: int32` and rows `[7, null, 9]`, maximum definition level is
1 and repetition level is 0. Definitions are `[1, 0, 1]`; packed present values
are `[7, 9]`. One valid hybrid representation uses a single padded eight-value
bit-packed group: header `03`, bits `05`. The definition section is therefore
`02 00 00 00 03 05`. No repetition section is present.

The PLAIN value section is `07 00 00 00 09 00 00 00`. Uncompressed page payload
is these two sections concatenated: 14 bytes. DataPageHeader has num_values=3,
encoding=PLAIN, definition/repetition encoding=RLE; PageHeader reports payload
size 14, excluding the header. Null count is 1; bounds are 7 and 9 encoded as
four-byte LE values. The chunk starts at offset 4 and its size includes the
page header. Its row group has three rows; footer metadata references the actual
page offset, and its serialized length precedes the closing PAR1.

### Nullable list of nullable INT32

Schema is optional `numbers (LIST)` -> repeated `list` -> optional `element`.
For root rows `[null, [], [1, null, 2]]` the leaf streams are:

| Root row | Slot | Definition | Repetition | Physical value |
| --- | --- | --- | --- | --- |
| null | absent list | 0 | 0 | none |
| [] | empty list | 1 | 0 | none |
| [1, null, 2] | first element | 3 | 0 | 1 |
| same row | null element | 2 | 1 | none |
| same row | final element | 3 | 1 | 2 |

Maximum definition level is 3 and repetition level is 1. A valid padded hybrid
definition stream is `03 b4 03`; repetition stream is `03 18`. With their V1
length prefixes, payload bytes are:

```text
02 00 00 00 03 18          # repetition stream
03 00 00 00 03 b4 03       # definition stream
01 00 00 00 02 00 00 00   # two PLAIN INT32 values
```

Payload size is 21; page num_values and chunk num_values are 5, root row count
is 3, and leaf null_count is 3. Padding slots do not contribute counts. Compress
the 21-byte payload as a unit when using Snappy; store its actual compressed
length. Do not split the final root row across pages. Null list, empty list,
and list containing null must remain distinct in independent-reader assertions.

## Deferred features

Data Page V2, delta encodings, byte-stream split, page indexes, Bloom filters,
encryption, INT96 writing, variant/JSON/geospatial/float16, Arrow adapters, workers,
and sync APIs are outside v1. Measure before prioritizing follow-up encodings.
No public encoding-plugin framework, schema evolution during a file, or append-to-
existing-file support is planned for v1.
