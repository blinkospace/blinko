import { expect, test } from 'bun:test';
import SimilarContentPlugin from '../../../docs/plugin-services/examples/similar-content/plugin';
import { PluginHostContextRuntime } from '../../../app/src/store/plugin/hostContext';
import { createPluginServices, type ServicesTransport } from '../../../app/src/store/plugin/services';
import type { VectorSnapshotDescriptor, VectorQueryResult } from '@shared/lib/pluginServices/v1';
import { vectorQueryInputSchema } from '../../services/pluginServices/vectorSchemas';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const snapshot: VectorSnapshotDescriptor = {
  handle: '00000000-0000-4000-8000-000000000001', expiresAt: '2099-01-01T00:00:00Z', preparedNoteCount: 2,
  range: { kind: 'prepared-subset', eligibleNoteCount: 3, unpreparedNoteCount: 1 },
  index: { embeddingSpaceId: 'synthetic-space', generation: 'synthetic-generation', corpusRevision: 'synthetic-revision', coverage: 'partial', provenance: 'verified' },
  scoring: { aggregation: 'note_level_weighted_v1', version: 'synthetic-score-v1', weightSource: 'provider-per-input-usage-v1', preprocessingVersion: 'synthetic-input-v1', modelFingerprint: 'synthetic-model' },
};
function queryResult(): VectorQueryResult {
  return {
    requestId: 'synthetic-query', index: snapshot.index,
    scoring: { metric: 'cosine', aggregation: 'note_level_weighted_v1', version: snapshot.scoring.version, higherIsBetter: true },
    retrieval: { algorithm: 'exact', truncated: true, reason: 'budget', remaining: 'unknown' },
    items: [{ note: { id: 2, type: 0, createdAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z', excerpt: 'Synthetic comparison' }, score: 0.8, matches: [], snapshot: { handle: snapshot.handle, hash: 'synthetic-body-hash' } }],
  };
}
function fixture(overrides: Partial<ServicesTransport> = {}) {
  let accountId = 1, notify = () => {};
  const runtime = new PluginHostContextRuntime({
    read: () => ({ accountId, token: `synthetic-${accountId}`, serviceUrl: 'https://service.invalid/', expiresAt: null }),
    subscribe: listener => { notify = listener; return () => {}; },
  });
  const calls: string[] = [], queries: unknown[] = [];
  const transport: ServicesTransport = {
    capabilities: async () => { calls.push('capabilities'); return { apiVersion: '1.0', hostVersion: 'synthetic', features: { 'vector.queryByNote': { available: true }, 'vector.snapshots': { available: true }, 'vector.noteLevelAggregation': { available: true } }, limits: { maxResults: 50, maxExcludeIds: 5000, maxInputBytes: 1000, maxOutputTokens: 10, maxConcurrentGeneration: 1 } }; },
    createSnapshot: async () => { calls.push('create'); return snapshot; },
    vectorQuery: async input => { calls.push('query'); queries.push(input); return queryResult(); },
    readSnapshotNote: async () => { calls.push('read'); return { status: 'ok', id: 2, accountId, type: 0, createdAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z', content: 'Synthetic same-version body', snapshotHash: 'synthetic-body-hash' }; },
    releaseSnapshot: async () => { calls.push('release'); },
    vectorStatus: async () => ({ available: false } as never),
    listModels: async () => [], generateText: async () => { throw new Error('No generation is authorized by this example.'); },
    ...overrides,
  };
  const plugin = new SimilarContentPlugin(createPluginServices(transport, runtime));
  plugin.init();
  return { plugin, runtime, calls, queries, switchAccount() { accountId++; notify(); }, close() { plugin.destroy(); runtime.dispose(); } };
}

test('independent similar-content consumer uses prepared snapshots and public files/context, preserving partial range semantics', async () => {
  const f = fixture();
  try {
    const result = await f.plugin.checkPreparedNote(1);
    expect(result?.firstMatch).toMatchObject({ status: 'ok', content: 'Synthetic same-version body' });
    expect(result?.range).toEqual(snapshot.range);
    expect(result?.result.retrieval).toMatchObject({ truncated: true, remaining: 'unknown' });
    expect(f.calls).toEqual(['capabilities', 'create', 'query', 'read', 'release']);
    expect(f.queries[0]).toMatchObject({ source: { kind: 'note', noteId: 1 }, snapshotHandle: snapshot.handle, aggregation: 'note_level_weighted_v1',
      expectedIndex: { embeddingSpaceId: snapshot.index.embeddingSpaceId, generation: snapshot.index.generation }, excludeNoteIds: [1] });
    // Response descriptors contain extra status fields; the real strict HTTP
    // input schema must accept the example's query, unlike a permissive transport stub.
    expect(vectorQueryInputSchema.safeParse(f.queries[0]).success).toBe(true);
    expect(f.queries[0]).not.toHaveProperty('idempotencyKey');
    const url = new URL(f.plugin.attachmentUrl('/api/file/a')!);
    expect(url.origin).toBe('https://service.invalid'); expect(url.searchParams.get('token')).toBe('synthetic-1');
    expect(new URL(f.plugin.attachmentUrl('https://external.invalid/api/file/a')!).searchParams.has('token')).toBe(false);
    f.switchAccount(); expect(f.plugin.lastPreparedCheck).toBeNull();
    f.plugin.destroy(); expect(f.plugin.attachmentUrl('/api/file/a')).toBeNull();
  } finally { f.close(); }
});

test('missing prepared capability does not silently query with the legacy algorithm', async () => {
  const f = fixture({ capabilities: async () => ({ apiVersion: '1.0', hostVersion: 'synthetic', features: {}, limits: {} } as never) });
  try { expect(await f.plugin.checkPreparedNote(1)).toBeNull(); expect(f.calls).toEqual([]); }
  finally { f.close(); }
});

test('inconsistent scoring is rejected and the same-account handle is still released', async () => {
  const result = queryResult(); result.scoring.aggregation = 'max_chunk_cosine_v1';
  const f = fixture({ vectorQuery: async () => result });
  try {
    await expect(f.plugin.checkPreparedNote(1)).rejects.toThrow('inconsistent');
    expect(f.calls).toContain('release'); expect(f.calls).not.toContain('read'); expect(f.plugin.lastPreparedCheck).toBeNull();
  } finally { f.close(); }
});

test('an old account query cannot deliver body/report or release its handle with a new login', async () => {
  const gate = deferred<VectorQueryResult>();
  const f = fixture({ vectorQuery: async () => gate.promise });
  try {
    const request = f.plugin.checkPreparedNote(1); void request.catch(() => {}); await tick();
    f.switchAccount(); gate.resolve(queryResult());
    await expect(request).rejects.toMatchObject({ code: 'ABORTED' });
    expect(f.calls).not.toContain('read'); expect(f.calls).not.toContain('release'); expect(f.plugin.lastPreparedCheck).toBeNull();
  } finally { f.close(); }
});

test('account replacement while releasing a completed report cannot return or cache the old report', async () => {
  const gate = deferred<void>(); let releasing = false;
  const f = fixture({ releaseSnapshot: async () => { releasing = true; return gate.promise; } });
  try {
    const request = f.plugin.checkPreparedNote(1); await tick(); expect(releasing).toBe(true);
    f.switchAccount(); gate.resolve();
    expect(await request).toBeNull(); expect(f.plugin.lastPreparedCheck).toBeNull();
  } finally { f.close(); }
});

test('destroy cancels pending work, clears the report and permits only same-account cleanup', async () => {
  const gate = deferred<VectorQueryResult>();
  const f = fixture({ vectorQuery: async () => gate.promise });
  try {
    const request = f.plugin.checkPreparedNote(1); void request.catch(() => {}); await tick();
    f.plugin.destroy(); gate.resolve(queryResult());
    await expect(request).rejects.toMatchObject({ code: 'ABORTED' });
    expect(f.calls).toContain('release'); expect(f.plugin.lastPreparedCheck).toBeNull();
    expect(await f.plugin.checkPreparedNote(1)).toBeNull();
  } finally { f.close(); }
});
