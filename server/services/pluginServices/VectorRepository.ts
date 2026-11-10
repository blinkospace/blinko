import { createClient, type Client, type Row, type Transaction } from "@libsql/client";
import { existsSync } from "node:fs";
import type { VectorIndexStatus } from "../../../shared/lib/pluginServices/v1";
import { fingerprintNoteSnapshot } from "./BodyInput";
import { INDEX_SCHEMA_VERSION } from "./indexMigrations";
import { ServiceError } from "./errors";
import { decodeTokenWeight } from './NoteAggregation';
import type { BodyRevision, IndexGeneration, NoteSnapshot } from "./types";

export function indexTable(name: string): string {
  if (!/^blinko_ps_vectors_[a-f0-9]{32}$/.test(name)) throw new ServiceError("INDEX_NOT_READY");
  return `"${name}"`;
}
export function decodeGeneration(row: Row): IndexGeneration {
  const generation: IndexGeneration = {
    generation: String(row.generation),
    embeddingSpaceId: String(row.space_id),
    dimensions: Number(row.dimensions),
    modelFingerprint: String(row.model_fingerprint),
    preprocessingVersion: String(row.preprocessing_version),
    tableName: String(row.table_name),
    state: String(row.state) as "ready" | "building",
  };
  indexTable(generation.tableName);
  if (
    !Number.isSafeInteger(generation.dimensions) ||
    generation.dimensions <= 0 ||
    generation.dimensions > 65536
  )
    throw new ServiceError("INDEX_NOT_READY");
  return generation;
}
export function validateVector(vector: number[], dimensions: number): void {
  if (
    !Array.isArray(vector) ||
    vector.length !== dimensions ||
    !vector.every((value) => Number.isFinite(value) && Number.isFinite(Math.fround(value))) ||
    !vector.some((value) => Math.fround(value) !== 0)
  )
    throw new ServiceError("SOURCE_NOT_INDEXED");
}
// vector_extract formats decimal text and loses stored F32 precision. Read the
// fixed-dimension blob directly; libsql F32_BLOB stores little-endian float32s.
export function decodeStoredF32(value: unknown, dimensions: number): number[] {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : null;
  if (!bytes || bytes.byteLength !== dimensions * 4) throw new ServiceError("SOURCE_NOT_INDEXED");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Indexed reads avoid a callback per axis on Node while preserving LE F32 bytes.
  const vector = new Array<number>(dimensions);
  for (let index = 0; index < dimensions; index++) {
    vector[index] = view.getFloat32(index * 4, true);
  }
  validateVector(vector, dimensions);
  return vector;
}

const unavailable = (): VectorIndexStatus => ({
  available: false,
  reason: "index-not-ready",
  embeddingSpaceId: null,
  generation: null,
  corpusRevision: null,
  coverage: "unknown",
  provenance: "none",
});

type Reader = Pick<Client | Transaction, "execute">;
export class VectorRepository {
  constructor(readonly client: Client) {}

  /** Returns null for an untouched legacy database; never creates or migrates it. */
  async readActiveGeneration(reader: Reader = this.client): Promise<IndexGeneration | null> {
    const exists = await reader.execute(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='blinko_ps_meta'",
    );
    if (!exists.rows.length) return null;
    const meta = await reader.execute(
      "SELECT schema_version,active_generation FROM blinko_ps_meta WHERE id=1",
    );
    if (!meta.rows.length || Number(meta.rows[0].schema_version) !== INDEX_SCHEMA_VERSION)
      throw new ServiceError("INDEX_NOT_READY");
    if (!meta.rows[0].active_generation) return null;
    const rows = await reader.execute({
      sql: "SELECT * FROM blinko_ps_generations WHERE generation=? AND state='ready'",
      args: [String(meta.rows[0].active_generation)],
    });
    if (!rows.rows.length) throw new ServiceError("INDEX_NOT_READY");
    return decodeGeneration(rows.rows[0]);
  }

  async hasOwnedIndexRecord(accountId: number, noteId: number): Promise<boolean> {
    const exists = await this.client.execute(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='blinko_ps_heads'",
    );
    if (!exists.rows.length) return false;
    const row = await this.client.execute({
      sql: "SELECT 1 FROM blinko_ps_heads WHERE account_id=? AND note_id=? LIMIT 1",
      args: [accountId, noteId],
    });
    return row.rows.length > 0;
  }

  async readStatus(accountId: number): Promise<VectorIndexStatus> {
    const tx = await this.client.transaction("read");
    try {
      const generation = await this.readActiveGeneration(tx);
      if (!generation) return unavailable();
      const rows = await tx.execute({
        sql: `SELECT r.provenance FROM blinko_ps_revisions r
        JOIN blinko_ps_heads h ON h.account_id=r.account_id AND h.note_id=r.note_id
        WHERE r.account_id=? AND r.generation=? AND r.state='published' AND h.tombstone=0`,
        args: [accountId, generation.generation],
      });
      const corpus = await tx.execute({
        sql: "SELECT revision FROM blinko_ps_corpora WHERE account_id=? AND generation=?",
        args: [accountId, generation.generation],
      });
      // Full account coverage is only known after checking the current PostgreSQL corpus.
      return {
        available: rows.rows.length > 0,
        ...(rows.rows.length ? {} : { reason: "index-not-ready" as const }),
        embeddingSpaceId: generation.embeddingSpaceId,
        generation: generation.generation,
        corpusRevision: corpus.rows[0] ? String(corpus.rows[0].revision) : null,
        coverage: rows.rows.length ? "partial" : "unknown",
        provenance: rows.rows.length
          ? rows.rows.some((row) => row.provenance === "legacy-attested")
            ? "legacy-attested"
            : "verified"
          : "none",
      };
    } finally {
      await tx.close();
    }
  }

  async readBodyRevision(input: {
    note: NoteSnapshot;
    embeddingSpaceId: string;
    generation: string;
    maxChunks?: number;
    maxVectorValues?: number;
    maxMetadataBytes?: number;
  }): Promise<BodyRevision | null> {
    if (input.note.isRecycle) return null;
    const tx = await this.client.transaction("read");
    try {
      const active = await this.readActiveGeneration(tx);
      if (!active) throw new ServiceError("INDEX_NOT_READY");
      if (
        active.generation !== input.generation ||
        active.embeddingSpaceId !== input.embeddingSpaceId
      )
        throw new ServiceError("INDEX_CHANGED");
      const rows = await tx.execute({
        sql: `SELECT r.* FROM blinko_ps_revisions r
        JOIN blinko_ps_heads h ON h.account_id=r.account_id AND h.note_id=r.note_id
        WHERE r.account_id=? AND r.note_id=? AND r.generation=? AND r.state='published' AND h.tombstone=0`,
        args: [input.note.accountId, input.note.id, active.generation],
      });
      if (!rows.rows.length) return null;
      if (rows.rows.length !== 1) throw new ServiceError("SOURCE_NOT_INDEXED");
      const row = rows.rows[0];
      const snapshotHash = fingerprintNoteSnapshot(input.note, active.preprocessingVersion);
      if (row.snapshot_hash !== snapshotHash) throw new ServiceError("SOURCE_INDEX_STALE");
      const chunkCount = Number(row.chunk_count);
      if (
        !Number.isSafeInteger(chunkCount) ||
        chunkCount <= 0 ||
        chunkCount > (input.maxChunks ?? 10000) ||
        chunkCount * active.dimensions > (input.maxVectorValues ?? Infinity)
      )
        throw new ServiceError("QUERY_BUDGET_EXCEEDED");
      if (input.maxMetadataBytes !== undefined) {
        const sizes = await tx.execute({
          sql: `SELECT COALESCE(SUM(length(CAST(metadata AS BLOB))),0) AS bytes FROM ${indexTable(active.tableName)} WHERE vector_id>=? AND vector_id<?`,
          args: [`${row.revision_id}:`, `${row.revision_id};`],
        });
        if (Number(sizes.rows[0].bytes) > input.maxMetadataBytes)
          throw new ServiceError("QUERY_BUDGET_EXCEEDED");
      }
      if (!["verified", "legacy-attested"].includes(String(row.provenance)))
        throw new ServiceError("LEGACY_INDEX_UNVERIFIED");
      const vectors = await tx.execute({
        sql: `SELECT metadata,embedding FROM ${indexTable(active.tableName)}
        WHERE vector_id>=? AND vector_id<? ORDER BY CAST(json_extract(metadata,'$.chunkOrdinal') AS INTEGER)`,
        args: [`${row.revision_id}:`, `${row.revision_id};`],
      });
      if (vectors.rows.length !== chunkCount) throw new ServiceError("SOURCE_NOT_INDEXED");
      const chunks = vectors.rows.map((value, ordinal) => {
        const metadata = JSON.parse(String(value.metadata));
        if (
          metadata.sourceKind !== "body" ||
          metadata.accountId !== input.note.accountId ||
          metadata.noteId !== input.note.id ||
          metadata.revisionId !== row.revision_id ||
          metadata.chunkOrdinal !== ordinal ||
          metadata.chunkCount !== chunkCount ||
          metadata.sourceHash !== row.source_hash ||
          metadata.noteSnapshotHash !== row.snapshot_hash ||
          metadata.embeddingSpaceId !== active.embeddingSpaceId ||
          metadata.generation !== active.generation ||
          typeof metadata.text !== "string"
        )
          throw new ServiceError("SOURCE_NOT_INDEXED");
        const vector = decodeStoredF32(value.embedding, active.dimensions);
        validateVector(vector, active.dimensions);
        const tokenWeight = decodeTokenWeight(metadata.tokenWeight);
        return { ordinal, text: metadata.text, vector, ...(tokenWeight ? { tokenWeight } : {}) };
      });
      return {
        accountId: input.note.accountId,
        noteId: input.note.id,
        revisionId: String(row.revision_id),
        noteSnapshotHash: snapshotHash,
        sourceHash: String(row.source_hash),
        embeddingSpaceId: active.embeddingSpaceId,
        generation: active.generation,
        chunkCount,
        provenance: String(row.provenance) as BodyRevision["provenance"],
        chunks,
      };
    } finally {
      await tx.close();
    }
  }

  /** Bounded page reader. Uses existing vector_id UNIQUE lookups, never one
   * JSON table scan per note, and checks complete-revision sizes before blobs. */
  async readQueryPage(input: {
    notes: readonly NoteSnapshot[];
    embeddingSpaceId: string;
    generation: string;
    maxChunks: number;
    maxVectorValues: number;
    maxMetadataBytes: number;
  }): Promise<{
    revisions: BodyRevision[];
    missing: number;
    stale: number;
    truncated: boolean;
    chunks: number;
  }> {
    const result = {
      revisions: [] as BodyRevision[],
      missing: 0,
      stale: 0,
      truncated: false,
      chunks: 0,
    };
    if (!input.notes.length) return result;
    if (input.notes.length > 128 || new Set(input.notes.map((n) => n.accountId)).size !== 1)
      throw new ServiceError("INVALID_INPUT");
    const tx = await this.client.transaction("read");
    try {
      const active = await this.readActiveGeneration(tx);
      if (!active) throw new ServiceError("INDEX_NOT_READY");
      if (
        active.generation !== input.generation ||
        active.embeddingSpaceId !== input.embeddingSpaceId
      )
        throw new ServiceError("INDEX_CHANGED");
      const rows = await tx.execute({
        sql: `SELECT r.* FROM blinko_ps_revisions r JOIN blinko_ps_heads h
          ON h.account_id=r.account_id AND h.note_id=r.note_id
          WHERE r.account_id=? AND r.generation=? AND r.state='published' AND h.tombstone=0
          AND r.note_id IN (${input.notes.map(() => "?").join(",")})`,
        args: [input.notes[0].accountId, active.generation, ...input.notes.map((n) => n.id)],
      });
      const selected: Array<{ note: NoteSnapshot; row: Row; hash: string; keys: string[] }> = [];
      for (const note of input.notes) {
        const found = rows.rows.filter((r) => Number(r.note_id) === note.id);
        if (!found.length) {
          result.missing++;
          continue;
        }
        const row = found[0];
        const hash = fingerprintNoteSnapshot(note, active.preprocessingVersion);
        if (
          note.isRecycle ||
          found.length !== 1 ||
          row.snapshot_hash !== hash ||
          !["verified", "legacy-attested"].includes(String(row.provenance))
        ) {
          result.stale++;
          continue;
        }
        const count = Number(row.chunk_count);
        if (!Number.isSafeInteger(count) || count < 1 || count > 10000) {
          result.stale++;
          continue;
        }
        if (
          result.chunks + count > input.maxChunks ||
          (result.chunks + count) * active.dimensions > input.maxVectorValues
        ) {
          result.truncated = true;
          break;
        }
        result.chunks += count;
        selected.push({
          note,
          row,
          hash,
          keys: Array.from({ length: count }, (_, i) => `${row.revision_id}:${i}`),
        });
      }
      const keys = selected.flatMap((s) => s.keys);
      if (!keys.length) return result;
      // Bound parameters and metadata before materializing strings or vector arrays.
      // Oversized pages return no partial revisions; callers report a budget stop.
      if (keys.length > 10000) return { ...result, revisions: [], truncated: true };
      const placeholders = keys.map(() => "?").join(",");
      const size = await tx.execute({
        sql: `SELECT COALESCE(SUM(length(CAST(metadata AS BLOB))),0) AS bytes FROM ${indexTable(active.tableName)} WHERE vector_id IN (${placeholders})`,
        args: keys,
      });
      if (Number(size.rows[0].bytes) > input.maxMetadataBytes)
        return { ...result, revisions: [], truncated: true };
      const vectors = await tx.execute({
        sql: `SELECT vector_id,metadata,embedding FROM ${indexTable(active.tableName)} WHERE vector_id IN (${placeholders})`,
        args: keys,
      });
      const byKey = new Map(vectors.rows.map((r) => [String(r.vector_id), r]));
      for (const { note, row, hash, keys } of selected) {
        try {
          const chunks = keys.map((key, ordinal) => {
            const value = byKey.get(key);
            if (!value) throw new ServiceError("SOURCE_NOT_INDEXED");
            const m = JSON.parse(String(value.metadata));
            if (
              m.sourceKind !== "body" ||
              m.accountId !== note.accountId ||
              m.noteId !== note.id ||
              m.revisionId !== row.revision_id ||
              m.chunkOrdinal !== ordinal ||
              m.chunkCount !== keys.length ||
              m.sourceHash !== row.source_hash ||
              m.noteSnapshotHash !== hash ||
              m.embeddingSpaceId !== active.embeddingSpaceId ||
              m.generation !== active.generation ||
              typeof m.text !== "string"
            )
              throw new ServiceError("SOURCE_NOT_INDEXED");
            return {
              ordinal,
              text: m.text,
              vector: decodeStoredF32(value.embedding, active.dimensions),
              ...(decodeTokenWeight(m.tokenWeight) ? { tokenWeight: decodeTokenWeight(m.tokenWeight) } : {}),
            };
          });
          result.revisions.push({
            accountId: note.accountId,
            noteId: note.id,
            revisionId: String(row.revision_id),
            noteSnapshotHash: hash,
            sourceHash: String(row.source_hash),
            embeddingSpaceId: active.embeddingSpaceId,
            generation: active.generation,
            chunkCount: keys.length,
            provenance: row.provenance as BodyRevision["provenance"],
            chunks,
          });
        } catch (error) {
          if (
            !(error instanceof SyntaxError) &&
            !(error instanceof ServiceError && error.code === "SOURCE_NOT_INDEXED")
          )
            throw error;
          result.stale++;
        }
      }
      return result;
    } finally {
      await tx.close();
    }
  }

  async scanBodyRevisions(input: {
    notes: readonly NoteSnapshot[];
    embeddingSpaceId: string;
    generation: string;
    maxChunks: number;
    signal?: AbortSignal;
  }): Promise<{ revisions: BodyRevision[]; truncated: boolean }> {
    const revisions: BodyRevision[] = [];
    let total = 0;
    for (const note of input.notes) {
      if (input.signal?.aborted) throw new ServiceError("ABORTED");
      try {
        const revision = await this.readBodyRevision({
          note,
          embeddingSpaceId: input.embeddingSpaceId,
          generation: input.generation,
        });
        if (revision) {
          if (total + revision.chunkCount > input.maxChunks) return { revisions, truncated: true };
          total += revision.chunkCount;
          revisions.push(revision);
        }
      } catch (error) {
        if (
          !(error instanceof ServiceError) ||
          !["SOURCE_INDEX_STALE", "SOURCE_NOT_INDEXED"].includes(error.code)
        )
          throw error;
      }
    }
    return { revisions, truncated: false };
  }
}

/** Open an existing local host database only. The caller owns and closes the connection. */
export async function openVectorReader(url: string): Promise<VectorRepository | null> {
  if (!url.startsWith("file:")) throw new ServiceError("INDEX_NOT_READY");
  if (!existsSync(url.slice(5))) return null;
  const client = createClient({ url });
  // libsql opens a new connection for a transaction, so a connection PRAGMA alone
  // does not make the whole client read-only. Guard every public execution path.
  const guard = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, key) {
        if (key === "execute")
          return (statement: string | { sql: string; args?: unknown[] }, args?: unknown[]) => {
            const sql = typeof statement === "string" ? statement : statement.sql;
            if (!/^\s*SELECT\b/i.test(sql)) return Promise.reject(new ServiceError("FORBIDDEN"));
            return (object as unknown as Client).execute(
              statement as Parameters<Client["execute"]>[0],
              args as never,
            );
          };
        if (key === "transaction")
          return async (mode: string) => {
            if (mode !== "read") throw new ServiceError("FORBIDDEN");
            return guard(await (object as unknown as Client).transaction("read"));
          };
        if (["batch", "migrate", "executeMultiple", "sync"].includes(String(key)))
          return () => Promise.reject(new ServiceError("FORBIDDEN"));
        const value = Reflect.get(object, key, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  return new VectorRepository(guard(client));
}
