import { afterAll, expect, test } from 'bun:test';
import { PrismaClient } from '@prisma/client';
import { createClient } from '@libsql/client';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IndexLifecycle } from '../../services/pluginServices/IndexLifecycle';
import { createVectorSnapshotService } from '../../services/pluginServices/VectorSnapshotService';
import { VectorSnapshotStore } from '../../services/pluginServices/VectorSnapshotStore';
import { createQueryNoteSource } from '../../services/pluginServices/VectorQueryHost';
import { createPolicyStore } from '../../services/pluginServices/PolicyStore';
import { createAccountRateGate } from '../../services/pluginServices/CallPolicy';
import { BODY_PREPROCESSING_VERSION, fingerprintNoteSnapshot, digest } from '../../services/pluginServices/BodyInput';
import { NOTE_AGGREGATION, TOKEN_WEIGHT_VERSION } from '../../services/pluginServices/NoteAggregation';
import { VECTOR_QUERY_BUDGET } from '../../services/pluginServices/vectorSchemas';
import { VECTOR_SNAPSHOT_LIMITS, type VectorSnapshotDescriptor } from '../../../shared/lib/pluginServices/v1';

if (process.env.PLUGIN_SERVICES_TEST_DB !== '1' || !process.env.DATABASE_URL) throw Error('Isolated PG required');
const db = new URL(process.env.DATABASE_URL);
if (db.hostname !== '127.0.0.1' || db.username !== 'blinko_test') throw Error('Owned synthetic PG required');
globalThis.fetch = Object.assign(async () => { throw Error('External HTTP forbidden'); }, {
  preconnect() { throw Error('External HTTP forbidden'); },
});
const prisma = new PrismaClient(), accounts: number[] = [], ids: number[] = [];
const url = 'file:' + join(mkdtempSync(join(tmpdir(), 'blinko-read-bound-')), 'vectors.db');
const client = createClient({ url }), store = new VectorSnapshotStore(client);
const notes = createQueryNoteSource(prisma), rateGate = createAccountRateGate({ prisma });
const service = createVectorSnapshotService({
  notes, policyStore: createPolicyStore({ read: async () => ({ readNoteRequestsPerMinute: 20 }) }), rateGate,
  withStore: async run => {
    const connection = createClient({ url });
    try { return await run(new VectorSnapshotStore(connection)); } finally { connection.close(); }
  },
  classifyMissing: async () => 'missing',
});
afterAll(async () => {
  client.close();
  await prisma.notes.deleteMany({ where: { id: { in: ids } } });
  await prisma.pluginServiceRate.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.accounts.deleteMany({ where: { id: { in: accounts } } });
  await prisma.$disconnect();
});

test('four concurrent exact-4MiB Unicode reads stay bounded and private; an extra byte is rejected', async () => {
  for (let i = 0; i < 2; i++) accounts.push((await prisma.accounts.create({ data: { name: 'synthetic-large-read-' + crypto.randomUUID() } })).id);
  const body = '界'.repeat(Math.floor(VECTOR_QUERY_BUDGET.maxNoteBytes / 3)) + 'a';
  expect(Buffer.byteLength(body)).toBe(VECTOR_QUERY_BUDGET.maxNoteBytes);
  const note = await prisma.notes.create({ data: { accountId: accounts[0], content: body, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02') } });
  ids.push(note.id);
  const current = (await notes.readOwned(accounts[0], note.id))!;
  const writer = new IndexLifecycle(client, { readNote: async () => null });
  await writer.initialize();
  const generation = await writer.createGeneration({ dimensions: 3, embeddingSpaceId: 'synthetic-bounded-read', modelFingerprint: 'synthetic-read-only', preprocessingVersion: BODY_PREPROCESSING_VERSION });
  await writer.activateGeneration(generation.generation);
  // This is an explicitly seeded immutable snapshot for the read path. It does
  // not test embedding, indexing or service.create on a 4MiB corpus.
  const handle = await store.reserve(accounts[0]), hash = fingerprintNoteSnapshot(current, generation.preprocessingVersion);
  const descriptor: VectorSnapshotDescriptor = {
    handle, expiresAt: new Date(Date.now() + VECTOR_SNAPSHOT_LIMITS.ttlMs).toISOString(), preparedNoteCount: 1,
    range: { kind: 'prepared-subset', eligibleNoteCount: 1, unpreparedNoteCount: 0 },
    index: { embeddingSpaceId: generation.embeddingSpaceId, generation: generation.generation, corpusRevision: crypto.randomUUID(), coverage: 'partial', provenance: 'verified' },
    scoring: { aggregation: NOTE_AGGREGATION, version: digest([NOTE_AGGREGATION, TOKEN_WEIGHT_VERSION, generation.modelFingerprint, generation.preprocessingVersion]), weightSource: TOKEN_WEIGHT_VERSION, preprocessingVersion: generation.preprocessingVersion, modelFingerprint: generation.modelFingerprint },
  };
  try {
    await store.add(handle, accounts[0], [{ noteId: note.id, hash, vector: [1, 0, 0] }]);
    await store.publish(accounts[0], { descriptor, scope: {}, dimensions: 3 });
    const input = { handle, noteId: note.id, snapshotHash: hash };
    const baselineRssBytes = process.memoryUsage().rss, started = performance.now();
    const results = await Promise.all(Array.from({ length: 4 }, () => service.readNote(accounts[0], input)));
    const totalMs = performance.now() - started, afterRssBytes = process.memoryUsage().rss;
    for (const result of results) {
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw Error('Unexpected read status');
      expect(result.id).toBe(note.id); expect(result.accountId).toBe(accounts[0]);
      expect(result.snapshotHash).toBe(hash); expect(Buffer.byteLength(result.content)).toBe(4194304);
    }
    await expect(service.readNote(accounts[1], input)).rejects.toMatchObject({ code: 'NOT_FOUND_OR_FORBIDDEN' });
    await prisma.notes.update({ where: { id: note.id }, data: { content: body + 'x' } });
    await expect(service.readNote(accounts[0], input)).rejects.toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED' });
    const row = await prisma.pluginServiceRate.findFirstOrThrow({ where: { accountId: accounts[0] } });
    expect(row).toMatchObject({ used: 5, readNoteUsed: 5, sharedUsed: 0 });
    console.log(JSON.stringify({ boundedReadEvidence: { bodyBytes: 4194304, simultaneousReads: 4, totalMs, baselineRssBytes, afterRssBytes, rssBoundary: 'Before/after process RSS only, not peak; includes fixture/native libraries. Service-level read fixture, not whole-corpus creation or HTTP.', oversizedByteRejected: true, foreignReadRejected: true, providerCalls: 0 } }));
  } finally { await service.release(accounts[0], { handle }); }
  expect(Number((await client.execute('SELECT COUNT(*) AS n FROM blinko_ps_snapshots')).rows[0].n)).toBe(0);
  expect(Number((await client.execute('SELECT COUNT(*) AS n FROM blinko_ps_snapshot_notes')).rows[0].n)).toBe(0);
}, 20000);
