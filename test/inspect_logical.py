import sys
from decimal import Decimal
from uuid import UUID

import pyarrow as pa
from pyarrow import parquet

table = parquet.read_table(sys.argv[1])
assert table["u"][0].as_py() == 2**64 - 1
assert table["small"][0].as_py() == -128
for name, carrier, raw in [
    ("d", pa.int32(), -1),
    ("tm", pa.int32(), 1234),
    ("tu", pa.int64(), 1234567),
    ("tn", pa.int64(), 1234567890),
    ("instant", pa.int64(), -1234),
    ("local", pa.int64(), -123456789),
]:
    assert table[name].cast(carrier)[0].as_py() == raw
assert table["instant"].type.tz == "UTC"
assert table["local"].type.tz is None
assert table["money"][0].as_py() == Decimal("-9999999999999999999999999999999999.9999")
assert table["money32"][0].as_py() == Decimal("-1.234")
assert table["money64"][0].as_py() == Decimal("1234567898.765")
assert table["key"][0].as_py() == UUID("00112233-4455-6677-8899-aabbccddeeff")
