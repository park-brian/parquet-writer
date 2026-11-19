# parquet-writer

An independent isomorphic JavaScript Parquet writer.

Start with the [design and reference index](docs/README.md), the
[writer design](docs/design.md), and the [implementation roadmap](docs/implementation-plan.md).

The target is portable ESM JavaScript for large analytical tables, with row and
column input, typed arrays, bounded data buffering, nested data, and asynchronous
output. The writer accepts row iterables and column batches with explicit or
inferred schemas. It supports nullable primitives, analytical logical types,
structs, lists, and maps. Snappy, dictionary encoding, and statistics are on by
default. See the [examples](examples/export.js) for typed arrays, nested rows,
and file and web stream output.
