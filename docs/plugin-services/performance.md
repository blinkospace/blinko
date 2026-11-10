# Synthetic exact-query resource measurements

These measurements exercise the service with real isolated PostgreSQL and the
existing local LibSQL schema. They use synthetic short notes and 1024-dimensional
float32 vectors, with no model resolution or external provider calls. Query code,
tests and measurement scripts were executed at commit `628d8a9`.

Reference machine: Apple M1 Max, 10 CPUs, macOS 27.2.0; Bun 1.2.8 (runtime
`process.version` reports v22.6.0), PostgreSQL 17.11. Approximate retrieval remains
unsupported. The existing query budgets were unchanged.

## Method

The resource script is `server/scripts/benchmark-plugin-vector-resources.ts`.
It bulk-seeds each fixture outside query timing, then runs that scenario in a
fresh process. All eight query-process PIDs are different. A separate thread
samples its own process RSS at a target interval of 5ms, so synchronous scoring
on the main event loop does not suspend memory sampling. The sampler was also
checked with a 32MiB allocation: its observed process RSS increased accordingly.

RSS includes Bun, loaded modules, native libraries, query allocations and the
sampler thread. It excludes the seeding process, other scenarios, the separate
PostgreSQL server and OS caches. The reported peak is the **observed sampled
peak**, not a kernel absolute high-water mark. Actual maximum sampling gaps in
these scenarios ranged from 5.67ms to 28.881ms. RSS baseline is measured before
the first query; baseline-to-peak growth is not an exact per-request allocation.
No concurrent-query or large-body capacity bound is established by these runs.

Each scenario retains its first query and ten subsequent warm queries, except
50k notes, which has one first query and three warm queries. Every query opens a
new vector reader; OS caches are not cleared. A first query is not a cold disk or
full-process startup measurement. SQL, vector reads and remaining scoring and
assembly time are recorded separately in each sample. Sampler overhead is
included. The measurements omit HTTP, SDK, browser and external embedding
latency. The small-sample p95 is descriptive, not a production SLO.

The note count includes the source, which is automatically excluded. Explicit
exclusion percentages below use the other `notes - 1` notes as denominator.
Target/source chunks are separate: the 64-source-chunk scenario still has four
chunks per target. Vectors are bulk synthetic fixtures, not a quality evaluation
of actual document chunking or model embeddings.

## Results

| Notes | Target / source chunks | Explicit exclusions | First query ms | Warm sample p95 ms | RSS baseline / sampled peak MiB | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1,000 | 1 / 1 | 0 | 98.6 | 84.9 | 235.7 / 306.1 | Completed exact scan |
| 10,000 | 1 / 1 | 0 | 679.1 | 651.6 | 240.8 / 349.0 | Completed exact scan |
| 50,000 | 1 / 1 | 0 | 2,329.1 | 2,315.3 | 233.8 / 342.7 | Partial: timeout, remaining unknown |
| 1,000 | 4 / 4 | 0 | 174.7 | 148.5 | 230.8 / 312.7 | Completed exact scan |
| 10,000 | 4 / 4 | 0 | 947.0 | 945.9 | 234.0 / 351.5 | Partial: operation budget, remaining unknown |
| 1,000 | 4 / 64 | 0 | 224.6 | 198.1 | 236.0 / 309.6 | Partial: operation budget, remaining unknown |
| 10,000 | 1 / 1 | 5,000 (50.005%) | 1,449.5 | 1,412.8 | 238.1 / 340.0 | Completed exact scan |
| 1,000 | 1 / 1 | 990 (99.099%) | 53.1 | 28.0 | 236.0 / 261.2 | Completed; nine eligible targets, remaining no |

All samples within each scenario reported the result state shown above. Account
coverage stayed conservatively `partial` even when the selected scope completed.
A faster partial scan does not establish the full-corpus Top-K. Increasing source
chunks can hit the pairwise operation budget well before the deadline.

The 10k single-chunk scenario with 5,000 exclusions was slower than its
unexcluded counterpart and exceeded one second in its warm p95 sample. The
unexcluded result must not be generalized to all exclusion sizes. No budget was
relaxed and no performance optimization was added to obtain these results.

The earlier timing-only script, `server/scripts/benchmark-plugin-vectors.ts`, and
its existing samples remain valid under their original commit and method. Its
warm p95 excludes the first query: for the original 10k single-chunk case it was
661.311ms; including the first query among all eleven samples gives 664.466ms.
Those are different sample sets, not conflicting measurements. Resource-script
numbers above are separate instrumented runs.

## Reproduction

Use a dedicated migrated local `blinko_test` PostgreSQL database and a new empty
output directory. The script checks `PLUGIN_SERVICES_TEST_DB=1`, loopback host
and username, and refuses to overwrite result and per-case files:

```sh
bun run server/scripts/benchmark-plugin-vector-resources.ts /new/empty/directory/resources.json
```

Do not point this script at an existing user database. It creates and removes
synthetic SQL accounts/notes and keeps synthetic vector fixtures in the output
directory for review. It does not change the host's configured vector file or
invoke an embedding provider.

## Qualified reference snapshots and optional mmap

The table above remains an earlier chunk-query measurement at its recorded
revision. The qualified note-level path adds PostgreSQL qualification/instance
metadata and fixed references to immutable F32 note aggregates; it is a different
measurement scope. See [snapshot semantics](./note-snapshots.md) and
[qualification preparation](../development/plugin-note-qualification.md).

A later synthetic run used Node 22.17.0, the same M1 Max machine, PostgreSQL 17.11,
@libsql/client 0.15.15 and libsql 0.5.22. The fixture contained 10,000 Markdown
notes, 1024 dimensions, four source and four target inputs, and no explicit
exclusions. Preparation reused proven synthetic vectors; it made no provider
calls. Five sequential fresh backend processes shared the prepared PG/libSQL
fixture and its natural request-rate windows. Each process performed real login,
first snapshot creation, first query, ten warm queries and public release.
Budgets stayed at 2000ms scan / 4000ms hard timeout with 128-member pages.

| Round | First query ms | Ten warm queries p95 ms | Node lifetime RSS high water MiB |
| ---: | ---: | ---: | ---: |
| 1 | 290.024 | 310.154 | 780.563 |
| 2 | 1388.581 | 295.913 | 737.922 |
| 3 | 1470.197 | 380.684 | 477.953 |
| 4 | 1587.187 | 491.180 | 546.234 |
| 5 | 1501.387 | 385.480 | 521.250 |

All 55 queries completed exact top-10 results, with zero score error against the
fixture oracle. All five creations captured 10,000 reference members, with zero
copied members, and release left no parents/references/copies. The 50 warm-query
samples had nearest-rank p95 400.678ms. Five first-query samples are too few for a
population guarantee; their nearest-rank p95 is simply the maximum, 1587.187ms.
Earlier timeout and observer-failure attempts remain separate; successful rounds
were not spliced into a failed run.

These five rounds belong to the 18,100,093-byte backend artifact with SHA256
`a27539fce21f96eee6233277e1251caebe3e3f4e87c43aa231d295643171b4a4`.
A subsequent integration build refreshed generated Prisma metadata for the same
product source tree, producing 18,106,661 bytes / SHA256
`161391e49fd3cbfb6a744275bb4ac5d4b072695ed801e3b76f4be490981a3ee4`.
That artifact completed an independent consumer's authenticated
capabilities/create/query/readNote/release smoke on a small synthetic fixture.
The five-round performance results are not reassigned to it or later builds.

The optional setting requests at most 512MiB of mmap per snapshot client,
reads back the effective value and falls back to ordinary reads when unsupported.
It does not prefetch vectors, cap process RSS or guarantee first-query latency.
Kernel wait4 high water covers the exact Node child lifetime, including startup,
creation, queries and cleanup. It is not a query-only peak or memory attributable
to mmap. This run observed about 781MiB at its highest; no matching baseline RSS
run establishes the incremental memory cost.

Preparation reads vectors, and PG/OS caches persist. No OS cache flush or random
paired A/B experiment was performed. These TCP/SDK results do not establish
physical cold-disk, browser, mobile-device or full-plugin latency. Native calls
may also outlive a cooperative deadline; the existing budgets are not a promise
of hard real-time interruption.
