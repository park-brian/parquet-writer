import json
import sys

from pyarrow import parquet

expected = json.loads(sys.stdin.buffer.read())
file = parquet.ParquetFile(sys.argv[1])
assert [file.metadata.row_group(i).num_rows for i in range(2)] == [2, 1]
assert file.read().to_pylist() == [
    {**row, "attributes": None if row["attributes"] is None else [tuple(pair) for pair in row["attributes"]]}
    for row in expected
]
leaf = file.metadata.row_group(1).column(1)
assert leaf.path_in_schema == "numbers.list.element"
assert leaf.num_values == 3
assert leaf.statistics.null_count == 1
