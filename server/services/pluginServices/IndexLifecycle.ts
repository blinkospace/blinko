import { randomUUID } from "node:crypto";
import type { Client, Transaction, Row } from "@libsql/client";
import { prepareBodyInput, fingerprintNoteSnapshot } from "./BodyInput";
import { migrateIndexMetadata } from "./indexMigrations";
import { writeRevisionCertificate } from './RevisionReferences';
import {
  decodeGeneration,
  decodeStoredF32,
  indexTable,
  validateVector,
  VectorRepository,
} from "./VectorRepository";
import { ServiceError } from "./errors";
import { encodeVectorF32, storedTokenWeight, validateWeightWitness, weightedMeanVector, aggregateVerifiedRevision, TOKEN_WEIGHT_VERSION, type BodyEncoderOutput, type TokenWeightWitness } from './NoteAggregation';
import type {
  EmbeddingSpace,
  IndexGeneration,
  NoteSnapshot,
  NoteSource,
  PreparedBody,
  RevisionLease,
} from "./types";

const id = () => randomUUID().replaceAll("-", "");
const MAX_AGGREGATION_DIMENSION_OPS = 100_000_000;
async function writeTransaction<T>(
  client: Client,
  run: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const tx = await client.transaction("write");
  try {
    const result = await run(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    await tx.close();
  }
}
function leaseFromRow(row: Row): RevisionLease {
  return {
    revisionId: String(row.revision_id),
    noteInstance: row.note_instance == null ? undefined : String(row.note_instance),
    accountId: Number(row.account_id),
    noteId: Number(row.note_id),
    generation: String(row.generation),
    noteSnapshotHash: String(row.snapshot_hash),
    sourceHash: String(row.source_hash),
    chunkCount: Number(row.chunk_count),
    epoch: Number(row.epoch),
    oldRevisionIds: JSON.parse(String(row.old_revisions)),
  };
}

/** The writer and maintenance path. Constructing a reader never constructs this class. */
export class IndexLifecycle {
  constructor(
    readonly client: Client,
    readonly source: NoteSource,
    readonly now = () => new Date(),
    /** Internal test seam: callers can only tighten the production bound. */
    private readonly aggregationDimensionOps = MAX_AGGREGATION_DIMENSION_OPS,
  ) {
    if (!Number.isSafeInteger(aggregationDimensionOps) || aggregationDimensionOps <= 0)
      throw new ServiceError("INVALID_INPUT");
    this.aggregationDimensionOps = Math.min(MAX_AGGREGATION_DIMENSION_OPS, aggregationDimensionOps);
  }
  private checkAggregationBudget(chunkCount: number, dimensions: number): void {
    if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0 ||
        !Number.isSafeInteger(dimensions) || dimensions <= 0)
      throw new ServiceError("INVALID_INPUT");
    // Check cardinalities before visiting vectors, encoding inputs or starting writes.
    if (chunkCount > Math.floor(this.aggregationDimensionOps / dimensions))
      throw new ServiceError("QUERY_BUDGET_EXCEEDED");
  }
  async initialize(): Promise<void> {
    await migrateIndexMetadata(this.client);
  }

  async createGeneration(space: EmbeddingSpace): Promise<IndexGeneration> {
    if (
      !Number.isSafeInteger(space.dimensions) ||
      space.dimensions <= 0 ||
      space.dimensions > 65536 ||
      !space.embeddingSpaceId ||
      !space.modelFingerprint ||
      !space.preprocessingVersion
    )
      throw new ServiceError("INVALID_INPUT");
    const generation = id();
    const tableName = `blinko_ps_vectors_${generation}`;
    await writeTransaction(this.client, async (tx) => {
      await tx.execute(`CREATE TABLE ${indexTable(tableName)} (id INTEGER PRIMARY KEY AUTOINCREMENT,
        vector_id TEXT NOT NULL UNIQUE, embedding F32_BLOB(${space.dimensions}) NOT NULL, metadata TEXT NOT NULL)`);
      await tx.execute({
        sql: `INSERT INTO blinko_ps_generations
        (generation,space_id,dimensions,model_fingerprint,preprocessing_version,table_name,state) VALUES(?,?,?,?,?,?,'building')`,
        args: [
          generation,
          space.embeddingSpaceId,
          space.dimensions,
          space.modelFingerprint,
          space.preprocessingVersion,
          tableName,
        ],
      });
    });
    return { ...space, generation, tableName, state: "building" };
  }

  async findCompatibleGeneration(
    space: EmbeddingSpace,
  ): Promise<IndexGeneration | null> {
    const active = await new VectorRepository(
      this.client,
    ).readActiveGeneration();
    if (
      active &&
      active.embeddingSpaceId === space.embeddingSpaceId &&
      active.modelFingerprint === space.modelFingerprint &&
      active.dimensions === space.dimensions &&
      active.preprocessingVersion === space.preprocessingVersion
    )
      return active;
    return null;
  }

  /** Explicit maintenance operation; retains the previous generation and every vector table for rollback. */
  async activateGeneration(
    generation: string,
    expectedActive?: string | null,
  ): Promise<void> {
    await writeTransaction(this.client, async (tx) => {
      const rows = await tx.execute({
        sql: "SELECT * FROM blinko_ps_generations WHERE generation=?",
        args: [generation],
      });
      if (!rows.rows.length) throw new ServiceError("INDEX_NOT_READY");
      const active = await tx.execute(
        "SELECT active_generation FROM blinko_ps_meta WHERE id=1",
      );
      if (
        expectedActive !== undefined &&
        (active.rows[0]?.active_generation ?? null) !== expectedActive
      )
        throw new ServiceError("INDEX_CHANGED");
      await tx.execute({
        sql: "UPDATE blinko_ps_generations SET state='ready' WHERE generation=?",
        args: [generation],
      });
      await tx.execute({
        sql: "UPDATE blinko_ps_meta SET active_generation=? WHERE id=1",
        args: [generation],
      });
    });
  }

  private async currentMatches(
    lease: Pick<RevisionLease, "accountId" | "noteId" | "noteSnapshotHash" | "noteInstance">,
    version: string,
  ): Promise<boolean> {
    const current = await this.source.readNote(lease.noteId);
    return (
      !!current &&
      !current.isRecycle &&
      current.accountId === lease.accountId &&
      (!lease.noteInstance || (await this.source.readInstance?.(lease.noteId)) === lease.noteInstance) &&
      fingerprintNoteSnapshot(current, version) === lease.noteSnapshotHash
    );
  }

  async beginRevision(
    note: NoteSnapshot,
    generation: IndexGeneration,
    body: PreparedBody,
  ): Promise<RevisionLease> {
    if (
      !body.texts.length ||
      body.texts.length !== body.values.length ||
      body.texts.length > 10000 ||
      body.noteSnapshotHash !==
        fingerprintNoteSnapshot(note, generation.preprocessingVersion)
    )
      throw new ServiceError("INVALID_INPUT");
    const noteInstance = await this.source.readInstance?.(note.id);
    if (this.source.readInstance && !noteInstance) throw new ServiceError('SOURCE_INDEX_STALE');
    const lease: RevisionLease = {
      revisionId: id(),
      noteInstance: noteInstance ?? undefined,
      accountId: note.accountId,
      noteId: note.id,
      generation: generation.generation,
      noteSnapshotHash: body.noteSnapshotHash,
      sourceHash: body.sourceHash,
      chunkCount: body.texts.length,
      epoch: 0,
      oldRevisionIds: [],
    };
    if (!(await this.currentMatches(lease, generation.preprocessingVersion)))
      throw new ServiceError("SOURCE_INDEX_STALE");
    return writeTransaction(this.client, async (tx) => {
      const head = await tx.execute({
        sql: `INSERT INTO blinko_ps_heads(account_id,note_id,epoch,tombstone) VALUES(?,?,1,0)
        ON CONFLICT(account_id,note_id) DO UPDATE SET epoch=epoch+1,tombstone=0 RETURNING epoch`,
        args: [note.accountId, note.id],
      });
      lease.epoch = Number(head.rows[0].epoch);
      const old = await tx.execute({
        sql: "SELECT revision_id FROM blinko_ps_revisions WHERE account_id=? AND note_id=? AND generation=? AND state='published'",
        args: [note.accountId, note.id, generation.generation],
      });
      lease.oldRevisionIds = old.rows.map((row) => String(row.revision_id));
      await tx.execute({
        sql: `INSERT INTO blinko_ps_revisions
        (revision_id,account_id,note_id,generation,snapshot_hash,source_hash,chunk_count,epoch,state,provenance,old_revisions,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,'writing','verified',?,?,?)`,
        args: [
          lease.revisionId,
          note.accountId,
          note.id,
          generation.generation,
          body.noteSnapshotHash,
          body.sourceHash,
          body.texts.length,
          lease.epoch,
          JSON.stringify(lease.oldRevisionIds),
          this.now().toISOString(),
          new Date(this.now().getTime() + 300000).toISOString(),
        ],
      });
      if (lease.noteInstance) await tx.execute({
        sql: 'INSERT INTO blinko_ps_revision_instances(revision_id,note_instance) VALUES(?,?)',
        args: [lease.revisionId, lease.noteInstance],
      });
      return lease;
    });
  }

  async stageRevision(
    lease: RevisionLease,
    generation: IndexGeneration,
    body: PreparedBody,
    vectors: number[][],
    provenance: "verified" | "legacy-attested" = "verified",
    tokenWeights?: TokenWeightWitness,
  ): Promise<void> {
    if (
      vectors.length !== lease.chunkCount ||
      body.texts.length !== lease.chunkCount ||
      body.sourceHash !== lease.sourceHash ||
      body.noteSnapshotHash !== lease.noteSnapshotHash ||
      generation.generation !== lease.generation
    )
      throw new ServiceError("INVALID_INPUT");
    if (tokenWeights) {
      this.checkAggregationBudget(lease.chunkCount, generation.dimensions);
      validateWeightWitness(tokenWeights, body, generation);
    }
    vectors.forEach((vector) => validateVector(vector, generation.dimensions));
    await writeTransaction(this.client, async (tx) => {
      const rows = await tx.execute({
        sql: `SELECT r.state,r.expires_at,h.epoch,h.tombstone FROM blinko_ps_revisions r
        JOIN blinko_ps_heads h ON h.account_id=r.account_id AND h.note_id=r.note_id WHERE r.revision_id=?`,
        args: [lease.revisionId],
      });
      const row = rows.rows[0];
      if (
        !row ||
        row.state !== "writing" ||
        row.tombstone ||
        Number(row.epoch) !== lease.epoch ||
        String(row.expires_at) <= this.now().toISOString()
      )
        throw new ServiceError("INDEX_CHANGED");
      for (let ordinal = 0; ordinal < vectors.length; ordinal++) {
        const metadata = {
          accountId: lease.accountId,
          id: lease.noteId,
          noteId: lease.noteId,
          revisionId: lease.revisionId,
          noteSnapshotHash: lease.noteSnapshotHash,
          sourceHash: lease.sourceHash,
          sourceKind: "body",
          chunkOrdinal: ordinal,
          chunkCount: lease.chunkCount,
          embeddingSpaceId: generation.embeddingSpaceId,
          generation: lease.generation,
          text: body.texts[ordinal],
          ...(tokenWeights ? { tokenWeight: storedTokenWeight(tokenWeights, ordinal) } : {}),
        };
        await tx.execute({
          sql: `INSERT INTO ${indexTable(generation.tableName)}(vector_id,embedding,metadata) VALUES(?,vector32(?),?)`,
          args: [
            `${lease.revisionId}:${ordinal}`,
            JSON.stringify(vectors[ordinal]),
            JSON.stringify(metadata),
          ],
        });
      }
      if (tokenWeights) {
        const mean = weightedMeanVector(vectors.map((vector, i) => ({ vector: vector.map(Math.fround), tokens: tokenWeights.counts[i] })));
        const vectorBlob = encodeVectorF32(mean), proof = JSON.stringify(tokenWeights);
        await tx.execute({
          sql: 'INSERT INTO blinko_ps_note_vectors(revision_id,account_id,note_id,generation,snapshot_hash,embedding,proof) VALUES(?,?,?,?,?,?,?)',
          args: [lease.revisionId, lease.accountId, lease.noteId, generation.generation, lease.noteSnapshotHash, vectorBlob, proof],
        });
        await writeRevisionCertificate(tx, lease, generation, vectorBlob, proof);
      }
      await tx.execute({
        sql: "UPDATE blinko_ps_revisions SET state='staged',provenance=? WHERE revision_id=? AND state='writing'",
        args: [provenance, lease.revisionId],
      });
    });
  }

  async publishRevision(
    lease: RevisionLease,
    generation: IndexGeneration,
  ): Promise<boolean> {
    if (!(await this.currentMatches(lease, generation.preprocessingVersion))) {
      await this.discardRevision(lease, generation);
      return false;
    }
    const published = await writeTransaction(this.client, async (tx) => {
      const row = await tx.execute({
        sql: `SELECT r.state,h.epoch,h.tombstone FROM blinko_ps_revisions r
        JOIN blinko_ps_heads h ON h.account_id=r.account_id AND h.note_id=r.note_id WHERE r.revision_id=?`,
        args: [lease.revisionId],
      });
      if (
        !row.rows[0] ||
        row.rows[0].tombstone ||
        Number(row.rows[0].epoch) !== lease.epoch
      )
        return false;
      if (row.rows[0].state === "published") return true;
      if (row.rows[0].state !== "staged") return false;
      const count = await tx.execute({
        sql: `SELECT COUNT(*) AS n FROM ${indexTable(generation.tableName)} WHERE json_extract(metadata,'$.revisionId')=?`,
        args: [lease.revisionId],
      });
      if (Number(count.rows[0].n) !== lease.chunkCount) return false;
      // Captured revision IDs only: a late worker must never delete somebody else's new version.
      for (const old of lease.oldRevisionIds) {
        await tx.execute({
          sql: "UPDATE blinko_ps_revisions SET state='discarded' WHERE revision_id=? AND state='published'",
          args: [old],
        });
        await tx.execute({
          sql: `DELETE FROM ${indexTable(generation.tableName)} WHERE json_extract(metadata,'$.revisionId')=?`,
          args: [old],
        });
        await tx.execute({ sql: 'DELETE FROM blinko_ps_note_vectors WHERE revision_id=? AND NOT EXISTS(SELECT 1 FROM blinko_ps_snapshot_refs f WHERE f.revision_id=blinko_ps_note_vectors.revision_id)', args: [old] });
      }
      await tx.execute({
        sql: "UPDATE blinko_ps_revisions SET state='published' WHERE revision_id=? AND state='staged'",
        args: [lease.revisionId],
      });
      await this.bumpCorpus(tx, lease.accountId, lease.generation);
      return true;
    });
    if (
      !published ||
      !(await this.currentMatches(lease, generation.preprocessingVersion))
    ) {
      await this.discardRevision(lease, generation);
      return false;
    }
    return true;
  }

  private async bumpCorpus(
    tx: Transaction,
    accountId: number,
    generation: string,
  ): Promise<void> {
    await tx.execute({
      sql: `INSERT INTO blinko_ps_corpora(account_id,generation,revision) VALUES(?,?,?)
      ON CONFLICT(account_id,generation) DO UPDATE SET revision=excluded.revision`,
      args: [accountId, generation, id()],
    });
  }

  async discardRevision(
    lease: RevisionLease,
    generation: IndexGeneration,
  ): Promise<void> {
    await writeTransaction(this.client, async (tx) => {
      await tx.execute({
        sql: "UPDATE blinko_ps_revisions SET state='discarded' WHERE revision_id=?",
        args: [lease.revisionId],
      });
      await tx.execute({
        sql: `DELETE FROM ${indexTable(generation.tableName)} WHERE json_extract(metadata,'$.revisionId')=?`,
        args: [lease.revisionId],
      });
      await tx.execute({ sql: 'DELETE FROM blinko_ps_note_vectors WHERE revision_id=? AND NOT EXISTS(SELECT 1 FROM blinko_ps_snapshot_refs f WHERE f.revision_id=blinko_ps_note_vectors.revision_id)', args: [lease.revisionId] });
      await this.bumpCorpus(tx, lease.accountId, lease.generation);
    });
  }

  async indexBody(
    note: NoteSnapshot,
    generation: IndexGeneration,
    encode: (values: string[]) => Promise<BodyEncoderOutput>,
    options: { requireTokenWeights?: boolean } = {},
  ): Promise<boolean> {
    const body = await prepareBodyInput(note);
    if (options.requireTokenWeights)
      this.checkAggregationBudget(body.texts.length, generation.dimensions);
    const lease = await this.beginRevision(note, generation, body);
    try {
      const encoded = await encode(body.values);
      const vectors = Array.isArray(encoded) ? encoded : encoded.vectors;
      const tokenWeights = Array.isArray(encoded) ? undefined : encoded.tokenWeights;
      if (options.requireTokenWeights && !tokenWeights)
        throw new ServiceError('CAPABILITY_UNSUPPORTED');
      await this.stageRevision(lease, generation, body, vectors, 'verified', tokenWeights);
      return await this.publishRevision(lease, generation);
    } catch (error) {
      await this.discardRevision(lease, generation);
      throw error;
    }
  }

  /** Explicit local maintenance: derive a new immutable revision from already
   * proven host chunks. Missing/unknown token provenance is rejected, never invented. */
  async certifyExisting(note: NoteSnapshot, generation: IndexGeneration): Promise<boolean> {
    if (!this.source.readInstance) throw new ServiceError('CAPABILITY_UNSUPPORTED');
    const revision = await new VectorRepository(this.client).readBodyRevision({ note, embeddingSpaceId: generation.embeddingSpaceId,
      generation: generation.generation, maxVectorValues: this.aggregationDimensionOps, maxMetadataBytes: 4 * 1024 * 1024 });
    if (!revision) throw new ServiceError('SOURCE_NOT_INDEXED');
    aggregateVerifiedRevision(revision, generation);
    const instance = await this.source.readInstance(note.id);
    const certified = await this.client.execute({ sql: 'SELECT 1 FROM blinko_ps_vector_certificates WHERE revision_id=? AND note_instance=?', args: [revision.revisionId, instance] });
    if (certified.rows.length) return true;
    const body = await prepareBodyInput(note);
    if (body.sourceHash !== revision.sourceHash || body.texts.length !== revision.chunks.length ||
        revision.chunks.some((chunk, i) => chunk.text !== body.texts[i])) throw new ServiceError('SOURCE_INDEX_STALE');
    const witness: TokenWeightWitness = { version: TOKEN_WEIGHT_VERSION, modelFingerprint: generation.modelFingerprint,
      sourceHash: body.sourceHash, counts: revision.chunks.map(chunk => chunk.tokenWeight!.tokens) };
    const lease = await this.beginRevision(note, generation, body);
    try {
      await this.stageRevision(lease, generation, body, revision.chunks.map(chunk => chunk.vector), revision.provenance, witness);
      return await this.publishRevision(lease, generation);
    } catch (error) { await this.discardRevision(lease, generation); throw error; }
  }

  /** Called after the SQL note has become invisible. The durable epoch fences already-running encoders. */
  async deleteNote(accountId: number, noteId: number): Promise<void> {
    await writeTransaction(this.client, async (tx) => {
      await tx.execute({
        sql: `INSERT INTO blinko_ps_heads(account_id,note_id,epoch,tombstone) VALUES(?,?,1,1)
        ON CONFLICT(account_id,note_id) DO UPDATE SET epoch=epoch+1,tombstone=1`,
        args: [accountId, noteId],
      });
      const generations = await tx.execute(
        "SELECT * FROM blinko_ps_generations",
      );
      for (const row of generations.rows) {
        const generation = decodeGeneration(row);
        await tx.execute({
          sql: `DELETE FROM ${indexTable(generation.tableName)} WHERE json_extract(metadata,'$.accountId')=? AND json_extract(metadata,'$.noteId')=?`,
          args: [accountId, noteId],
        });
        await this.bumpCorpus(tx, accountId, generation.generation);
      }
      await tx.execute({ sql: 'DELETE FROM blinko_ps_snapshot_refs WHERE note_id=? AND handle IN (SELECT handle FROM blinko_ps_snapshots WHERE account_id=?)', args: [noteId, accountId] });
      await tx.execute({ sql: 'DELETE FROM blinko_ps_note_vectors WHERE account_id=? AND note_id=?', args: [accountId, noteId] });
      await tx.execute({ sql: 'DELETE FROM blinko_ps_snapshot_notes WHERE note_id=? AND handle IN (SELECT handle FROM blinko_ps_snapshots WHERE account_id=?)', args: [noteId, accountId] });
      await tx.execute({
        sql: "UPDATE blinko_ps_revisions SET state='discarded' WHERE account_id=? AND note_id=?",
        args: [accountId, noteId],
      });
    });
  }

  /** Recovery does no embedding: finish complete matching stages; expire incomplete writers. */
  async recover(): Promise<{ published: number; discarded: number }> {
    const rows = await this.client.execute(
      "SELECT r.*,i.note_instance,g.space_id,g.dimensions,g.model_fingerprint,g.preprocessing_version,g.table_name,g.state AS generation_state FROM blinko_ps_revisions r JOIN blinko_ps_generations g ON r.generation=g.generation LEFT JOIN blinko_ps_revision_instances i ON i.revision_id=r.revision_id WHERE r.state IN ('writing','staged')",
    );
    const result = { published: 0, discarded: 0 };
    for (const row of rows.rows) {
      const generation = decodeGeneration({
        ...row,
        state: row.generation_state,
      });
      const lease = leaseFromRow(row);
      if (row.state === "staged") {
        if (await this.publishRevision(lease, generation)) result.published++;
        else result.discarded++;
      } else if (String(row.expires_at) <= this.now().toISOString()) {
        await this.discardRevision(lease, generation);
        result.discarded++;
      }
    }
    return result;
  }

  /** Ownership inventory only. Unknown historical model/encoding remains unverified. */
  async inventoryLegacy(): Promise<number> {
    const exists = await this.client.execute(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='blinko'",
    );
    if (!exists.rows.length) return 0;
    const rows = await this.client.execute(
      "SELECT vector_id,metadata FROM blinko WHERE json_valid(metadata) AND COALESCE(json_extract(metadata,'$.isAttachment'),0)=0",
    );
    let count = 0;
    for (const row of rows.rows) {
      const metadata = JSON.parse(String(row.metadata));
      const noteId = Number(metadata.noteId ?? metadata.id);
      if (!Number.isSafeInteger(noteId) || noteId <= 0) continue;
      const note = await this.source.readNote(noteId);
      if (!note || note.isRecycle) continue;
      await this.client.execute({
        sql: "INSERT OR REPLACE INTO blinko_ps_legacy(vector_id,account_id,note_id) VALUES(?,?,?)",
        args: [String(row.vector_id), note.accountId, noteId],
      });
      count++;
    }
    return count;
  }

  /** Host administrator only: explicit model attestation plus exact original input/chunk evidence. */
  async attestLegacy(input: {
    note: NoteSnapshot;
    generation: IndexGeneration;
    vectorIds: string[];
    administratorId: number;
    confirmed: boolean;
    evidence: string;
  }): Promise<boolean> {
    if (
      input.confirmed !== true ||
      !Number.isSafeInteger(input.administratorId) ||
      input.administratorId <= 0 ||
      input.evidence.trim().length < 16 ||
      input.evidence.length > 2000
    )
      throw new ServiceError("FORBIDDEN");
    const body = await prepareBodyInput(input.note);
    if (
      !input.vectorIds.length ||
      input.vectorIds.length !== body.texts.length ||
      new Set(input.vectorIds).size !== input.vectorIds.length
    )
      throw new ServiceError("SOURCE_NOT_INDEXED");
    const vectors: number[][] = [];
    for (let ordinal = 0; ordinal < input.vectorIds.length; ordinal++) {
      const rows = await this.client.execute({
        sql: "SELECT embedding,metadata FROM blinko WHERE vector_id=?",
        args: [input.vectorIds[ordinal]],
      });
      const row = rows.rows[0];
      if (!row) throw new ServiceError("SOURCE_NOT_INDEXED");
      const m = JSON.parse(String(row.metadata));
      const original =
        m.text +
        "Create At: " +
        m.createTime +
        " Update At: " +
        (m.updatedAt ?? undefined);
      if (
        m.isAttachment ||
        Number(m.noteId ?? m.id) !== input.note.id ||
        original !== body.values[ordinal]
      )
        throw new ServiceError("SOURCE_INDEX_STALE");
      vectors.push(decodeStoredF32(row.embedding, input.generation.dimensions));
    }
    const lease = await this.beginRevision(input.note, input.generation, body);
    await this.stageRevision(
      lease,
      input.generation,
      body,
      vectors,
      "legacy-attested",
    );
    await this.client.execute({
      sql: "INSERT INTO blinko_ps_attestations(revision_id,administrator_id,evidence,created_at) VALUES(?,?,?,?)",
      args: [
        lease.revisionId,
        input.administratorId,
        input.evidence,
        this.now().toISOString(),
      ],
    });
    return this.publishRevision(lease, input.generation);
  }
}
