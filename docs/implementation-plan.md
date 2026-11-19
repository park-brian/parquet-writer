# Implementation roadmap

Slices 1–4 are complete. Slices 5–7 describe the remaining implementation.
Column vectors currently feed normalized group buffers. Benchmark the direct
typed-array path in slice 7 before adding a second buffering representation.

Use [the design](design.md) for normative API and wire behavior and [the reference
index](README.md) for source locations and revisions. Implement in this order.
Keep each slice reviewable and avoid parallel replacement implementations.

## Working method and harness

Read the core as if it were laid out on one page. A reader should be able to
follow a table from input to footer in order and see why each step exists.
Compress concepts through direct control flow and a small vocabulary. Give each
helper or boundary a job that matters to the current slice. Keep wire rules
next to the code that writes them. Prefer a few clear lines to a clever one.
Keep input validation tied to the format and API contracts. Application policy
belongs with the caller.

Start with a minimal ESM package using Node's test runner, TypeScript for JSDoc
checking/declaration generation, and Playwright for browser checks. Use fast-check
as a development-only seeded property-testing dependency. Pin versions and commit
the npm lockfile when adding dependencies. Dev dependencies include hyparquet and
hyparquet-writer; neither is a runtime dependency. Do not add native or WASM code
to the mandatory runtime graph.

Use `src` for portable modules and explicit adapters, `test` for unit/property
cases and small fixtures, and `bench` for workloads. Share data/case definitions
between Node and browser tests, not the filesystem harness. Use `.tmp` for generated
files and reports, and an isolated `.venv` for pinned DuckDB/PyArrow Python tooling.
The installed DuckDB CLI can assist development but must not be the only recorded
oracle version. Record package/tool versions in interoperability reports.

Introduce these commands with the corresponding slice; do not leave placeholders
that succeed without running checks:

| Command | Meaning |
| --- | --- |
| `npm test` | Fast unit tests and deterministic wire vectors |
| `npm run typecheck` | Check JS/JSDoc and example type contracts |
| `npm run test:interop` | Write fixtures, compare through hyparquet, DuckDB, PyArrow |
| `npm run test:browser` | Shared cases in Chromium, Firefox, WebKit |
| `npm run test:property` | Seeded supported-schema/value generation |
| `npm run test:large` | Opt-in multi-gigabyte output and independent reading |
| `npm run bench` | Reproducible workloads, throughput, size, memory report |
| `npm run build:types` | Generate package declarations |
| `npm run test:package` | Check packed package entry points and declarations |

Missing Python/browser tools must produce actionable setup errors, not silent
skips or passing interoperability results. Run fast tests/type checks for every
slice. Run the relevant interop cases as soon as that capability exists, then the
full supported matrix before slice completion. Re-run broader checks only for a
new change or unresolved concern.

## Ordered slices

### 1. Smallest independently readable file

Depends on this documentation only.

- Establish package/harness, portable entry point, binary writes, growing page
  buffers, UTF-8 utilities, unsigned varints, signed zigzag, and 64-bit handling.
- Add a small Compact Protocol serializer covering supported schema/page/footer
  structures. Keep field descriptors and enum values next to the pinned-IDL source
  reference; do not implement a general-purpose Thrift framework.
- Compile an explicit flat schema. Implement required INT32, DOUBLE, and STRING
  with PLAIN values, one uncompressed page per leaf, and one row group.
- Establish the sink contract and writer state handling on this vertical path.
  Do not create an alternate temporary all-in-memory file assembler.
- Write PAR1, contiguous chunks, actual offsets/sizes, metadata, length, and PAR1.
  Add a valid zero-row file with a declared nonempty schema.

Exit: hyparquet and DuckDB read generated nonempty/empty files. PyArrow checks
schemas, row counts, and offsets. The pinned CBIIT Java CLI runs `meta`, `footer`,
and `pages` on the populated fixture and checks zero rows in the empty footer.
Use `meta` for the physical schema because `schema` displays an Avro projection.
Compare selected metadata fields rather than command output formatting.
Compact Protocol field deltas,
list lengths around 14/15, nested structs, and signed/unsigned varint boundaries
have golden vectors. The nullable/nested design examples become executable cases
in their later slices. Root import works in a browser without Node shims.

### 2. Primitives, buffering, and streaming

Depends on slice 1.

- Complete BOOLEAN, INT32/64, FLOAT/DOUBLE, BYTE_ARRAY, and fixed binary physical
  encoders, with exact range/null validation and typed-array paths.
- Implement hybrid RLE/bit-packing and flat optional definition levels. Test
  mixed runs, width 0/1/31/32, eight-value padding, and run boundaries.
- Split pages/groups using the design defaults. Validate input batches before
  emitting their group; retain only necessary group buffers and footer metadata.
- Implement all row/column entry points with explicit schemas, Node file/stream
  adapters, web writable-stream adapter, memory sink, and flush semantics.
- Enforce input lifetime rules, busy-state admission, backpressure, write-all,
  cancellation, iterator cleanup, terminal errors, and sink finalization.
- Use the documented nested list case to test the page interface with precomputed
  levels. Keep root row, leaf slot, and physical value counts separate before
  adding nested schema compilation in slice 5.

Exit: nullable INT32 trace produces its specified 14-byte payload. Exercise two
or more pages and groups, zero-row batches, all-null pages, false/zero values,
validity bitmaps, and nonzero-offset typed-array views. A delayed sink prevents
source read-ahead. Stream many tiny column batches backed by the same typed array,
checking preserved values and full row groups up to the configured limit.
Inject source/write failures before the footer and verify finalization stops.
Inject a sink close failure after the footer and verify the operation rejects.
Repeated close/abort and overlapping operations
follow the design. Compare primitive values and metadata in all three readers.

### 3. Compression, dictionaries, and statistics

Depends on slice 2.

- Add pure JS raw-block Snappy and optional async codec hooks. Cross-check its
  output with independent decompressors; do not use framed Snappy.
- Add bounded dictionary prepasses, exact binary-key equality, cost selection,
  dictionary pages, and page-local index generation. Fall back to PLAIN for the
  whole chunk when capped or ineffective; reset at row-group boundaries.
- Compute per-page statistics, merge safe chunk bounds, and discard page state.
  Add Compact Protocol boolean and binary field vectors when statistics use them.
  Serialize modern bounds, null counts, column orders, and actual encoding lists.
  Check that all-null pages preserve bounds from other pages while unsafe non-null
  pages suppress chunk bounds. Inspect a selected dictionary with the Java CLI.
- Exercise async codecs through the same pipeline as synchronous ones.

Exit: independent readers decode PLAIN/dictionary files under both built-in codecs.
Test dictionaries of 1, 2, 255, 256, and 257 entries, cap crossings, all-unique and
repeated long values, hash collisions, and distinct byte objects with equal content.
Check NaNs, infinities, both zeros, UTF-8 versus JS string ordering, long-bound
omission, and all-null pages. DuckDB/PyArrow filtered scans must match unfiltered
values filtered in the harness; metadata-only aggregate success is insufficient.

### 4. Common analytical logical types

Depends on slice 3.

- Implement signed/unsigned integer widths, epoch dates, time/timestamp units
  and UTC semantics, decimal through precision 38, and UUID.
- Validate logical ranges and serialize compatible annotations. For decimals,
  verify signed big-endian fixed bytes and precision-dependent physical storage.
- Use shared logical comparators for dictionary preparation/statistics; avoid
  unsigned or decimal ordering through signed physical byte comparisons.

Exit: independent readers preserve exact integer/decimal values and temporal
units. Test integer extrema, uint64 above signed max, unsafe number rejection,
negative epoch timestamps, timezone changes, invalid Date, all time units, decimal
sign/scale/precision boundaries, and UUID byte order. Tests compare unscaled
decimal integers and raw temporal units without lossy JSON/float conversions.

### 5. Nested structs, lists, and maps

Depends on slice 4.

- Compile canonical schemas and maximum levels; add shared subtree traversal and
  leaf streams. Preserve a direct path for flat typed columns.
- Distinguish absent parent, empty collection, absent element, and present value.
  Required children inside absent optional parents produce null placeholders,
  not incorrect required-value errors.
- Keep root rows intact at page/group boundaries. Count root rows separately
  from repeated leaf slots. Enforce required map keys and supported key types.

Exit: the documented nested example has the specified 21-byte payload, five leaf
slots, three root rows, and three leaf nulls. Test nested lists, lists of structs,
structs containing lists/maps, null structs inside lists, optional parents with
required children, null list elements, and large repeated rows. Compare schemas,
values, levels/counts, and filtered scans using independent readers. Adapt focused
cases from DuckDB's write_stats_null_count and nested writer tests with provenance.

### 6. Inference and convenience APIs

Depends on slice 5.

- Implement complete in-memory inference and bounded first-batch stream inference.
  Share type rules with schema compilation; do not create a second encoder.
- Resolve partial hints, freeze inferred schemas, replay initial buffered data,
  and validate all later batches without widening or dropping fields.
- Add path/batch/row context to input errors and executable API examples for
  rows, typed columns with validity, nested records, file sinks, and web streams.

Exit: test all-null/missing fields, typed empty vectors, empty streams, leading
empty batches, empty lists/maps, mixed types, hints, later nulls, later fractions,
new fields, overflow, and incompatible nested values. Confirm stream inference
does not consume the full source before output begins. Producer buffer reuse is
safe after the convenience API advances to the next supplied column batch.

### 7. Release validation and performance

Depends on slice 6.

- Complete cross-browser, property, fault, package, and independent-reader suites.
  Generate declarations and validate the npm tarball in isolated consumers.
- Audit numeric metadata boundaries with synthetic counters beyond 2^32 and
  2^53; test footer/page field overflow rejection before serialization truncates it.
  Also run a real >4 GiB UNCOMPRESSED file through independent readers; synthetic
  counter tests alone do not certify large-file interoperability.
- Measure representative workloads and optimize only demonstrated hot paths.
  Check repeated UTF-8 encoding, buffer copies, per-value allocations, level
  expansion, dictionary overhead, and unnecessary await boundaries.
- Document supported features, defaults, memory behavior, adapter ownership,
  partial output, limitations, benchmark environment, and examples.

Exit: every supported capability passes the matrix below; no unrecorded skips.
The public package imports in Node and all three browser engines with no Node
polyfills or mandatory WASM. Slow-sink memory does not grow with queued data or
retained pages; explain expected footer growth separately. No throughput promise
is made until measurements establish it.

## Conformance strategy

The writer is the system under test; do not implement a production reader to
prove it correct. Use hyparquet for fast JS feedback and DuckDB/PyArrow for
independent decoding/metadata. Java/Rust source and test cases inform algorithms
without requiring their build systems in normal CI.

| Area | Mandatory assertions |
| --- | --- |
| Binary | Exact bytes for encoders/Compact Protocol, padding/count separation, endian/overflow boundaries |
| Schema | Physical and logical types, canonical wrappers, nullability, leaf order, names containing dots |
| Values | Exact BigInt/decimal, temporal units, null/empty distinctions, binary bytes, signed zero |
| File accounting | Header/footer, payload versus header sizes, offsets, rows versus slots, compressed/uncompressed totals |
| Statistics | Independent metadata, null counts, logical bounds, filtered scans matching full scans |
| Streaming | No read-ahead under backpressure, bounded current work, input lifetime, all failure/cleanup paths |
| Portability | Same portable JS in Node and three browser engines; typed-array subviews and Unicode |
| Scale | Wide schema, many groups, huge cells, high cardinality, >4 GiB actual file |

Normalize reader output deliberately: undefined optional values to null,
timestamps to declared integer units, decimals to unscaled BigInt plus scale,
maps to ordered entries, and bytes to byte sequences. Configure hyparquet binary
decoding explicitly instead of accepting its text fallback. Compare NaN using
NaN-aware equality and signed zero using Object.is; do not normalize away these
distinctions. Separate lack of oracle type support from writer correctness, and
record a replacement check if an oracle cannot expose a particular representation.

Select a small Apache fixture subset and adapt the schema/data into supported
output profiles. Do not require reproducing its original codec/encoding. Keep
malformed-reader fixtures out of writer acceptance unless they demonstrate an
invalid state the writer could emit. Each regression owns a minimal reproduction,
source revision, and expected semantic or wire result.

Property tests generate bounded acyclic schemas and values only within supported
types, with variable null density, repetition, cardinality, widths, and group/page
sizes. Preserve failing seeds and minimized fixtures. Routine CI uses fixed seeds;
expanded scheduled runs explore additional seeds. Malformed input generators
exercise validation separately from valid-file generation.

## Benchmark protocol

For opt-in local scale tests, use the existing Parquet corpus under
`D:\Projects\LDlink`. Accept the corpus location as a benchmark argument so
other machines can use their own data. The local inventory contained 286 files,
with the largest at about 27 GB. Start with footer inspection, then select one
manageable file for value checks and one large file for sustained streaming.
Read bounded batches, use a separate output path, and record the input's schema,
codec, row-group layout, and page version where available. Keep this corpus
outside CI and preserve the synthetic benchmarks for reproducible comparisons.
Check available output disk space before a large run. Certify large offsets with
an output file larger than 4 GiB and read a late row group through an independent
reader. Input size and a successful metadata-only count cannot certify that path.

Use deterministic 1-million-row workloads for routine measurements, with opt-in
10-million-row and multi-gigabyte workloads. Cover dense numeric typed columns,
low/high-cardinality strings, repeated large strings, Unicode, null-heavy columns,
wide tables, decimals/timestamps, and nested lists/structs. Include both column
input and generated row streams.

Compare hyparquet-writer with matching schema, codec, page/group targets, and
dictionary/statistics settings where available. Record differences where settings
cannot match. DuckDB/PyArrow are useful external context, not JS speed promises.
Record CPU/OS/runtime/tool versions, source revision, seed, warmups, iterations,
sink type, and whether source generation/I/O are included. Use three warmups and
five measured runs; report median/range, rows/s, uncompressed MiB/s, output size,
and peak process/heap memory. Browser memory measurements may be unavailable;
label them unavailable rather than comparing incompatible counters.

Measure encoding separately from end-to-end file output. For streaming memory,
use a discard/counting sink and a slow sink; memory-buffer output is a separate
measurement. Exclude caller-resident input from claims about incremental working
memory. Sample through steady-state groups and report footer growth. Establish
baselines before considering regression gates; use a controlled machine and
investigate sustained >15% median regressions rather than failing noisy shared CI.

## Follow-up order

After v1 validation, measure before selecting the next capability. The initial
order is delta integer/string encodings and byte-stream split, then Data Page V2,
then page/offset indexes and Bloom filters. Parallel workers and Arrow adapters
follow only when profiling or caller requirements justify their extra ownership
and scheduling contracts. Specialized types/encryption need separate designs.
