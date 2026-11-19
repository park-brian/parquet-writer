# parquet-writer

An independent isomorphic JavaScript Parquet writer.

Start with the [design and reference index](docs/README.md), the
[writer design](docs/design.md), and the [implementation roadmap](docs/implementation-plan.md).

The target is portable ESM JavaScript for large analytical tables, with row and
column input, typed arrays, bounded data buffering, nested data, and asynchronous
output. The current writer accepts row iterables and column batches with an
explicit flat schema, writes nullable primitive values in uncompressed PLAIN
pages, and streams through buffer, web stream, and Node adapters.
