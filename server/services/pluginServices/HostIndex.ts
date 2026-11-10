import { createClient } from "@libsql/client";
import { existsSync, mkdirSync } from "node:fs";
import { VectorSnapshotStore } from './VectorSnapshotStore';
import { configureSnapshotReadConnection } from './SnapshotReadConnection';
import path from "node:path";
import { VECTOR_DB_FILE_PATH } from "../../../shared/lib/sharedConstant";
import { IndexLifecycle } from "./IndexLifecycle";
import {
  createModelResolver,
  createTextModelCatalog,
  createTextGeneratorFactory,
  type ResolvedEmbedding,
} from "./ModelResolver";
import { VectorRepository, openVectorReader } from "./VectorRepository";
import { ServiceError } from "./errors";
import type { NoteSnapshot, NoteSource } from "./types";

export interface HostIndexDeps extends NoteSource {
  url: string;
  resolveEmbedding(): Promise<ResolvedEmbedding>;
  markIndexed?(note: NoteSnapshot): Promise<void>;
}
export function createHostIndex(deps: HostIndexDeps) {
  async function writer<T>(run: (lifecycle: IndexLifecycle) => Promise<T>): Promise<T> {
    if (!deps.url.startsWith("file:")) throw new ServiceError("INDEX_NOT_READY");
    mkdirSync(path.dirname(deps.url.slice(5)), { recursive: true });
    const client = createClient({ url: deps.url });
    try {
      const lifecycle = new IndexLifecycle(client, deps);
      await lifecycle.initialize();
      return await run(lifecycle);
    } finally {
      client.close();
    }
  }
  return {
    async upsert(input: { id: number; content: string; requireTokenWeights?: boolean }): Promise<boolean> {
      const note = await deps.readNote(input.id);
      if (!note || note.isRecycle || note.content !== input.content) return false;
      const embedding = await deps.resolveEmbedding();
      return writer(async (lifecycle) => {
        const previous = await new VectorRepository(lifecycle.client).readActiveGeneration();
        const generation =
          (await lifecycle.findCompatibleGeneration(embedding.space)) ??
          (await lifecycle.createGeneration(embedding.space));
        if (!(await lifecycle.indexBody(note, generation, async values => {
          if (!input.requireTokenWeights) return embedding.embedBody(values);
          if (!embedding.embedBodyMeasured) throw new ServiceError('CAPABILITY_UNSUPPORTED');
          const result = await embedding.embedBodyMeasured(values);
          if (!result.tokenWeights) throw new ServiceError('CAPABILITY_UNSUPPORTED');
          return result;
        }, { requireTokenWeights: input.requireTokenWeights }))) return false;
        if (generation.generation !== previous?.generation)
          await lifecycle.activateGeneration(generation.generation, previous?.generation ?? null);
        await deps.markIndexed?.(note);
        return true;
      });
    },
    async deleteOwned(accountId: number, noteId: number): Promise<boolean> {
      if (!Number.isSafeInteger(accountId) || accountId <= 0) return false;
      const note = await deps.readNote(noteId);
      if (note && note.accountId !== accountId) return false;
      if (!note) {
        const owned = await this.withReader(async (repository) =>
          repository ? repository.hasOwnedIndexRecord(accountId, noteId) : false,
        );
        if (!owned) return false;
      }
      await this.delete(accountId, noteId);
      return true;
    },
    async delete(accountId: number, noteId: number): Promise<void> {
      await writer(async (lifecycle) => {
        await lifecycle.deleteNote(accountId, noteId);
        // Legacy IDs are globally unique note IDs. Delete every matching old chunk,
        // rather than the former LIMIT 1 deletion. The caller supplies authoritative ownership.
        const exists = await lifecycle.client.execute(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='blinko'",
        );
        if (exists.rows.length)
          await lifecycle.client.execute({
            sql: "DELETE FROM blinko WHERE json_valid(metadata) AND (CAST(json_extract(metadata,'$.noteId') AS INTEGER)=? OR CAST(json_extract(metadata,'$.id') AS INTEGER)=?)",
            args: [noteId, noteId],
          });
      });
    },
    async beginRebuild(): Promise<string> {
      const embedding = await deps.resolveEmbedding();
      return writer(async (lifecycle) => {
        const generation = await lifecycle.createGeneration(embedding.space);
        await lifecycle.activateGeneration(generation.generation);
        return generation.generation;
      });
    },
    async recover(): Promise<{ published: number; discarded: number }> {
      return writer((lifecycle) => lifecycle.recover());
    },
    /** Snapshot metadata is writable, but opening the query path never creates a
     * database, migrates tables, resolves a model or rebuilds an index. */
    async withSnapshotStore<T>(run: (store: VectorSnapshotStore) => Promise<T>): Promise<T> {
      if (!deps.url.startsWith('file:') || !existsSync(deps.url.slice(5))) throw new ServiceError('INDEX_NOT_READY');
      const client = createClient({ url: deps.url });
      try {
        await client.execute('PRAGMA foreign_keys=ON');
        await configureSnapshotReadConnection(client);
        const store = new VectorSnapshotStore(client);
        if (!(await store.available())) throw new ServiceError('INDEX_NOT_READY');
        await new VectorRepository(client).readActiveGeneration();
        return await run(store);
      } finally { client.close(); }
    },
    async withReader<T>(run: (repository: VectorRepository | null) => Promise<T>): Promise<T> {
      const repository = await openVectorReader(deps.url);
      try {
        return await run(repository);
      } finally {
        repository?.client.close();
      }
    },
  };
}

// Lazy host adapters avoid importing the old all-resources factory from the new reader path.
export const hostNoteSource: NoteSource = {
  async readInstance(id) {
    const { prisma } = await import('../../prisma');
    const rows = await prisma.$queryRaw<Array<{ instance: string }>>`SELECT q.instance::text FROM plugin_note_qualification q JOIN notes n ON n.id=q."noteId" WHERE n.id=${id}::int AND n."accountId" IS NOT NULL`;
    return rows[0]?.instance ?? null;
  },
  async readNote(id) {
    const { prisma } = await import("../../prisma");
    const note = await prisma.notes.findUnique({
      where: { id },
      select: {
        id: true,
        accountId: true,
        content: true,
        createdAt: true,
        updatedAt: true,
        isRecycle: true,
      },
    });
    return note && note.accountId !== null ? { ...note, accountId: note.accountId } : null;
  },
};
export const hostModelResolver = createModelResolver({
  async readEmbeddingModel() {
    const [{ prisma }, { getGlobalConfig }] = await Promise.all([
      import("../../prisma"),
      import("../../routerTrpc/config"),
    ]);
    const config = await getGlobalConfig({ useAdmin: true });
    if (!config.embeddingModelId) return null;
    return prisma.aiModels.findUnique({
      where: { id: config.embeddingModelId },
      select: {
        id: true,
        modelKey: true,
        config: true,
        provider: {
          select: { id: true, provider: true, baseURL: true, config: true },
        },
      },
    });
  },
  async createEmbeddingModel(record) {
    const [{ prisma }, { EmbeddingProvider }] = await Promise.all([
      import("../../prisma"),
      import("../../aiServer/providers/EmbeddingProvider"),
    ]);
    const provider = await prisma.aiProviders.findUnique({
      where: { id: record.provider.id },
    });
    if (
      !provider ||
      provider.provider !== record.provider.provider ||
      (provider.baseURL ?? null) !== (record.provider.baseURL ?? null) ||
      ((provider.config as { apiVersion?: unknown } | null)?.apiVersion ?? null) !==
        ((record.provider.config as { apiVersion?: unknown } | null)?.apiVersion ?? null)
    )
      throw new ServiceError("MODEL_UNAVAILABLE");
    return new EmbeddingProvider().getEmbeddingModel({
      provider: provider.provider,
      apiKey: provider.apiKey,
      baseURL: provider.baseURL,
      modelKey: record.modelKey,
      apiVersion: (provider.config as { apiVersion?: unknown } | null)?.apiVersion,
    });
  },
});
export const hostModelCatalog = createTextModelCatalog({
  async listMetadata(_accountId) {
    const { prisma } = await import("../../prisma");
    const models = await prisma.aiModels.findMany({
      select: {
        id: true,
        title: true,
        capabilities: true,
        provider: { select: { title: true } },
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    return models.map((model) => ({
      id: model.id,
      title: model.title,
      providerLabel: model.provider.title,
      capabilities: {
        inference: (model.capabilities as { inference?: boolean } | null)?.inference === true,
      },
    }));
  },
  async readDefaultModelId(_accountId) {
    const { getGlobalConfig } = await import("../../routerTrpc/config");
    return (await getGlobalConfig({ useAdmin: true })).mainModelId ?? null;
  },
});
export const hostTextGeneratorFactory = createTextGeneratorFactory({
  async createLanguageModel(_accountId, modelId) {
    const [{ prisma }, { LLMProvider }] = await Promise.all([
      import("../../prisma"),
      import("../../aiServer/providers/LLMProvider"),
    ]);
    const model = await prisma.aiModels.findUnique({
      where: { id: modelId },
      include: { provider: true },
    });
    if (!model || !(model.capabilities as { inference?: boolean } | null)?.inference) return null;
    return new LLMProvider().getLanguageModel({
      provider: model.provider.provider,
      apiKey: model.provider.apiKey,
      baseURL: model.provider.baseURL,
      modelKey: model.modelKey,
      apiVersion: (model.provider.config as { apiVersion?: unknown } | null)?.apiVersion,
    });
  },
});

export async function markHostNoteIndexed(note: NoteSnapshot): Promise<void> {
  const { prisma } = await import("../../prisma");
  // Prisma @updatedAt would change the encoding snapshot. A narrow SQL CAS updates
  // only this legacy UI flag, preserving concurrent metadata edits and note timestamps.
  await prisma.$executeRaw`UPDATE notes SET metadata=jsonb_set(COALESCE(metadata::jsonb,'{}'::jsonb),'{isIndexed}','true'::jsonb,true)::json
      WHERE id=${note.id}::int AND "accountId"=${note.accountId}::int AND content=${note.content}
        AND "createdAt"=${note.createdAt} AND "updatedAt"=${note.updatedAt ?? null} AND "isRecycle"=false`;
}
export const hostIndex = createHostIndex({
  url: VECTOR_DB_FILE_PATH,
  readNote: hostNoteSource.readNote,
  readInstance: hostNoteSource.readInstance,
  resolveEmbedding: () => hostModelResolver.resolveEmbedding(),
  markIndexed: markHostNoteIndexed,
});

/** Private host RAG adapter; existing public response is built by aiModelFactory. */
export async function queryHostBody(
  query: string,
  accountId: number,
  topK: number,
  minScore: number,
) {
  const embedding = await hostModelResolver.resolveEmbedding();
  return hostIndex.withReader(async (repository) => {
    if (!repository) return [];
    const active = await repository.readActiveGeneration();
    if (active && active.embeddingSpaceId !== embedding.space.embeddingSpaceId)
      throw new ServiceError("EMBEDDING_SPACE_MISMATCH");
    const { prisma } = await import("../../prisma");
    const notes = await prisma.notes.findMany({
      where: { accountId, isRecycle: false },
      select: {
        id: true,
        accountId: true,
        content: true,
        createdAt: true,
        updatedAt: true,
        isRecycle: true,
      },
    });
    if (notes.length > 10000) throw new ServiceError("QUERY_BUDGET_EXCEEDED");
    const scan = active
      ? await repository.scanBodyRevisions({
          notes: notes.map((note) => ({ ...note, accountId })),
          embeddingSpaceId: active.embeddingSpaceId,
          generation: active.generation,
          maxChunks: 10000,
        })
      : { revisions: [], truncated: false };
    if (scan.truncated) throw new ServiceError("QUERY_BUDGET_EXCEEDED");
    const { vector } = await embedding.embedQueryText(query);
    const norm = Math.hypot(...vector);
    if (vector.length !== embedding.space.dimensions || !norm)
      throw new ServiceError("EMBEDDING_SPACE_MISMATCH");
    const cosine = (values: number[]) =>
      values.length === vector.length && values.every(Number.isFinite) && Math.hypot(...values) > 0
        ? Math.max(
            -1,
            Math.min(
              1,
              values.reduce((sum, v, i) => sum + v * vector[i], 0) / (Math.hypot(...values) * norm),
            ),
          )
        : -Infinity;
    const scores = new Map<number, number>();
    for (const revision of scan.revisions)
      scores.set(
        revision.noteId,
        Math.max(...revision.chunks.map((chunk) => cosine(chunk.vector))),
      );
    // Compatibility is confined to the old host RAG API. Unverified legacy rows
    // never enter VectorRepository or the new public plugin service.
    const legacy = await repository.client.execute(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='blinko'",
    );
    if (legacy.rows.length && notes.length) {
      const owned = new Set(notes.map((note) => note.id));
      const indexed = new Set(scan.revisions.map((revision) => revision.noteId));
      const rows = await repository.client.execute({
        sql: `SELECT metadata,vector_extract(embedding) AS vector FROM blinko
        WHERE json_valid(metadata) AND CAST(COALESCE(json_extract(metadata,'$.noteId'),json_extract(metadata,'$.id')) AS INTEGER) IN (${notes.map(() => "?").join(",")}) LIMIT 10001`,
        args: notes.map((note) => note.id),
      });
      if (rows.rows.length > 10000) throw new ServiceError("QUERY_BUDGET_EXCEEDED");
      for (const row of rows.rows) {
        const metadata = JSON.parse(String(row.metadata));
        const noteId = Number(metadata.noteId ?? metadata.id);
        if (!owned.has(noteId) || (indexed.has(noteId) && !metadata.isAttachment)) continue;
        const score = cosine(JSON.parse(String(row.vector)));
        scores.set(noteId, Math.max(scores.get(noteId) ?? -Infinity, score));
      }
    }
    return [...scores]
      .filter(([, score]) => score >= minScore)
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, topK)
      .map(([noteId, score]) => ({
        id: String(noteId),
        metadata: { id: noteId, noteId },
        score,
      }));
  });
}
