import sys

from pyarrow import parquet

filename, count = sys.argv[1:]
count = int(count)
file = parquet.ParquetFile(filename)
assert file.metadata.num_rows == count
group = file.metadata.num_row_groups - 1
chunk = file.metadata.row_group(group).column(1)
assert chunk.data_page_offset > 2**32
rows = file.read_row_group(group).to_pylist()
assert rows[0]["id"] == count - 16
assert rows[-1]["id"] == count - 1
for row in rows:
    payload = row["payload"]
    assert len(payload) == 2**20
    assert payload[0] == row["id"] & 255
    assert payload[-1] == (row["id"] >> 8) & 255
print(f"PyArrow decoded {len(rows)} rows from data offset {chunk.data_page_offset:,}")
