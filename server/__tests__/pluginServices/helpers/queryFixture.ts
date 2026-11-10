import { createClient } from "@libsql/client";
import { IndexLifecycle } from "../../../services/pluginServices/IndexLifecycle";
import { VectorRepository } from "../../../services/pluginServices/VectorRepository";
import {
  BODY_PREPROCESSING_VERSION,
  digest,
  encodingValues,
  fingerprintNoteSnapshot,
} from "../../../services/pluginServices/BodyInput";
import { createPolicyStore } from "../../../services/pluginServices/PolicyStore";
import {
  createVectorQueryService,
  matchesSelection,
  type QueryNote,
  type QueryNoteSource,
  type VectorQueryDeps,
} from "../../../services/pluginServices/VectorQueryService";
import type { EmbeddingSpace } from "../../../services/pluginServices/types";

export async function queryFixture() {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const client = createClient({
    url: "file:" + join(mkdtempSync(join(tmpdir(), "blinko-query-")), "vectors.db"),
  });
  const notes = new Map<number, QueryNote>();
  const writer = new IndexLifecycle(client, { readNote: async (id) => notes.get(id) ?? null });
  await writer.initialize();
  const space: EmbeddingSpace = {
    dimensions: 3,
    modelFingerprint: "query-fixture-v1",
    embeddingSpaceId: "query-fixture-space",
    preprocessingVersion: BODY_PREPROCESSING_VERSION,
  };
  const generation = await writer.createGeneration(space);
  const repository = new VectorRepository(client);
  const source: QueryNoteSource = {
    readOwned: async (account, id) => {
      const n = notes.get(id);
      return n?.accountId === account && !n.isRecycle ? { ...n } : null;
    },
    page: async (account, selection, cursor, take) => ({
      notes: [...notes.values()]
        .filter((n) => n.id > cursor && matchesSelection(n, account, selection))
        .sort((a, b) => a.id - b.id)
        .slice(0, take)
        .map((n) => ({ ...n })),
      truncated: false,
    }),
    recheck: async (account, selection, ids) =>
      [...notes.values()]
        .filter((n) => ids.includes(n.id) && matchesSelection(n, account, selection))
        .map((n) => ({ ...n })),
    stamp: async (account) => digest([...notes.values()].filter((n) => n.accountId === account)),
  };
  const counters = { resolved: 0, encoded: 0, dispatched: 0, rates: 0, paid: 0 };
  const deps: VectorQueryDeps = {
    notes: source,
    policyStore: createPolicyStore({ read: async () => null }),
    rateGate: {
      check: async () => ({ allowed: true, used: 0, limit: 20 }),
      acquire: async () => {
        counters.rates++;
        return { allowed: true, used: 1, limit: 20 };
      },
    },
    callPolicy: {
      sweepExpired: async () => ({ released: 0, unknown: 0 }),
      runPaidOperation: async (_spec, invoke) => {
        counters.paid++;
        return (
          await invoke({
            requestId: "synthetic-query",
            signal: new AbortController().signal,
            markDispatched: async () => {
              counters.dispatched++;
            },
          })
        ).result;
      },
    },
    resolveEmbedding: async () => {
      counters.resolved++;
      return {
        modelId: 1,
        space,
        embedBody: async () => {
          throw new Error("Must never rebuild");
        },
        embedQueryText: async (_text, _signal, before) => {
          await before?.();
          counters.encoded++;
          return { vector: [1, 0, 0], tokens: 3 };
        },
      };
    },
    withReader: async (run) => run(repository),
  };
  async function add(id: number, vectors: number[][], extra: Partial<QueryNote> = {}) {
    const note: QueryNote = {
      id,
      accountId: 1,
      type: 0,
      isArchived: false,
      isRecycle: false,
      tagIds: [],
      content: `Synthetic note ${id}`,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      ...extra,
    };
    notes.set(id, note);
    if (vectors.length) {
      const texts = vectors.map((_, i) => `${note.content} chunk ${i}`);
      const body = {
        texts,
        values: encodingValues(texts, note),
        sourceHash: digest(texts),
        noteSnapshotHash: fingerprintNoteSnapshot(note),
      };
      const lease = await writer.beginRevision(note, generation, body);
      await writer.stageRevision(lease, generation, body, vectors);
      await writer.publishRevision(lease, generation);
    }
    return note;
  }
  await writer.activateGeneration(generation.generation);
  return {
    client,
    writer,
    repository,
    generation,
    notes,
    counters,
    deps,
    add,
    query: (override: Partial<VectorQueryDeps> = {}) =>
      createVectorQueryService({ ...deps, ...override }),
  };
}
