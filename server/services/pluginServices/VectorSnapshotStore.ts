import type { Client, Row, Transaction } from "@libsql/client";
import { randomInt, randomUUID } from "node:crypto";
import {
  VECTOR_SNAPSHOT_LIMITS as LIMITS,
  type VectorSnapshotDescriptor,
  type VectorScope,
} from "../../../shared/lib/pluginServices/v1";
import { ServiceError } from "./errors";
import { encodeVectorF32 } from "./NoteAggregation";
import { decodeStoredF32 } from "./VectorRepository";
import { collectRevisionGarbage, REVISION_CERTIFICATE_VERSION } from './RevisionReferences';
export interface SnapshotMember { noteId: number; hash: string; instance?: string; revisionId?: string; }
export interface SnapshotReference extends SnapshotMember { instance: string; revisionId: string; }

export interface SnapshotEnvelope {
  descriptor: VectorSnapshotDescriptor;
  scope: VectorScope;
  dimensions: number;
}
export interface SnapshotEntry {
  noteId: number;
  hash: string;
  vector: number[];
}
/** Read/BEGIN or a COMMIT explicitly refused as BUSY while still active.
 * Never replay a transaction body or retry a commit of unknown outcome. */
async function waitForLock<T>(
  run: () => Promise<T>,
  stillValid = () => true,
): Promise<T> {
  const deadline = performance.now() + 500;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (
        (error as { code?: unknown })?.code !== "SQLITE_BUSY" ||
        !stillValid()
      )
        throw error;
      if (performance.now() >= deadline)
        throw new ServiceError("QUERY_BUDGET_EXCEEDED");
      await new Promise((resolve) => setTimeout(resolve, 4 + randomInt(13)));
    }
  }
}
export class VectorSnapshotStore {
  constructor(
    readonly client: Client,
    readonly now = Date.now,
  ) {}
  async available(): Promise<boolean> {
    return (
      (
        await waitForLock(() =>
          this.client.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='blinko_ps_snapshots'",
          ),
        )
      ).rows.length > 0
    );
  }
  private async transaction<T>(
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    // SQLite may refuse COMMIT while another process still holds a read lock.
    // Its local driver leaves that transaction active on SQLITE_BUSY; retry only
    // COMMIT, never fn. Each wait remains inside the existing service deadline.
    const tx = await waitForLock(() => this.client.transaction("write"));
    try {
      const result = await fn(tx);
      await waitForLock(
        () => tx.commit(),
        () => !tx.closed,
      );
      return result;
    } catch (error) {
      if (!tx.closed) await tx.rollback();
      throw error;
    } finally {
      await tx.close();
    }
  }
  private async prune(tx: Transaction): Promise<void> {
    const now = this.now();
    await tx.execute({ sql: 'DELETE FROM blinko_ps_snapshot_refs WHERE handle IN (SELECT handle FROM blinko_ps_snapshots WHERE expires_at<=?)', args: [now] });
    await tx.execute({
      sql: "DELETE FROM blinko_ps_snapshot_notes WHERE handle IN (SELECT handle FROM blinko_ps_snapshots WHERE expires_at<=?)",
      args: [now],
    });
    // Bounded tombstones preserve INDEX_CHANGED for recently expired handles,
    // without retaining vectors or allowing expired leases to consume live quotas.
    await tx.execute({
      sql: "UPDATE blinko_ps_snapshots SET state='expired',reserved_bytes=0,written_bytes=0,note_count=0,descriptor='{}' WHERE expires_at<=?",
      args: [now],
    });
    await tx.execute(
      "DELETE FROM blinko_ps_snapshots WHERE state='expired' AND handle NOT IN (SELECT handle FROM blinko_ps_snapshots WHERE state='expired' ORDER BY expires_at DESC LIMIT 1024)",
    );
    await collectRevisionGarbage(tx);
  }
  /** Reserve the full possible payload before doing work. The write transaction
   * enforces count/bytes across processes; a second create cannot race the sum. */
  async reserve(accountId: number): Promise<string> {
    if (!(await this.available())) throw new ServiceError("INDEX_NOT_READY");
    return this.transaction(async (tx) => {
      await this.prune(tx);
      const rows = await tx.execute({
        sql: `SELECT COUNT(*) AS total,COALESCE(SUM(reserved_bytes),0) AS bytes,
        SUM(CASE WHEN account_id=? THEN 1 ELSE 0 END) AS own_count,
        COALESCE(SUM(CASE WHEN account_id=? THEN reserved_bytes ELSE 0 END),0) AS own_bytes
        FROM blinko_ps_snapshots WHERE state IN ('building','ready')`,
        args: [accountId, accountId],
      });
      const row = rows.rows[0];
      if (
        Number(row.total) >= LIMITS.maxHostCount ||
        Number(row.own_count) >= LIMITS.maxPerAccount ||
        Number(row.bytes) + LIMITS.maxSnapshotBytes > LIMITS.maxHostBytes ||
        Number(row.own_bytes) + LIMITS.maxSnapshotBytes > LIMITS.maxAccountBytes
      )
        throw new ServiceError("QUERY_BUDGET_EXCEEDED");
      const handle = randomUUID();
      await tx.execute({
        sql: "INSERT INTO blinko_ps_snapshots(handle,account_id,state,expires_at,reserved_bytes,descriptor) VALUES(?,?,'building',?,?, '{}')",
        args: [handle, accountId, this.now() + 30_000, LIMITS.maxSnapshotBytes],
      });
      return handle;
    });
  }
  async add(
    handle: string,
    accountId: number,
    entries: SnapshotEntry[],
  ): Promise<void> {
    if (entries.length > 128) throw new ServiceError("QUERY_BUDGET_EXCEEDED");
    if (!entries.length) return;
    await this.transaction(async (tx) => {
      const parent = await tx.execute({
        sql: "SELECT 1 FROM blinko_ps_snapshots WHERE handle=? AND account_id=? AND state='building' AND expires_at>?",
        args: [handle, accountId, this.now()],
      });
      if (!parent.rows.length) throw new ServiceError("INDEX_CHANGED");
      const encoded = entries.map((entry) => ({
        ...entry,
        bytes: encodeVectorF32(entry.vector),
      }));
      const addedBytes = encoded.reduce(
        (sum, entry) => sum + entry.bytes.byteLength + 128,
        0,
      );
      const reserved = await tx.execute({
        sql: "UPDATE blinko_ps_snapshots SET written_bytes=written_bytes+?,note_count=note_count+? WHERE handle=? AND account_id=? AND written_bytes+?<=? AND note_count+?<=?",
        args: [
          addedBytes,
          entries.length,
          handle,
          accountId,
          addedBytes,
          LIMITS.maxSnapshotBytes,
          entries.length,
          LIMITS.maxPreparedNotes,
        ],
      });
      if (reserved.rowsAffected !== 1)
        throw new ServiceError("QUERY_BUDGET_EXCEEDED");
      // At most 128 entries / 512 parameters, under the existing page bound.
      // One statement retains the transaction's quota accounting and rollback.
      await tx.execute({
        sql: `INSERT INTO blinko_ps_snapshot_notes(handle,note_id,snapshot_hash,embedding) VALUES ${encoded.map(() => "(?,?,?,?)").join(",")}`,
        args: encoded.flatMap((entry) => [handle, entry.noteId, entry.hash, entry.bytes]),
      });
    });
  }
  /** Metadata-only fixed membership. Does not read/copy proof or vector payloads. */
  async addReferences(handle: string, accountId: number, entries: SnapshotReference[]): Promise<void> {
    if (entries.length > 128) throw new ServiceError('QUERY_BUDGET_EXCEEDED');
    if (!entries.length) return;
    await this.transaction(async tx => {
      const parent = await tx.execute({ sql: "SELECT 1 FROM blinko_ps_snapshots WHERE handle=? AND account_id=? AND state='building' AND expires_at>?", args: [handle, accountId, this.now()] });
      if (!parent.rows.length) throw new ServiceError('INDEX_CHANGED');
      const rows = await tx.execute({ sql: `SELECT n.revision_id,n.note_id,n.snapshot_hash,c.note_instance,c.logical_bytes
        FROM blinko_ps_note_vectors n JOIN blinko_ps_vector_certificates c ON c.revision_id=n.revision_id
        JOIN blinko_ps_revisions r ON r.revision_id=n.revision_id
        JOIN blinko_ps_heads h ON h.account_id=r.account_id AND h.note_id=r.note_id
        WHERE n.account_id=? AND r.account_id=n.account_id AND r.note_id=n.note_id AND r.generation=n.generation
        AND r.snapshot_hash=n.snapshot_hash AND r.state='published' AND h.tombstone=0 AND c.certificate_version=?
        AND n.revision_id IN (${entries.map(() => '?').join(',')})`, args: [accountId, REVISION_CERTIFICATE_VERSION, ...entries.map(e => e.revisionId)] });
      const found = new Map(rows.rows.map(r => [String(r.revision_id), r]));
      let bytes = 0;
      for (const entry of entries) {
        const row = found.get(entry.revisionId);
        if (!row || Number(row.note_id) !== entry.noteId || row.snapshot_hash !== entry.hash || row.note_instance !== entry.instance)
          throw new ServiceError('INDEX_CHANGED');
        bytes += Number(row.logical_bytes);
      }
      if (!Number.isSafeInteger(bytes) || bytes < 1) throw new ServiceError('INDEX_NOT_READY');
      const reserved = await tx.execute({ sql: `UPDATE blinko_ps_snapshots SET written_bytes=written_bytes+?,note_count=note_count+?
        WHERE handle=? AND account_id=? AND written_bytes+?<=? AND note_count+?<=?`,
        args: [bytes, entries.length, handle, accountId, bytes, LIMITS.maxSnapshotBytes, entries.length, LIMITS.maxPreparedNotes] });
      if (reserved.rowsAffected !== 1) throw new ServiceError('QUERY_BUDGET_EXCEEDED');
      await tx.execute({ sql: `INSERT INTO blinko_ps_snapshot_refs(handle,note_id,revision_id,snapshot_hash,note_instance) VALUES ${entries.map(() => '(?,?,?,?,?)').join(',')}`,
        args: entries.flatMap(e => [handle, e.noteId, e.revisionId, e.hash, e.instance]) });
    });
  }
  async publish(accountId: number, envelope: SnapshotEnvelope): Promise<void> {
    const serialized = JSON.stringify(envelope);
    const headerBytes = new TextEncoder().encode(serialized).byteLength;
    if (headerBytes > LIMITS.maxSnapshotBytes)
      throw new ServiceError("QUERY_BUDGET_EXCEEDED");
    await this.transaction(async (tx) => {
      const result = await tx.execute({
        sql: "UPDATE blinko_ps_snapshots SET state='ready',expires_at=?,reserved_bytes=written_bytes+?,descriptor=? WHERE handle=? AND account_id=? AND state='building' AND expires_at>? AND written_bytes+?<=? AND note_count=?",
        args: [
          Date.parse(envelope.descriptor.expiresAt),
          headerBytes,
          serialized,
          envelope.descriptor.handle,
          accountId,
          this.now(),
          headerBytes,
          LIMITS.maxSnapshotBytes,
          envelope.descriptor.preparedNoteCount,
        ],
      });
      if (result.rowsAffected !== 1) throw new ServiceError("INDEX_CHANGED");
    });
  }
  async get(accountId: number, handle: string): Promise<SnapshotEnvelope> {
    if (!(await this.available())) throw new ServiceError("INDEX_NOT_READY");
    const result = await this.client.execute({
      sql: "SELECT state,expires_at,descriptor FROM blinko_ps_snapshots WHERE handle=? AND account_id=?",
      args: [handle, accountId],
    });
    const row = result.rows[0];
    if (!row) throw new ServiceError("NOT_FOUND_OR_FORBIDDEN");
    if (row.state !== "ready" || Number(row.expires_at) <= this.now())
      throw new ServiceError("INDEX_CHANGED");
    try {
      const envelope = JSON.parse(String(row.descriptor)) as SnapshotEnvelope;
      if (
        envelope.descriptor.handle !== handle ||
        !Number.isSafeInteger(envelope.dimensions) ||
        envelope.dimensions <= 0 ||
        envelope.dimensions > 65536
      )
        throw new Error("Invalid snapshot");
      return envelope;
    } catch {
      throw new ServiceError("INDEX_NOT_READY");
    }
  }
  async page(
    handle: string,
    afterId: number,
  ): Promise<SnapshotMember[]> {
    const result = await this.client.execute({
      sql: `SELECT note_id,snapshot_hash,NULL AS note_instance,NULL AS revision_id FROM blinko_ps_snapshot_notes WHERE handle=? AND note_id>?
        UNION ALL SELECT note_id,snapshot_hash,note_instance,revision_id FROM blinko_ps_snapshot_refs WHERE handle=? AND note_id>?
        ORDER BY note_id LIMIT 128`,
      args: [handle, afterId, handle, afterId],
    });
    return result.rows.map(row => ({ noteId: Number(row.note_id), hash: String(row.snapshot_hash),
      ...(row.note_instance == null ? {} : { instance: String(row.note_instance), revisionId: String(row.revision_id) }) }));
  }
  async vectors(
    handle: string,
    ids: number[],
    dimensions: number,
  ): Promise<Map<number, number[]>> {
    if (ids.length > 128) throw new ServiceError("QUERY_BUDGET_EXCEEDED");
    if (!ids.length) return new Map();
    const result = await this.client.execute({
      sql: `SELECT note_id,embedding FROM blinko_ps_snapshot_notes WHERE handle=? AND note_id IN (${ids.map(() => "?").join(",")})
        UNION ALL SELECT f.note_id,n.embedding FROM blinko_ps_snapshot_refs f JOIN blinko_ps_note_vectors n ON n.revision_id=f.revision_id
        WHERE f.handle=? AND f.note_id IN (${ids.map(() => '?').join(',')})`,
      args: [handle, ...ids, handle, ...ids],
    });
    return new Map(
      result.rows.map((row) => [
        Number(row.note_id),
        decodeStoredF32(row.embedding, dimensions),
      ]),
    );
  }
  async entry(
    handle: string,
    noteId: number,
  ): Promise<SnapshotMember | null> {
    const result = await this.client.execute({
      sql: `SELECT note_id,snapshot_hash,NULL AS note_instance,NULL AS revision_id FROM blinko_ps_snapshot_notes WHERE handle=? AND note_id=?
        UNION ALL SELECT note_id,snapshot_hash,note_instance,revision_id FROM blinko_ps_snapshot_refs WHERE handle=? AND note_id=?`,
      args: [handle, noteId, handle, noteId],
    });
    const row = result.rows[0];
    return row ? { noteId, hash: String(row.snapshot_hash),
      ...(row.note_instance == null ? {} : { instance: String(row.note_instance), revisionId: String(row.revision_id) }) } : null;
  }
  async release(accountId: number, handle: string): Promise<void> {
    await this.transaction(async (tx) => {
      const own = await tx.execute({
        sql: "SELECT 1 FROM blinko_ps_snapshots WHERE handle=? AND account_id=?",
        args: [handle, accountId],
      });
      if (!own.rows.length) throw new ServiceError("NOT_FOUND_OR_FORBIDDEN");
      await tx.execute({ sql: 'DELETE FROM blinko_ps_snapshot_refs WHERE handle=?', args: [handle] });
      await tx.execute({
        sql: "DELETE FROM blinko_ps_snapshot_notes WHERE handle=?",
        args: [handle],
      });
      await tx.execute({
        sql: "DELETE FROM blinko_ps_snapshots WHERE handle=? AND account_id=?",
        args: [handle, accountId],
      });
      await collectRevisionGarbage(tx);
    });
  }
}
