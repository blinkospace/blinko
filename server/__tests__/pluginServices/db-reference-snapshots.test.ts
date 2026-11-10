import { beforeAll, afterAll, afterEach, test, expect } from 'bun:test';
import { PrismaClient } from '@prisma/client';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NoteQualificationRegistry } from '../../services/pluginServices/NoteQualification';
import { IndexLifecycle } from '../../services/pluginServices/IndexLifecycle';
import { VectorSnapshotStore } from '../../services/pluginServices/VectorSnapshotStore';
import { createVectorSnapshotService } from '../../services/pluginServices/VectorSnapshotService';
import { createQueryNoteSource } from '../../services/pluginServices/VectorQueryHost';
import { createPolicyStore } from '../../services/pluginServices/PolicyStore';
import { BODY_PREPROCESSING_VERSION, digest } from '../../services/pluginServices/BodyInput';
import type { IndexGeneration } from '../../services/pluginServices/types';
import type { VectorSnapshotDescriptor } from '../../../shared/lib/pluginServices/v1';
const db = new URL(process.env.DATABASE_URL ?? '');
if (process.env.B_CANDIDATE_PROBE !== '1' || db.hostname !== '127.0.0.1' || db.username !== 'candidate_owner' || db.pathname !== '/candidate_owned') throw Error('Dedicated synthetic database required');
const prisma = new PrismaClient(), registry = new NoteQualificationRegistry(prisma);
const client = createClient({ url: 'file:' + join(mkdtempSync(join(tmpdir(), 'blinko-reference-test-')), 'vectors.db') });
const audit = { bodies: 0, vectors: 0, proofs: 0, sql: [] as string[] };
function observed<T extends object>(object: T): T {
  return new Proxy(object, { get(target, key) {
    if (key === 'execute') return async (...args: any[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0].sql;
      audit.sql.push(sql);
      const result = await (target as any).execute(...args);
      for (const row of result.rows) { if ('embedding' in row) audit.vectors++; if ('proof' in row) audit.proofs++; }
      return result;
    };
    if (key === 'transaction') return async (...args: any[]) => observed(await (target as any).transaction(...args));
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
const store = new VectorSnapshotStore(observed(client));
const source = createQueryNoteSource(prisma), handles = new Set<string>();
const service = createVectorSnapshotService({ notes: { ...source,
  async readOwned(account, id) { audit.bodies++; return source.readOwned(account, id); },
  async page() { throw Error('Reference create must not call the legacy body scanner'); },
  async recheck() { throw Error('Reference scan must use qualification metadata'); },
  async stamp() { throw Error('Reference requests must use the durable PG fence'); },
}, qualifications: registry, withStore: async run => run(store), policyStore: createPolicyStore({ read: async () => null }),
  rateGate: { check: async (_a, limit) => ({ allowed: true, used: 0, limit }), acquire: async (_a, limit) => ({ allowed: true, used: 1, limit }) },
  async classifyMissing(accountId, noteId) { const note = await prisma.notes.findUnique({ where: { id: noteId }, select: { accountId: true, isRecycle: true } }); return !note || note.isRecycle || note.accountId === accountId ? 'missing' : 'forbidden'; },
  random: n => n - 1 });
const writer = new IndexLifecycle(client, { async readNote(id) { const n = await prisma.notes.findUnique({ where: { id } }); return n?.accountId == null ? null : { ...n, accountId: n.accountId }; }, async readInstance(id) { return (await registry.identity(id))?.instance ?? null; } });
let account: number, tag: number, generation: IndexGeneration;
const ids: number[] = [];
async function create(scope = {}) { const value = await service.create(account, { aggregation: 'note_level_weighted_v1', scope }); handles.add(value.handle); return value; }
async function release(handle: string) { await service.release(account, { handle }); handles.delete(handle); }
const query = (snapshot: VectorSnapshotDescriptor, noteId = ids[0]) => service.query(account, { source: { kind: 'note', noteId }, aggregation: 'note_level_weighted_v1', snapshotHandle: snapshot.handle, limit: 3 });
async function publish(id: number, vector: number[]) {
  const note = (await writer.source.readNote(id))!;
  await registry.ensureReady(account);
  expect(await writer.indexBody(note, generation, async values => ({ vectors: values.map(() => vector), tokenWeights: {
    version: 'provider-per-input-usage-v1', modelFingerprint: generation.modelFingerprint,
    sourceHash: digest([generation.preprocessingVersion, values]), counts: values.map(() => 17) } }))).toBe(true);
}
const resetAudit = () => { audit.bodies = audit.vectors = audit.proofs = 0; audit.sql.length = 0; };
beforeAll(async () => {
  account = (await prisma.accounts.create({ data: { name: 'synthetic-reference-owner' } })).id;
  for (let i = 0; i < 5; i++) ids.push((await prisma.notes.create({ data: { accountId: account, content: i === 4 ? '![image](local.png)' : `Synthetic reference ${i}`, createdAt: new Date('2026-01-01Z'), updatedAt: new Date('2026-01-02Z') } })).id);
  tag = (await prisma.tag.create({ data: { accountId: account, name: 'synthetic-reference-tag' } })).id;
  for (const id of ids.slice(0, 2)) await prisma.tagsToNote.create({ data: { noteId: id, tagId: tag } });
  expect((await registry.initialize()).ready).toBe(true);
  await writer.initialize();
  generation = await writer.createGeneration({ dimensions: 2, modelFingerprint: 'synthetic-no-provider', embeddingSpaceId: 'synthetic-reference-space', preprocessingVersion: BODY_PREPROCESSING_VERSION });
  for (let i = 0; i < 3; i++) await publish(ids[i], [[1, 0], [0, 1], [-1, 0]][i]);
  await writer.activateGeneration(generation.generation);
});
afterEach(async () => { for (const handle of [...handles]) await release(handle); });
afterAll(async () => { client.close(); await prisma.$disconnect(); });

test('warm create scans qualification metadata and writes references with zero body/proof/vector reads', async () => {
  resetAudit(); const snapshot = await create();
  expect(snapshot.preparedNoteCount).toBe(3);
  expect(snapshot.range).toEqual({ kind: 'prepared-subset', eligibleNoteCount: 4, unpreparedNoteCount: 1 });
  expect([audit.bodies, audit.vectors, audit.proofs]).toEqual([0, 0, 0]);
  expect(audit.sql.some(sql => /INSERT INTO blinko_ps_snapshot_refs/.test(sql))).toBe(true);
  expect(Number((await client.execute('SELECT COUNT(*) n FROM blinko_ps_snapshot_notes')).rows[0].n)).toBe(0);
});
test('sample counts the complete legal pool before exclusions and reads only its selected body', async () => {
  const snapshot = await create(); resetAudit();
  const sampled = await service.sample(account, { handle: snapshot.handle, excludeNoteIds: [ids[1], ids[2]] });
  expect(sampled.poolSize).toBe(3); expect(sampled.item?.note.id).toBe(ids[0]);
  expect([audit.bodies, audit.vectors, audit.proofs]).toEqual([1, 0, 0]);
});
test('readNote rechecks type, all-tags, archive and creation-time scope before exposing the body', async () => {
  const snapshot = await create({ types: [0], tagIds: [tag], tagMatch: 'all', createdFrom: '2025-01-01T00:00:00Z', createdBefore: '2027-01-01T00:00:00Z' });
  const member = (await store.entry(snapshot.handle, ids[0]))!;
  const original = await prisma.notes.findUniqueOrThrow({ where: { id: ids[0] } });
  const input = { handle: snapshot.handle, noteId: ids[0], snapshotHash: member.hash };
  expect((await service.readNote(account, input)).status).toBe('ok');
  for (const sql of [`UPDATE notes SET type=2 WHERE id=${ids[0]}`, `UPDATE notes SET "isArchived"=true WHERE id=${ids[0]}`, `UPDATE notes SET "createdAt"='2028-01-01' WHERE id=${ids[0]}`]) {
    await prisma.$executeRawUnsafe(sql); expect((await service.readNote(account, input)).status).toBe('forbidden');
    await prisma.$executeRaw`UPDATE notes SET type=0,"isArchived"=false,"createdAt"=${original.createdAt},"updatedAt"=${original.updatedAt} WHERE id=${ids[0]}::int`;
  }
  await prisma.tagsToNote.deleteMany({ where: { noteId: ids[0], tagId: tag } });
  expect((await service.readNote(account, input)).status).toBe('forbidden');
  await prisma.tagsToNote.create({ data: { noteId: ids[0], tagId: tag } });
  await registry.ensureReady(account);
  expect((await registry.identity(ids[0]))?.snapshotHash).toBe(member.hash);
});
test('new revisions stay out of old scenes; edited source uses frozen vector until last reference release', async () => {
  const old = await create(), member = (await store.entry(old.handle, ids[0]))!;
  await prisma.$executeRaw`UPDATE notes SET content='Synthetic edited source' WHERE id=${ids[0]}::int`;
  expect((await query(old)).items[0].score).toBe(0);
  await publish(ids[0], [0, 1]);
  const fresh = await create();
  expect((await query(old)).items[0].score).toBe(0);
  expect((await query(fresh)).items[0].score).toBe(1);
  expect((await client.execute({ sql: 'SELECT 1 FROM blinko_ps_note_vectors WHERE revision_id=?', args: [member.revisionId!] })).rows).toHaveLength(1);
  await release(old.handle);
  expect((await client.execute({ sql: 'SELECT 1 FROM blinko_ps_note_vectors WHERE revision_id=?', args: [member.revisionId!] })).rows).toHaveLength(0);
});
test('same-ID body/time recreation cannot revive an old member or source', async () => {
  const snapshot = await create(), member = (await store.entry(snapshot.handle, ids[2]))!;
  const note = await prisma.notes.findUniqueOrThrow({ where: { id: ids[2] } });
  await prisma.notes.delete({ where: { id: ids[2] } });
  await prisma.notes.create({ data: { id: note.id, accountId: account, content: note.content, createdAt: note.createdAt, updatedAt: note.updatedAt } });
  expect((await service.readNote(account, { handle: snapshot.handle, noteId: note.id, snapshotHash: member.hash })).status).toBe('missing');
  await expect(query(snapshot, note.id)).rejects.toHaveProperty('code', 'NOT_FOUND_OR_FORBIDDEN');
  const sample = await service.sample(account, { handle: snapshot.handle, excludeNoteIds: ids.slice(0, 2) });
  expect(sample).toEqual({ poolSize: 2, item: null });
});
test('shared vectors retain full logical quota per scene and immutable blobs reject update/replacement', async () => {
  const a = await create(), b = await create();
  const usage = (await client.execute('SELECT reserved_bytes FROM blinko_ps_snapshots ORDER BY handle')).rows.map(r => Number(r.reserved_bytes));
  expect(usage).toHaveLength(2); expect(usage.every(bytes => bytes > 2 * (2 * 4 + 128))).toBe(true);
  await expect(create()).rejects.toHaveProperty('code', 'QUERY_BUDGET_EXCEEDED');
  const member = (await store.entry(a.handle, ids[0]))!;
  await expect(client.execute({ sql: "UPDATE blinko_ps_note_vectors SET proof='{}' WHERE revision_id=?", args: [member.revisionId!] })).rejects.toThrow('immutable');
  await expect(client.execute({ sql: 'INSERT OR REPLACE INTO blinko_ps_note_vectors SELECT * FROM blinko_ps_note_vectors WHERE revision_id=?', args: [member.revisionId!] })).rejects.toThrow('immutable');
  await expect(client.execute({ sql: 'DELETE FROM blinko_ps_note_vectors WHERE revision_id=?', args: [member.revisionId!] })).rejects.toThrow('FOREIGN KEY');
});
test('explicit reinitialization rotates instances, and existing proven chunks can be certified without provider calls', async () => {
  const old = await create();
  expect((await registry.initialize()).ready).toBe(true);
  expect((await service.sample(account, { handle: old.handle })).poolSize).toBe(0);
  await expect(create()).rejects.toHaveProperty('code', 'INDEX_NOT_READY');
  for (const id of ids.slice(0, 2)) expect(await writer.certifyExisting((await writer.source.readNote(id))!, generation)).toBe(true);
  const fresh = await create(); expect(fresh.preparedNoteCount).toBe(2);
  expect((await service.sample(account, { handle: old.handle })).poolSize).toBe(0);
  const note = (await writer.source.readNote(ids[3]))!;
  await writer.indexBody(note, generation, async values => values.map(() => [1, 0]));
  await expect(writer.certifyExisting(note, generation)).rejects.toHaveProperty('code', 'SOURCE_NOT_INDEXED');
});

test('an oversized edited source retains its frozen vector while a new scene still enforces the original body bound', async () => {
  const snapshot = await create(), original = await prisma.notes.findUniqueOrThrow({ where: { id: ids[0] } });
  try {
    await prisma.$executeRaw`UPDATE notes SET content=${'x'.repeat(4 * 1024 * 1024 + 1)} WHERE id=${ids[0]}::int`;
    const result = await query(snapshot); expect(result.items.map(x => x.note.id)).toEqual([ids[1]]); expect(result.items[0].score).toBe(1);
    await expect(create()).rejects.toHaveProperty('code', 'QUERY_BUDGET_EXCEEDED');
  } finally { await prisma.$executeRaw`UPDATE notes SET content=${original.content} WHERE id=${ids[0]}::int`; }
});

test('retained copied snapshot rows remain consumable through the qualified service after metadata migration', async () => {
  const legacy = createVectorSnapshotService({ notes: source, withStore: async run => run(store), policyStore: createPolicyStore({ read: async () => null }),
    rateGate: { check: async (_a, limit) => ({ allowed: true, used: 0, limit }), acquire: async (_a, limit) => ({ allowed: true, used: 1, limit }) },
    async classifyMissing() { return 'missing'; } });
  await registry.ensureReady(account);
  const snapshot = await legacy.create(account, { aggregation: 'note_level_weighted_v1', scope: { tagIds: [tag] } }); handles.add(snapshot.handle);
  expect(snapshot.preparedNoteCount).toBe(2); expect((await store.entry(snapshot.handle, ids[0]))?.instance).toBeUndefined();
  expect((await service.sample(account, { handle: snapshot.handle })).poolSize).toBe(2);
  expect((await query(snapshot)).items[0].note.id).toBe(ids[1]);
});

test('a real PG mutation after metadata capture rejects create and releases all reserved references', async () => {
  let mutated = false;
  const qualifications = new Proxy(registry, { get(target, key) {
    if (key === 'page') return async (...args: Parameters<typeof registry.page>) => {
      const rows = await target.page(...args);
      if (!mutated) { mutated = true; await prisma.$executeRaw`UPDATE notes SET "isArchived"=true WHERE id=${ids[0]}::int`; }
      return rows;
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const raced = createVectorSnapshotService({ notes: source, qualifications, withStore: async run => run(store), policyStore: createPolicyStore({ read: async () => null }),
    rateGate: { check: async (_a, limit) => ({ allowed: true, used: 0, limit }), acquire: async (_a, limit) => ({ allowed: true, used: 1, limit }) },
    async classifyMissing() { return 'missing'; } });
  try {
    await expect(raced.create(account, { aggregation: 'note_level_weighted_v1' })).rejects.toHaveProperty('code', 'INDEX_CHANGED');
    expect(Number((await client.execute('SELECT COUNT(*) n FROM blinko_ps_snapshots')).rows[0].n)).toBe(0);
    expect(Number((await client.execute('SELECT COUNT(*) n FROM blinko_ps_snapshot_refs')).rows[0].n)).toBe(0);
  } finally { await prisma.$executeRaw`UPDATE notes SET "isArchived"=false WHERE id=${ids[0]}::int`; }
});
