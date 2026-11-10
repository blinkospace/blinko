import { test, expect } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHostIndex } from "../../services/pluginServices/HostIndex";
import { BODY_PREPROCESSING_VERSION } from "../../services/pluginServices/BodyInput";
import type { NoteSnapshot } from "../../services/pluginServices/types";

function fixture() {
  const url =
    "file:" +
    path.join(
      mkdtempSync(path.join(tmpdir(), "blinko-host-index-")),
      "host.db",
    );
  const notes = new Map<number, NoteSnapshot>([
    [
      1,
      {
        id: 1,
        accountId: 1,
        content: "Synthetic body",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-02"),
      },
    ],
  ]);
  let modelResolutions = 0,
    encodings = 0,
    flags = 0;
  const host = createHostIndex({
    url,
    readNote: async (id) => notes.get(id) ?? null,
    markIndexed: async () => {
      flags++;
    },
    resolveEmbedding: async () => {
      modelResolutions++;
      return {
        modelId: 1,
        space: {
          dimensions: 3,
          embeddingSpaceId: "synthetic-only",
          modelFingerprint: "synthetic",
          preprocessingVersion: BODY_PREPROCESSING_VERSION,
        },
        embedBody: async (values) => {
          encodings++;
          return values.map(() => [2, 0, 0]);
        },
        embedQueryText: async () => {
          throw new Error("must not be used");
        },
      };
    },
  });
  return {
    host,
    url,
    notes,
    counts: () => ({ modelResolutions, encodings, flags }),
  };
}
test("single-note cleanup requires current or persisted ownership after SQL deletion", async () => {
  const f = fixture();
  expect(await f.host.deleteOwned(1, 99999)).toBe(false);
  await f.host.upsert({ id: 1, content: "Synthetic body" });
  expect(await f.host.deleteOwned(2, 1)).toBe(false);
  f.notes.delete(1);
  expect(await f.host.deleteOwned(2, 1)).toBe(false);
  expect(await f.host.deleteOwned(1, 1)).toBe(true);
  expect(await f.host.deleteOwned(1, 1)).toBe(true);
  expect(
    await f.host.withReader(
      async (repository) => (await repository!.readStatus(1)).available,
    ),
  ).toBe(false);
});
test("host writer and reader share the same database without a configured main LLM", async () => {
  const f = fixture();
  expect(await f.host.upsert({ id: 1, content: "Synthetic body" })).toBe(true);
  expect(
    await f.host.withReader(
      async (repo) => (await repo!.readStatus(1)).provenance,
    ),
  ).toBe("verified");
  expect(f.counts()).toEqual({ modelResolutions: 1, encodings: 1, flags: 1 });
  expect(f.notes.get(1)!.updatedAt!.toISOString()).toBe(
    "2026-01-02T00:00:00.000Z",
  );
  await f.host.withReader(async (repo) => {
    const generation = (await repo!.readActiveGeneration())!;
    expect(
      (await repo!.readBodyRevision({ note: f.notes.get(1)!, ...generation }))!
        .chunks[0].vector,
    ).toEqual([2, 0, 0]);
  });
  expect(f.counts().encodings).toBe(1);
});
test("host rejects outdated queued content before constructing an embedding resource", async () => {
  const f = fixture();
  expect(await f.host.upsert({ id: 1, content: "Old queued content" })).toBe(
    false,
  );
  expect(f.counts().modelResolutions).toBe(0);
});
test("host body rebuild keeps the old generation available for explicit rollback", async () => {
  const f = fixture();
  await f.host.upsert({ id: 1, content: "Synthetic body" });
  const old = await f.host.withReader(
    async (repo) => (await repo!.readActiveGeneration())!.generation,
  );
  const fresh = await f.host.beginRebuild();
  expect(fresh).not.toBe(old);
  const client = createClient({ url: f.url });
  try {
    expect(
      (await client.execute("SELECT generation FROM blinko_ps_generations"))
        .rows,
    ).toHaveLength(2);
  } finally {
    client.close();
  }
});
test("host delete removes all legacy chunks and published body revisions", async () => {
  const f = fixture();
  await f.host.upsert({ id: 1, content: "Synthetic body" });
  const client = createClient({ url: f.url });
  try {
    await client.execute(
      "CREATE TABLE blinko(vector_id TEXT,embedding F32_BLOB(3),metadata TEXT)",
    );
    for (let ordinal = 0; ordinal < 4; ordinal++)
      await client.execute({
        sql: "INSERT INTO blinko VALUES(?,vector32(?),?)",
        args: [
          String(ordinal),
          "[1,0,0]",
          JSON.stringify({ id: 1, noteId: 1, text: "legacy" }),
        ],
      });
    f.notes.delete(1);
    await f.host.delete(1, 1);
    await f.host.delete(1, 1);
    expect((await client.execute("SELECT * FROM blinko")).rows).toHaveLength(0);
    expect(
      await f.host.withReader(
        async (repo) => (await repo!.readStatus(1)).available,
      ),
    ).toBe(false);
  } finally {
    client.close();
  }
});
