import json
import sys

from pyarrow import parquet

expected = json.loads(sys.stdin.buffer.read())
with open(sys.argv[1], "rb") as source:
    file = parquet.ParquetFile(source)
    assert file.schema.names == ["id", "value", "label"]
    assert [file.schema.column(i).physical_type for i in range(3)] == [
        "INT32", "DOUBLE", "BYTE_ARRAY"
    ]
    assert file.read().to_pylist() == expected
    assert file.metadata.num_rows == len(expected)
    assert file.metadata.num_row_groups == bool(expected)
    if expected:
        offset = 4
        group = file.metadata.row_group(0)
        for i in range(group.num_columns):
            chunk = group.column(i)
            assert chunk.data_page_offset == offset
            offset += chunk.total_compressed_size
        source.seek(-8, 2)
        assert offset == source.tell() - int.from_bytes(source.read(4), "little")
