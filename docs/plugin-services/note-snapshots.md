# Prepared note-vector snapshots

The existing default query aggregation remains `max_chunk_cosine_v1`. A caller can explicitly request `note_level_weighted_v1` against a bounded, account-owned snapshot of prepared note vectors. Querying and creating a snapshot never calls an embedding or language model.

## Preparation and weight evidence

The host normalizes each stored F32 chunk vector, computes its mean weighted by the token count of that chunk's actual encoded input, then normalizes the note vector. The input includes the host's versioned preprocessing, including timestamps. It does not reuse an unrelated tokenizer's estimate or split a batch's aggregate usage among its inputs.

The current evidence version is `provider-per-input-usage-v1`. The explicit measured encoder sends one encoded input per request, disables SDK retries, and records that request's reported token count. Every count must be a positive integer, bound to the exact encoded-input fingerprint and model fingerprint. Unknown usage cannot produce this evidence. Reported usage does not establish the provider's hidden tokenizer revision; the evidence describes the individually reported usage of the encoded inputs.

The internal writer option remains `hostIndex.upsert({ id, content, requireTokenWeights: true })`. Operators can now use the bounded, preview-and-confirm `prepare-weighted` command described in [index maintenance](./index-maintenance.md#explicit-weighted-preparation). It uses the same `IndexLifecycle` writer and index database, selects explicit account-owned notes, skips valid prepared revisions, and requires a fresh durable journal before individual provider calls. Ordinary index updates retain the existing batch encoder. There is no implicit historical conversion, query-time rebuild, public rebuild endpoint or automatic opt-in of existing deployments. Existing vectors without verifiable per-input counts require explicit preparation before they support this aggregation. Whether a real provider reports usable per-input counts still needs to be established for that provider/model combination. Synthetic-provider tests do not establish this.

The weighted writer enforces a 100,000,000 chunk-dimension bound before visiting vector contents or writing staged chunks. The explicitly measured indexing path checks the same bound after splitting the input and before invoking the encoder or creating a revision. Internal tests can tighten this bound; they cannot raise it. Ordinary batch indexing retains its existing behavior.

Both chunk and note vectors live in the existing host index database. New snapshots retain fixed references to certified immutable note-vector revisions instead of copying their vector blobs. Publishing a replacement revision does not change those references. An older aggregate remains while a snapshot references it; deletion and permission checks still override snapshot visibility. Retained copied snapshots keep their original hash-based guarantees and do not gain instance evidence during migration.

## Capability discovery and permissions

Require both `vector.noteLevelAggregation` and `vector.snapshots`. Their availability also depends on enabled note-query/exact-query policies, a trusted PostgreSQL qualification registry, local index metadata version 2 and certified prepared revisions for the caller's account. Apply the application migrations and explicitly initialize qualification before enabling this path; see [qualification and immutable references](../development/plugin-note-qualification.md) and [operator preparation](./index-maintenance.md#operator-commands). Creating a pool still validates its scope and current contents; discovery is not a full-body scan.

`vector.snapshots` requires permission to call every snapshot procedure. Exact paths are:

- `pluginServices.vector.snapshots.create`
- `pluginServices.vector.snapshots.sample`
- `pluginServices.vector.snapshots.readNote`
- `pluginServices.vector.snapshots.release`

The existing `pluginServices` and `pluginServices.vector` grants cover these operations. A substring or a permission for only one method does not grant the others. These checks travel with the procedures and reject accidental secondary mounts. SDK errors from authentication/permission guards are normalized to `UNAUTHENTICATED`/`FORBIDDEN`.

## Public SDK

```ts
const caps = await services.capabilities();
if (!caps.features['vector.noteLevelAggregation']?.available ||
    !caps.features['vector.snapshots']?.available) {
  // Explain unavailable/disabled/index-not-ready; do not fall back silently.
  return;
}
const snapshot = await services.vector.snapshots.create({
  scope: { types: [0, 1] },
  aggregation: 'note_level_weighted_v1',
});
try {
  const start = await services.vector.snapshots.sample({
    handle: snapshot.handle,
    excludeNoteIds: previousStartId ? [previousStartId] : [],
  });
  if (!start.item) return;
  const body = await services.vector.snapshots.readNote({
    handle: snapshot.handle,
    noteId: start.item.note.id,
    snapshotHash: start.item.snapshot.hash,
  });
  if (body.status !== 'ok') return;
  const result = await services.vector.query({
    source: { kind: 'note', noteId: body.id },
    snapshotHandle: snapshot.handle,
    aggregation: 'note_level_weighted_v1',
    expectedIndex: { embeddingSpaceId: snapshot.index.embeddingSpaceId, generation: snapshot.index.generation },
    scope: { types: [0, 1] },
    excludeNoteIds: [],
    limit: 8,
  });
  // Validate scoring.aggregation AND scoring.version against snapshot.scoring.
  // retrieval.algorithm remains 'exact'; it does not name the aggregation.
} finally {
  await services.vector.snapshots.release({ handle: snapshot.handle });
}
```

A handle fixes the prepared membership, source vectors, embedding space, generation and scoring version. It represents a **prepared subset**, not the entire library. `range` reports the eligible and unprepared counts observed while creating it. The descriptor always conservatively reports `coverage: 'partial'`. If scope is supplied to a snapshot-bound query, it must equal the canonical scope used to create that snapshot.

`sample` uses reservoir sampling over every currently legal same-version member. `poolSize` is the complete count **before exclusions**. A nonempty pool with `item: null` means no unexcluded choice, not an empty library. If the scan or version fence cannot be completed, the method fails instead of guessing the pool size.

Each item carries `{ snapshot: { handle, hash } }`. Pass these exact values to `readNote`. `ok` includes the authoritative note id, account id, type, dates, full content and the matching hash. `changed` includes current content/hash for display but cannot verify a new selection against an old score. Previously selected statistics may retain their selected snapshot. `missing`/`forbidden` distinguish invalidation only inside an authenticated owned snapshot. A fabricated or other-account handle always returns `NOT_FOUND_OR_FORBIDDEN`.

Queries may use the frozen vector of an already selected, subsequently edited source. Target notes whose current body hash changed are skipped, and lower-ranked valid members fill the requested result count. Source deletion, recycling or loss of visibility still overrides the snapshot. New notes and new same-generation revisions do not silently enlarge an existing pool. Generation/model/preprocessing changes invalidate it with `INDEX_CHANGED`.

Scores remain cosine values in `[-1,1]`, with zero and negative scores retained unless a threshold is explicitly supplied. Ties use ascending note id. Complete exclusions apply before ranking/limit. Budget/time/staleness truncation reports `remaining: 'unknown'`; it is not evidence of full-library exhaustion.

The reference path uses durable PostgreSQL qualification rows, note instances and account fences. Ordinary note and tag-association writes invalidate qualification in the same transaction, including body writes that preserve `updatedAt`. Capture/publication compare qualification, generation and corpus fences; certification uses a version CAS so stale work cannot certify a newer write. Up to four dirty notes per account can be repaired in a request; larger unknown sets require explicit maintenance and return `INDEX_NOT_READY`. Loss of registry trust requires explicit initialization. Current scope, ownership and per-note SHA checks remain authoritative. Physical tuple identifiers used by older adapters are not persisted as snapshot identity or exposed as portable revisions.

## Lifetime and resource limits

The effective limits are returned as `capabilities.vectorSnapshotLimits`:

- Ready lifetime: 30 minutes. In-progress reservation lifetime: 30 seconds.
- At most 2 live snapshots per account and 16 across the host.
- At most 128 MiB logical payload per snapshot, 256 MiB per account and 1 GiB across the host.
- At most 50,000 prepared notes, with the existing scan/vector-value/computation budgets still enforced.

Creation reserves the full maximum payload in a LibSQL write transaction before recording members. Normal reference creation reads qualification/certificate metadata and inserts fixed revision references, without materializing vector blobs or proofs. Each page updates its logical-byte/member counters atomically. Sharing physical vectors does not discount per-scene quota: accounting includes the full logical vector cost and the applicable proof/certificate/reference allowance plus descriptor. Publication shrinks the reservation to that cost. Concurrent processes cannot each pass a stale count/sum. SQLite lock waits are bounded; only read statements, a refused BEGIN, or a BUSY COMMIT whose transaction is still active may be retried. Transaction bodies and commits of unknown outcome are never replayed.

Release removes the descriptor, member references or owned copied members, quota and now-unreferenced superseded aggregates in one LibSQL transaction. Current published vectors and aggregates still referenced by another scene remain. Failed preparation attempts to clean its reservation and children while preserving the original error. If best-effort release also fails, its reservation continues to count until the lease expires and an explicit mutation point prunes it. New reservations prune expired scenes and collect eligible superseded aggregates; there is no periodic cleanup daemon. Expired handles are rejected immediately, and at most 1,024 metadata-only tombstones remain to return `INDEX_CHANGED`. This does not promise immediate physical SQLite file shrinkage. The limits bound logical retained payload, not process RSS, PostgreSQL memory, mapped pages or total database file size. See [resource measurement boundaries](./performance.md#qualified-reference-snapshots-and-optional-mmap).

Snapshot reads and preparation use the shared account request frequency policy. They do not create a paid-provider request. Release remains available for cleanup when an administrator disables the service, but still requires authentication, ownership and its procedure permission. Invalid/expired handles are not silently replaced or retried as a new session.
