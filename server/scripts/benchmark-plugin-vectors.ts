// Synthetic exact-query benchmark. Requires the same guarded disposable PG as tests.
import { PrismaClient } from "@prisma/client";
import { createClient } from "@libsql/client";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, release } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { IndexLifecycle } from "../services/pluginServices/IndexLifecycle";
import {
  VectorRepository,
  indexTable,
  openVectorReader,
} from "../services/pluginServices/VectorRepository";
import {
  BODY_PREPROCESSING_VERSION,
  fingerprintNoteSnapshot,
  digest,
} from "../services/pluginServices/BodyInput";
import { createQueryNoteSource } from "../services/pluginServices/VectorQueryHost";
import { createPolicyStore } from "../services/pluginServices/PolicyStore";
import { createAccountRateGate, createCallPolicy } from "../services/pluginServices/CallPolicy";
import { createVectorQueryService } from "../services/pluginServices/VectorQueryService";
import { VECTOR_QUERY_BUDGET } from "../services/pluginServices/vectorSchemas";
if (process.env.PLUGIN_SERVICES_TEST_DB !== "1" || !process.env.DATABASE_URL)
  throw new Error("Dedicated PG required");
const database = new URL(process.env.DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(database.hostname) || database.username !== "blinko_test")
  throw new Error("Wrong database");
const output = process.argv[2];
if (!output) throw new Error("Provide an unused output JSON path");
const prisma = new PrismaClient();
const date = new Date("2026-01-01T00:00:00Z");
const dimensions = 1024;
const runs: unknown[] = [];
try {
  for (const [count, chunksPerNote] of [
    [1000, 1],
    [10000, 1],
    [50000, 1],
    [1000, 4],
    [10000, 4],
  ]) {
    const account = await prisma.accounts.create({
      data: { name: `synthetic-vector-benchmark-${count}-${chunksPerNote}` },
    });
    const url =
      "file:" + path.join(mkdtempSync(path.join(tmpdir(), "blinko-vector-bench-")), "vectors.db");
    const client = createClient({ url });
    console.log(JSON.stringify({ seeding: { notes: count, chunksPerNote, dimensions } }));
    const seedStart = performance.now();
    try {
      for (let offset = 0; offset < count; offset += 1000) {
        await prisma.notes.createMany({
          data: Array.from({ length: Math.min(1000, count - offset) }, (_, i) => ({
            accountId: account.id,
            content: `Synthetic benchmark note ${offset + i}: semantic vector query and reusable plugin services.`,
            createdAt: date,
            updatedAt: date,
          })),
        });
      }
      const notes = await prisma.notes.findMany({
        where: { accountId: account.id },
        orderBy: { id: "asc" },
        select: { id: true, accountId: true, content: true, createdAt: true, updatedAt: true },
      });
      const writer = new IndexLifecycle(client, { readNote: async () => null });
      await writer.initialize();
      const generation = await writer.createGeneration({
        dimensions,
        embeddingSpaceId: "synthetic-benchmark-1024",
        modelFingerprint: "synthetic-benchmark",
        preprocessingVersion: BODY_PREPROCESSING_VERSION,
      });
      const blobs = Array.from({ length: 4 }, (_, i) => {
        const v = new Float32Array(dimensions);
        v[0] = 1;
        v[1] = i / 4;
        v[2] = 0.25;
        return Buffer.from(v.buffer);
      });
      // Fixture bulk insert only: no models, no host indexes or private data.
      for (let start = 0; start < notes.length; start += 250) {
        const tx = await client.transaction("write");
        try {
          for (const row of notes.slice(start, start + 250)) {
            const note = { ...row, accountId: account.id };
            const revision = randomUUID().replaceAll("-", "");
            const hash = fingerprintNoteSnapshot(note);
            const sourceHash = digest([note.content, chunksPerNote]);
            await tx.execute({
              sql: "INSERT INTO blinko_ps_heads(account_id,note_id,epoch,tombstone) VALUES(?,?,1,0)",
              args: [account.id, note.id],
            });
            await tx.execute({
              sql: `INSERT INTO blinko_ps_revisions(revision_id,account_id,note_id,generation,snapshot_hash,source_hash,chunk_count,epoch,state,provenance,old_revisions,created_at,expires_at)
              VALUES(?,?,?,?,?,?,?,1,'published','verified','[]',?,?)`,
              args: [
                revision,
                account.id,
                note.id,
                generation.generation,
                hash,
                sourceHash,
                chunksPerNote,
                date.toISOString(),
                date.toISOString(),
              ],
            });
            for (let ordinal = 0; ordinal < chunksPerNote; ordinal++) {
              const metadata = {
                accountId: account.id,
                id: note.id,
                noteId: note.id,
                revisionId: revision,
                noteSnapshotHash: hash,
                sourceHash,
                sourceKind: "body",
                chunkOrdinal: ordinal,
                chunkCount: chunksPerNote,
                embeddingSpaceId: generation.embeddingSpaceId,
                generation: generation.generation,
                text: note.content + ` chunk ${ordinal}`,
              };
              await tx.execute({
                sql: `INSERT INTO ${indexTable(generation.tableName)}(vector_id,embedding,metadata) VALUES(?,?,?)`,
                args: [`${revision}:${ordinal}`, blobs[ordinal], JSON.stringify(metadata)],
              });
            }
          }
          await tx.commit();
        } finally {
          await tx.close();
        }
      }
      await client.execute({
        sql: "INSERT INTO blinko_ps_corpora(account_id,generation,revision) VALUES(?,?,?)",
        args: [account.id, generation.generation, randomUUID()],
      });
      await writer.activateGeneration(generation.generation);
      const seedMs = performance.now() - seedStart;
      const measurements: Array<Record<string, unknown> & { totalMs: number }> = [];
      let sqlMs = 0,
        vectorMs = 0;
      const rawNotes = createQueryNoteSource(prisma);
      const timedNotes = Object.fromEntries(
        Object.entries(rawNotes).map(([key, fn]) => [
          key,
          async (...args: unknown[]) => {
            const at = performance.now();
            try {
              return await (fn as Function)(...args);
            } finally {
              sqlMs += performance.now() - at;
            }
          },
        ]),
      ) as unknown as typeof rawNotes;
      const service = createVectorQueryService({
        notes: timedNotes,
        policyStore: createPolicyStore({ read: async () => null }),
        rateGate: createAccountRateGate({ prisma }),
        callPolicy: createCallPolicy({ prisma }),
        resolveEmbedding: async () => {
          throw new Error("Models forbidden");
        },
        withReader: async (run) => {
          const repo = (await openVectorReader(url))!;
          const timed = new Proxy(repo, {
            get(target, key) {
              const value = Reflect.get(target, key);
              if (typeof value !== "function") return value;
              return async (...args: unknown[]) => {
                const at = performance.now();
                try {
                  return await value.apply(target, args);
                } finally {
                  vectorMs += performance.now() - at;
                }
              };
            },
          });
          try {
            return await run(timed);
          } finally {
            repo.client.close();
          }
        },
      });
      const samples = count === 50000 ? 4 : 11;
      for (let i = 0; i < samples; i++) {
        sqlMs = 0;
        vectorMs = 0;
        const at = performance.now();
        const result = await service.query(account.id, {
          source: { kind: "note", noteId: notes[0].id },
          limit: 10,
        });
        const totalMs = performance.now() - at;
        measurements.push({
          totalMs,
          sqlMs,
          vectorMs,
          scoreAndAssemblyMs: Math.max(0, totalMs - sqlMs - vectorMs),
          returned: result.items.length,
          retrieval: result.retrieval,
          coverage: result.index.coverage,
        });
      }
      const warm = measurements
        .slice(1)
        .map((m) => m.totalMs)
        .sort((a, b) => a - b);
      const result = {
        notes: count,
        chunksPerNote,
        dimensions,
        seedMs,
        samples: measurements,
        warmP50Ms: warm[Math.floor(warm.length * 0.5)],
        warmP95Ms: warm[Math.min(warm.length - 1, Math.ceil(warm.length * 0.95) - 1)],
      };
      runs.push(result);
      console.log(JSON.stringify(result));
    } finally {
      client.close();
      await prisma.notes.deleteMany({ where: { accountId: account.id } });
      await prisma.pluginServiceRate.deleteMany({ where: { accountId: account.id } });
      await prisma.accounts.delete({ where: { id: account.id } });
    }
  }
  writeFileSync(
    output,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        cpu: cpus()[0]?.model,
        cpuCount: cpus().length,
        platform: process.platform,
        os: release(),
        runtime: process.version,
        budget: VECTOR_QUERY_BUDGET,
        providerCalls: 0,
        sql: "PostgreSQL 17.11 local",
        vectorStore: "LibSQL local file, existing host schema",
        cache:
          "first query and subsequent warm queries; new reader connection each call; OS caches not cleared",
        limitation:
          "Small descriptive sample, not a statistically stable production SLO estimate. Service boundary includes SQL, vector reads, account rate gate and scoring; no HTTP/SDK or external embedding delay in this benchmark.",
        runs,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
} finally {
  await prisma.$disconnect();
}
