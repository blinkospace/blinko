import { afterEach, expect, test } from "bun:test";
import { queryFixture } from "./helpers/queryFixture";
import { createPolicyStore } from "../../services/pluginServices/PolicyStore";
import { vectorQueryInputSchema } from "../../services/pluginServices/vectorSchemas";
const fixtures: Awaited<ReturnType<typeof queryFixture>>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.client.close();
});
async function setup() {
  const f = await queryFixture();
  fixtures.push(f);
  await f.add(1, [[2, 0, 0]]);
  return f;
}
const byNote = { source: { kind: "note" as const, noteId: 1 } };

test("stored note path never resolves, constructs or calls any model", async () => {
  const f = await setup();
  await f.add(2, [[5, 0, 0]]);
  await f.add(3, [[-1, 0, 0]]);
  await f.add(4, [[0, 3, 0]]);
  const result = await f.query().query(1, byNote);
  expect(result.items.map((r) => r.note.id)).toEqual([2, 4, 3]);
  expect(result.items.map((r) => r.score)).toEqual([1, 0, -1]);
  expect(result.retrieval).toEqual({ algorithm: "exact", truncated: false, remaining: "no" });
  expect(f.counters).toEqual({ resolved: 0, encoded: 0, dispatched: 0, rates: 1, paid: 0 });
  expect(Object.keys(result.items[0].note).sort()).toEqual([
    "createdAt",
    "excerpt",
    "id",
    "type",
    "updatedAt",
  ]);
  expect(JSON.stringify(result)).not.toContain('"vector"');
});
test("all source and target chunks participate; deduplicate and sort ties by note ID", async () => {
  const f = await setup();
  await f.add(1, [
    [1, 0, 0],
    [0, 9, 0],
  ]);
  await f.add(5, [[0, 3, 0]]);
  await f.add(2, [
    [0, 0, 1],
    [0, 8, 0],
  ]);
  const r = await f.query().query(1, { ...byNote, limit: 1 });
  expect(r.items.map((v) => v.note.id)).toEqual([2]);
  expect(r.items[0].matches[0]).toMatchObject({ sourceChunkOrdinal: 1, targetChunkOrdinal: 1 });
  expect(r.retrieval.remaining).toBe("yes");
});
test("filter exclusions before limit and retain inclusive negative thresholds", async () => {
  const f = await setup();
  for (let id = 2; id <= 15; id++) await f.add(id, [[1, 0, 0]]);
  await f.add(16, [[-1, 0, 0]]);
  const r = await f.query().query(1, {
    ...byNote,
    limit: 2,
    excludeNoteIds: Array.from({ length: 14 }, (_, i) => i + 2),
    minScore: -1,
  });
  expect(r.items.map((v) => v.note.id)).toEqual([16]);
  expect(r.items[0].score).toBe(-1);
});
test("SQL-source interface plus final guard enforce owner, recycle, type, archive, tag any/all and dates", async () => {
  const f = await setup();
  await f.add(2, [[1, 0, 0]], { tagIds: [10, 11] });
  await f.add(3, [[1, 0, 0]], { tagIds: [10] });
  await f.add(4, [[1, 0, 0]], { type: 2, tagIds: [10, 11] });
  await f.add(5, [[1, 0, 0]], { isArchived: true, tagIds: [10, 11] });
  await f.add(6, [[1, 0, 0]], { accountId: 2 });
  await f.add(7, [], { isRecycle: true });
  expect(
    (
      await f.query().query(1, {
        ...byNote,
        scope: {
          tagIds: [10, 11],
          tagMatch: "all",
          createdFrom: "2026-01-01T00:00:00Z",
          createdBefore: "2026-01-02T00:00:00Z",
        },
      })
    ).items.map((v) => v.note.id),
  ).toEqual([2]);
  expect(
    (
      await f.query().query(1, {
        ...byNote,
        scope: { types: [2], includeArchived: true, tagIds: [10], tagMatch: "any" },
      })
    ).items.map((v) => v.note.id),
  ).toEqual([4]);
  expect(
    (await f.query().query(1, { ...byNote, scope: { createdBefore: "2026-01-01T00:00:00Z" } }))
      .items,
  ).toHaveLength(0);
});
test("source absence and foreign ownership have identical public errors", async () => {
  const f = await setup();
  await f.add(2, [[1, 0, 0]], { accountId: 2 });
  for (const noteId of [2, 999])
    await expect(f.query().query(1, { source: { kind: "note", noteId } })).rejects.toMatchObject({
      code: "NOT_FOUND_OR_FORBIDDEN",
    });
});
test("missing or stale source fails without encoding or rebuilding", async () => {
  const f = await setup();
  await f.add(2, []);
  await expect(f.query().query(1, { source: { kind: "note", noteId: 2 } })).rejects.toMatchObject({
    code: "SOURCE_NOT_INDEXED",
  });
  f.notes.get(1)!.content = "edited";
  await expect(f.query().query(1, byNote)).rejects.toMatchObject({ code: "SOURCE_INDEX_STALE" });
  expect(f.counters.encoded).toBe(0);
});
test("unsupported mode and expected-generation mismatch fail explicitly", async () => {
  const f = await setup();
  await expect(f.query().query(1, { ...byNote, mode: "approximate" })).rejects.toMatchObject({
    code: "CAPABILITY_UNSUPPORTED",
  });
  await expect(
    f.query().query(1, {
      ...byNote,
      expectedIndex: { embeddingSpaceId: f.generation.embeddingSpaceId, generation: "other" },
    }),
  ).rejects.toMatchObject({ code: "INDEX_CHANGED" });
});
test("source chunk budget rejects whole source before blobs; target budget returns partial unknown", async () => {
  const f = await setup();
  await f.add(1, [
    [1, 0, 0],
    [0, 1, 0],
  ]);
  await f.add(2, [[1, 0, 0]]);
  await f.add(3, [[0, 1, 0]]);
  await expect(f.query({ budget: { maxSourceChunks: 1 } }).query(1, byNote)).rejects.toMatchObject({
    code: "QUERY_BUDGET_EXCEEDED",
  });
  const r = await f.query({ budget: { maxTargetChunks: 1 } }).query(1, byNote);
  expect(r.items.map((i) => i.note.id)).toEqual([2]);
  expect(r.retrieval).toEqual({
    algorithm: "exact",
    truncated: true,
    remaining: "unknown",
    reason: "budget",
  });
});
test("stale candidate does not claim exhaustion and does not return stale content", async () => {
  const f = await setup();
  await f.add(2, [[1, 0, 0]]);
  await f.add(3, [[0, 1, 0]]);
  f.notes.get(2)!.content = "edited";
  const r = await f.query().query(1, byNote);
  expect(r.items.map((i) => i.note.id)).toEqual([3]);
  expect(r.index.coverage).toBe("partial");
  expect(r.retrieval).toMatchObject({
    truncated: true,
    remaining: "unknown",
    reason: "stale-candidates",
  });
});
test("final ownership/archive/edit recheck skips changed leaders and fills from lower-ranked notes", async () => {
  const f = await setup();
  await f.add(2, [[1, 0, 0]]);
  await f.add(3, [[1, 1, 0]]);
  await f.add(4, [[0, 1, 0]]);
  let first = true;
  const notes = {
    ...f.deps.notes,
    recheck: async (...args: Parameters<typeof f.deps.notes.recheck>) => {
      if (first) {
        first = false;
        f.notes.get(2)!.accountId = 9;
        f.notes.get(3)!.isArchived = true;
      }
      return f.deps.notes.recheck(...args);
    },
  };
  const r = await f.query({ notes }).query(1, { ...byNote, limit: 1 });
  expect(r.items.map((i) => i.note.id)).toEqual([4]);
  expect(r.retrieval.remaining).toBe("unknown");
});
test("source mutation before response rejects the response", async () => {
  const f = await setup();
  await f.add(2, [[1, 0, 0]]);
  const notes = {
    ...f.deps.notes,
    recheck: async (...args: Parameters<typeof f.deps.notes.recheck>) => {
      f.notes.get(1)!.content = "concurrent source edit";
      return f.deps.notes.recheck(...args);
    },
  };
  await expect(f.query({ notes }).query(1, byNote)).rejects.toMatchObject({
    code: "SOURCE_INDEX_STALE",
  });
});
test("source processing and page deadlines report timeout without reporting exhaustion", async () => {
  const f = await setup();
  await f.add(2, [[1, 0, 0]]);
  let tick = 0;
  const r = await f.query({ now: () => tick++ * 2000 }).query(1, byNote);
  expect(r.retrieval).toMatchObject({ truncated: true, remaining: "unknown", reason: "timeout" });
});
test("rate denial and disabled policy stop before query computation and model construction", async () => {
  const f = await setup();
  const gate = {
    check: f.deps.rateGate.check,
    acquire: async () => ({ allowed: false, used: 20, limit: 20, retryAfterMs: 100 }),
  };
  await expect(f.query({ rateGate: gate }).query(1, byNote)).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
  const policyStore = createPolicyStore({
    read: async () => ({ features: { "vector.queryByNote": { enabled: false } } }),
  });
  await expect(f.query({ policyStore }).query(1, byNote)).rejects.toMatchObject({
    code: "CAPABILITY_UNSUPPORTED",
  });
  expect(f.counters.encoded).toBe(0);
});
test("text query embeds only the query behind paid orchestration and dispatch callback", async () => {
  const f = await setup();
  await f.add(2, [[0, 1, 0]]);
  const r = await f
    .query()
    .query(1, { source: { kind: "text", text: "synthetic search" }, idempotencyKey: "key" });
  expect(r.items.map((i) => i.note.id)).toEqual([1, 2]);
  expect(r.items[0].matches[0].sourceChunkOrdinal).toBeUndefined();
  expect(f.counters).toEqual({ resolved: 1, encoded: 1, dispatched: 1, rates: 0, paid: 1 });
});
test("dimension-operation budget and vector-value budget return complete-note partial results", async () => {
  const f = await setup();
  await f.add(2, [[1, 0, 0]]);
  await f.add(3, [[0, 1, 0]]);
  for (const budget of [{ maxDimensionOps: 3 }, { maxVectorValues: 6 }]) {
    const r = await f.query({ budget }).query(1, byNote);
    expect(r.items.map((i) => i.note.id)).toEqual([2]);
    expect(r.retrieval).toMatchObject({ truncated: true, remaining: "unknown", reason: "budget" });
  }
});
test("metadata byte gate rejects before materializing vectors", async () => {
  const f = await setup();
  const note = await f.add(2, [[1, 0, 0]]);
  const page = await f.repository.readQueryPage({
    notes: [note],
    ...f.generation,
    maxChunks: 10,
    maxVectorValues: 30,
    maxMetadataBytes: 1,
  });
  expect(page.revisions).toEqual([]);
  expect(page.truncated).toBe(true);
});
test("generation change while scanning is an explicit failure", async () => {
  const f = await setup();
  await f.add(2, [[1, 0, 0]]);
  const notes = {
    ...f.deps.notes,
    page: async (...args: Parameters<typeof f.deps.notes.page>) => {
      const next = await f.writer.createGeneration({
        ...f.generation,
        embeddingSpaceId: "next-space",
      });
      await f.writer.activateGeneration(next.generation);
      return f.deps.notes.page(...args);
    },
  };
  await expect(f.query({ notes }).query(1, byNote)).rejects.toMatchObject({
    code: "INDEX_CHANGED",
  });
});
test("incompatible text model is refused before paid reservation or encoding", async () => {
  const f = await setup();
  const actual = await f.deps.resolveEmbedding();
  await expect(
    f
      .query({
        resolveEmbedding: async () => ({
          ...actual,
          space: { ...actual.space, embeddingSpaceId: "other-space" },
        }),
      })
      .query(1, { source: { kind: "text", text: "test" }, idempotencyKey: "key" }),
  ).rejects.toMatchObject({ code: "EMBEDDING_SPACE_MISMATCH" });
  expect(f.counters.encoded).toBe(0);
  expect(f.counters.paid).toBe(0);
});
test("uncooperative SQL adapter cannot leave the caller waiting forever", async () => {
  const f = await setup();
  const at = performance.now();
  const notes = { ...f.deps.notes, stamp: async () => new Promise<string>(() => {}) };
  await expect(
    f.query({ notes, budget: { hardTimeoutMs: 30 } }).query(1, byNote),
  ).rejects.toMatchObject({ code: "TIMEOUT" });
  expect(performance.now() - at).toBeLessThan(250);
});
test("runtime input schema rejects unknown fields, oversized exclusions, empty text and unqualified dates", () => {
  for (const input of [
    { ...byNote, rawVector: [1] },
    { source: { kind: "text", text: "  " }, idempotencyKey: "key" },
    { ...byNote, excludeNoteIds: Array(5001).fill(2) },
    { ...byNote, scope: { createdFrom: "2026-01-01T00:00:00" } },
    { ...byNote, minScore: NaN },
  ])
    expect(vectorQueryInputSchema.safeParse(input).success).toBe(false);
});

test("timeout reason takes explicit precedence over a concurrent corpus change", async () => {
  const f = await setup();
  await f.add(2, [[1, 0, 0]]);
  let tick = 0,
    stamp = 0;
  const notes = { ...f.deps.notes, stamp: async () => String(stamp++) };
  const r = await f.query({ notes, now: () => tick++ * 2000 }).query(1, byNote);
  expect(r.retrieval).toMatchObject({ truncated: true, remaining: "unknown", reason: "timeout" });
});
