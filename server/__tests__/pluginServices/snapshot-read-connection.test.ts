const { test }: typeof import('node:test') = typeof Bun === 'undefined' ? require('node:test') : require('bun:test');
import assert from 'node:assert/strict';
import { createClient, type Client } from '@libsql/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configureSnapshotReadConnection } from '../../services/pluginServices/SnapshotReadConnection';
import { createHostIndex } from '../../services/pluginServices/HostIndex';
import { BODY_PREPROCESSING_VERSION, digest } from '../../services/pluginServices/BodyInput';
import type { NoteSnapshot } from '../../services/pluginServices/types';

const limit = 512 * 1024 * 1024;
const scalar = async (client: Pick<Client, 'execute'>, sql: string) => Number((await client.execute(sql)).rows[0][0]);
const file = () => 'file:' + path.join(mkdtempSync(path.join(tmpdir(), 'blinko-snapshot-mmap-')), 'vectors.db');

test('unsupported, disabled and rejected mmap settings retain ordinary file reads', async () => {
  const client = createClient({ url: file() });
  try {
    await client.execute('CREATE TABLE ordinary(value INTEGER)');
    await client.execute('INSERT INTO ordinary VALUES(17)');
    for (const mode of ['unknown', 'zero', 'throw', 'oversized'] as const) {
      const optional: Pick<Client, 'execute'> = { execute: async (input, args) => {
        const sql = typeof input === 'string' ? input : input.sql;
        if (!sql.startsWith('PRAGMA mmap_size')) return client.execute(input, args);
        if (mode === 'throw') throw new Error('mmap unsupported by test VFS');
        if (mode === 'unknown') return { rows: [], columns: [], columnTypes: [], rowsAffected: 0, lastInsertRowid: undefined, toJSON() { return {}; } } as any;
        const result = await client.execute('PRAGMA mmap_size');
        result.rows[0].mmap_size = mode === 'zero' ? 0 : limit + 4096;
        return result;
      } };
      assert.equal(await configureSnapshotReadConnection(optional), 0);
      assert.equal(await scalar(optional, 'SELECT value FROM ordinary'), 17);
    }
  } finally { client.close(); }
});

test('fresh host query connections map on demand and observe writer updates, retained references and deletion', async () => {
  const url = file();
  const notes = new Map<number, NoteSnapshot>([[1, { id: 1, accountId: 1, content: 'Synthetic original body', createdAt: new Date('2026-01-01Z'), updatedAt: new Date('2026-01-02Z') }]]);
  const space = { dimensions: 2, modelFingerprint: 'synthetic-mmap', embeddingSpaceId: 'synthetic-mmap', preprocessingVersion: BODY_PREPROCESSING_VERSION };
  const host = createHostIndex({ url, readNote: async id => notes.get(id) ?? null, readInstance: async () => 'synthetic-instance',
    resolveEmbedding: async () => ({ modelId: 1, space, embedBody: async values => values.map(() => [1, 0]), embedQueryText: async () => [1, 0],
      embedBodyMeasured: async values => ({ vectors: values.map(() => notes.get(1)!.content.includes('updated') ? [0, 1] : [1, 0]),
        tokenWeights: { version: 'provider-per-input-usage-v1', modelFingerprint: space.modelFingerprint, sourceHash: digest([space.preprocessingVersion, values]), counts: values.map(() => 17) } }) }) });
  assert(await host.upsert({ id: 1, content: notes.get(1)!.content, requireTokenWeights: true }));
  const handle = await host.withSnapshotStore(async store => {
    const handle = await store.reserve(1);
    const row = (await store.client.execute('SELECT revision_id,snapshot_hash FROM blinko_ps_note_vectors WHERE note_id=1')).rows[0];
    await store.addReferences(handle, 1, [{ noteId: 1, hash: String(row.snapshot_hash), revisionId: String(row.revision_id), instance: 'synthetic-instance' }]);
    return handle;
  });
  await host.withSnapshotStore(async first => {
    assert.equal(await scalar(first.client, 'PRAGMA mmap_size'), limit);
    assert.deepEqual((await first.page(handle, 0)).map(x => x.noteId), [1]);
    assert.deepEqual((await first.vectors(handle, [1], 2)).get(1), [1, 0]);
    assert.equal(await scalar(first.client, 'PRAGMA mmap_size'), limit);
    await host.withSnapshotStore(async second => {
      assert.notEqual(first.client, second.client);
      assert.equal(await scalar(second.client, 'PRAGMA mmap_size'), limit);
      assert.deepEqual((await second.vectors(handle, [1], 2)).get(1), [1, 0]);
      notes.set(1, { ...notes.get(1)!, content: 'Synthetic updated body', updatedAt: new Date('2026-01-03Z') });
      assert(await host.upsert({ id: 1, content: notes.get(1)!.content, requireTokenWeights: true }));
      for (const store of [first, second]) {
        assert.deepEqual((await store.vectors(handle, [1], 2)).get(1), [1, 0]);
        const live = (await store.client.execute('SELECT n.embedding FROM blinko_ps_note_vectors n JOIN blinko_ps_revisions r ON r.revision_id=n.revision_id WHERE r.state=\'published\'')).rows;
        assert.equal(live.length, 1);
        assert.deepEqual(Array.from(new Float32Array(live[0].embedding as ArrayBuffer)), [0, 1]);
        assert.equal(await scalar(store.client, 'PRAGMA mmap_size'), limit);
      }
      notes.delete(1); await host.delete(1, 1);
      for (const store of [first, second]) {
        assert.deepEqual(await store.page(handle, 0), []);
        assert.equal((await store.vectors(handle, [1], 2)).size, 0);
      }
    });
  });
  await host.withSnapshotStore(async store => { assert.equal(await scalar(store.client, 'PRAGMA mmap_size'), limit); await store.release(1, handle); });
  console.log(JSON.stringify({ connectionLocalMmapBytes: limit, freshQueryConnections: 3, originalVector: [1, 0], updatedVector: [0, 1], frozenReferenceSurvivedUpdate: true, deletionSeenByBothConnections: true, runtime: typeof Bun === 'undefined' ? 'Node' : 'Bun' }));
});
