import { afterAll, afterEach, expect, test } from 'bun:test';
import { prisma } from '../../prisma';
import { hostNoteSource } from '../../services/pluginServices/HostIndex';
import { createClient } from '@libsql/client';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IndexLifecycle } from '../../services/pluginServices/IndexLifecycle';
import { NoteQualificationRegistry } from '../../services/pluginServices/NoteQualification';
import { VectorSnapshotStore, type SnapshotEnvelope, type SnapshotReference } from '../../services/pluginServices/VectorSnapshotStore';
import { prepareBodyInput, BODY_PREPROCESSING_VERSION, digest } from '../../services/pluginServices/BodyInput';
import { VECTOR_SNAPSHOT_LIMITS } from '../../../shared/lib/pluginServices/v1';
const db = new URL(process.env.DATABASE_URL ?? '');
if (process.env.B_CANDIDATE_PROBE !== '1' || db.hostname !== '127.0.0.1' || db.username !== 'candidate_owner' || db.pathname !== '/candidate_owned') throw Error('Dedicated synthetic process test database required');
const registry = new NoteQualificationRegistry(prisma);
const connections: ReturnType<typeof createClient>[] = [];
afterEach(() => { for (const client of connections.splice(0)) client.close(); });
afterAll(async () => { await prisma.$disconnect(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'blinko-reference-process-'));
  mkdirSync(join(root, '.blinko/vector'), { recursive: true });
  const url = 'file:' + join(root, '.blinko/vector/embeddings.db'), client = createClient({ url }); connections.push(client);
  const account = (await prisma.accounts.create({ data: { name: 'reference-process-' + root.split('/').at(-1) } })).id;
  const note = await prisma.notes.create({ data: { accountId: account, content: 'Synthetic durable process body' } });
  expect((await registry.initialize()).ready).toBe(true);
  const clock = { now: Date.now() };
  const source = hostNoteSource;
  const writer = new IndexLifecycle(client, source, () => new Date(clock.now)), store = new VectorSnapshotStore(client, () => clock.now);
  await writer.initialize();
  const generation = await writer.createGeneration({ dimensions: 2, embeddingSpaceId: 'synthetic-durable-process', modelFingerprint: 'synthetic-no-provider', preprocessingVersion: BODY_PREPROCESSING_VERSION });
  const body = await prepareBodyInput({ ...note, accountId: account });
  const witness = { version: 'provider-per-input-usage-v1' as const, modelFingerprint: generation.modelFingerprint, sourceHash: body.sourceHash, counts: body.values.map(() => 17) };
  async function publish(vector = [1, 0]) { const lease = await writer.beginRevision({ ...note, accountId: account }, generation, body); await writer.stageRevision(lease, generation, body, body.values.map(() => vector), 'verified', witness); expect(await writer.publishRevision(lease, generation)).toBe(true); return lease; }
  const first = await publish(); await writer.activateGeneration(generation.generation);
  const member: SnapshotReference = { noteId: note.id, hash: body.noteSnapshotHash, revisionId: first.revisionId, instance: (await registry.identity(note.id))!.instance };
  function envelope(handle: string, count = 1): SnapshotEnvelope { return { dimensions: 2, scope: {}, descriptor: { handle, preparedNoteCount: count, expiresAt: new Date(clock.now + VECTOR_SNAPSHOT_LIMITS.ttlMs).toISOString(), range: { kind: 'prepared-subset', eligibleNoteCount: count, unpreparedNoteCount: 0 }, index: { generation: generation.generation, embeddingSpaceId: generation.embeddingSpaceId, corpusRevision: 'synthetic-process-corpus', coverage: 'partial', provenance: 'verified' }, scoring: { aggregation: 'note_level_weighted_v1', version: digest(['synthetic-process-scoring']), weightSource: 'provider-per-input-usage-v1', modelFingerprint: generation.modelFingerprint, preprocessingVersion: generation.preprocessingVersion } } }; }
  async function ready() { const handle = await store.reserve(account); await store.addReferences(handle, account, [member]); await store.publish(account, envelope(handle)); return handle; }
  async function run(mode: string, extra: Record<string, unknown> = {}) {
    const spec = join(root, mode + '-' + crypto.randomUUID() + '.json');
    writeFileSync(spec, JSON.stringify({ url, now: clock.now, accountId: account, ...extra }));
    const worker = Bun.spawn([process.execPath, resolve(import.meta.dir, 'helpers/reference-process-worker.ts'), mode, spec], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited]);
    return { exit, stdout, stderr, spec };
  }
  const parent = (handle: string) => client.execute({ sql: 'SELECT * FROM blinko_ps_snapshots WHERE handle=?', args: [handle] }).then(r => r.rows[0]);
  const vector = (revision = first.revisionId) => client.execute({ sql: 'SELECT 1 FROM blinko_ps_note_vectors WHERE revision_id=?', args: [revision] }).then(r => r.rows.length);
  return { root, url, client, account, note, body, witness, clock, writer, store, generation, first, member, envelope, publish, ready, run, parent, vector };
}

test('reserve committed before process exit retains building quota until real prune', async () => {
  const f = await fixture(), worker = await f.run('reserve-after'); expect(worker.exit).toBe(86);
  const { handle } = JSON.parse(readFileSync(worker.spec + '.handle.json', 'utf8'));
  expect(Number((await f.parent(handle)).reserved_bytes)).toBe(VECTOR_SNAPSHOT_LIMITS.maxSnapshotBytes);
  f.clock.now += 30_001; await f.store.reserve(f.account);
  expect((await f.parent(handle)).state).toBe('expired'); expect(Number((await f.parent(handle)).reserved_bytes)).toBe(0);
});
test('reference insert before commit exits atomically and preserves the earlier reservation', async () => {
  const f = await fixture(), handle = await f.store.reserve(f.account);
  expect((await f.run('refs-before', { handle, members: [f.member] })).exit).toBe(86);
  expect(await f.store.page(handle, 0)).toEqual([]);
  const row = await f.parent(handle); expect(row.state).toBe('building'); expect(Number(row.written_bytes)).toBe(0);
  expect(Number(row.reserved_bytes)).toBe(VECTOR_SNAPSHOT_LIMITS.maxSnapshotBytes);
});
for (const phase of ['before', 'after']) test(`ready ${phase} commit process exit leaves a recoverable durable state`, async () => {
  const f = await fixture(), handle = await f.store.reserve(f.account); await f.store.addReferences(handle, f.account, [f.member]);
  expect((await f.run('ready-' + phase, { handle, envelope: f.envelope(handle) })).exit).toBe(86);
  const row = await f.parent(handle); expect(row.state).toBe(phase === 'before' ? 'building' : 'ready');
  expect(await f.store.page(handle, 0)).toHaveLength(1);
  if (phase === 'after') { expect((await f.store.get(f.account, handle)).descriptor.handle).toBe(handle); await expect(f.store.publish(f.account, f.envelope(handle))).rejects.toHaveProperty('code', 'INDEX_CHANGED'); }
  else { f.clock.now += 30_001; await f.store.reserve(f.account); expect(await f.store.page(handle, 0)).toEqual([]); }
});
for (const phase of ['before', 'after']) test(`release and GC ${phase} commit process exit preserve atomic references and accounting`, async () => {
  const f = await fixture(), handle = await f.ready(); await f.publish([0, 1]); expect(await f.vector()).toBe(1);
  expect((await f.run('release-' + phase, { handle })).exit).toBe(86);
  if (phase === 'before') { expect((await f.parent(handle)).state).toBe('ready'); expect(await f.store.page(handle, 0)).toHaveLength(1); expect(await f.vector()).toBe(1); await f.store.release(f.account, handle); }
  expect(await f.parent(handle)).toBeUndefined(); expect(await f.store.page(handle, 0)).toEqual([]); expect(await f.vector()).toBe(0);
});
for (const phase of ['before', 'after']) test(`vector stage ${phase} commit exit recovers without inventing a prepared revision`, async () => {
  const f = await fixture(), lease = await f.writer.beginRevision({ ...f.note, accountId: f.account }, f.generation, f.body);
  expect((await f.run('stage-' + phase, { lease, generation: f.generation, body: f.body, witness: f.witness, vectors: f.body.values.map(() => [0, 1]) })).exit).toBe(86);
  const state = await f.client.execute({ sql: 'SELECT state FROM blinko_ps_revisions WHERE revision_id=?', args: [lease.revisionId] });
  expect(state.rows[0].state).toBe(phase === 'before' ? 'writing' : 'staged');
  expect(await f.vector(lease.revisionId)).toBe(phase === 'before' ? 0 : 1);
  await prisma.$executeRaw`UPDATE notes SET content='Changed between stores' WHERE id=${f.note.id}::int`;
  f.clock.now += 300_001;
  expect((await f.writer.recover()).discarded).toBe(1);
  expect(await f.vector(lease.revisionId)).toBe(0);
  expect(Number((await f.client.execute({ sql: 'SELECT COUNT(*) n FROM blinko_ps_vector_certificates WHERE revision_id=?', args: [lease.revisionId] })).rows[0].n)).toBe(0);
});
async function race(f: Awaited<ReturnType<typeof fixture>>, accounts: number[]) {
  const specs = accounts.map((accountId, i) => { const spec = join(f.root, `quota-${i}.json`); writeFileSync(spec, JSON.stringify({ url: f.url, accountId, now: f.clock.now })); return spec; });
  const workers = specs.map(spec => Bun.spawn([process.execPath, resolve(import.meta.dir, 'helpers/reference-process-worker.ts'), 'quota', spec], { stdout: 'pipe', stderr: 'pipe' }));
  const deadline = performance.now() + 5000;
  while (!specs.every(spec => existsSync(spec + '.ready'))) { if (performance.now() > deadline) throw Error('worker barrier timeout'); await Bun.sleep(5); }
  writeFileSync(join(f.root, 'go'), 'go');
  const results = await Promise.all(workers.map(async worker => { const [stdout, stderr, code] = await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited]); expect({ code, stderr }).toEqual({ code: 0, stderr: '' }); return JSON.parse(stdout); }));
  expect(results.map(r => r.status).sort()).toEqual(['rejected', 'reserved']);
}
test('two real libSQL processes compete for the second account reservation', async () => { const f = await fixture(); await f.store.reserve(f.account); await race(f, [f.account, f.account]); expect(Number((await f.client.execute('SELECT COUNT(*) n FROM blinko_ps_snapshots')).rows[0].n)).toBe(2); });
test('host byte quota stays atomic when different accounts race', async () => { const f = await fixture(); for (let i = 0; i < 7; i++) await f.store.reserve(f.account + 100 + Math.floor(i / 2)); await race(f, [f.account + 1000, f.account + 1001]); expect(Number((await f.client.execute('SELECT SUM(reserved_bytes) n FROM blinko_ps_snapshots')).rows[0].n)).toBe(VECTOR_SNAPSHOT_LIMITS.maxHostBytes); });
test('host count quota stays atomic for ready scenes sharing negligible physical data', async () => { const f = await fixture(); for (let i = 0; i < 15; i++) { const account = f.account + 100 + i, handle = await f.store.reserve(account); await f.store.publish(account, f.envelope(handle, 0)); } await race(f, [f.account + 1000, f.account + 1001]); expect(Number((await f.client.execute('SELECT COUNT(*) n FROM blinko_ps_snapshots')).rows[0].n)).toBe(VECTOR_SNAPSHOT_LIMITS.maxHostCount); });
test('real maintenance CLI repairs dirty notes, rotates untrusted instances and certifies only proven existing chunks', async () => {
  const f = await fixture(), instance = f.member.instance;
  async function cli(...args: string[]) { const worker = Bun.spawn([process.execPath, resolve(import.meta.dir, '../../scripts/plugin-services-index.ts'), ...args], { cwd: f.root, stdout: 'pipe', stderr: 'pipe' }); const [stdout, stderr, exit] = await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited]); return { stdout, stderr, exit }; }
  await prisma.$executeRaw`UPDATE notes SET type=1 WHERE id=${f.note.id}::int`;
  let result = await cli('maintain-qualification'); expect(result.exit).toBe(0); expect(JSON.parse(result.stdout).ready).toBe(true); expect((await registry.identity(f.note.id))?.instance).toBe(instance);
  await prisma.$executeRawUnsafe('ALTER TABLE notes DISABLE TRIGGER blinko_ps_note_qualification_change');
  await prisma.$executeRawUnsafe('ALTER TABLE notes ENABLE TRIGGER blinko_ps_note_qualification_change');
  await expect(registry.stamp(f.account)).rejects.toHaveProperty('code', 'INDEX_NOT_READY');
  result = await cli('initialize-qualification'); expect(result.exit).toBe(0); expect(JSON.parse(result.stdout).ready).toBe(true); expect((await registry.identity(f.note.id))?.instance).not.toBe(instance);
  result = await cli('certify-existing', '--account', String(f.account), '--notes', JSON.stringify([f.note.id])); expect(result.exit).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ published: [f.note.id], providerCalls: 0 });
  const unknown = await prisma.notes.create({ data: { accountId: f.account, content: 'Synthetic unknown weight provenance' } }); await registry.maintain();
  await f.writer.indexBody({ ...unknown, accountId: f.account }, f.generation, async values => values.map(() => [1, 0]));
  result = await cli('certify-existing', '--account', String(f.account), '--notes', JSON.stringify([unknown.id])); expect(result.exit).not.toBe(0);
  expect(Number((await f.client.execute({ sql: 'SELECT COUNT(*) n FROM blinko_ps_vector_certificates c JOIN blinko_ps_note_vectors v ON v.revision_id=c.revision_id WHERE v.note_id=?', args: [unknown.id] })).rows[0].n)).toBe(0);
});
