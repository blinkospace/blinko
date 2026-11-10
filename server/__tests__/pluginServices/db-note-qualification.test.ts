import { afterAll, beforeAll, expect, test, spyOn } from 'bun:test';
import { PrismaClient } from '@prisma/client';
import { NoteQualificationRegistry, QUALIFICATION_RULE } from '../../services/pluginServices/NoteQualification';
import { fingerprintNoteSnapshot } from '../../services/pluginServices/BodyInput';
const url = new URL(process.env.DATABASE_URL ?? '');
if (process.env.B_CANDIDATE_PROBE !== '1' || url.hostname !== '127.0.0.1' || url.username !== 'candidate_owner' || url.pathname !== '/candidate_owned')
  throw Error('Dedicated synthetic non-super database required');
const prisma = new PrismaClient(), registry = new NoteQualificationRegistry(prisma);
let a: number, other: number, first: number, empty: number, tagged: number, tag: number;
const selection = { scope: {}, excludeNoteIds: [] };
beforeAll(async () => {
  a = (await prisma.accounts.create({ data: { name: 'qualification-owner' } })).id;
  other = (await prisma.accounts.create({ data: { name: 'qualification-other' } })).id;
  first = (await prisma.notes.create({ data: { accountId: a, content: 'First synthetic note' } })).id;
  empty = (await prisma.notes.create({ data: { accountId: a, content: '![only image](local.png)' } })).id;
  tagged = (await prisma.notes.create({ data: { accountId: a, content: 'Tagged synthetic note', type: 1 } })).id;
  tag = (await prisma.tag.create({ data: { accountId: a, name: 'qualification-synthetic-tag' } })).id;
  await prisma.tagsToNote.create({ data: { noteId: tagged, tagId: tag } });
});
afterAll(async () => { await prisma.$disconnect(); });

test('partial initialization stays untrusted; complete initialization is explicit', async () => {
  await expect(registry.stamp(a)).rejects.toHaveProperty('code', 'INDEX_NOT_READY');
  expect((await registry.initialize({ maxNotes: 1 })).ready).toBe(false);
  const instance = (await prisma.$queryRaw<Array<{ instance: string }>>`SELECT instance::text FROM plugin_note_qualification WHERE "noteId"=${first}::int`)[0].instance;
  await expect(registry.stamp(a)).rejects.toHaveProperty('code', 'INDEX_NOT_READY');
  const resumed = await registry.initialize({ maxNotes: 1 }); expect(resumed.ready).toBe(false); expect(resumed.pending).toBe(1);
  expect((await registry.initialize({ maxNotes: 32 })).ready).toBe(true);
  expect((await registry.identity(first))?.instance).toBe(instance);
  expect(await registry.pending()).toBe(0);
});
test('metadata retains complete scope and usability without returning content', async () => {
  const notes = await registry.page(a, selection, 0, 128);
  expect(notes).toHaveLength(3);
  expect(notes.every(n => !('content' in n))).toBe(true);
  expect(notes.find(n => n.id === empty)?.usableBody).toBe(false);
  const matched = await registry.page(a, { scope: { types: [1], tagIds: [tag], tagMatch: 'all' }, excludeNoteIds: [] }, 0, 128);
  expect(matched.map(n => n.id)).toEqual([tagged]);
  expect(await registry.page(other, selection, 0, 128)).toEqual([]);
});
test('body write with original updatedAt dirties qualification; bounded maintenance recomputes exact host hash', async () => {
  const before = await registry.stamp(a);
  await prisma.$executeRaw`UPDATE notes SET content='Updated synthetic body' WHERE id=${first}::int`;
  expect(await registry.pending(a)).toBe(1);
  expect(await registry.stamp(a)).not.toBe(before);
  await registry.ensureReady(a);
  const note = await prisma.notes.findUniqueOrThrow({ where: { id: first } });
  expect((await registry.identity(first))?.snapshotHash).toBe(fingerprintNoteSnapshot({ ...note, accountId: a }));
  expect(await registry.pending(a)).toBe(0);
});
test('a concurrent writer between capture and certification wins the version CAS', async () => {
  await prisma.$executeRaw`UPDATE notes SET content='Captured synthetic body' WHERE id=${first}::int`;
  let fired = false;
  const proxy = new Proxy(prisma, { get(target, key) {
    if (key === '$transaction') return async (...args: unknown[]) => {
      if (!fired) { fired = true; await prisma.$executeRaw`UPDATE notes SET content='Newer concurrent body' WHERE id=${first}::int`; }
      return (target.$transaction as Function).apply(target, args);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  expect(await new NoteQualificationRegistry(proxy).certifyBatch(a, 4)).toEqual({ read: 1, certified: 0 });
  expect(await registry.pending(a)).toBe(1);
  await registry.ensureReady(a);
});
test('tag ownership invalidates the same account fence and scope; no cross-account tag leak', async () => {
  const before = await registry.stamp(a);
  await prisma.tag.update({ where: { id: tag }, data: { accountId: other } });
  expect(await registry.stamp(a)).not.toBe(before);
  await registry.ensureReady(a);
  expect(await registry.page(a, { scope: { tagIds: [tag] }, excludeNoteIds: [] }, 0, 128)).toEqual([]);
});
test('same-ID recreation gets a new instance even with restored body and times', async () => {
  const note = await prisma.notes.findUniqueOrThrow({ where: { id: first } }), identity = await registry.identity(first);
  await prisma.notes.delete({ where: { id: first } });
  await prisma.notes.create({ data: { id: first, accountId: a, content: note.content, createdAt: note.createdAt, updatedAt: note.updatedAt } });
  await registry.ensureReady(a);
  const rebuilt = await registry.identity(first);
  expect(rebuilt?.instance).not.toBe(identity?.instance);
  expect(rebuilt?.snapshotHash).toBe(identity?.snapshotHash);
});
test('disable then re-enable does not restore trust; explicit reinitialization repairs missed writes', async () => {
  await prisma.$executeRawUnsafe('ALTER TABLE notes DISABLE TRIGGER blinko_ps_note_qualification_change');
  await prisma.$executeRaw`UPDATE notes SET content='Changed while disabled' WHERE id=${first}::int`;
  await prisma.$executeRawUnsafe('ALTER TABLE notes ENABLE TRIGGER blinko_ps_note_qualification_change');
  await expect(registry.stamp(a)).rejects.toHaveProperty('code', 'INDEX_NOT_READY');
  expect((await registry.initialize({ maxNotes: 32 })).ready).toBe(true);
  const row = await prisma.notes.findUniqueOrThrow({ where: { id: first } });
  expect((await registry.identity(first))?.snapshotHash).toBe(fingerprintNoteSnapshot({ ...row, accountId: a }));
});
test('metadata marker alone preserves certificate, while privilege attributes remain ordinary', async () => {
  const before = await registry.stamp(a);
  await prisma.$executeRaw`UPDATE notes SET metadata='{"isIndexed":true}'::json WHERE id=${first}::int`;
  expect(await registry.stamp(a)).toBe(before);
  const role = await prisma.$queryRaw<Array<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>>`
    SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`;
  expect(role[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
});

test('ordinary time/type/archive/recycle/ownership DML invalidates qualification and both ownership fences', async () => {
  const row = async () => (await prisma.$queryRaw<Array<{ version: bigint; state: string; instance: string }>>`SELECT version,state,instance::text FROM plugin_note_qualification WHERE "noteId"=${first}::int`)[0];
  for (const mutate of [
    () => prisma.$executeRaw`UPDATE notes SET "createdAt"="createdAt"+interval '1 second' WHERE id=${first}::int`,
    () => prisma.$executeRaw`UPDATE notes SET "updatedAt"="updatedAt"+interval '1 second' WHERE id=${first}::int`,
    () => prisma.$executeRaw`UPDATE notes SET type=1 WHERE id=${first}::int`,
    () => prisma.$executeRaw`UPDATE notes SET "isArchived"=true WHERE id=${first}::int`,
    () => prisma.$executeRaw`UPDATE notes SET "isRecycle"=true WHERE id=${first}::int`,
    () => prisma.$executeRaw`UPDATE notes SET "isRecycle"=false WHERE id=${first}::int`,
  ]) {
    const before = await row(), fence = await registry.stamp(a); await mutate(); const after = await row();
    expect(after.state).toBe('dirty'); expect(after.version).toBe(before.version + 1n); expect(await registry.stamp(a)).not.toBe(fence);
    await registry.certifyBatch(null);
  }
  const beforeA = await registry.stamp(a), beforeB = await registry.stamp(other);
  await prisma.$executeRaw`UPDATE notes SET "accountId"=${other}::int WHERE id=${first}::int`;
  expect(await registry.stamp(a)).not.toBe(beforeA); expect(await registry.stamp(other)).not.toBe(beforeB);
  expect(await registry.recheck(a, { scope: { includeArchived: true }, excludeNoteIds: [] }, [first])).toEqual([]);
  await prisma.$executeRaw`UPDATE notes SET "accountId"=NULL WHERE id=${first}::int`; await registry.certifyBatch(null);
  expect(await registry.pending()).toBe(0);
  await prisma.$executeRaw`UPDATE notes SET "accountId"=${a}::int WHERE id=${first}::int`; await registry.certifyBatch(null);
});

test('ordinary primary-key DML rotates the durable instance and removes the previous identity', async () => {
  const original = await registry.identity(first), next = first + 100000;
  expect(await prisma.notes.findUnique({ where: { id: next } })).toBeNull();
  await prisma.$executeRaw`UPDATE notes SET id=${next}::int WHERE id=${first}::int`; await registry.certifyBatch(null);
  expect(await registry.identity(first)).toBeNull(); expect((await registry.identity(next))?.instance).not.toBe(original?.instance);
  await prisma.$executeRaw`UPDATE notes SET id=${first}::int WHERE id=${next}::int`; await registry.certifyBatch(null);
  expect((await registry.identity(first))?.instance).not.toBe(original?.instance);
});

test('more than four dirty notes reject request repair without reading bodies; explicit maintenance completes them', async () => {
  await prisma.notes.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ accountId: a, content: `Synthetic dirty repair ${i}` })) });
  const certify = spyOn(registry, 'certifyBatch');
  try { await expect(registry.ensureReady(a)).rejects.toHaveProperty('code', 'INDEX_NOT_READY'); expect(certify).not.toHaveBeenCalled(); }
  finally { certify.mockRestore(); }
  expect((await registry.maintain()).ready).toBe(true); expect(await registry.pending()).toBe(0);
});
