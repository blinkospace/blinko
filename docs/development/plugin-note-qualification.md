# Note qualification and immutable snapshot references

The note-level snapshot API retains its existing public inputs, descriptors and scoring rules. PostgreSQL records current note eligibility; the existing local libSQL database stores immutable weighted vectors and fixed scene references. New reference scenes record `noteId`, note instance, revision and body/timestamp hash. Publishing another revision does not change an existing scene. Retained copied scenes remain on their original hash-based semantics: their old rows contain no durable instance evidence, and migration does not invent it.

## Operator preparation

This candidate has been exercised only with isolated synthetic data. Apply normal application Prisma migrations and explicitly migrate the local index metadata before enabling snapshots. The SQLite writer supports metadata version 1 → 2 and preserves existing copied snapshot rows. Readers do not perform migrations.

From the server working directory, using the application's database configuration and vector file:

```sh
bun scripts/plugin-services-index.ts migrate
bun scripts/plugin-services-index.ts initialize-qualification
bun scripts/plugin-services-index.ts certify-existing --account 42 --notes '[101,102]'
```

`initialize-qualification` registers every note, including unowned, unusable and unprepared notes. It starts a new instance epoch and marks the registry untrusted until every row is certified. Each explicit invocation is bounded to 50,000 captures and 30 seconds. Exit status 2 means incomplete. Repeating the command resumes that incomplete initialization when schema and rule evidence are unchanged; it does not discard completed batches. A completed registry, changed schema/rule, or a TRUNCATE requires a new epoch. Ordinary requests never run this initialization.

`certify-existing` accepts at most 128 explicit owned IDs. It uses existing host chunks only when their recorded model, preprocessing, source input, individual token weights and provenance validate. It derives a new immutable revision through the normal writer. It does not call a provider, infer token counts or attest unknown history. Notes without sufficient evidence remain unprepared. Existing separately authorized weighted preparation is still an explicit operation.

For larger ordinary edit/import batches, use:

```sh
bun scripts/plugin-services-index.ts maintain-qualification
```

This bounded command preserves note instances. It may be repeated until `ready` is true. It cannot repair a registry that has lost schema trust; use explicit initialization in that case. The runtime may repair at most four dirty rows per account per request. A larger unknown set returns `INDEX_NOT_READY` before scanning bodies.

The tested migration role is an ordinary table owner with no superuser, role-creation, database-creation or replication attribute. It can apply existing Prisma migrations and create the normal table triggers. No extension, event trigger, elevated product role or alternate SQLite driver is introduced. Deployments with separate migration and application roles must provide the application role access to the new metadata tables and trigger functions under their existing ownership/grant policy; those deployment-specific grants have not been validated by the candidate's owner-role test. The implementation does not automatically create roles or grant privileges.

## Qualification and consistency

The migration registers existing notes as dirty. Normal note body, timestamps, type, archive/recycle and ownership DML invalidates eligibility in the same PG transaction. Tag relation changes and tag ownership changes invalidate affected notes. Ownership transfers advance both account fences. Deleting and recreating an ID creates a different instance. A change to the legacy `metadata.isIndexed` marker alone preserves eligibility.

Certification captures the host body/timestamp fingerprint and Markdown usability, then uses instance/version CAS. A concurrent write wins; stale certification cannot overwrite it. Failed maintenance leaves the row dirty. Trigger disable/re-enable changes catalog evidence and cannot silently restore trust. TRUNCATE clears trust. Explicit reinitialization rotates instances, preventing old scenes from becoming current merely because body text and times match again.

PG write transactions never wait for libSQL or a provider. The two stores do not invent a shared `prepared=true` transaction. Scene creation matches PG qualification to a libSQL revision certificate, checks generation/corpus/account fences around capture and publication, and fails on a concurrent change. Unknown commits are not automatically replayed.

Normal scene creation reads qualification and certificate metadata and writes member references. It does not read full bodies, proofs or vector blobs. Sampling scans the complete currently legal member pool, counts it before exclusions, and reads the selected body once. Exact query still scans eligible vectors and computes full cosine scores. Scope checks include account, recycle/archive, types, creation-time bounds and account-owned tags with any/all matching. Detail reads repeat the full scope check.

An edited source may use its frozen vector while it remains visible and belongs to the same instance. Changed targets are skipped and lower ranks can fill the requested result. Deletion, recycling or loss of ownership/scope takes priority. Oversized edited sources can still use their frozen vector; new scene creation retains the existing body-size budget.

## Storage, accounting and cleanup

The writer validates token-weight evidence and F32 aggregation before creating a revision certificate. Vector/proof rows and certificates reject updates and replacements. Scene references prevent deletion of an in-use vector. A superseded revision can lose its old search chunks while its immutable aggregate survives until the last scene reference is released.

Each scene pays the full logical vector cost, plus its proof, certificate and a conservative reference allowance when these exceed the old vector-plus-128-byte accounting. Sharing physical storage does not discount per-scene quota. Existing limits remain: 128 MiB per scene, 256 MiB per account, 1 GiB per host, two scenes per account, sixteen per host, 50,000 members, 30 seconds building, and 30 minutes ready. Scan and hard deadlines remain two and four seconds.

Release removes parent, references, quota and now-unreferenced superseded vectors in one libSQL transaction. New reservations prune expired building/ready scenes and perform the same reference-aware collection. There is no new periodic cleanup daemon; expiration checks reject stale handles immediately, while physical pruning occurs at these explicit mutation points. Current published vectors and retained generation data are not discarded by scene GC.

Process tests inject `process.exit(86)` before/after actual libSQL commits and use separate processes for quota races. They demonstrate process-exit rollback/recovery, not power-loss or PostgreSQL-server crash recovery. Scale measurements remain service-layer synthetic measurements; they do not establish browser, device, OS-cache cold-start or full PRD performance acceptance.
