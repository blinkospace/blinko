import { randomUUID } from "node:crypto";
import type {
  CapabilityState,
  NoteType,
  VectorMatch,
  VectorQueryInput,
  VectorQueryItem,
  VectorQueryResult,
  VectorScope,
} from "../../../shared/lib/pluginServices/v1";
import { digest, fingerprintNoteSnapshot } from "./BodyInput";
import { ServiceError } from "./errors";
import { PaidCallError, type AccountRateGate, type CallPolicy } from "./CallPolicy";
import type { PolicyStore } from "./PolicyStore";
import type { ResolvedEmbedding } from "./ModelResolver";
import type { NoteSnapshot } from "./types";
import type { VectorRepository } from "./VectorRepository";
import { validateVector } from "./VectorRepository";
import { VECTOR_QUERY_BUDGET, vectorQueryInputSchema } from "./vectorSchemas";

export interface QueryNote extends NoteSnapshot {
  type: NoteType;
  isArchived: boolean;
  tagIds: number[];
}
export interface QuerySelection {
  scope: VectorScope;
  excludeNoteIds: number[];
}
export interface QueryNoteSource {
  readOwned(accountId: number, noteId: number): Promise<QueryNote | null>;
  page(
    accountId: number,
    selection: QuerySelection,
    afterId: number,
    take: number,
  ): Promise<{ notes: QueryNote[]; truncated: boolean }>;
  recheck(accountId: number, selection: QuerySelection, ids: number[]): Promise<QueryNote[]>;
  /** Version fence includes content, visibility and tags, not vector metadata. */
  stamp(accountId: number): Promise<string>;
}
export interface VectorQueryDeps {
  notes: QueryNoteSource;
  policyStore: PolicyStore;
  rateGate: AccountRateGate;
  callPolicy: CallPolicy;
  resolveEmbedding(): Promise<ResolvedEmbedding>;
  withReader<T>(run: (repository: VectorRepository | null) => Promise<T>): Promise<T>;
  budget?: Partial<Record<keyof typeof VECTOR_QUERY_BUDGET, number>>;
  now?: () => number;
}
const excerpt = (s: string) => s.slice(0, 320);
export function matchesSelection(
  note: Omit<QueryNote, 'content'>,
  accountId: number,
  selection: QuerySelection,
): boolean {
  const s = selection.scope;
  return (
    note.accountId === accountId &&
    !note.isRecycle &&
    !selection.excludeNoteIds.includes(note.id) &&
    (s.includeArchived || !note.isArchived) &&
    (s.types ?? [0, 1]).includes(note.type) &&
    (!s.createdFrom || note.createdAt.getTime() >= Date.parse(s.createdFrom)) &&
    (!s.createdBefore || note.createdAt.getTime() < Date.parse(s.createdBefore)) &&
    (!s.tagIds?.length ||
      (s.tagMatch === "all"
        ? s.tagIds.every((id) => note.tagIds.includes(id))
        : s.tagIds.some((id) => note.tagIds.includes(id))))
  );
}
function requireCapability(state: CapabilityState): void {
  if (!state.available) throw new ServiceError("CAPABILITY_UNSUPPORTED");
}
type TruncationReason = NonNullable<VectorQueryResult["retrieval"]["reason"]>;
const reasonPriority: Record<TruncationReason, number> = {
  "recall-limit": 0,
  "stale-candidates": 1,
  budget: 2,
  "index-changed": 3,
  timeout: 4,
};
export function primaryReason(
  current: TruncationReason | undefined,
  next: TruncationReason,
): TruncationReason {
  return current && reasonPriority[current] >= reasonPriority[next] ? current : next;
}
function norm(v: number[]): number {
  let n = 0;
  for (const x of v) n += x * x;
  return Math.sqrt(n);
}
function cosine(a: number[], b: number[], an: number, bn: number): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return Math.max(-1, Math.min(1, sum / (an * bn)));
}
export function createVectorQueryService(deps: VectorQueryDeps) {
  const budget = { ...VECTOR_QUERY_BUDGET, ...deps.budget };
  const now = deps.now ?? (() => performance.now());
  const execute = async (
    accountId: number,
    raw: VectorQueryInput,
    signal: AbortSignal,
  ): Promise<VectorQueryResult> => {
    const checkDeadline = () => {
      if (signal.aborted) throw new ServiceError("TIMEOUT", { retryable: true });
    };
    const parsed = vectorQueryInputSchema.safeParse(raw);
    if (!parsed.success) throw new ServiceError("INVALID_INPUT");
    const input = parsed.data;
    if (input.aggregation === 'note_level_weighted_v1' || input.snapshotHandle) throw new ServiceError('CAPABILITY_UNSUPPORTED');
    const policy = await deps.policyStore.load();
    checkDeadline();
    const feature = input.source.kind === "note" ? "vector.queryByNote" : "vector.queryByText";
    requireCapability(deps.policyStore.capability(policy, feature));
    requireCapability(deps.policyStore.capability(policy, "vector.exact"));
    if (input.mode === "approximate") throw new ServiceError("CAPABILITY_UNSUPPORTED");
    const limit = input.limit ?? 10;
    if (
      limit > policy.limits.maxResults ||
      (input.excludeNoteIds?.length ?? 0) > policy.limits.maxExcludeIds ||
      new TextEncoder().encode(JSON.stringify(input)).length > policy.limits.maxInputBytes
    )
      throw new ServiceError("INVALID_INPUT");
    const selection: QuerySelection = {
      scope: input.scope ?? {},
      excludeNoteIds: [
        ...new Set([
          ...(input.excludeNoteIds ?? []),
          ...(input.source.kind === "note" ? [input.source.noteId] : []),
        ]),
      ].sort((a, b) => a - b),
    };
    return deps.withReader(async (repository) => {
      if (!repository) throw new ServiceError("INDEX_NOT_READY");
      const status = await repository.readStatus(accountId);
      checkDeadline();
      const active = await repository.readActiveGeneration();
      if (!active || !status.available || !status.corpusRevision || status.provenance === "none")
        throw new ServiceError("INDEX_NOT_READY");
      if (
        status.generation !== active.generation ||
        status.embeddingSpaceId !== active.embeddingSpaceId
      )
        throw new ServiceError("INDEX_CHANGED");
      if (
        input.expectedIndex &&
        (input.expectedIndex.generation !== active.generation ||
          input.expectedIndex.embeddingSpaceId !== active.embeddingSpaceId)
      )
        throw new ServiceError("INDEX_CHANGED");
      let requestId: string = randomUUID();
      let sourceNote: QueryNote | null = null;
      let sourceHash: string | undefined;
      let sources: Array<{ ordinal?: number; vector: number[] }>;
      let started = now();
      if (input.source.kind === "note") {
        sourceNote = await deps.notes.readOwned(accountId, input.source.noteId);
        if (!sourceNote || sourceNote.accountId !== accountId || sourceNote.isRecycle)
          throw new ServiceError("NOT_FOUND_OR_FORBIDDEN");
        checkDeadline();
        const rate = await deps.rateGate.acquire(accountId, policy.maxRequestsPerMinute, { readNoteRequestsPerMinute: policy.readNoteRequestsPerMinute, lane: 'shared' });
        if (!rate.allowed)
          throw new ServiceError("RATE_LIMITED", {
            retryable: true,
            retryAfterMs: rate.retryAfterMs,
          });
        const source = await repository.readBodyRevision({
          note: sourceNote,
          ...active,
          maxChunks: budget.maxSourceChunks,
          maxVectorValues: budget.maxVectorValues,
          maxMetadataBytes: budget.maxMetadataBytesPerPage,
        });
        if (!source) throw new ServiceError("SOURCE_NOT_INDEXED");
        sourceHash = source.noteSnapshotHash;
        sources = source.chunks;
      } else {
        // Metadata-only resolution. Provider/key construction stays inside the paid gate.
        const embedding = await deps.resolveEmbedding();
        if (embedding.space.embeddingSpaceId !== active.embeddingSpaceId)
          throw new ServiceError("EMBEDDING_SPACE_MISMATCH");
        if (!deps.policyStore.isModelAllowed(policy, embedding.modelId))
          throw new ServiceError("MODEL_UNAVAILABLE");
        const text = input.source.text;
        const embedded = await deps.callPolicy.runPaidOperation(
          {
            accountId,
            operation: "vector.queryByText",
            modelId: embedding.modelId,
            idempotencyKey: input.idempotencyKey!,
            requestFingerprint: digest([input, active.embeddingSpaceId, active.generation]),
            reservedTokens: new TextEncoder().encode(text).length + 8,
            maxOutputTokens: 0,
            timeoutMs: 30_000,
            dailyTokenLimit: policy.dailyTokenBudget,
            maxConcurrent: policy.limits.maxConcurrentGeneration,
            maxRequestsPerMinute: policy.maxRequestsPerMinute,
            readNoteRequestsPerMinute: policy.readNoteRequestsPerMinute,
          },
          async (context) => {
            const revalidate = async () => {
              if (signal.aborted)
                throw new PaidCallError("TIMEOUT", { requestId: context.requestId });
              const current = await deps.policyStore.load();
              if (!deps.policyStore.capability(current, "vector.queryByText").available)
                throw new PaidCallError("CAPABILITY_UNSUPPORTED", { requestId: context.requestId });
              if (!deps.policyStore.isModelAllowed(current, embedding.modelId))
                throw new PaidCallError("MODEL_UNAVAILABLE", { requestId: context.requestId });
              const generation = await repository.readActiveGeneration();
              if (generation?.generation !== active.generation)
                throw new PaidCallError("INDEX_CHANGED", { requestId: context.requestId });
            };
            await revalidate();
            let result: Awaited<ReturnType<ResolvedEmbedding["embedQueryText"]>>;
            try {
              result = await embedding.embedQueryText(text, context.signal, async () => {
                await revalidate();
                await context.markDispatched();
              });
            } catch (error) {
              if (error instanceof ServiceError)
                throw new PaidCallError(error.code, {
                  requestId: context.requestId,
                  retryable: error.retryable,
                });
              throw error;
            }
            return {
              result: { ...result, requestId: context.requestId },
              usage: {
                inputTokens: result.tokens,
                outputTokens: 0,
                status: result.tokens === null ? "unknown" : "reported",
              },
            };
          },
        );
        requestId = embedded.requestId;
        validateVector(embedded.vector, active.dimensions);
        sources = [{ vector: embedded.vector }];
        started = now(); // Local scan deadline; embedding has its own enforced paid timeout.
      }
      checkDeadline();
      const sourceNorms = sources.map((s) => norm(s.vector));
      let reason: VectorQueryResult["retrieval"]["reason"];
      let missing = 0,
        targetChunks = 0,
        visited = 0,
        vectorValues = sources.length * active.dimensions;
      const before = await deps.notes.stamp(accountId);
      type Scored = { id: number; hash: string; score: number; match: VectorMatch };
      const scored: Scored[] = [];
      let cursor = 0,
        finished = false;
      while (!finished) {
        checkDeadline();
        if (now() - started >= budget.timeoutMs) {
          reason = primaryReason(reason, "timeout");
          break;
        }
        if (visited >= budget.maxNotes) {
          reason = primaryReason(reason, "budget");
          break;
        }
        const page = await deps.notes.page(
          accountId,
          selection,
          cursor,
          Math.min(budget.pageSize, budget.maxNotes - visited),
        );
        const notes = page.notes.filter((n) => matchesSelection(n, accountId, selection));
        if (page.truncated) reason = primaryReason(reason, "budget");
        if (!page.notes.length) {
          finished = !page.truncated;
          break;
        }
        visited += page.notes.length;
        cursor = page.notes[page.notes.length - 1].id;
        const remainingChunks = Math.min(
          budget.maxTargetChunks - targetChunks,
          Math.floor(budget.maxDimensionOps / (sources.length * active.dimensions)) - targetChunks,
          10000,
        );
        checkDeadline();
        const scan = await repository.readQueryPage({
          notes,
          ...active,
          maxChunks: Math.max(0, remainingChunks),
          maxVectorValues: Math.max(0, budget.maxVectorValues - vectorValues),
          maxMetadataBytes: budget.maxMetadataBytesPerPage,
        });
        missing += scan.missing + scan.stale;
        if (scan.stale) reason = primaryReason(reason, "stale-candidates");
        if (scan.truncated) reason = primaryReason(reason, "budget");
        targetChunks += scan.chunks;
        vectorValues += scan.chunks * active.dimensions;
        for (const revision of scan.revisions) {
          if (now() - started >= budget.timeoutMs) {
            reason = primaryReason(reason, "timeout");
            break;
          }
          let best = -Infinity;
          let match: VectorMatch | undefined;
          for (const target of revision.chunks) {
            const tn = norm(target.vector);
            for (let i = 0; i < sources.length; i++) {
              const score = cosine(sources[i].vector, target.vector, sourceNorms[i], tn);
              if (score > best) {
                best = score;
                match = {
                  ...(sources[i].ordinal === undefined
                    ? {}
                    : { sourceChunkOrdinal: sources[i].ordinal }),
                  targetChunkOrdinal: target.ordinal,
                  excerpt: excerpt(target.text),
                };
              }
            }
          }
          if (match && (input.minScore === undefined || best >= input.minScore))
            scored.push({
              id: revision.noteId,
              hash: revision.noteSnapshotHash,
              score: best,
              match,
            });
        }
        if (reason === "budget" || reason === "timeout") break;
        // A short page proves exhaustion at this snapshot; a full page needs one more read.
        if (
          page.notes.length <
          Math.min(budget.pageSize, budget.maxNotes - visited + page.notes.length)
        )
          finished = true;
      }
      scored.sort((a, b) => b.score - a.score || a.id - b.id);
      const items: VectorQueryItem[] = [];
      let hasMore = false;
      // Filter all higher-ranked stale/inaccessible candidates before applying limit.
      for (let offset = 0; offset < scored.length; offset += budget.pageSize) {
        checkDeadline();
        const batch = scored.slice(offset, offset + budget.pageSize);
        const current = new Map(
          (
            await deps.notes.recheck(
              accountId,
              selection,
              batch.map((r) => r.id),
            )
          ).map((n) => [n.id, n]),
        );
        for (const hit of batch) {
          const note = current.get(hit.id);
          if (
            !note ||
            !matchesSelection(note, accountId, selection) ||
            fingerprintNoteSnapshot(note, active.preprocessingVersion) !== hit.hash
          ) {
            reason = primaryReason(reason, "stale-candidates");
            continue;
          }
          if (items.length === limit) {
            hasMore = true;
            break;
          }
          items.push({
            note: {
              id: note.id,
              type: note.type,
              createdAt: note.createdAt.toISOString(),
              updatedAt: (note.updatedAt ?? note.createdAt).toISOString(),
              excerpt: excerpt(note.content),
            },
            score: hit.score,
            matches: [hit.match],
          });
        }
        if (hasMore) break;
      }
      checkDeadline();
      if (sourceNote) {
        const current = await deps.notes.readOwned(accountId, sourceNote.id);
        if (!current || current.accountId !== accountId || current.isRecycle)
          throw new ServiceError("NOT_FOUND_OR_FORBIDDEN");
        if (
          fingerprintNoteSnapshot(current, active.preprocessingVersion) !== sourceHash ||
          current.isArchived !== sourceNote.isArchived
        )
          throw new ServiceError("SOURCE_INDEX_STALE");
      }
      // Re-read the result IDs together immediately before the version fence and projection.
      checkDeadline();
      const finalNotes = new Map(
        (
          await deps.notes.recheck(
            accountId,
            selection,
            items.map((item) => item.note.id),
          )
        ).map((n) => [n.id, n]),
      );
      const finalItems = items.filter((item) => {
        const n = finalNotes.get(item.note.id);
        const hit = scored.find((h) => h.id === item.note.id)!;
        const ok =
          n &&
          matchesSelection(n, accountId, selection) &&
          fingerprintNoteSnapshot(n, active.preprocessingVersion) === hit.hash;
        if (!ok) reason = primaryReason(reason, "stale-candidates");
        return ok;
      });
      checkDeadline();
      const end = await repository.readStatus(accountId);
      if (end.generation !== active.generation || end.embeddingSpaceId !== active.embeddingSpaceId)
        throw new ServiceError("INDEX_CHANGED");
      if (
        end.corpusRevision !== status.corpusRevision ||
        (await deps.notes.stamp(accountId)) !== before
      )
        reason = primaryReason(reason, "index-changed");
      checkDeadline();
      return {
        requestId,
        items: finalItems,
        scoring: { metric: "cosine", aggregation: "max_chunk_cosine_v1", higherIsBetter: true },
        index: {
          embeddingSpaceId: active.embeddingSpaceId,
          generation: active.generation,
          corpusRevision: status.corpusRevision,
          coverage: missing ? "partial" : status.coverage,
          provenance: status.provenance,
        },
        retrieval: {
          algorithm: "exact",
          truncated: !!reason || !finished,
          remaining: reason || !finished ? "unknown" : hasMore ? "yes" : "no",
          ...(reason ? { reason } : {}),
        },
      };
    });
  };
  return {
    async query(accountId: number, input: VectorQueryInput): Promise<VectorQueryResult> {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Bound caller latency even if a database adapter does not resolve. CPU work
      // has an independent operation/page budget. In-flight SQL may finish later;
      // checks below prevent starting further work after this response deadline.
      const deadline = budget.hardTimeoutMs + (input?.source?.kind === "text" ? 30000 : 0);
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ServiceError("TIMEOUT", { retryable: true }));
        }, deadline);
      });
      try {
        return await Promise.race([execute(accountId, input, controller.signal), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
