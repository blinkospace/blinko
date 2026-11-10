import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { prisma } from "../../prisma";
import { appRouter, type AppRouter } from "../../routerTrpc/_app";
import { IndexLifecycle } from "../../services/pluginServices/IndexLifecycle";
import {
  hostModelResolver,
  hostNoteSource,
} from "../../services/pluginServices/HostIndex";
import {
  BODY_PREPROCESSING_VERSION,
  digest,
} from "../../services/pluginServices/BodyInput";
import { TOKEN_WEIGHT_VERSION } from "../../services/pluginServices/NoteAggregation";
import { NoteQualificationRegistry } from '../../services/pluginServices/NoteQualification';
import {
  createPluginServices,
  createPluginServicesTransport,
} from "../../../app/src/store/plugin/services";
import type { VectorSnapshotDescriptor } from "../../../shared/lib/pluginServices/v1";

if (process.env.PLUGIN_SERVICES_TEST_DB !== "1" || !process.env.DATABASE_URL)
  throw new Error("An isolated PostgreSQL database is required");
const db = new URL(process.env.DATABASE_URL);
if (
  !["127.0.0.1", "localhost"].includes(db.hostname) ||
  (db.username !== "blinko_test" && !(process.env.B_CANDIDATE_PROBE === '1' && db.username === 'candidate_owner' && db.pathname === '/candidate_owned'))
)
  throw new Error("Wrong database");
const cwd = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "blinko-weighted-host-"));
process.chdir(temp);
mkdirSync(".blinko/vector", { recursive: true });
const client = createClient({ url: "file:.blinko/vector/embeddings.db" });
const writer = new IndexLifecycle(client, hostNoteSource);
let owner = 0,
  foreign = 0,
  currentUser = "0";
let permissions: string[] | undefined;
let ids: number[] = [],
  snapshot: VectorSnapshotDescriptor;
const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "http://plugin-services.test/api/trpc",
      transformer: superjson,
      fetch: (url, init) =>
        fetchRequestHandler({
          endpoint: "/api/trpc",
          req: new Request(String(url), init),
          router: appRouter,
          createContext: () => ({
            id: currentUser,
            sub: currentUser,
            name: "synthetic-snapshot-user",
            role: "superadmin",
            permissions,
            exp: 0,
            iat: 0,
            ip: "127.0.0.1",
            userAgent: null,
          }),
        }),
    }),
  ],
});
const sdk = createPluginServices(createPluginServicesTransport(() => trpc));
const q = (extra = {}) => ({
  source: { kind: "note" as const, noteId: ids[0] },
  aggregation: "note_level_weighted_v1" as const,
  snapshotHandle: snapshot.handle,
  ...extra,
});
const code = (p: Promise<unknown>) =>
  p.then(
    () => "SUCCESS",
    (error) => error.code,
  );

beforeAll(async () => {
  await prisma.pluginServicePolicy.deleteMany();
  owner = (
    await prisma.accounts.create({ data: { name: "synthetic-weighted-owner" } })
  ).id;
  foreign = (
    await prisma.accounts.create({
      data: { name: "synthetic-weighted-foreign" },
    })
  ).id;
  currentUser = String(owner);
  for (let i = 0; i < 7; i++)
    ids.push(
      (
        await prisma.notes.create({
          data: {
            accountId: i === 6 ? foreign : owner,
            type: i === 5 ? 2 : 0,
            content: `Synthetic weighted note ${i}`,
            createdAt: new Date("2026-01-01T00:00:00Z"),
            updatedAt: new Date("2026-01-02T00:00:00Z"),
          },
        })
      ).id,
    );
  expect((await new NoteQualificationRegistry(prisma).initialize()).ready).toBe(true);
  await writer.initialize();
  const generation = await writer.createGeneration({
    dimensions: 3,
    modelFingerprint: "synthetic-host-measured",
    embeddingSpaceId: "synthetic-weighted-host",
    preprocessingVersion: BODY_PREPROCESSING_VERSION,
  });
  for (let i = 0; i < ids.length; i++) {
    const note = (await hostNoteSource.readNote(ids[i]))!;
    // Index writes use synthetic outputs with explicit per-input usage evidence.
    // No real provider is configured or invoked by this fixture.
    await writer.indexBody(note, generation, async (values) => ({
      vectors: values.map(() =>
        i === 1
          ? [1, 0, 0]
          : i === 2
            ? [1, 1, 0]
            : i === 3
              ? [0, 1, 0]
              : i === 4
                ? [-1, 0, 0]
                : [1, 0, 0],
      ),
      tokenWeights: {
        version: TOKEN_WEIGHT_VERSION,
        modelFingerprint: generation.modelFingerprint,
        sourceHash: digest([generation.preprocessingVersion, values]),
        counts: values.map((value) => value.length),
      },
    }));
  }
  await writer.activateGeneration(generation.generation);
  await prisma.pluginServicePolicy.create({
    data: {
      id: 1,
      limits: {},
      features: {
        "vector.queryByText": { enabled: false },
        "ai.generateText": { enabled: false },
        "ai.listModels": { enabled: false },
      },
    },
  });
});
afterAll(async () => {
  client.close();
  await prisma.notes.deleteMany({ where: { id: { in: ids } } });
  await prisma.pluginServicePolicy.deleteMany();
  await prisma.pluginServiceRate.deleteMany({
    where: { accountId: { in: [owner, foreign] } },
  });
  await prisma.accounts.deleteMany({ where: { id: { in: [owner, foreign] } } });
  await prisma.$disconnect();
  process.chdir(cwd);
});
test("public SDK and authenticated appRouter use real PostgreSQL/LibSQL without model resolution or external HTTP", async () => {
  const resolve = spyOn(
    hostModelResolver,
    "resolveEmbedding",
  ).mockImplementation(async () => {
    throw new Error("No model construction in this path");
  });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("No external HTTP");
  });
  try {
    const caps = await sdk.capabilities();
    expect(caps.features["vector.snapshots"]?.available).toBe(true);
    expect(caps.features["vector.noteLevelAggregation"]?.available).toBe(true);
    snapshot = await sdk.vector.snapshots.create({
      aggregation: "note_level_weighted_v1",
      scope: { types: [0, 1] },
    });
    expect(snapshot.preparedNoteCount).toBe(5);
    expect(snapshot.range.kind).toBe("prepared-subset");
    const r = await sdk.vector.query(q({ limit: 3 }));
    expect(r.items.map((x) => x.note.id)).toEqual([ids[1], ids[2], ids[3]]);
    [1, Math.SQRT1_2, 0].forEach((score, i) =>
      expect(r.items[i].score).toBeCloseTo(score, 12),
    );
    expect(r.items.every((x) => x.snapshot?.handle === snapshot.handle)).toBe(
      true,
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    resolve.mockRestore();
    fetch.mockRestore();
  }
});
test("real SQL exclusion fills from lower ranks and does not discard zero or negative scores", async () => {
  const r = await sdk.vector.query(
    q({ excludeNoteIds: [ids[1], ids[2]], limit: 2 }),
  );
  expect(r.items.map((x) => [x.note.id, x.score])).toEqual([
    [ids[3], 0],
    [ids[4], -1],
  ]);
  expect(r.retrieval.remaining).toBe("no");
  const none = await sdk.vector.snapshots.sample({
    handle: snapshot.handle,
    excludeNoteIds: ids.slice(0, 5),
  });
  expect(none).toEqual({ item: null, poolSize: 5 });
});
test("host readNote is bound to the returned hash and changes never become new verified selections", async () => {
  const r = await sdk.vector.query(q({ limit: 1 })),
    hit = r.items[0];
  const input = {
    handle: snapshot.handle,
    noteId: hit.note.id,
    snapshotHash: hit.snapshot!.hash,
  };
  const original = await sdk.vector.snapshots.readNote(input);
  expect(original.status).toBe("ok");
  if (original.status === "ok") {
    expect(original.accountId).toBe(owner);
    expect(original.type).toBe(0);
  }
  await prisma.notes.update({
    where: { id: hit.note.id },
    data: { content: "Synthetic edited text" },
  });
  expect((await sdk.vector.snapshots.readNote(input)).status).toBe("changed");
  expect(
    (await sdk.vector.query(q({ limit: 2 }))).items.map((x) => x.note.id),
  ).toEqual([ids[2], ids[3]]);
});
test("foreign and fabricated handles are indistinguishable through the SDK", async () => {
  currentUser = String(foreign);
  expect(
    await code(sdk.vector.snapshots.sample({ handle: snapshot.handle })),
  ).toBe("NOT_FOUND_OR_FORBIDDEN");
  currentUser = String(owner);
  expect(
    await code(
      sdk.vector.snapshots.sample({
        handle: "11111111-1111-4111-8111-111111111111",
      }),
    ),
  ).toBe("NOT_FOUND_OR_FORBIDDEN");
});
test("restricted discovery requires every snapshot procedure and exact route authorization still applies", async () => {
  permissions = [
    "pluginServices.capabilities",
    "pluginServices.vector.snapshots.create",
  ];
  try {
    const caps = await sdk.capabilities();
    expect(caps.features["vector.snapshots"]).toEqual({
      available: false,
      reason: "forbidden",
    });
    expect(
      await code(sdk.vector.snapshots.sample({ handle: snapshot.handle })),
    ).toBe("FORBIDDEN");
  } finally {
    permissions = undefined;
  }
});
test("expiry and release are enforced by the actual route, and do not silently create another pool", async () => {
  await client.execute({
    sql: "UPDATE blinko_ps_snapshots SET expires_at=0 WHERE handle=?",
    args: [snapshot.handle],
  });
  expect(
    await code(sdk.vector.snapshots.sample({ handle: snapshot.handle })),
  ).toBe("INDEX_CHANGED");
  await sdk.vector.snapshots.release({ handle: snapshot.handle });
  expect(
    await code(sdk.vector.snapshots.sample({ handle: snapshot.handle })),
  ).toBe("NOT_FOUND_OR_FORBIDDEN");
  expect(
    Number(
      (await client.execute("SELECT COUNT(*) AS n FROM blinko_ps_snapshots"))
        .rows[0].n,
    ),
  ).toBe(0);
});
