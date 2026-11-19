# Writer benchmarks

`npm run bench` runs the full synthetic matrix. Pass workload names to run a
subset, for example `npm run bench -- numeric categorical`. The defaults are
one million rows, three warmups, and five measured runs. Set `PARQUET_ROWS`,
`PARQUET_WARMUPS`, or `PARQUET_RUNS` to change the work. Input is deterministic.

Compare the two memory modes for throughput and file size. Both request Snappy,
65,536-row groups, 1 MiB pages, a 1 MiB dictionary budget, and statistics.
The writers use different page size estimates and dictionary decisions. The text
case is particularly sensitive because the estimated PLAIN values are much larger
than their dictionary indexes. The reference run skips decimals and nested lists
in this harness. Row modes include the cost of turning resident vectors into a
row stream. Sampled memory includes the input and the runtime's other allocations.
Process RSS high water is cumulative within each invocation.

## Local baseline

Windows, AMD Ryzen 9 7950X, Node 26.5.0, hyparquet-writer 0.18.0. The following
measurements used one million rows and report in-memory median times.

| Workload | Before the optimization | Current | hyparquet-writer | Current file bytes |
| --- | ---: | ---: | ---: | ---: |
| Numeric typed columns | 211 ms | 146 ms | 69 ms | 4,393,257 |
| Categorical strings | 526 ms | 85 ms | 79 ms | 39,896 |
| Repeated long text | 1,402 ms | 89 ms | 47 ms | 250,682 |

The complete matrix also ran for unique, nullable, wide, temporal, decimal,
and nested data. Use the printed per-mode ranges, throughput, and memory
measurements when comparing later changes. These are local baselines.

## Real files

Set `PYTHON` to an interpreter with PyArrow and pass an input path, fresh output
path, and optional row limit. Zero selects all rows. This measures end-to-end
read, conversion, and write time for supported flat Arrow columns. The source
is streamed in batches. In the LDlink sample, PyArrow confirmed that all 20,000
output rows matched the source.

```powershell
$env:PYTHON = '.venv/Scripts/python.exe'
npm run bench:corpus -- D:/Projects/LDlink/sources/dbsnp.v1.uncompressed.parquet .tmp/ldlink-sample.parquet 20000
npm run test:large
```

The large test writes a real uncompressed output file and asks PyArrow to read
the final row group. It verified 4,311,925,781 output bytes and decoded 16 rows
from data-page offset 4,295,120,233. It requires 5 GiB of free disk space and
removes the generated file on completion when it uses the default output path.
