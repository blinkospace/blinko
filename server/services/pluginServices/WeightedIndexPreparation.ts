import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BODY_PREPROCESSING_VERSION, digest, fingerprintNoteSnapshot, prepareBodyInput } from './BodyInput';
import type { HostIndexDeps } from './HostIndex';
import { IndexLifecycle } from './IndexLifecycle';
import type { ResolvedEmbedding } from './ModelResolver';
import { TOKEN_WEIGHT_VERSION, validateWeightWitness, type TokenWeightWitness } from './NoteAggregation';
import { decodeStoredF32, openVectorReader, validateVector, VectorRepository } from './VectorRepository';
import { ServiceError } from './errors';
import type { EmbeddingSpace, IndexGeneration, NoteSnapshot, PreparedBody } from './types';

// A bounded local operator operation, not a plugin endpoint or a second index.
const MAX_DIMENSION_OPS = 100_000_000;
const MAX_NOTE_CHARS = 2_000_000;
export const weightedPreparationSchema = z.object({
  accountId: z.number().int().positive(),
  noteIds: z.array(z.number().int().positive()).min(1).max(500),
  maxRequests: z.number().int().min(0).max(10_000),
  maxInputChars: z.number().int().min(0).max(10_000_000),
}).strict();
export type WeightedPreparationInput = z.infer<typeof weightedPreparationSchema>;
export interface WeightedPreparationDeps extends HostIndexDeps {
  /** Stable host database identity, hashed into the confirmation; never print the URL. */
  sourceIdentity: string;
}
export interface WeightedPreparationPlan {
  version: 'weighted-preparation-v1';
  targetId: string;
  planId: string;
  input: WeightedPreparationInput;
  modelId: number;
  space: EmbeddingSpace;
  activeGeneration: string | null;
  notes: Array<{
    noteId: number;
    snapshotHash: string;
    sourceHash: string;
    chunks: number;
    inputChars: number;
    prepared: boolean;
  }>;
  requests: number;
  inputChars: number;
}
export type PreparationEvent = Record<string, unknown> & { event: string };
export interface WeightedPreparationResult {
  status: 'complete' | 'failed';
  planId: string;
  publishedNoteIds: number[];
  skippedNoteIds: number[];
  dispatchedRequests: number;
  consumedInputChars: number;
  generation: string | null;
  error?: string;
}
function sameSpace(a: EmbeddingSpace, b: EmbeddingSpace): boolean {
  return a.embeddingSpaceId === b.embeddingSpaceId && a.modelFingerprint === b.modelFingerprint &&
    a.dimensions === b.dimensions && a.preprocessingVersion === b.preprocessingVersion;
}
async function ownedNote(deps: HostIndexDeps, accountId: number, noteId: number): Promise<NoteSnapshot> {
  const note = await deps.readNote(noteId);
  if (!note || note.accountId !== accountId || note.isRecycle) throw new ServiceError('NOT_FOUND_OR_FORBIDDEN');
  if (note.content.length > MAX_NOTE_CHARS) throw new ServiceError('QUERY_BUDGET_EXCEEDED');
  return note;
}
function checkBody(body: PreparedBody, dimensions: number): number {
  if (!body.values.length || body.values.length > 10_000 ||
      !Number.isSafeInteger(dimensions) || dimensions <= 0 || dimensions > 65_536 ||
      body.values.length > Math.floor(MAX_DIMENSION_OPS / dimensions))
    throw new ServiceError('QUERY_BUDGET_EXCEEDED');
  return body.values.reduce((total, value) => total + value.length, 0);
}
async function prepared(repository: VectorRepository, note: NoteSnapshot, body: PreparedBody, generation: IndexGeneration): Promise<boolean> {
  const rows = await repository.client.execute({
    sql: `SELECT n.embedding,n.proof,r.source_hash,r.chunk_count,r.snapshot_hash,r.provenance
      FROM blinko_ps_note_vectors n JOIN blinko_ps_revisions r ON r.revision_id=n.revision_id
      JOIN blinko_ps_heads h ON h.account_id=r.account_id AND h.note_id=r.note_id
      WHERE n.account_id=? AND n.note_id=? AND n.generation=? AND r.state='published' AND h.tombstone=0`,
    args: [note.accountId, note.id, generation.generation],
  });
  if (rows.rows.length !== 1) return false;
  const row = rows.rows[0];
  if (row.snapshot_hash !== body.noteSnapshotHash || row.source_hash !== body.sourceHash ||
      Number(row.chunk_count) !== body.values.length || !['verified', 'legacy-attested'].includes(String(row.provenance))) return false;
  try {
    validateWeightWitness(JSON.parse(String(row.proof)), body, generation);
    decodeStoredF32(row.embedding, generation.dimensions);
    return true;
  } catch { return false; }
}

/** Preview resolves metadata only: no migrations, writes or provider construction. */
export async function planWeightedPreparation(deps: WeightedPreparationDeps, raw: WeightedPreparationInput): Promise<WeightedPreparationPlan> {
  if (!deps.sourceIdentity || !deps.url.startsWith('file:')) throw new ServiceError('INVALID_INPUT');
  const parsed = weightedPreparationSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError('INVALID_INPUT');
  const input = { ...parsed.data, noteIds: [...new Set(parsed.data.noteIds)].sort((a, b) => a - b) };
  if (input.noteIds.length !== parsed.data.noteIds.length) throw new ServiceError('INVALID_INPUT');
  const embedding = await deps.resolveEmbedding();
  if (embedding.space.preprocessingVersion !== BODY_PREPROCESSING_VERSION) throw new ServiceError('EMBEDDING_SPACE_MISMATCH');
  const repository = await openVectorReader(deps.url);
  try {
    const active = await repository?.readActiveGeneration() ?? null;
    if (active && !sameSpace(active, embedding.space)) throw new ServiceError('EMBEDDING_SPACE_MISMATCH');
    const cacheAvailable = !!(active && repository && (await repository.client.execute(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='blinko_ps_note_vectors'",
    )).rows.length);
    const notes: WeightedPreparationPlan['notes'] = [];
    let requests = 0, inputChars = 0, dimensionOps = 0;
    for (const noteId of input.noteIds) {
      const note = await ownedNote(deps, input.accountId, noteId);
      const body = await prepareBodyInput(note);
      const chars = checkBody(body, embedding.space.dimensions);
      const ready = !!(cacheAvailable && repository && active && await prepared(repository, note, body, active));
      if (!ready) {
        requests += body.values.length;
        inputChars += chars;
        dimensionOps += body.values.length * embedding.space.dimensions;
      }
      if (requests > input.maxRequests || inputChars > input.maxInputChars || dimensionOps > MAX_DIMENSION_OPS)
        throw new ServiceError('QUERY_BUDGET_EXCEEDED');
      notes.push({ noteId, snapshotHash: body.noteSnapshotHash, sourceHash: body.sourceHash,
        chunks: body.values.length, inputChars: chars, prepared: ready });
    }
    // Catch a generation switch during the preview; execution validates the whole plan again.
    if ((await repository?.readActiveGeneration())?.generation !== active?.generation)
      throw new ServiceError('INDEX_CHANGED');
    const plan = { version: 'weighted-preparation-v1' as const,
      targetId: digest([deps.sourceIdentity, path.resolve(deps.url.slice(5))]), input, modelId: embedding.modelId,
      space: embedding.space, activeGeneration: active?.generation ?? null, notes, requests, inputChars };
    return { ...plan, planId: digest(plan) };
  } finally { repository?.client.close(); }
}

/** journal must durably persist each event before returning. Never resume/replay
 * this execution after an unknown outcome; make a fresh preview and journal. */
export async function applyWeightedPreparation(deps: WeightedPreparationDeps, plan: WeightedPreparationPlan, options: {
  confirmPlan: string;
  allowProviderCalls: boolean;
  journal(event: PreparationEvent): void;
}): Promise<WeightedPreparationResult> {
  if (!options.allowProviderCalls || options.confirmPlan !== plan.planId) throw new ServiceError('FORBIDDEN');
  const fresh = await planWeightedPreparation(deps, plan.input);
  if (fresh.planId !== plan.planId) throw new ServiceError('INDEX_CHANGED');
  const result: WeightedPreparationResult = { status: 'complete', planId: plan.planId,
    publishedNoteIds: [], skippedNoteIds: plan.notes.filter(n => n.prepared).map(n => n.noteId),
    dispatchedRequests: 0, consumedInputChars: 0, generation: plan.activeGeneration };
  options.journal({ event: 'started', plan });
  if (!plan.requests) { options.journal({ event: 'finished', result }); return result; }
  if (!deps.url.startsWith('file:')) throw new ServiceError('INDEX_NOT_READY');
  mkdirSync(path.dirname(deps.url.slice(5)), { recursive: true });
  const client = createClient({ url: deps.url });
  try {
    const lifecycle = new IndexLifecycle(client, deps);
    await lifecycle.initialize();
    const repository = new VectorRepository(client);
    const embedding: ResolvedEmbedding = await deps.resolveEmbedding();
    if (embedding.modelId !== plan.modelId || !sameSpace(embedding.space, plan.space)) throw new ServiceError('INDEX_CHANGED');
    if (!embedding.embedBodyMeasured) throw new ServiceError('CAPABILITY_UNSUPPORTED');
    let expectedActive = plan.activeGeneration;
    if ((await repository.readActiveGeneration())?.generation !== (expectedActive ?? undefined)) throw new ServiceError('INDEX_CHANGED');
    const generation = await lifecycle.findCompatibleGeneration(embedding.space) ?? await lifecycle.createGeneration(embedding.space);
    async function checkCurrent(noteId: number, snapshotHash: string): Promise<void> {
      if ((await repository.readActiveGeneration())?.generation !== (expectedActive ?? undefined)) throw new ServiceError('INDEX_CHANGED');
      const current = await deps.resolveEmbedding();
      if (current.modelId !== plan.modelId || !sameSpace(current.space, plan.space)) throw new ServiceError('INDEX_CHANGED');
      const note = await ownedNote(deps, plan.input.accountId, noteId);
      if (fingerprintNoteSnapshot(note, plan.space.preprocessingVersion) !== snapshotHash) throw new ServiceError('SOURCE_INDEX_STALE');
      if ((await repository.readActiveGeneration())?.generation !== (expectedActive ?? undefined)) throw new ServiceError('INDEX_CHANGED');
    }
    for (const entry of plan.notes) {
      if (entry.prepared) continue;
      await checkCurrent(entry.noteId, entry.snapshotHash);
      const note = await ownedNote(deps, plan.input.accountId, entry.noteId);
      const published = await lifecycle.indexBody(note, generation, async values => {
        if (digest([plan.space.preprocessingVersion, values]) !== entry.sourceHash ||
            values.length !== entry.chunks || values.reduce((sum, v) => sum + v.length, 0) !== entry.inputChars)
          throw new ServiceError('SOURCE_INDEX_STALE');
        const vectors: number[][] = [], counts: number[] = [];
        for (let ordinal = 0; ordinal < values.length; ordinal++) {
          await checkCurrent(entry.noteId, entry.snapshotHash);
          const value = values[ordinal];
          if (result.dispatchedRequests + 1 > plan.input.maxRequests ||
              result.consumedInputChars + value.length > plan.input.maxInputChars)
            throw new ServiceError('QUERY_BUDGET_EXCEEDED');
          // Reserve durably before dispatch. Failure/timeout never refunds or retries.
          options.journal({ event: 'dispatch-reserved', noteId: entry.noteId, ordinal, inputChars: value.length });
          result.dispatchedRequests++;
          result.consumedInputChars += value.length;
          const encoded = await embedding.embedBodyMeasured!([value], AbortSignal.timeout(30_000));
          options.journal({ event: 'dispatch-returned', noteId: entry.noteId, ordinal });
          const witness = encoded.tokenWeights;
          if (!witness || encoded.vectors.length !== 1) throw new ServiceError('CAPABILITY_UNSUPPORTED');
          validateWeightWitness(witness, { values: [value], texts: [], noteSnapshotHash: entry.snapshotHash,
            sourceHash: digest([plan.space.preprocessingVersion, [value]]) }, generation);
          // Validate vectors before spending on the next input.
          validateVector(encoded.vectors[0], generation.dimensions);
          vectors.push(encoded.vectors[0]); counts.push(witness.counts[0]);
        }
        await checkCurrent(entry.noteId, entry.snapshotHash);
        const tokenWeights: TokenWeightWitness = { version: TOKEN_WEIGHT_VERSION,
          modelFingerprint: generation.modelFingerprint, sourceHash: entry.sourceHash, counts };
        return { vectors, tokenWeights };
      }, { requireTokenWeights: true });
      if (!published) throw new ServiceError('SOURCE_INDEX_STALE');
      await checkCurrent(entry.noteId, entry.snapshotHash);
      if (expectedActive === null) {
        await lifecycle.activateGeneration(generation.generation, null);
        expectedActive = generation.generation;
        result.generation = generation.generation;
      }
      result.publishedNoteIds.push(entry.noteId);
      options.journal({ event: 'note-published', noteId: entry.noteId, generation: generation.generation });
      await deps.markIndexed?.(note);
    }
    options.journal({ event: 'finished', result });
    return result;
  } catch (error) {
    result.status = 'failed';
    // Raw provider/storage messages can include encoded note contents or credentials.
    result.error = error instanceof ServiceError ? error.code : 'PROVIDER_OR_STORAGE_ERROR';
    options.journal({ event: 'finished', result });
    return result;
  } finally { client.close(); }
}
