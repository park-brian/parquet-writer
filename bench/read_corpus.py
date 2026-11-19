import json
import sys

import pyarrow as pa
from pyarrow import parquet

path, limit = sys.argv[1:]
limit = int(limit)
file = parquet.ParquetFile(path)
fields = []
for field in file.schema_arrow:
    types = {
        pa.bool_(): "boolean", pa.int32(): "int32", pa.int64(): "int64",
        pa.uint32(): "uint32", pa.uint64(): "uint64", pa.string(): "string",
        pa.float32(): "float", pa.float64(): "double",
    }
    if field.type in types:
        fields.append({"name": field.name, "type": types[field.type], "nullable": field.nullable})
if not fields:
    raise ValueError("Corpus file needs at least one supported flat column")
print(json.dumps({"fields": fields}), flush=True)
print(f"Source: {file.metadata.num_rows:,} rows in {file.metadata.num_row_groups:,} groups", file=sys.stderr)
names = [field["name"] for field in fields]
wide = {field["name"] for field in fields if field["type"] in ("int64", "uint64")}
remaining = limit
for batch in file.iter_batches(batch_size=8192, columns=names):
    if limit:
        batch = batch.slice(0, remaining)
    columns = batch.to_pydict()
    for name in wide:
        columns[name] = [None if value is None else str(value) for value in columns[name]]
    print(json.dumps({"rowCount": batch.num_rows, "columns": columns}, allow_nan=False))
    if limit:
        remaining -= batch.num_rows
        if not remaining:
            break
