import { afterEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IndexLifecycle } from "../../services/pluginServices/IndexLifecycle";
import {
  VectorRepository,
  openVectorReader,
  indexTable,
} from "../../services/pluginServices/VectorRepository";
import {
  prepareBodyInput,
  BODY_PREPROCESSING_VERSION,
  fingerprintNoteSnapshot,
  encodingValues,
  digest,
} from "../../services/pluginServices/BodyInput";
import { rollbackIndexMetadata } from "../../services/pluginServices/indexMigrations";
import { createModelResolver } from "../../services/pluginServices/ModelResolver";
import { TOKEN_WEIGHT_VERSION } from "../../services/pluginServices/NoteAggregation";
import type {
  NoteSnapshot,
  EmbeddingSpace,
} from "../../services/pluginServices/types";

const clients: Client[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});
const space: EmbeddingSpace = {
  dimensions: 3,
  modelFingerprint: "synthetic-model-v1",
  embeddingSpaceId: "synthetic-space-v1",
  preprocessingVersion: BODY_PREPROCESSING_VERSION,
};
const seed = (id = 1, accountId = 1): NoteSnapshot => ({
  id,
  accountId,
  content: "# Current body\n\nA synthetic note.",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
});
async function fixture(aggregationDimensionOps?: number) {
  const url =
    "file:" +
    path.join(mkdtempSync(path.join(tmpdir(), "blinko-ps-")), "vectors.db");
  const client = createClient({ url });
  clients.push(client);
  const notes = new Map<number, NoteSnapshot>([[1, seed()]]);
  const source = { readNote: async (id: number) => notes.get(id) ?? null };
  let at = new Date("2026-01-03T00:00:00Z");
  const writer = new IndexLifecycle(client, source, () => at, aggregationDimensionOps);
  await writer.initialize();
  const generation = await writer.createGeneration(space);
  const repo = new VectorRepository(client);
  const encode = async (values: string[]) => values.map(() => [2, 0, 0]);
  return {
    url,
    client,
    writer,
    generation,
    notes,
    repo,
    encode,
    setTime: (value: Date) => {
      at = value;
    },
  };
}
async function read(
  f: Awaited<ReturnType<typeof fixture>>,
  note = f.notes.get(1)!,
) {
  return f.repo.readBodyRevision({
    note,
    generation: f.generation.generation,
    embeddingSpaceId: f.generation.embeddingSpaceId,
  });
}

describe("same-database body revisions and lifecycle", () => {
  test("explicit weighted indexing rejects over budget before encoding or creating a revision; ordinary indexing is unchanged", async () => {
    const f = await fixture(2);
    let encoded = 0;
    const before = (await f.client.execute("SELECT total_changes() AS n")).rows;
    await expect(f.writer.indexBody(f.notes.get(1)!, f.generation, async (values) => {
      encoded++;
      return f.encode(values);
    }, { requireTokenWeights: true })).rejects.toMatchObject({ code: "QUERY_BUDGET_EXCEEDED" });
    expect(encoded).toBe(0);
    expect((await f.client.execute("SELECT total_changes() AS n")).rows).toEqual(before);
    expect((await f.client.execute("SELECT revision_id FROM blinko_ps_revisions")).rows).toHaveLength(0);
    expect(await f.writer.indexBody(f.notes.get(1)!, f.generation, f.encode)).toBe(true);
  });
  test("production-sized weighted stage rejects from cardinalities before vector visits and before any transaction writes", async () => {
    // This cannot raise the production bound. Use 1,526 references to one inert
    // vector instead of allocating/encoding more than 100 million values.
    const f = await fixture(Number.MAX_SAFE_INTEGER);
    const generation = await f.writer.createGeneration({ ...space, dimensions: 65536 });
    const chunkCount = Math.floor(100_000_000 / generation.dimensions) + 1;
    const prepared = await prepareBodyInput(f.notes.get(1)!);
    const texts = Array<string>(chunkCount).fill("synthetic");
    const values = encodingValues(texts, f.notes.get(1)!);
    const body = { ...prepared, texts, values, sourceHash: digest([BODY_PREPROCESSING_VERSION, values]) };
    const lease = await f.writer.beginRevision(f.notes.get(1)!, generation, body);
    let vectorVisits = 0;
    const vector = new Proxy<number[]>([], { get() { vectorVisits++; throw new Error("must reject before reading any vector"); } });
    const before = (await f.client.execute("SELECT total_changes() AS n")).rows;
    await expect(f.writer.stageRevision(lease, generation, body, Array(chunkCount).fill(vector), "verified", {
      version: TOKEN_WEIGHT_VERSION, sourceHash: body.sourceHash,
      modelFingerprint: generation.modelFingerprint, counts: Array(chunkCount).fill(1),
    })).rejects.toMatchObject({ code: "QUERY_BUDGET_EXCEEDED" });
    expect(vectorVisits).toBe(0);
    // total_changes also counts rolled-back writes, so zero rules out staging
    // chunks first and merely rolling the transaction back afterward.
    expect((await f.client.execute("SELECT total_changes() AS n")).rows).toEqual(before);
    expect((await f.client.execute(`SELECT vector_id FROM ${indexTable(generation.tableName)}`)).rows).toHaveLength(0);
    expect((await f.client.execute("SELECT revision_id FROM blinko_ps_note_vectors")).rows).toHaveLength(0);
    expect((await f.client.execute({ sql: "SELECT state FROM blinko_ps_revisions WHERE revision_id=?", args: [lease.revisionId] })).rows[0].state).toBe("writing");
  });
  test("weighted stage accepts the exact tightened boundary and requires evidence when explicitly requested", async () => {
    const f = await fixture(3);
    const note = f.notes.get(1)!;
    const body = await prepareBodyInput(note);
    expect(body.values).toHaveLength(1);
    expect(await f.writer.indexBody(note, f.generation, async () => ({
      vectors: [[1, 0, 0]], tokenWeights: {
        version: TOKEN_WEIGHT_VERSION, sourceHash: body.sourceHash,
        modelFingerprint: f.generation.modelFingerprint, counts: [2],
      },
    }), { requireTokenWeights: true })).toBe(true);
    expect((await f.client.execute("SELECT revision_id FROM blinko_ps_note_vectors")).rows).toHaveLength(1);
    await expect(f.writer.indexBody(note, f.generation, f.encode, { requireTokenWeights: true })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect((await f.client.execute("SELECT revision_id FROM blinko_ps_note_vectors")).rows).toHaveLength(1);
  });
  test("reads stored float32 values without vector_extract decimal rounding", async () => {
    const f = await fixture();
    const values = [0.123456789, -0.016936950385570526, 0.987654321];
    await f.writer.indexBody(f.notes.get(1)!, f.generation, async (input) =>
      input.map(() => values),
    );
    await f.writer.activateGeneration(f.generation.generation);
    expect((await read(f))!.chunks[0].vector).toEqual(values.map(Math.fround));
  });
  test("reader does not create a missing database or migrate a legacy database", async () => {
    const missing = path.join(
      mkdtempSync(path.join(tmpdir(), "blinko-missing-")),
      "missing.db",
    );
    expect(await openVectorReader("file:" + missing)).toBeNull();
    expect(existsSync(missing)).toBe(false);
    const c = createClient({ url: "file::memory:" });
    clients.push(c);
    await c.execute("CREATE TABLE legacy_marker(id INTEGER)");
    const before = await c.execute("SELECT total_changes() AS n");
    expect((await new VectorRepository(c).readStatus(1)).provenance).toBe(
      "none",
    );
    expect((await c.execute("SELECT total_changes() AS n")).rows).toEqual(
      before.rows,
    );
    expect(
      (
        await c.execute(
          "SELECT name FROM sqlite_master WHERE name LIKE 'blinko_ps_%'",
        )
      ).rows,
    ).toHaveLength(0);
  });
  test("complete vectors are read unchanged, and reader connection cannot write", async () => {
    const f = await fixture();
    await f.writer.indexBody(f.notes.get(1)!, f.generation, f.encode);
    await f.writer.activateGeneration(f.generation.generation, null);
    const reader = (await openVectorReader(f.url))!;
    clients.push(reader.client);
    expect(
      (await reader.readBodyRevision({
        note: f.notes.get(1)!,
        ...f.generation,
      }))!.chunks[0].vector,
    ).toEqual([2, 0, 0]);
    await expect(
      reader.client.execute("CREATE TABLE forbidden(id INTEGER)"),
    ).rejects.toThrow();
    expect((await f.repo.readStatus(2)).provenance).toBe("none");
  });
  test("long-to-short replacement removes all old chunks without changing SQL timestamps", async () => {
    const f = await fixture();
    const long = {
      ...seed(),
      content: Array.from(
        { length: 1000 },
        (_, i) =>
          `paragraph ${i}: synthetic body text for full chunk coverage.\n\n`,
      ).join(""),
    };
    f.notes.set(1, long);
    const timestamp = long.updatedAt!.toISOString();
    await f.writer.indexBody(long, f.generation, f.encode);
    await f.writer.activateGeneration(f.generation.generation);
    const old = await read(f);
    expect(old!.chunkCount).toBeGreaterThan(1);
    const short = {
      ...seed(),
      content: "Short body",
      updatedAt: new Date("2026-01-03T00:00:00Z"),
    };
    f.notes.set(1, short);
    await f.writer.indexBody(short, f.generation, f.encode);
    expect((await read(f))!.chunkCount).toBe(1);
    expect(
      Number(
        (
          await f.client.execute(
            `SELECT COUNT(*) AS n FROM ${indexTable(f.generation.tableName)}`,
          )
        ).rows[0].n,
      ),
    ).toBe(1);
    expect(long.updatedAt!.toISOString()).toBe(timestamp);
    expect(f.notes.get(1)!.updatedAt!.toISOString()).toBe(
      "2026-01-03T00:00:00.000Z",
    );
  });
  test("out-of-order old worker cannot overwrite or delete the new revision", async () => {
    const f = await fixture();
    const old = f.notes.get(1)!;
    const body = await prepareBodyInput(old);
    const lease = await f.writer.beginRevision(old, f.generation, body);
    const fresh = {
      ...old,
      content: "New body",
      updatedAt: new Date("2026-01-03T00:00:00Z"),
    };
    f.notes.set(1, fresh);
    await f.writer.indexBody(fresh, f.generation, f.encode);
    await f.writer.activateGeneration(f.generation.generation);
    await expect(
      f.writer.stageRevision(
        lease,
        f.generation,
        body,
        await f.encode(body.values),
      ),
    ).rejects.toThrow();
    await f.writer.discardRevision(lease, f.generation);
    expect((await read(f))!.chunks[0].text).toBe("New body");
  });
  test("delete fence rejects a late encoder and never recreates a SQL note", async () => {
    const f = await fixture();
    const body = await prepareBodyInput(f.notes.get(1)!);
    const lease = await f.writer.beginRevision(
      f.notes.get(1)!,
      f.generation,
      body,
    );
    f.notes.delete(1);
    await f.writer.deleteNote(1, 1);
    await expect(
      f.writer.stageRevision(
        lease,
        f.generation,
        body,
        await f.encode(body.values),
      ),
    ).rejects.toThrow();
    await f.writer.discardRevision(lease, f.generation);
    expect(
      Number(
        (
          await f.client.execute(
            `SELECT COUNT(*) AS n FROM ${indexTable(f.generation.tableName)}`,
          )
        ).rows[0].n,
      ),
    ).toBe(0);
    expect(f.notes.size).toBe(0);
  });
  test("staged crash recovers without encoding, incomplete writer expires", async () => {
    const f = await fixture();
    const body = await prepareBodyInput(f.notes.get(1)!);
    const lease = await f.writer.beginRevision(
      f.notes.get(1)!,
      f.generation,
      body,
    );
    await f.writer.stageRevision(
      lease,
      f.generation,
      body,
      await f.encode(body.values),
    );
    expect(await f.writer.recover()).toEqual({ published: 1, discarded: 0 });
    await f.writer.activateGeneration(f.generation.generation);
    expect((await read(f))!.chunkCount).toBe(body.texts.length);
    await f.writer.beginRevision(f.notes.get(1)!, f.generation, body);
    f.setTime(new Date("2026-01-04T00:00:00Z"));
    expect(await f.writer.recover()).toEqual({ published: 0, discarded: 1 });
  });
  test("staged stale source is discarded on restart", async () => {
    const f = await fixture();
    const body = await prepareBodyInput(f.notes.get(1)!);
    const lease = await f.writer.beginRevision(
      f.notes.get(1)!,
      f.generation,
      body,
    );
    await f.writer.stageRevision(
      lease,
      f.generation,
      body,
      await f.encode(body.values),
    );
    f.notes.set(1, { ...seed(), content: "Edited while stopped" });
    expect(await f.writer.recover()).toEqual({ published: 0, discarded: 1 });
  });
  test("dimension changes use a new physical table and old generation can be restored", async () => {
    const f = await fixture();
    await f.writer.indexBody(seed(), f.generation, f.encode);
    await f.writer.activateGeneration(f.generation.generation);
    const next = await f.writer.createGeneration({
      ...space,
      dimensions: 2,
      embeddingSpaceId: "two-dimensions",
      modelFingerprint: "two",
    });
    await f.writer.indexBody(seed(), next, async (values) =>
      values.map(() => [0, 3]),
    );
    await f.writer.activateGeneration(next.generation, f.generation.generation);
    expect((await f.repo.readActiveGeneration())!.dimensions).toBe(2);
    await expect(read(f)).rejects.toMatchObject({ code: "INDEX_CHANGED" });
    await f.writer.activateGeneration(f.generation.generation, next.generation);
    expect((await read(f))!.chunks[0].vector).toEqual([2, 0, 0]);
  });
  test("migration rollback preserves vector bytes and can migrate again", async () => {
    const f = await fixture();
    await f.writer.indexBody(seed(), f.generation, f.encode);
    await rollbackIndexMetadata(f.client);
    expect(
      (
        await f.client.execute(
          `SELECT vector_extract(embedding) AS v FROM ${indexTable(f.generation.tableName)}`,
        )
      ).rows[0].v,
    ).toBe("[2,0,0]");
    expect((await f.repo.readStatus(1)).provenance).toBe("none");
    await f.writer.initialize();
  });
  test("wrong account, recycle bin and stale SQL snapshots cannot read vectors", async () => {
    const f = await fixture();
    await f.writer.indexBody(seed(), f.generation, f.encode);
    await f.writer.activateGeneration(f.generation.generation);
    expect(await read(f, { ...seed(), accountId: 2 })).toBeNull();
    expect(await read(f, { ...seed(), isRecycle: true })).toBeNull();
    await expect(
      read(f, { ...seed(), content: "Changed SQL body" }),
    ).rejects.toMatchObject({ code: "SOURCE_INDEX_STALE" });
  });
  test("partial chunk deletion invalidates whole revision", async () => {
    const f = await fixture();
    await f.writer.indexBody(seed(), f.generation, f.encode);
    await f.writer.activateGeneration(f.generation.generation);
    await f.client.execute(`DELETE FROM ${indexTable(f.generation.tableName)}`);
    await expect(read(f)).rejects.toMatchObject({ code: "SOURCE_NOT_INDEXED" });
  });
  test("legacy ownership inventory does not invent provenance; attestation needs explicit source evidence", async () => {
    const f = await fixture();
    const note = f.notes.get(1)!;
    const body = await prepareBodyInput(note);
    await f.client.execute(
      "CREATE TABLE blinko(vector_id TEXT,embedding F32_BLOB(3),metadata TEXT)",
    );
    const vectorIds = body.texts.map((_, i) => `legacy-${i}`);
    for (let ordinal = 0; ordinal < body.texts.length; ordinal++)
      await f.client.execute({
        sql: "INSERT INTO blinko VALUES(?,vector32(?),?)",
        args: [
          vectorIds[ordinal],
          "[2,0,0]",
          JSON.stringify({
            id: note.id,
            noteId: note.id,
            text: body.texts[ordinal],
            createTime: note.createdAt.toISOString(),
            updatedAt: note.updatedAt!.toISOString(),
          }),
        ],
      });
    expect(await f.writer.inventoryLegacy()).toBe(body.texts.length);
    expect((await f.repo.readStatus(1)).provenance).toBe("none");
    await expect(
      f.writer.attestLegacy({
        note,
        generation: f.generation,
        vectorIds,
        administratorId: 1,
        confirmed: false,
        evidence: "synthetic-model-record: known encoder and input",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await f.writer.attestLegacy({
        note,
        generation: f.generation,
        vectorIds,
        administratorId: 1,
        confirmed: true,
        evidence: "synthetic-model-record: known encoder and input",
      }),
    ).toBe(true);
    await f.writer.activateGeneration(f.generation.generation);
    expect((await read(f))!.provenance).toBe("legacy-attested");
    expect(
      (await f.client.execute("SELECT * FROM blinko_ps_attestations")).rows,
    ).toHaveLength(1);
  });
  test("original undefined timestamp encoding is distinct from a current timestamp", () => {
    const note = seed();
    const legacy = { ...note, updatedAt: undefined };
    expect(encodingValues(["a"], legacy)[0]).toEndWith("Update At: undefined");
    expect(fingerprintNoteSnapshot(note)).not.toBe(
      fingerprintNoteSnapshot(legacy),
    );
  });
  test("embedding resolution does not require main LLM or construct a provider for inspection", async () => {
    let calls = 0;
    const resolver = createModelResolver({
      readEmbeddingModel: async () => ({
        id: 1,
        modelKey: "synthetic",
        config: { embeddingDimensions: 3 },
        provider: { id: 1, provider: "custom" },
      }),
      createEmbeddingModel: async () => {
        calls++;
        throw new Error("should remain lazy");
      },
    });
    expect((await resolver.resolveEmbedding()).space.dimensions).toBe(3);
    expect(calls).toBe(0);
  });
});
