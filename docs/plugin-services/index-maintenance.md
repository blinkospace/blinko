# Plugin services index maintenance

Body indexing uses the host's existing `.blinko/vector/embeddings.db`. PostgreSQL remains authoritative for note ownership, deletion and current content. The index metadata and versioned vector tables live in that same LibSQL file; this is not a second plugin database.

## Data model and source verification

A generation identifies an embedding space, dimensions, model/endpoint/configuration fingerprint and preprocessing version. Its physical table has a fixed `F32_BLOB(dimension)` column. A dimension or model change creates a new physical table. An explicit active pointer selects a generation; older tables remain available for rollback.

A body revision records account, note, complete chunk count, source-input hash, current SQL snapshot hash, generation and provenance. Every vector records a unique revision and ordinal. Readers require the complete revision, correct account, current content/timestamps, a non-deleted note and finite, nonzero vectors. Attachments are excluded from these body revisions.

The sole encoding function is `prepareBodyInput`. Its preprocessing version pins the Markdown chunker and timestamp concatenation. Historical input containing the literal `undefined` is different from an input containing an actual update timestamp. A current content hash is not proof of how an old vector was encoded.

Publication follows `writing → staged → published`. Complete chunks are inserted in one transaction, then the revision is published under the note's persisted epoch. A new writer or deletion advances that epoch. A late worker cleans only its own revision or specifically captured old revision IDs. It cannot erase a newer worker's chunks. Current PostgreSQL content is checked before and after publication, and checked again on reads. PostgreSQL and LibSQL do not form a distributed transaction; these validations and read-time exclusion are required.

SQL deletion happens before vector cleanup. The durable tombstone fences already-running encoders. Readers exclude the SQL-deleted note even when cleanup fails. Repeating cleanup is safe. Background body indexing updates the legacy `metadata.isIndexed` flag with a narrow SQL compare-and-set; it never rewrites `notes.updatedAt` or replaces concurrent metadata.

## Operator commands

Use the application's configured database environment and the **server working directory**. These are explicit local host-operator actions. Pause indexing workers and back up the PostgreSQL database plus the entire LibSQL file before migration, preparation or rollback. Run one maintenance process at a time. The commands in this first block send no embedding or generation request; the separately confirmed `prepare-weighted` execution below can call the configured embedding provider.

```sh
bun scripts/plugin-services-index.ts status --account 1
bun scripts/plugin-services-index.ts migrate
bun scripts/plugin-services-index.ts initialize-qualification
bun scripts/plugin-services-index.ts maintain-qualification
bun scripts/plugin-services-index.ts certify-existing --account 1 --notes '[42,43]'
bun scripts/plugin-services-index.ts recover
bun scripts/plugin-services-index.ts activate --generation <retained-generation-id>
bun scripts/plugin-services-index.ts rollback-metadata
```

`status` is read-only and does not create a missing database. Ordinary queries never migrate metadata, initialize a model or rebuild an index. `migrate` creates metadata transactionally and inventories only historical ownership that can be resolved through current SQL notes. Inventory does **not** assign verified provenance. `recover` publishes complete stages that still match the current note and epoch, and discards expired incomplete writers. Changed or deleted stages are discarded without calling an embedding provider. `activate` switches to a retained generation; it does not mix dimensions or erase another table. `rollback-metadata` removes only the new metadata tables and retains every vector table. Restore the matching application/configuration version when rolling back the application.

A full host body rebuild creates a fresh generation and retains the previous one. Coverage is partial while the rebuild proceeds. An interrupted rebuild can be resumed, or the previous generation can be explicitly selected. No `ready` coverage claim is inferred from a table merely existing.

## Qualification and immutable reference preparation

Apply the application PostgreSQL migrations and generate the matching Prisma client before building or running the updated server. The local `migrate` command explicitly upgrades index metadata from version 1 to 2, retaining old copied snapshot rows. New reference snapshots additionally require a trusted qualification registry and immutable revision certificates; see [qualification and consistency](../development/plugin-note-qualification.md).

`initialize-qualification` registers and certifies every current note, including empty/unusable/unowned and unprepared rows. Each invocation is bounded to 50,000 captures and 30 seconds; exit 2 means incomplete. Repeat to resume incomplete initialization. A completed initialization invoked again starts a new instance epoch and can invalidate existing reference scenes. Requests do not run this initialization. Loss of schema trust or TRUNCATE requires explicit reinitialization.

`maintain-qualification` repairs ordinary dirty rows without rotating note instances. Requests repair at most four dirty rows per account; larger unknown sets return `INDEX_NOT_READY` until explicit maintenance finishes. No periodic maintenance worker is added.

`certify-existing` takes at most 128 explicit owned IDs and derives a new immutable revision only when existing model/preprocessing/input and per-input token-weight evidence validates. It makes no provider call and does not infer missing historical evidence. Notes lacking that evidence remain unprepared; separately authorized weighted preparation below is an explicit alternative.

Normal reference creation captures certificate and qualification metadata, not full body/proof/vector payloads. Each scene still pays its full logical quota. Deletion, visibility loss and current scope checks override frozen vectors; a new revision cannot silently alter an existing scene. Release collects superseded aggregates only after their final reference disappears and does not delete current published vectors.

## Explicit weighted preparation

This local operator command prepares selected body notes for `note_level_weighted_v1` using the existing host index, configured embedding model and `IndexLifecycle` writer. It is not a public rebuild API or a plugin-triggered backfill. The operator must authorize any provider cost separately from ordinary plugin usage policies; its request/character bounds are not a monetary cap or the plugin paid-call ledger.

First preview an explicit account and list of note IDs. This reads current notes, splits the actual versioned inputs and resolves model metadata. It creates no missing index, migrates no tables, initializes no provider and sends no provider request:

```sh
bun scripts/plugin-services-index.ts prepare-weighted \
  --account 1 --notes '[42,43]' \
  --max-requests 20 --max-input-chars 100000
```

The JSON output contains `preview: true`, `providerCalls: 0` and `plan`. Review `plan.planId`, account, note IDs, prepared flags, model ID/fingerprints, active generation, number of individual requests and encoded input characters. It includes no note text, credential or provider URL. Characters are UTF-16 code units of the actual encoded strings, including timestamps, not tokens or a price estimate. An existing matching weighted revision is skipped; unverified historical chunks and ordinary batch vectors do not count as prepared.

To execute the reviewed plan, repeat exactly the same arguments and supply all three execution flags. Replace the placeholder with the preview's `plan.planId`; choose a new journal in an existing private local directory:

```sh
bun scripts/plugin-services-index.ts prepare-weighted \
  --account 1 --notes '[42,43]' \
  --max-requests 20 --max-input-chars 100000 \
  --confirm-plan <reviewed-plan-id> --allow-provider-calls \
  --journal ./weighted-prepare-run-001.ndjson
```

The confirmation binds the source database identity, absolute index path, account, selected note snapshots, actual encoded-input hashes, model/dimensions/preprocessing, active generation and budgets. Changing one requires a new preview. No existing active generation is silently replaced by an incompatible model; resolve that maintenance decision separately. A previously missing index can create and activate a compatible generation after the first successful publication. The ordinary current body revision and note-vector cache are replaced for each successful note in the existing database; these updates have the same snapshot/corpus invalidation behavior as other host index writes. This is not an atomic all-notes transaction. Back up before execution if rollback of those revisions is required; the journal does not contain old vectors.

Limits are enforced before any dispatch: at most 500 explicitly selected unique notes, 10,000 requests, 10,000,000 encoded input characters and 100,000,000 chunk-dimension operations per plan. Each note is limited to 2,000,000 source characters and the writer's existing chunk limits. Supplied request/character budgets may tighten these bounds; they cannot raise them. Larger preparations require deliberate batches and new previews. The tool does not enumerate or implicitly prepare the whole library.

Every input is sent separately with SDK retries disabled and a 30-second abort signal. Before each dispatch, the tool rechecks ownership, recycling, note snapshot, model and active generation, and durably writes a `dispatch-reserved` event. A failed, timed-out or unverifiable request consumes its reservation. Missing/invalid per-input usage or vector evidence stops immediately; no counts are guessed. A provider may continue processing after client cancellation, so timeout is not proof of zero provider cost. A complete result reports published/skipped IDs and consumed requests/characters; it does not certify full-library coverage. Verify availability through capabilities and a prepared snapshot, retaining its prepared-subset/partial semantics.

The journal is exclusively created with mode 0600 and flushed before each provider dispatch. Existing files are refused, including an incomplete run; the tool never automatically resumes or replays that journal. Preview/success exit 0, rejected input or confirmation/journal creation exits 1, and an execution that stops after starting exits 2 with a sanitized JSON result. Provider errors and encoded text are excluded from the journal and printed error. Keep the journal private because it contains account/note identifiers and hashes.

After interruption or failure:

1. Preserve the journal. A `dispatch-reserved` without `dispatch-returned` has an unknown provider outcome; inspect the provider/operator records before authorizing another attempt. A return event alone does not prove the note was published.
2. Use `recover` to finish complete matching stages or expire incomplete writers; it sends no provider request. Existing successful publications remain valid. Unpublished work is never counted as prepared.
3. Preview again. It skips currently valid published notes and shows the exact remaining requests. After explicitly resolving any unknown provider outcome/cost, confirm this new plan with a new journal to retry the remaining work. There is no automatic retry, refund or chunk-level paid-response cache.
4. If source/model/generation changed, review the new plan rather than reusing the previous confirmation. Resume indexing workers only after maintenance and verification finish. Ordinary future batch indexing can replace weighted evidence for an edited note; that note then requires another explicit preparation to rejoin the prepared subset.

## Historical attestation

Unknown historical vectors remain unverified and do not participate in new plugin queries. Prefer reindexing when model identity, input strings or chunk completeness cannot be established. Reindexing is a separate host maintenance action and may incur provider cost; it is not an automatic effect of a plugin query.

For an already-created matching generation, an operator may attest a historical note only with explicit model confirmation, a recorded evidence reference and the ordered IDs of **all** original body chunks:

```sh
bun scripts/plugin-services-index.ts attest-legacy \
  --account 1 --note 42 --generation <matching-generation-id> \
  --administrator 1 --confirm-model \
  --vector-ids '["legacy-vector-id"]' \
  --evidence 'operator evidence reference identifying model, configuration and original input'
```

The tool checks current ownership, exact original chunk text/timestamps, full chunk count and vector dimensions. It stores an audit record and publishes `legacy-attested`, never `verified`. A confirmation flag alone cannot bypass missing or mismatched input evidence. The administrator ID is an audit attribution supplied by the already-trusted local operator, not a separate login credential.

## Test boundaries

`test:plugin-services` starts each suite in its own Bun process and requires real dedicated PostgreSQL databases. Missing database configuration is a failure, not a skipped test. CI provisions PostgreSQL 17 with two databases on the same loopback fixture server:

- `DATABASE_URL` uses the standard `blinko_test` fixture account and `blinko_plugin_services_test` database for legacy suites.
- `PLUGIN_SERVICES_REFERENCE_DATABASE_URL` uses the ordinary `candidate_owner` role and `candidate_owned` database for `db-note-qualification`, `db-reference-process` and `db-reference-snapshots`. Only those child processes receive the reference URL and its explicit guard. The one-connection ledger suite keeps its standard database and process-local pool limits.

Set `PLUGIN_SERVICES_TEST_DB=1` and both URLs explicitly. In a fresh disposable fixture, run `bun server/scripts/setup-plugin-services-test-db.ts` from the repository root to create the ordinary reference role/database. This setup requires the standard fixture administrator to create them; the reference role has no superuser, database/role creation or replication privilege. It refuses to change/reuse an existing role/database and accepts only the fixed local synthetic names. Apply `prisma migrate deploy` to both URLs before running the suites. Existing explicitly guarded ordinary-owner harnesses may still supply their reference URL as `DATABASE_URL`; this does not let an unguarded standard database substitute for the reference fixture.

Local fixtures can use another project-local PostgreSQL 17 installation. LibSQL tests use real fixed-dimension tables and synthetic vectors. Provider tests use synthetic transports or model implementations; they do not certify a paid cloud provider or a user's deployment. CI also runs the dedicated service typecheck and fixed-editor-asset regression; full-project TypeScript correctness remains a separate scope.
