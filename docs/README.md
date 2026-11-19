# Writer design and references

This documentation specifies the full writer. The roadmap tracks progress from
the initial write path through the remaining implementation.

- [Design](design.md): API, value representations, architecture, wire rules, ownership, and examples.
- [Implementation plan](implementation-plan.md): ordered slices, acceptance criteria, tests, and performance work.

## Decisions

- Independent implementation; existing writers are references and comparison targets.
- Isomorphic ESM JavaScript with JSDoc checking and generated declarations.
- Large analytical tables drive defaults. Rows and column batches share one pipeline.
- All writing operations return promises; no synchronous API in v1.
- Explicit schemas or optional inference, including frozen first-batch inference for streams.
- V1 includes nested data and streaming, common analytical types, Snappy, dictionaries, and statistics.
- No mandatory runtime dependencies, native code, or WASM; optional codec implementations may use them.
- Spec definitions govern behavior when reference implementations disagree.

## Pinned reference inventory

Retrieved on 2026-11-16 (America/New_York). Checkouts are ignored under
`_references/`; they are not submodules or runtime dependencies. Branch names
describe where these snapshots came from, not a request to track future changes.

| Repository | Branch | Commit | Use and selected directories |
| --- | --- | --- | --- |
| [hyparam/hyparquet](https://github.com/hyparam/hyparquet) | master | `8f4096afaa8da5d0bbd76a0225b44c71ac4fcd83` | JS reader oracle; `src`, `test` |
| [apache/parquet-java](https://github.com/apache/parquet-java) (formerly parquet-mr) | master | `567c0ec92533ef34f87b8bd9005f10e3c9fdc83d` | Levels, encoders, regression cases; `parquet-column/src`, `parquet-encoding/src`, `parquet-hadoop/src`, `parquet-format-structures/src` |
| [duckdb/duckdb](https://github.com/duckdb/duckdb) | main | `9d8ecca6dac5b82e49648c45cd5134bb7342d018` | Analytical writer and SQL assertions; `extension/parquet`, `test/sql/copy/parquet`, `test/parquet` |
| [jorgecarleitao/parquet2](https://github.com/jorgecarleitao/parquet2) | main | `b0e654526ce06bcb02b3e0e1f5aa3e1a10580350` | Page/compression/file separation; `src`, `tests` |
| [hyparam/hyparquet-writer](https://github.com/hyparam/hyparquet-writer) | master | `ea5f25cfcda7c295ed998ff6f01fdc5d870fce05` | JS writer approaches and baseline; `src`, `test` |
| [apache/parquet-format](https://github.com/apache/parquet-format) | master | `5cc18cae643835b19f869d3cffb085cd3c04eb15` | Authoritative Thrift and root-level format specifications; `src` |
| [apache/parquet-testing](https://github.com/apache/parquet-testing) | master | `0e00127a431f83388d38eebb22cf644d06e86a15` | Selected fixtures and recipes; `data`, `bad_data` |

Sparse checkout includes root files, including available license and notice files.
The Java and DuckDB checkouts are source references; building them is not required.
The Rust reference is the `parquet2` crate, not Apache arrow-rs or a choice of data-page version.

## Reproducing the checkouts

Run this PowerShell from the project root on a fresh checkout. It fails rather
than replacing an existing reference directory. Run repositories individually
when repairing a partially completed setup.

```powershell
$references = @(
  @('hyparam/hyparquet', '8f4096afaa8da5d0bbd76a0225b44c71ac4fcd83', @('src', 'test')),
  @('apache/parquet-java', '567c0ec92533ef34f87b8bd9005f10e3c9fdc83d', @('parquet-column/src', 'parquet-encoding/src', 'parquet-hadoop/src', 'parquet-format-structures/src')),
  @('duckdb/duckdb', '9d8ecca6dac5b82e49648c45cd5134bb7342d018', @('extension/parquet', 'test/sql/copy/parquet', 'test/parquet')),
  @('jorgecarleitao/parquet2', 'b0e654526ce06bcb02b3e0e1f5aa3e1a10580350', @('src', 'tests')),
  @('hyparam/hyparquet-writer', 'ea5f25cfcda7c295ed998ff6f01fdc5d870fce05', @('src', 'test')),
  @('apache/parquet-format', '5cc18cae643835b19f869d3cffb085cd3c04eb15', @('src')),
  @('apache/parquet-testing', '0e00127a431f83388d38eebb22cf644d06e86a15', @('data', 'bad_data'))
)
New-Item -ItemType Directory -Force _references | Out-Null
foreach ($reference in $references) {
  $repository, $revision, $directories = $reference
  $destination = Join-Path '_references' ($repository.Split('/')[-1])
  git clone --depth 1 --filter=blob:none --sparse "https://github.com/$repository.git" $destination
  if ($LASTEXITCODE -ne 0) { throw "Clone failed: $repository" }
  git -C $destination fetch --depth 1 origin $revision
  if ($LASTEXITCODE -ne 0) { throw "Fetch failed: $repository" }
  git -C $destination checkout --detach $revision
  if ($LASTEXITCODE -ne 0) { throw "Checkout failed: $repository" }
  git -C $destination sparse-checkout set -- $directories
  if ($LASTEXITCODE -ne 0) { throw "Sparse checkout failed: $repository" }
}
```

Partial clones fetch selected blobs on demand, so expanding the checkout requires
network access. Do not initialize unrelated upstream submodules. For fixtures
referenced through missing submodules, use the separately pinned parquet-testing
checkout or regenerate the selected case.

## Source map and lessons

Run `npm test` for the hyparquet check. To run the other readers on Windows,
install DuckDB on PATH and set up PyArrow in a virtual environment:

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install pyarrow==26.0.1
$env:PYTHON = '.venv/Scripts/python.exe'
npm run test:interop
npx playwright install chromium firefox webkit
npm run test:browser
```

Set `DUCKDB` or `PARQUET_CLI_JAR` to override the default executable or JAR path.

The optional Java CLI check uses the standalone
[CBIIT parquet-cli 1.15.2 release](https://github.com/CBIIT/parquet-cli/releases/tag/1.15.2).
The checkout is `_references/cbiit-parquet-cli` at
`6ebcef6cc63761aa70625990643bfe515cad34fa`. Download the release asset into
its `bin` directory and verify SHA-256
`f9c3d96f7d06e11d26cb9f8afab0d1d3284f0d535ad27aed4ea0d9b4942035b5`.
This binary has its own release pin, independent of the Apache Java source checkout.
The following command was verified with Java 21 on Windows using the local fixture.

```powershell
java -jar _references/cbiit-parquet-cli/bin/parquet-cli-1.15.2.jar meta _references/parquet-testing/data/alltypes_plain.parquet
```

- [Format layout and Thrift](https://github.com/apache/parquet-format/tree/5cc18cae643835b19f869d3cffb085cd3c04eb15): Compact Protocol, counts, offsets, logical annotations, and canonical LIST/MAP. Footer version is 1, regardless of data-page version.
- [Java levels/pages](https://github.com/apache/parquet-java/blob/567c0ec92533ef34f87b8bd9005f10e3c9fdc83d/parquet-column/src/main/java/org/apache/parquet/column/impl/ColumnWriterV1.java): separate levels from values; do not port its Hadoop interfaces or class hierarchy.
- [Java hybrid encoder tests](https://github.com/apache/parquet-java/tree/567c0ec92533ef34f87b8bd9005f10e3c9fdc83d/parquet-column/src/test/java/org/apache/parquet/column/values/rle): translate boundary vectors into small JS tests.
- [DuckDB writer cases](https://github.com/duckdb/duckdb/tree/9d8ecca6dac5b82e49648c45cd5134bb7342d018/test/sql/copy/parquet/writer): adopt assertions for dictionary widths, nested null counts, memory usage, unsigned values, and statistics. Do not port query-engine scheduling.
- [Rust file assembly](https://github.com/jorgecarleitao/parquet2/blob/b0e654526ce06bcb02b3e0e1f5aa3e1a10580350/src/write/file.rs): separate prepared pages from file output. Do not retain per-page index state when indexes are disabled.
- [JS writer tests](https://github.com/hyparam/hyparquet-writer/tree/ea5f25cfcda7c295ed998ff6f01fdc5d870fce05/test): useful nesting, multipage, and dictionary cases. Do not depend on reader internals or reproduce variable synchronous/asynchronous return types.
- [Apache fixture descriptions](https://github.com/apache/parquet-testing/blob/0e00127a431f83388d38eebb22cf644d06e86a15/data/README.md): select supported cases; reading and rewriting a fixture is not evidence that every original encoding was preserved.

Keep the source URL, revision, license/notice, purpose, and generation recipe
beside each adopted fixture or vector. Commit a small fixture subset with tests;
routine test runs must not depend on these ignored reference checkouts.
