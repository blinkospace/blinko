import type { Transaction } from '@libsql/client';
import type { IndexGeneration, RevisionLease } from './types';
export const REVISION_CERTIFICATE_VERSION = 'immutable-f32-token-weight-v1';
/** Called only after the writer validated weights and produced the F32 aggregate.
 * Old rows receive no certificate merely because metadata was migrated. */
export async function writeRevisionCertificate(tx: Transaction, lease: RevisionLease, generation: IndexGeneration, vector: Uint8Array, proof: string): Promise<void> {
  if (!lease.noteInstance) return;
  const encoder = new TextEncoder();
  const certificateBytes = encoder.encode(JSON.stringify({ revision: lease.revisionId, instance: lease.noteInstance,
    note: lease.noteId, account: lease.accountId, hash: lease.noteSnapshotHash, sourceHash: lease.sourceHash,
    generation: generation.generation, version: REVISION_CERTIFICATE_VERSION })).byteLength;
  // Includes the proof, certificate and a conservatively bounded per-scene reference.
  // Each scene pays the full logical payload even though the physical vector is shared.
  const logicalBytes = Math.max(vector.byteLength + 128, vector.byteLength + encoder.encode(proof).byteLength + certificateBytes + 256);
  await tx.execute({ sql: `INSERT INTO blinko_ps_vector_certificates(revision_id,note_instance,certificate_version,logical_bytes) VALUES(?,?,?,?)`,
    args: [lease.revisionId, lease.noteInstance, REVISION_CERTIFICATE_VERSION, logicalBytes] });
}
/** Current published vectors survive. Superseded vectors survive until their last
 * building/ready reference is removed in the same release/prune transaction. */
export async function collectRevisionGarbage(tx: Transaction): Promise<void> {
  await tx.execute(`DELETE FROM blinko_ps_note_vectors WHERE revision_id IN
    (SELECT revision_id FROM blinko_ps_revisions WHERE state='discarded')
    AND NOT EXISTS(SELECT 1 FROM blinko_ps_snapshot_refs f WHERE f.revision_id=blinko_ps_note_vectors.revision_id)`);
}
