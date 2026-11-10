import type { Client } from "@libsql/client";
import { ServiceError } from "./errors";

export const INDEX_SCHEMA_VERSION = 2;
// Explicit writer/maintenance entry only. Readers never run schema migrations.
export async function migrateIndexMetadata(client: Client): Promise<void> {
  await client.execute('PRAGMA foreign_keys=ON');
  const exists = await client.execute(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='blinko_ps_meta'",
  );
  if (exists.rows.length) {
    const row = await client.execute(
      "SELECT schema_version FROM blinko_ps_meta WHERE id=1",
    );
    if (
      row.rows.length &&
      ![1, INDEX_SCHEMA_VERSION].includes(Number(row.rows[0].schema_version))
    )
      throw new ServiceError("INDEX_NOT_READY");
  }
  await client.batch(
    [...`
    CREATE TABLE IF NOT EXISTS blinko_ps_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, active_generation TEXT);
    INSERT OR IGNORE INTO blinko_ps_meta(id,schema_version) VALUES(1,1);
    CREATE TABLE IF NOT EXISTS blinko_ps_generations (
      generation TEXT PRIMARY KEY, space_id TEXT NOT NULL, dimensions INTEGER NOT NULL CHECK(dimensions>0),
      model_fingerprint TEXT NOT NULL, preprocessing_version TEXT NOT NULL,
      table_name TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('building','ready')));
    CREATE TABLE IF NOT EXISTS blinko_ps_heads (
      account_id INTEGER NOT NULL, note_id INTEGER NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
      tombstone INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account_id,note_id));
    CREATE TABLE IF NOT EXISTS blinko_ps_revisions (
      revision_id TEXT PRIMARY KEY, account_id INTEGER NOT NULL, note_id INTEGER NOT NULL,
      generation TEXT NOT NULL REFERENCES blinko_ps_generations(generation),
      snapshot_hash TEXT NOT NULL, source_hash TEXT NOT NULL, chunk_count INTEGER NOT NULL CHECK(chunk_count>=0),
      epoch INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('writing','staged','published','discarded')),
      provenance TEXT NOT NULL CHECK(provenance IN ('verified','legacy-attested')),
      old_revisions TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS blinko_ps_revision_lookup ON blinko_ps_revisions(account_id,note_id,generation,state);
    CREATE TABLE IF NOT EXISTS blinko_ps_legacy (
      vector_id TEXT PRIMARY KEY, account_id INTEGER NOT NULL, note_id INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS blinko_ps_attestations (
      revision_id TEXT PRIMARY KEY, administrator_id INTEGER NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS blinko_ps_corpora (
      account_id INTEGER NOT NULL,generation TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(account_id,generation));
    CREATE TABLE IF NOT EXISTS blinko_ps_note_vectors (
      revision_id TEXT PRIMARY KEY, account_id INTEGER NOT NULL, note_id INTEGER NOT NULL,
      generation TEXT NOT NULL, snapshot_hash TEXT NOT NULL, embedding BLOB NOT NULL, proof TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS blinko_ps_note_vector_lookup ON blinko_ps_note_vectors(account_id,generation,note_id);
    CREATE TABLE IF NOT EXISTS blinko_ps_snapshots (
      handle TEXT PRIMARY KEY, account_id INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('building','ready','expired')),
      expires_at INTEGER NOT NULL, reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
      written_bytes INTEGER NOT NULL DEFAULT 0 CHECK(written_bytes>=0), note_count INTEGER NOT NULL DEFAULT 0 CHECK(note_count>=0), descriptor TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS blinko_ps_snapshot_expiry ON blinko_ps_snapshots(expires_at);
    CREATE INDEX IF NOT EXISTS blinko_ps_snapshot_account ON blinko_ps_snapshots(account_id);
    CREATE TABLE IF NOT EXISTS blinko_ps_snapshot_notes (
      handle TEXT NOT NULL, note_id INTEGER NOT NULL, snapshot_hash TEXT NOT NULL, embedding BLOB NOT NULL,
      PRIMARY KEY(handle,note_id));
  `
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean),
      `CREATE TABLE IF NOT EXISTS blinko_ps_revision_instances (
        revision_id TEXT PRIMARY KEY REFERENCES blinko_ps_revisions(revision_id) ON DELETE CASCADE, note_instance TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS blinko_ps_vector_certificates (
        revision_id TEXT PRIMARY KEY REFERENCES blinko_ps_note_vectors(revision_id) ON DELETE CASCADE,
        note_instance TEXT NOT NULL, certificate_version TEXT NOT NULL, logical_bytes INTEGER NOT NULL CHECK(logical_bytes>0))`,
      `CREATE TABLE IF NOT EXISTS blinko_ps_snapshot_refs (
        handle TEXT NOT NULL REFERENCES blinko_ps_snapshots(handle) ON DELETE CASCADE,
        note_id INTEGER NOT NULL, revision_id TEXT NOT NULL REFERENCES blinko_ps_note_vectors(revision_id),
        snapshot_hash TEXT NOT NULL,note_instance TEXT NOT NULL,PRIMARY KEY(handle,note_id))`,
      'CREATE INDEX IF NOT EXISTS blinko_ps_snapshot_ref_revision ON blinko_ps_snapshot_refs(revision_id)',
      `CREATE TRIGGER IF NOT EXISTS blinko_ps_note_vector_immutable BEFORE UPDATE ON blinko_ps_note_vectors
        BEGIN SELECT RAISE(ABORT,'immutable note revision'); END`,
      `CREATE TRIGGER IF NOT EXISTS blinko_ps_note_vector_no_replace BEFORE INSERT ON blinko_ps_note_vectors
        WHEN EXISTS(SELECT 1 FROM blinko_ps_note_vectors WHERE revision_id=NEW.revision_id)
        BEGIN SELECT RAISE(ABORT,'immutable note revision'); END`,
      `CREATE TRIGGER IF NOT EXISTS blinko_ps_certificate_immutable BEFORE UPDATE ON blinko_ps_vector_certificates
        BEGIN SELECT RAISE(ABORT,'immutable revision certificate'); END`,
      `CREATE TRIGGER IF NOT EXISTS blinko_ps_certificate_no_replace BEFORE INSERT ON blinko_ps_vector_certificates
        WHEN EXISTS(SELECT 1 FROM blinko_ps_vector_certificates WHERE revision_id=NEW.revision_id)
        BEGIN SELECT RAISE(ABORT,'immutable revision certificate'); END`,
      'UPDATE blinko_ps_meta SET schema_version=2 WHERE id=1',
    ],
    "write",
  );
}

// Explicit metadata rollback retains all vector tables and their contents.
export async function rollbackIndexMetadata(client: Client): Promise<void> {
  await client.batch(
    `
    DROP TABLE IF EXISTS blinko_ps_snapshot_refs;
    DROP TABLE IF EXISTS blinko_ps_vector_certificates;
    DROP TABLE IF EXISTS blinko_ps_revision_instances;
    DROP TABLE IF EXISTS blinko_ps_snapshot_notes;
    DROP TABLE IF EXISTS blinko_ps_snapshots;
    DROP TABLE IF EXISTS blinko_ps_note_vectors;
    DROP TABLE IF EXISTS blinko_ps_attestations;
    DROP TABLE IF EXISTS blinko_ps_legacy;
    DROP TABLE IF EXISTS blinko_ps_corpora;
    DROP TABLE IF EXISTS blinko_ps_revisions;
    DROP TABLE IF EXISTS blinko_ps_heads;
    DROP TABLE IF EXISTS blinko_ps_generations;
    DROP TABLE IF EXISTS blinko_ps_meta;
  `
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean),
    "write",
  );
}
