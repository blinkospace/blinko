import { expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import type { EmbeddingModelV1 } from '@ai-sdk/provider';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHostIndex } from '../../services/pluginServices/HostIndex';
import { createModelResolver } from '../../services/pluginServices/ModelResolver';
import { IndexLifecycle } from '../../services/pluginServices/IndexLifecycle';
import { planWeightedPreparation, applyWeightedPreparation, type PreparationEvent } from '../../services/pluginServices/WeightedIndexPreparation';
import { VectorRepository } from '../../services/pluginServices/VectorRepository';
import type { NoteSnapshot } from '../../services/pluginServices/types';

function fixture() {
  const filename = path.join(mkdtempSync(path.join(tmpdir(), 'blinko-weighted-prepare-')), 'host.db');
  const notes = new Map<number, NoteSnapshot>([1, 2, 3, 4].map(id => [id, {
    id, accountId: id === 3 ? 2 : 1, content: 'Synthetic body ' + id,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'), isRecycle: id === 4,
  }]));
  let constructions = 0, modelVersion = 'synthetic-v1';
  let onCall = (_values: string[]) => {};
  let usage = true;
  const calls: string[][] = [], flags: number[] = [], events: PreparationEvent[] = [];
  const model: EmbeddingModelV1<string> = {
    specificationVersion: 'v1', provider: 'synthetic', modelId: 'fixture', maxEmbeddingsPerCall: 100, supportsParallelCalls: true,
    async doEmbed(input) {
      calls.push(input.values);
      onCall(input.values);
      return { embeddings: input.values.map(() => [1, 1]), ...(usage ? { usage: { tokens: 7 } } : {}) };
    },
  };
  const resolver = createModelResolver({
    readEmbeddingModel: async () => ({ id: 1, modelKey: modelVersion, config: { embeddingDimensions: 2 },
      provider: { id: 1, provider: 'synthetic', baseURL: 'http://synthetic.invalid' } }),
    createEmbeddingModel: async () => { constructions++; return model; },
  });
  const deps = { url: 'file:' + filename, sourceIdentity: 'isolated-synthetic-database',
    readNote: async (id: number) => notes.get(id) ?? null, resolveEmbedding: resolver.resolveEmbedding,
    markIndexed: async (note: NoteSnapshot) => { flags.push(note.id); } };
  const input = { accountId: 1, noteIds: [1, 2], maxRequests: 100, maxInputChars: 100_000 };
  const host = createHostIndex(deps);
  const journal = (event: PreparationEvent) => events.push(structuredClone(event));
  const execute = async (plan?: Awaited<ReturnType<typeof planWeightedPreparation>>) => {
    const selected = plan ?? await planWeightedPreparation(deps, input);
    return applyWeightedPreparation(deps, selected, { confirmPlan: selected.planId, allowProviderCalls: true, journal });
  };
  return { filename, notes, deps, input, calls, flags, events, journal, execute, host,
    constructions: () => constructions, setUsage: (value: boolean) => { usage = value; },
    onCall: (handler: typeof onCall) => { onCall = handler; },
    changeModel: () => { modelVersion = 'synthetic-v2'; } };
}

test('preview is bounded, canonical, content-free and creates no index or provider resource', async () => {
  const f = fixture();
  const plan = await planWeightedPreparation(f.deps, f.input);
  expect(plan.requests).toBe(2);
  expect(plan.notes.map(n => n.noteId)).toEqual([1, 2]);
  expect(plan.inputChars).toBeGreaterThan(2 * 'Synthetic body'.length);
  expect(JSON.stringify(plan)).not.toContain('Synthetic body');
  expect(JSON.stringify(plan)).not.toContain('synthetic.invalid');
  expect(existsSync(f.filename)).toBe(false);
  expect(f.constructions()).toBe(0);
  expect(f.calls).toHaveLength(0);
  const reversed = await planWeightedPreparation(f.deps, { ...f.input, noteIds: [2, 1] });
  expect(reversed.planId).toBe(plan.planId);
});

test('request, input and note bounds reject before writes and provider construction', async () => {
  const f = fixture();
  for (const input of [
    { ...f.input, maxRequests: 1 }, { ...f.input, maxInputChars: 1 },
    { ...f.input, noteIds: [1, 1] }, { ...f.input, noteIds: Array.from({ length: 501 }, (_, i) => i + 1) },
    { ...f.input, maxRequests: 10_001 },
  ]) await expect(planWeightedPreparation(f.deps, input)).rejects.toThrow();
  f.notes.get(1)!.content = 'x'.repeat(2_000_001);
  await expect(planWeightedPreparation(f.deps, f.input)).rejects.toThrow();
  expect(existsSync(f.filename)).toBe(false);
  expect(f.constructions()).toBe(0);
});

test('foreign, recycled and missing notes cannot enter an operator plan', async () => {
  const f = fixture();
  for (const id of [3, 4, 999])
    await expect(planWeightedPreparation(f.deps, { ...f.input, noteIds: [id] })).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  expect(existsSync(f.filename)).toBe(false);
});

test('execution requires confirmation and fresh note, model, budget and target identities', async () => {
  const f = fixture();
  const plan = await planWeightedPreparation(f.deps, f.input);
  await expect(applyWeightedPreparation(f.deps, plan, { confirmPlan: 'wrong', allowProviderCalls: true, journal: f.journal })).rejects.toThrow();
  await expect(applyWeightedPreparation(f.deps, plan, { confirmPlan: plan.planId, allowProviderCalls: false, journal: f.journal })).rejects.toThrow();
  await expect(applyWeightedPreparation({ ...f.deps, sourceIdentity: 'another-database' }, plan, { confirmPlan: plan.planId, allowProviderCalls: true, journal: f.journal })).rejects.toThrow();
  f.notes.get(1)!.content += ' edited';
  await expect(f.execute(plan)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  expect(existsSync(f.filename)).toBe(false);
});

test('real LibSQL publication uses individual measured inputs, same database, and fresh previews skip finished notes', async () => {
  const f = fixture();
  const plan = await planWeightedPreparation(f.deps, f.input);
  const result = await f.execute(plan);
  expect(result.status).toBe('complete');
  expect(result.publishedNoteIds).toEqual([1, 2]);
  expect(result.dispatchedRequests).toBe(2);
  expect(result.consumedInputChars).toBe(plan.inputChars);
  expect(f.calls.every(values => values.length === 1)).toBe(true);
  expect(f.flags).toEqual([1, 2]);
  expect(f.events.map(e => e.event)).toEqual(['started', 'dispatch-reserved', 'dispatch-returned', 'note-published',
    'dispatch-reserved', 'dispatch-returned', 'note-published', 'finished']);
  const next = await planWeightedPreparation(f.deps, { ...f.input, maxRequests: 0, maxInputChars: 0 });
  expect(next.requests).toBe(0);
  expect(next.notes.every(n => n.prepared)).toBe(true);
  expect((await f.execute(next)).skippedNoteIds).toEqual([1, 2]);
  expect(f.calls).toHaveLength(2);
  await f.host.withReader(async repository => {
    expect((await repository!.readStatus(1)).provenance).toBe('verified');
    const active = (await repository!.readActiveGeneration())!;
    const revision = (await repository!.readBodyRevision({ note: f.notes.get(1)!, ...active }))!;
    expect(revision.chunks[0].tokenWeight?.tokens).toBe(7);
  });
});

test('ordinary existing vectors need explicit measured preparation without changing the active generation', async () => {
  const f = fixture();
  await f.host.upsert({ id: 1, content: f.notes.get(1)!.content });
  const active = await f.host.withReader(async r => (await r!.readActiveGeneration())!.generation);
  const plan = await planWeightedPreparation(f.deps, f.input);
  expect(plan.notes[0].prepared).toBe(false);
  expect((await f.execute(plan)).generation).toBe(active);
  const client = createClient({ url: f.deps.url });
  try { expect((await client.execute('SELECT generation FROM blinko_ps_generations')).rows).toHaveLength(1); }
  finally { client.close(); }
});

test('preview can inventory an older metadata database without creating its missing weighted cache table', async () => {
  const f = fixture();
  await f.host.upsert({ id: 1, content: f.notes.get(1)!.content });
  const client = createClient({ url: f.deps.url });
  try {
    await client.execute('DROP TABLE blinko_ps_note_vectors');
    const before = f.calls.length;
    const plan = await planWeightedPreparation(f.deps, f.input);
    expect(plan.notes.every(n => !n.prepared)).toBe(true);
    expect(f.calls.length).toBe(before);
    expect((await client.execute("SELECT 1 FROM sqlite_master WHERE name='blinko_ps_note_vectors'")).rows).toHaveLength(0);
  } finally { client.close(); }
});

test('unknown provider usage stops after the first charged attempt and never fabricates weights or retries', async () => {
  const f = fixture();
  f.setUsage(false);
  const result = await f.execute();
  expect(result.status).toBe('failed');
  expect(result.error).toBe('CAPABILITY_UNSUPPORTED');
  expect(result.dispatchedRequests).toBe(1);
  expect(result.publishedNoteIds).toEqual([]);
  expect(f.calls).toHaveLength(1);
  expect(f.flags).toEqual([]);
  const client = createClient({ url: f.deps.url });
  try {
    expect((await client.execute("SELECT revision_id FROM blinko_ps_revisions WHERE state IN ('writing','staged','published')")).rows).toHaveLength(0);
    expect((await client.execute('SELECT revision_id FROM blinko_ps_note_vectors')).rows).toHaveLength(0);
  } finally { client.close(); }
});

test('partial failure retains successful notes, consumes the failed attempt and requires a new explicit plan', async () => {
  const f = fixture();
  f.onCall(() => { if (f.calls.length === 2) throw new Error('private provider message Synthetic body'); });
  const old = await planWeightedPreparation(f.deps, f.input);
  const result = await f.execute(old);
  expect(result.status).toBe('failed');
  expect(result.publishedNoteIds).toEqual([1]);
  expect(result.dispatchedRequests).toBe(2);
  expect(result.error).toBe('PROVIDER_OR_STORAGE_ERROR');
  expect(JSON.stringify(f.events)).not.toContain('private provider message');
  await expect(f.execute(old)).rejects.toThrow();
  const next = await planWeightedPreparation(f.deps, f.input);
  expect(next.requests).toBe(1);
  expect(next.notes.map(n => n.prepared)).toEqual([true, false]);
  f.onCall(() => {});
  expect((await f.execute(next)).publishedNoteIds).toEqual([2]);
  expect(f.calls).toHaveLength(3);
});

test('journal persistence failure prevents dispatch', async () => {
  const f = fixture();
  const plan = await planWeightedPreparation(f.deps, f.input);
  const result = await applyWeightedPreparation(f.deps, plan, { confirmPlan: plan.planId, allowProviderCalls: true,
    journal(event) { if (event.event === 'dispatch-reserved') throw new Error('disk full'); } });
  expect(result.status).toBe('failed');
  expect(result.dispatchedRequests).toBe(0);
  expect(f.calls).toHaveLength(0);
});

test('note change during a provider call prevents publication and further calls', async () => {
  const f = fixture();
  f.onCall(() => { f.notes.get(1)!.content += ' changed while encoding'; });
  const result = await f.execute();
  expect(result.status).toBe('failed');
  expect(result.error).toBe('SOURCE_INDEX_STALE');
  expect(result.publishedNoteIds).toEqual([]);
  expect(f.calls).toHaveLength(1);
  expect(f.flags).toEqual([]);
});

test('model changes before and during execution stop without silently switching embedding spaces', async () => {
  const f = fixture();
  const plan = await planWeightedPreparation(f.deps, f.input);
  f.changeModel();
  await expect(f.execute(plan)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  const g = fixture();
  g.onCall(g.changeModel);
  const result = await g.execute();
  expect(result.status).toBe('failed');
  expect(result.error).toBe('INDEX_CHANGED');
  expect(g.calls).toHaveLength(1);
  expect(result.publishedNoteIds).toEqual([]);
});

test('incompatible active generation is rejected in preview, without rewriting or paying', async () => {
  const f = fixture();
  await f.host.upsert({ id: 1, content: f.notes.get(1)!.content });
  f.calls.length = 0;
  const oldGeneration = await f.host.withReader(async r => (await r!.readActiveGeneration())!.generation);
  f.changeModel();
  await expect(planWeightedPreparation(f.deps, f.input)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  expect(await f.host.withReader(async r => (await r!.readActiveGeneration())!.generation)).toBe(oldGeneration);
});

test('generation switches after preview and during dispatch cannot be overwritten', async () => {
  const f = fixture();
  await f.host.upsert({ id: 1, content: f.notes.get(1)!.content });
  const plan = await planWeightedPreparation(f.deps, f.input);
  await f.host.beginRebuild();
  await expect(f.execute(plan)).rejects.toThrow();
  const g = fixture();
  await g.host.upsert({ id: 1, content: g.notes.get(1)!.content });
  const client = createClient({ url: g.deps.url });
  const lifecycle = new IndexLifecycle(client, g.deps);
  const other = await lifecycle.createGeneration((await g.deps.resolveEmbedding()).space);
  // A journal callback simulates another local process switching before dispatch.
  const current = await planWeightedPreparation(g.deps, g.input);
  let switched = false;
  const realResolve = g.deps.resolveEmbedding;
  g.deps.resolveEmbedding = async () => {
    if (g.events.some(e => e.event === 'dispatch-returned') && !switched) {
      switched = true; await lifecycle.activateGeneration(other.generation);
    }
    return realResolve();
  };
  try {
    const result = await g.execute(current);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('INDEX_CHANGED');
    expect((await new VectorRepository(client).readActiveGeneration())!.generation).toBe(other.generation);
  } finally { client.close(); }
});
