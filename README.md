# parquet-writer

An independent isomorphic JavaScript Parquet writer.

Start with the [design and reference index](docs/README.md), the
[writer design](docs/design.md), and the [implementation roadmap](docs/implementation-plan.md).

The target is portable ESM JavaScript for large analytical tables, with row and
column input, typed arrays, bounded data buffering, nested data, and asynchronous
output. The initial write path supports explicit, required INT32, DOUBLE, and
UTF-8 string fields with uncompressed PLAIN pages.
