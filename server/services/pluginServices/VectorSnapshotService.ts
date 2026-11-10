import { randomInt, randomUUID } from "node:crypto";
import { hasUsableBody } from './BodyEligibility';
export { hasUsableBody } from './BodyEligibility';
import type {
  CreateVectorSnapshotInput,
  ReadVectorSnapshotInput,
  ReadVectorSnapshotResult,
  SampleVectorSnapshotInput,
  SampleVectorSnapshotResult,
  VectorQueryInput,
  VectorQueryItem,
  VectorQueryResult,
  VectorScope,
  VectorSnapshotDescriptor,
} from "../../../shared/lib/pluginServices/v1";
import { VECTOR_SNAPSHOT_LIMITS } from "../../../shared/lib/pluginServices/v1";
import { fingerprintNoteSnapshot, digest } from "./BodyInput";
import {
  NOTE_AGGREGATION,
  TOKEN_WEIGHT_VERSION,
  type TokenWeightWitness,
} from "./NoteAggregation";
import { VectorRepository, decodeStoredF32 } from "./VectorRepository";
import {
  VectorSnapshotStore,
  type SnapshotEnvelope,
  type SnapshotEntry,
  type SnapshotMember,
  type SnapshotReference,
} from "./VectorSnapshotStore";
import type { QualificationSource, QualifiedNote } from './NoteQualification';
import { REVISION_CERTIFICATE_VERSION } from './RevisionReferences';
import {
  createVectorSnapshotSchema,
  sampleVectorSnapshotSchema,
  readVectorSnapshotSchema,
  snapshotHandleSchema,
  vectorQueryInputSchema,
  VECTOR_QUERY_BUDGET as DEFAULT_BUDGET,
  type VectorQueryBudget,
} from "./vectorSchemas";
import {
  matchesSelection,
  primaryReason,
  type QueryNote,
  type QueryNoteSource,
} from "./VectorQueryService";
import type { AccountRateGate } from "./CallPolicy";
import type { PolicyStore, ResolvedPolicy } from "./PolicyStore";
import { ServiceError } from "./errors";

interface SnapshotDeps {
  withStore<T>(run: (store: VectorSnapshotStore) => Promise<T>): Promise<T>;
  notes: QueryNoteSource;
  qualifications?: QualificationSource;
  policyStore: PolicyStore;
  rateGate: AccountRateGate;
  /** Only classify ids already belonging to an authenticated snapshot; no foreign content. */
  classifyMissing(
    accountId: number,
    noteId: number,
  ): Promise<"missing" | "forbidden">;
  random?: (exclusive: number) => number;
  now?: () => number;
  /** Test/deployment seams may only tighten computation budgets. */
  budget?: Partial<VectorQueryBudget>;
}
function canonicalScope(scope: VectorScope = {}): VectorScope {
  return {
    types: [...new Set(scope.types ?? ([0, 1] as const))].sort(),
    includeArchived: scope.includeArchived ?? false,
    tagIds: [...new Set(scope.tagIds ?? [])].sort((a, b) => a - b),
    tagMatch: scope.tagMatch ?? "any",
    ...(scope.createdFrom
      ? { createdFrom: new Date(scope.createdFrom).toISOString() }
      : {}),
    ...(scope.createdBefore
      ? { createdBefore: new Date(scope.createdBefore).toISOString() }
      : {}),
  };
}
function summary(note: QueryNote): VectorQueryItem["note"] {
  return {
    id: note.id,
    type: note.type,
    createdAt: note.createdAt.toISOString(),
    updatedAt: (note.updatedAt ?? note.createdAt).toISOString(),
    excerpt: note.content.slice(0, 320),
  };
}
function cosine(a: number[], b: number[]): number {
  let sum = 0,
    an = 0,
    bn = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  if (!an || !bn) throw new ServiceError("SOURCE_NOT_INDEXED");
  return Math.max(-1, Math.min(1, sum / Math.sqrt(an * bn)));
}
/** Same host index/database, with bounded immutable note-vector snapshots.
 * It never resolves models, reads credentials, tokenizes, or calls a provider. */
export function createVectorSnapshotService(deps: SnapshotDeps) {
  const now = deps.now ?? Date.now;
  const stamp = (accountId: number) => (deps.qualifications ?? deps.notes).stamp(accountId);
  const BUDGET = Object.fromEntries(
    Object.entries(DEFAULT_BUDGET).map(([key, value]) => {
      const requested = deps.budget?.[key as keyof VectorQueryBudget];
      return [
        key,
        requested === undefined
          ? value
          : Math.max(1, Math.min(value, requested)),
      ];
    }),
  ) as VectorQueryBudget;
  async function invoke<T>(
    accountId: number,
    raw: unknown,
    run: (
      store: VectorSnapshotStore,
      check: () => void,
      policy: ResolvedPolicy,
    ) => Promise<T>,
    release = false,
    lane: 'shared' | 'readNote' = 'shared',
  ): Promise<T> {
    if (!Number.isSafeInteger(accountId) || accountId <= 0)
      throw new ServiceError("UNAUTHENTICATED");
    const controller = new AbortController();
    const check = () => {
      if (controller.signal.aborted)
        throw new ServiceError("TIMEOUT", { retryable: true });
    };
    let timer: ReturnType<typeof setTimeout>;
    const operation = async () => {
      const policy = await deps.policyStore.load();
      check();
      if (
        new TextEncoder().encode(JSON.stringify(raw)).byteLength >
        policy.limits.maxInputBytes
      )
        throw new ServiceError("INVALID_INPUT");
      if (!release) {
        for (const key of [
          "vector.snapshots",
          "vector.noteLevelAggregation",
          "vector.queryByNote",
          "vector.exact",
        ] as const)
          if (!deps.policyStore.capability(policy, key).available)
            throw new ServiceError("CAPABILITY_UNSUPPORTED");
        const gate = await deps.rateGate.acquire(
          accountId,
          policy.maxRequestsPerMinute,
          { readNoteRequestsPerMinute: policy.readNoteRequestsPerMinute, lane },
        );
        if (!gate.allowed)
          throw new ServiceError("RATE_LIMITED", {
            retryable: true,
            retryAfterMs: gate.retryAfterMs,
          });
      }
      check();
      if (!release) await deps.qualifications?.ensureReady(accountId);
      check();
      return deps.withStore((store) => run(store, check, policy));
    };
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ServiceError("TIMEOUT", { retryable: true }));
          }, BUDGET.hardTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  async function open(
    store: VectorSnapshotStore,
    accountId: number,
    handle: string,
  ): Promise<SnapshotEnvelope> {
    const env = await store.get(accountId, handle);
    const active = await new VectorRepository(
      store.client,
    ).readActiveGeneration();
    if (
      !active ||
      active.generation !== env.descriptor.index.generation ||
      active.embeddingSpaceId !== env.descriptor.index.embeddingSpaceId ||
      active.modelFingerprint !== env.descriptor.scoring.modelFingerprint ||
      active.preprocessingVersion !==
        env.descriptor.scoring.preprocessingVersion
    )
      throw new ServiceError("INDEX_CHANGED");
    return env;
  }
  async function checkedCurrent(
    accountId: number,
    env: SnapshotEnvelope,
    entries: SnapshotMember[],
  ): Promise<Map<number, QueryNote | QualifiedNote>> {
    const references = new Map(entries.map((e) => [e.noteId, e]));
    if (deps.qualifications) {
      const rows = await deps.qualifications.recheck(accountId, { scope: env.scope, excludeNoteIds: [] }, [...references.keys()]);
      return new Map(rows.filter(note => {
        const ref = references.get(note.id);
        return ref && (ref.instance === undefined || ref.instance === note.instance) && note.usableBody && ref.hash === note.snapshotHash &&
          matchesSelection(note, accountId, { scope: env.scope, excludeNoteIds: [] });
      }).map(note => [note.id, note]));
    }
    const notes = await deps.notes.recheck(
      accountId,
      { scope: env.scope, excludeNoteIds: [] },
      [...references.keys()],
    );
    return new Map(
      notes
        .filter((note) => {
          const ref = references.get(note.id);
          return (
            ref &&
            matchesSelection(note, accountId, {
              scope: env.scope,
              excludeNoteIds: [],
            }) &&
            fingerprintNoteSnapshot(
              note,
              env.descriptor.scoring.preprocessingVersion,
            ) === ref.hash
          );
        })
        .map((n) => [n.id, n]),
    );
  }
  async function bodyForHit(accountId: number, env: SnapshotEnvelope, ref: SnapshotMember, current: QueryNote | QualifiedNote): Promise<QueryNote | null> {
    const note = 'content' in current ? current : await deps.notes.readOwned(accountId, ref.noteId);
    return note && matchesSelection(note, accountId, { scope: env.scope, excludeNoteIds: [] }) &&
      fingerprintNoteSnapshot(note, env.descriptor.scoring.preprocessingVersion) === ref.hash ? note : null;
  }
  return {
    async create(
      accountId: number,
      raw: CreateVectorSnapshotInput,
    ): Promise<VectorSnapshotDescriptor> {
      const parsed = createVectorSnapshotSchema.safeParse(raw);
      if (!parsed.success) throw new ServiceError("INVALID_INPUT");
      return invoke(accountId, parsed.data, async (store, check) => {
        const repository = new VectorRepository(store.client);
        const active = await repository.readActiveGeneration();
        if (!active) throw new ServiceError("INDEX_NOT_READY");
        const status = await repository.readStatus(accountId);
        const before = await stamp(accountId);
        const scope = canonicalScope(parsed.data.scope);
        const handle = await store.reserve(accountId);
        let published = false;
        try {
          let after = 0,
            scanned = 0,
            eligible = 0,
            prepared = 0,
            payloadBytes = 4096,
            values = 0,
            ops = 0;
          let provenance: "verified" | "legacy-attested" = "verified";
          const started = now();
          for (;;) {
            check();
            if (now() - started > BUDGET.timeoutMs)
              throw new ServiceError("QUERY_BUDGET_EXCEEDED");
            const page = deps.qualifications ? { notes: await deps.qualifications.page(accountId, { scope, excludeNoteIds: [] }, after, BUDGET.pageSize), truncated: false } : await deps.notes.page(
              accountId,
              { scope, excludeNoteIds: [] },
              after,
              BUDGET.pageSize,
            );
            if (now() - started > BUDGET.timeoutMs)
              throw new ServiceError("QUERY_BUDGET_EXCEEDED");
            if (page.truncated) throw new ServiceError("QUERY_BUDGET_EXCEEDED");
            scanned += page.notes.length;
            if (scanned > BUDGET.maxNotes)
              throw new ServiceError("QUERY_BUDGET_EXCEEDED");
            const current = page.notes.filter(
              (n) =>
                matchesSelection(n, accountId, { scope, excludeNoteIds: [] }) &&
                ('content' in n ? hasUsableBody(n.content) : n.usableBody),
            );
            eligible += current.length;
            const entries: SnapshotEntry[] = [];
            const references: SnapshotReference[] = [];
            if (deps.qualifications && current.length) {
              const rows = await store.client.execute({ sql: `SELECT n.note_id,n.revision_id,n.snapshot_hash,c.note_instance,c.logical_bytes,r.provenance
                FROM blinko_ps_note_vectors n JOIN blinko_ps_vector_certificates c ON c.revision_id=n.revision_id
                JOIN blinko_ps_revisions r ON r.revision_id=n.revision_id JOIN blinko_ps_heads h ON h.account_id=r.account_id AND h.note_id=r.note_id
                WHERE n.account_id=? AND n.generation=? AND r.account_id=n.account_id AND r.note_id=n.note_id AND r.generation=n.generation
                AND r.snapshot_hash=n.snapshot_hash AND r.state='published' AND h.tombstone=0 AND c.certificate_version=?
                AND n.note_id IN (${current.map(() => '?').join(',')})`, args: [accountId, active.generation, REVISION_CERTIFICATE_VERSION, ...current.map(n => n.id)] });
              const byNote = new Map<number, typeof rows.rows>();
              for (const row of rows.rows) { const id = Number(row.note_id); const bucket = byNote.get(id) ?? []; bucket.push(row); byNote.set(id, bucket); }
              for (const note of current) {
                if (!('instance' in note)) throw new ServiceError('INDEX_NOT_READY');
                const candidates = byNote.get(note.id);
                if (candidates?.length !== 1) continue;
                const row = candidates[0];
                if (row.snapshot_hash !== note.snapshotHash || row.note_instance !== note.instance) continue;
                payloadBytes += Number(row.logical_bytes);
                if (!Number.isSafeInteger(payloadBytes) || payloadBytes > VECTOR_SNAPSHOT_LIMITS.maxSnapshotBytes) throw new ServiceError('QUERY_BUDGET_EXCEEDED');
                references.push({ noteId: note.id, revisionId: String(row.revision_id), hash: note.snapshotHash!, instance: note.instance });
                if (row.provenance === 'legacy-attested') provenance = 'legacy-attested';
              }
            } else if (current.length) {
              const marks = current.map(() => "?").join(",");
              const size = await store.client.execute({
                sql: `SELECT COALESCE(SUM(length(n.proof)),0) AS bytes FROM blinko_ps_note_vectors n JOIN blinko_ps_revisions r ON r.revision_id=n.revision_id WHERE n.account_id=? AND n.generation=? AND r.state='published' AND n.note_id IN (${marks})`,
                args: [
                  accountId,
                  active.generation,
                  ...current.map((n) => n.id),
                ],
              });
              if (Number(size.rows[0].bytes) > BUDGET.maxMetadataBytesPerPage)
                throw new ServiceError("QUERY_BUDGET_EXCEEDED");
              const rows = await store.client.execute({
                sql: `SELECT n.*,r.source_hash,r.chunk_count,r.provenance FROM blinko_ps_note_vectors n JOIN blinko_ps_revisions r ON r.revision_id=n.revision_id JOIN blinko_ps_heads h ON h.account_id=r.account_id AND h.note_id=r.note_id WHERE n.account_id=? AND n.generation=? AND r.state='published' AND h.tombstone=0 AND n.note_id IN (${marks})`,
                args: [
                  accountId,
                  active.generation,
                  ...current.map((n) => n.id),
                ],
              });
              // Group once per bounded page, retaining every matching revision.
              // Ambiguous published revisions remain unavailable.
              const byNote = new Map<number, typeof rows.rows>();
              for (const row of rows.rows) {
                const id = Number(row.note_id);
                const bucket = byNote.get(id) ?? [];
                bucket.push(row);
                byNote.set(id, bucket);
              }
              for (const note of current) {
                check();
                if (!('content' in note)) throw new ServiceError('INDEX_NOT_READY');
                const found = byNote.get(note.id);
                if (found?.length !== 1) continue;
                const row = found[0],
                  hash = fingerprintNoteSnapshot(
                    note,
                    active.preprocessingVersion,
                  );
                if (
                  row.snapshot_hash !== hash ||
                  !["verified", "legacy-attested"].includes(
                    String(row.provenance),
                  )
                )
                  continue;
                let witness: TokenWeightWitness;
                try {
                  witness = JSON.parse(String(row.proof));
                } catch {
                  continue;
                }
                if (
                  !witness ||
                  typeof witness !== "object" ||
                  witness.version !== TOKEN_WEIGHT_VERSION ||
                  witness.modelFingerprint !== active.modelFingerprint ||
                  witness.sourceHash !== row.source_hash ||
                  !Array.isArray(witness.counts) ||
                  witness.counts.length !== Number(row.chunk_count) ||
                  !witness.counts.every(
                    (n) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647,
                  )
                )
                  continue;
                values += active.dimensions;
                ops += active.dimensions;
                payloadBytes += active.dimensions * 4 + 128;
                if (
                  values > BUDGET.maxVectorValues ||
                  ops > BUDGET.maxDimensionOps ||
                  payloadBytes > VECTOR_SNAPSHOT_LIMITS.maxSnapshotBytes
                )
                  throw new ServiceError("QUERY_BUDGET_EXCEEDED");
                entries.push({
                  noteId: note.id,
                  hash,
                  vector: decodeStoredF32(row.embedding, active.dimensions),
                });
                if (row.provenance === "legacy-attested")
                  provenance = "legacy-attested";
              }
            }
            check();
            if (deps.qualifications) await store.addReferences(handle, accountId, references);
            else await store.add(handle, accountId, entries);
            prepared += deps.qualifications ? references.length : entries.length;
            if (page.notes.length < BUDGET.pageSize) break;
            after = page.notes[page.notes.length - 1].id;
          }
          if (now() - started > BUDGET.timeoutMs)
            throw new ServiceError("QUERY_BUDGET_EXCEEDED");
          if (eligible && !prepared) throw new ServiceError("INDEX_NOT_READY");
          const end = await repository.readStatus(accountId);
          if (
            end.generation !== active.generation ||
            end.embeddingSpaceId !== active.embeddingSpaceId ||
            end.corpusRevision !== status.corpusRevision ||
            (await stamp(accountId)) !== before
          )
            throw new ServiceError("INDEX_CHANGED");
          check();
          const descriptor: VectorSnapshotDescriptor = {
            handle,
            expiresAt: new Date(
              now() + VECTOR_SNAPSHOT_LIMITS.ttlMs,
            ).toISOString(),
            preparedNoteCount: prepared,
            range: {
              kind: "prepared-subset",
              eligibleNoteCount: eligible,
              unpreparedNoteCount: eligible - prepared,
            },
            index: {
              embeddingSpaceId: active.embeddingSpaceId,
              generation: active.generation,
              corpusRevision:
                status.corpusRevision ??
                digest([
                  "observed-empty-prepared-corpus",
                  active.generation,
                  before,
                ]),
              coverage: "partial",
              provenance,
            },
            scoring: {
              aggregation: NOTE_AGGREGATION,
              version: digest([
                NOTE_AGGREGATION,
                TOKEN_WEIGHT_VERSION,
                active.modelFingerprint,
                active.preprocessingVersion,
              ]),
              weightSource: TOKEN_WEIGHT_VERSION,
              preprocessingVersion: active.preprocessingVersion,
              modelFingerprint: active.modelFingerprint,
            },
          };
          await store.publish(accountId, {
            descriptor,
            scope,
            dimensions: active.dimensions,
          });
          check();
          if (deps.qualifications && (await stamp(accountId)) !== before) throw new ServiceError('INDEX_CHANGED');
          const lastActive = await repository.readActiveGeneration();
          if (lastActive?.generation !== active.generation) throw new ServiceError('INDEX_CHANGED');
          published = true;
          return descriptor;
        } finally {
          if (!published)
            await store.release(accountId, handle).catch(() => undefined);
        }
      });
    },
    async sample(
      accountId: number,
      raw: SampleVectorSnapshotInput,
    ): Promise<SampleVectorSnapshotResult> {
      const parsed = sampleVectorSnapshotSchema.safeParse(raw);
      if (!parsed.success) throw new ServiceError("INVALID_INPUT");
      const input = parsed.data;
      return invoke(accountId, parsed.data, async (store, check, policy) => {
        if ((input.excludeNoteIds?.length ?? 0) > policy.limits.maxExcludeIds)
          throw new ServiceError("INVALID_INPUT");
        const env = await open(store, accountId, input.handle);
        const before = await stamp(accountId);
        const exclude = new Set(input.excludeNoteIds ?? []);
        let poolSize = 0,
          selectable = 0,
          after = 0;
        let picked: { entry: SnapshotMember; current: QueryNote | QualifiedNote } | null = null;
        const started = now();
        for (;;) {
          check();
          if (now() - started > BUDGET.timeoutMs)
            throw new ServiceError("QUERY_BUDGET_EXCEEDED");
          const entries = await store.page(input.handle, after);
          const current = await checkedCurrent(accountId, env, entries);
          for (const entry of entries) {
            const note = current.get(entry.noteId);
            if (!note) continue;
            poolSize++;
            if (
              !exclude.has(note.id) &&
              (deps.random ?? randomInt)(++selectable) === 0
            )
              picked = { entry, current: note };
          }
          if (entries.length < BUDGET.pageSize) break;
          after = entries[entries.length - 1].noteId;
        }
        check();
        if (now() - started > BUDGET.timeoutMs)
          throw new ServiceError("QUERY_BUDGET_EXCEEDED");
        const body = picked ? await bodyForHit(accountId, env, picked.entry, picked.current) : null;
        if (picked && !body) throw new ServiceError('INDEX_CHANGED');
        if ((await stamp(accountId)) !== before)
          throw new ServiceError("INDEX_CHANGED");
        await open(store, accountId, input.handle);
        check();
        return { item: picked && body ? { note: summary(body), snapshot: { handle: input.handle, hash: picked.entry.hash } } : null, poolSize };
      });
    },
    async readNote(
      accountId: number,
      raw: ReadVectorSnapshotInput,
    ): Promise<ReadVectorSnapshotResult> {
      const parsed = readVectorSnapshotSchema.safeParse(raw);
      if (!parsed.success) throw new ServiceError("INVALID_INPUT");
      const input = parsed.data;
      return invoke(accountId, parsed.data, async (store, check) => {
        const env = await open(store, accountId, input.handle);
        const before = await stamp(accountId);
        const entry = await store.entry(input.handle, input.noteId);
        if (!entry) return { status: "missing" };
        if (entry.hash !== input.snapshotHash)
          throw new ServiceError("INVALID_INPUT");
        const note = await deps.notes.readOwned(accountId, input.noteId);
        check();
        if (!note)
          return {
            status: await deps.classifyMissing(accountId, input.noteId),
          };
        if (
          !matchesSelection(note, accountId, {
            scope: env.scope,
            excludeNoteIds: [],
          })
        )
          return { status: "forbidden" };
        if (entry.instance && (await deps.qualifications?.identity(input.noteId))?.instance !== entry.instance) return { status: 'missing' };
        const hash = fingerprintNoteSnapshot(
          note,
          env.descriptor.scoring.preprocessingVersion,
        );
        await open(store, accountId, input.handle);
        if ((await stamp(accountId)) !== before) throw new ServiceError('INDEX_CHANGED');
        check();
        if (hash !== entry.hash)
          return {
            status: "changed",
            content: note.content,
            snapshotHash: hash,
          };
        return {
          status: "ok",
          id: note.id,
          accountId,
          type: note.type,
          createdAt: note.createdAt.toISOString(),
          updatedAt: (note.updatedAt ?? note.createdAt).toISOString(),
          content: note.content,
          snapshotHash: hash,
        };
      }, false, 'readNote');
    },
    async release(accountId: number, raw: { handle: string }): Promise<void> {
      const parsed = snapshotHandleSchema.safeParse(raw);
      if (!parsed.success) throw new ServiceError("INVALID_INPUT");
      return invoke(
        accountId,
        parsed.data,
        (store) => store.release(accountId, parsed.data.handle),
        true,
      );
    },
    async query(
      accountId: number,
      raw: VectorQueryInput,
    ): Promise<VectorQueryResult> {
      const parsed = vectorQueryInputSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.source.kind !== "note" ||
        parsed.data.aggregation !== NOTE_AGGREGATION ||
        !parsed.data.snapshotHandle
      )
        throw new ServiceError("INVALID_INPUT");
      const input = parsed.data,
        handle = input.snapshotHandle!,
        sourceId = parsed.data.source.noteId;
      if (input.mode === "approximate")
        throw new ServiceError("CAPABILITY_UNSUPPORTED");
      const limit = input.limit ?? 10;
      return invoke(accountId, parsed.data, async (store, check, policy) => {
        if (
          limit > policy.limits.maxResults ||
          (input.excludeNoteIds?.length ?? 0) > policy.limits.maxExcludeIds
        )
          throw new ServiceError("INVALID_INPUT");
        const env = await open(store, accountId, handle);
        if (
          input.scope &&
          digest(canonicalScope(input.scope)) !== digest(env.scope)
        )
          throw new ServiceError("INVALID_INPUT");
        if (
          input.expectedIndex &&
          (input.expectedIndex.generation !== env.descriptor.index.generation ||
            input.expectedIndex.embeddingSpaceId !==
              env.descriptor.index.embeddingSpaceId)
        )
          throw new ServiceError("INDEX_CHANGED");
        const before = await stamp(accountId);
        const source = deps.qualifications ? (await deps.qualifications.recheck(accountId, { scope: env.scope, excludeNoteIds: [] }, [sourceId]))[0] : await deps.notes.readOwned(accountId, sourceId);
        const sourceReference = await store.entry(handle, sourceId);
        if (
          !source || !sourceReference ||
          (sourceReference.instance && (!('instance' in source) || source.instance !== sourceReference.instance)) ||
          !matchesSelection(source, accountId, {
            scope: env.scope,
            excludeNoteIds: [],
          })
        )
          throw new ServiceError("NOT_FOUND_OR_FORBIDDEN");
        const sourceVector = (
          await store.vectors(handle, [sourceId], env.dimensions)
        ).get(sourceId);
        if (!sourceVector) throw new ServiceError("NOT_FOUND_OR_FORBIDDEN");
        const exclude = new Set([sourceId, ...(input.excludeNoteIds ?? [])]);
        const scored: Array<{ id: number; hash: string; instance?: string; score: number }> = [];
        let after = 0,
          values = env.dimensions,
          ops = 0,
          finished = false;
        let reason: VectorQueryResult["retrieval"]["reason"];
        const started = now();
        for (;;) {
          check();
          if (now() - started > BUDGET.timeoutMs) {
            reason = primaryReason(reason, "timeout");
            break;
          }
          const page = await store.page(handle, after);
          const entries = page.filter((e) => !exclude.has(e.noteId));
          const current = await checkedCurrent(accountId, env, entries);
          if (current.size < entries.length)
            reason = primaryReason(reason, "stale-candidates");
          const accepted = entries.filter((e) => current.has(e.noteId));
          if (
            values + accepted.length * env.dimensions >
              BUDGET.maxVectorValues ||
            ops + accepted.length * env.dimensions > BUDGET.maxDimensionOps
          ) {
            reason = primaryReason(reason, "budget");
            break;
          }
          const vectors = await store.vectors(
            handle,
            accepted.map((e) => e.noteId),
            env.dimensions,
          );
          for (const entry of accepted) {
            check();
            const vector = vectors.get(entry.noteId);
            if (!vector) {
              reason = primaryReason(reason, "stale-candidates");
              continue;
            }
            values += env.dimensions;
            ops += env.dimensions;
            const score = cosine(sourceVector, vector);
            if (input.minScore === undefined || score >= input.minScore)
              scored.push({ id: entry.noteId, hash: entry.hash, instance: entry.instance, score });
          }
          if (page.length < BUDGET.pageSize) {
            finished = true;
            break;
          }
          after = page[page.length - 1].noteId;
        }
        scored.sort((a, b) => b.score - a.score || a.id - b.id);
        const items: VectorQueryItem[] = [];
        let hasMore = false;
        for (let i = 0; i < scored.length; i += BUDGET.pageSize) {
          check();
          const batch = scored.slice(i, i + BUDGET.pageSize);
          const current = await checkedCurrent(
            accountId,
            env,
            batch.map((hit) => ({ noteId: hit.id, hash: hit.hash, instance: hit.instance })),
          );
          for (const hit of batch) {
            const note = current.get(hit.id);
            if (!note) {
              reason = primaryReason(reason, "stale-candidates");
              continue;
            }
            if (items.length === limit) {
              hasMore = true;
              break;
            }
            const body = await bodyForHit(accountId, env, { noteId: hit.id, hash: hit.hash, instance: hit.instance }, note);
            if (!body) { reason = primaryReason(reason, 'stale-candidates'); continue; }
            items.push({
              note: summary(body),
              score: hit.score,
              matches: [],
              snapshot: { handle, hash: hit.hash },
            });
          }
          if (hasMore) break;
        }
        const lastSource = deps.qualifications ? (await deps.qualifications.recheck(accountId, { scope: env.scope, excludeNoteIds: [] }, [sourceId]))[0] : await deps.notes.readOwned(accountId, sourceId);
        if (
          !lastSource ||
          (sourceReference.instance && (!('instance' in lastSource) || lastSource.instance !== sourceReference.instance)) ||
          !matchesSelection(lastSource, accountId, {
            scope: env.scope,
            excludeNoteIds: [],
          })
        )
          throw new ServiceError("NOT_FOUND_OR_FORBIDDEN");
        await open(store, accountId, handle);
        if ((await stamp(accountId)) !== before)
          throw new ServiceError("INDEX_CHANGED");
        if (now() - started > BUDGET.timeoutMs)
          reason = primaryReason(reason, "timeout");
        check();
        return {
          requestId: randomUUID(),
          items,
          scoring: {
            metric: "cosine",
            aggregation: NOTE_AGGREGATION,
            version: env.descriptor.scoring.version,
            higherIsBetter: true,
          },
          index: { ...env.descriptor.index },
          retrieval: {
            algorithm: "exact",
            truncated: !finished || Boolean(reason),
            remaining: !finished || reason ? "unknown" : hasMore ? "yes" : "no",
            ...(reason ? { reason } : {}),
          },
        };
      });
    },
  };
}
