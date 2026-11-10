# Public vector query V1

`window.Blinko.services.vector.query` returns note-level similarities using the existing host LibSQL file. By-note queries read all verified body chunks of the current SQL snapshot and do not resolve an AI model or call an embedding provider. Text queries embed only the query text through the shared paid-call ledger; they require a compatible configured embedding model, allowed policy and an idempotency key. Neither path rebuilds an index.

Only `exact` and `auto` are supported; `auto` uses exact. Explicit `approximate` fails with `CAPABILITY_UNSUPPORTED`. Capabilities distinguish by-note readiness from text-model compatibility. Inspection is metadata-only and never constructs a provider.

The default target scope is the caller's own type 0/1, non-archived, non-recycled notes. Types, archives, authorized tag IDs (`any`/`all`) and timezone-qualified creation dates can narrow/extend that scope. `createdFrom` is inclusive and `createdBefore` exclusive. Shared notes owned by somebody else and recycled notes are excluded. SQL selects the authorized candidate scope before vector lookup. The service rechecks ownership, visibility, tags and the content/timestamp fingerprint before projecting results.

Exclusions apply before selection; the source note is automatically excluded. Limits count distinct notes, default 10, maximum 50, with at most 5000 exclusion IDs. Administrator policy can lower these public limits. Raw vectors and private note metadata are never returned. Excerpts are at most 320 JavaScript string units.

## Scores and completeness

Scores are cosine similarities in `[-1, 1]`, using norms rather than assuming normalized vectors. All source/target chunk pairs participate in `max_chunk_cosine_v1`; the largest pair supplies one match excerpt. Negative and zero scores are preserved unless the caller provides `minScore`. Sort order is score descending, then note ID ascending. Scores are not probabilities.

`index.coverage` describes account index coverage and is independent from exact scan completion. The current status adapter conservatively reports `partial` for an available account index: a completed query in a narrow scope does not prove that every account note is indexed. Unknown historical sources are not admitted. Provenance can be `verified` or `legacy-attested`.

`remaining=yes` means at least one additional eligible scored note exists beyond the limit after rechecking. `no` is used only after a completed exact scan with stable SQL corpus and LibSQL generation/corpus fences. Missing, never-indexed notes reduce coverage. Stale/corrupt candidates, a budget stop, timeout, or changed corpus produce truncated/unknown results with a reason. Initial expected-index mismatches and active-generation changes fail explicitly with `INDEX_CHANGED`. A final source edit fails with `SOURCE_INDEX_STALE`; missing/foreign source errors are indistinguishable.

## Computation limits

These are server limits, not client-tunable query arguments:

| Limit | Value |
| --- | ---: |
| Complete source chunks | 64 |
| Target chunks | 50,000 |
| Candidate notes | 50,000 |
| Stored vector values read, including source | 33,554,432 |
| Pairwise dimension operations | 100,000,000 |
| Scan deadline | 2 seconds |
| Response deadline, by note | 4 seconds |
| Response deadline, by text | 34 seconds, including a separately enforced 30-second embedding timeout |
| SQL candidate page | 128 notes |
| Individual SQL body | 4 MiB UTF-8 |
| Vector metadata read per page | 8 MiB |

`budget` covers chunk/value/operation/note counts, metadata bytes, and the 4 MiB individual SQL-body read limit. Increasing a computation budget does not repair an oversized body. When several conditions occur, the single public reason follows an explicit priority: timeout, index-changed, budget, stale-candidates, recall-limit. All of them keep `remaining=unknown`.

Source chunk/value/metadata limits are checked before fetching vector blobs; an oversized source fails as a whole. Target scanning stops between complete revisions. The reader uses existing `vector_id` unique lookups, with metadata identity, shape and F32 checks. A scan timeout allows time for final authorization; the separate response timer rejects with `TIMEOUT` if a database adapter does not finish. In-flight database reads may finish later; this is not a database cancellation guarantee. It never permits a late model dispatch.

The account frequency gate is shared with paid services, default 20 new requests per database minute, configurable up to 240. It is separate from paid concurrency (default 2) and daily tokens (default 200,000, maximum 5,000,000; UTC reservation day). `plugin_service_rate` is persistent across processes; first insert and conflict update both enforce its limit. Paid replays do not dispatch again. Rate history has an indexed cleanup path; note-only hosts also reclaim old windows. These controls cover the new services, not every legacy AI entry point.

## Verification and benchmark boundaries

Correctness cases use deterministic synthetic chunks in a real isolated LibSQL file. Host tests use real PostgreSQL, the actual `appRouter`, `httpBatchLink`, Request/Response handling and the formal SDK. The by-note test forbids global network fetch and model resolution. The text test uses a local simulated provider with the real persistent ledger, including same-key replay. Random-walk and similar-content examples run against that host chain. No new cloud calls are required by these tests.

`server/scripts/benchmark-plugin-vectors.ts` requires the same explicitly guarded disposable PostgreSQL test environment. It creates synthetic 1024-dimensional corpora at 1k, 10k and 50k notes, plus four-chunk 1k/10k cases. Bulk fixture seeding is excluded from query timing. Each query opens a new reader connection; SQL, vector reads and remaining scoring/assembly time are reported separately. The first query and later warm queries are retained; OS caches are not cleared. This is service-boundary timing without HTTP/SDK/browser or external embedding latency. Small samples are descriptive rather than a stable production p95 guarantee. No approximate-adapter benchmark is claimed.

Additional source-chunk, exclusion and sampled-process-RSS measurements are documented in [Resource measurements](./performance.md), including the 64-source-chunk boundary and the slower 5,000-exclusion case. Those instrumented service timings do not include browser or external embedding latency.

Apply the additive Prisma migration before enabling the new root router. Rolling back this feature requires stopping its traffic, preserving any required rate/audit records, dropping `plugin_service_rate` and the policy rate column/constraint, then reverting code. It does not require changing notes or vector data. Existing generation rollback/recovery mechanisms remain in place.
