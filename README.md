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

```js
import { writeParquetBuffer } from 'parquet-writer'

const bytes = await writeParquetBuffer({
  rows: [{ name: 'Ada', score: 7 }, { name: 'Grace', score: null }],
})
```

Use `writeParquet` with a sink when the output should grow on disk or in a
stream instead of memory. Stream inference fixes the schema after the first
bounded group. Supply an explicit schema for empty input or stable column
types, and use `BigInt` for exact 64-bit integers and unscaled decimals.
