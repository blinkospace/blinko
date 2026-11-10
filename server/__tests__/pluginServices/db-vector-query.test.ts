import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  hostTextGeneratorFactory,
} from "../../services/pluginServices/HostIndex";
import type { TextGenerator } from "../../services/pluginServices/AiGenerationService";
import { createQueryNoteSource } from "../../services/pluginServices/VectorQueryHost";
import { createAccountRateGate, createCallPolicy } from "../../services/pluginServices/CallPolicy";
import { createPolicyStore } from "../../services/pluginServices/PolicyStore";
import { createVectorQueryService } from "../../services/pluginServices/VectorQueryService";
import { VectorRepository } from "../../services/pluginServices/VectorRepository";
import { BODY_PREPROCESSING_VERSION } from "../../services/pluginServices/BodyInput";
import {
  createPluginServices,
  createPluginServicesTransport,
  decodeServiceError,
} from "../../../app/src/store/plugin/services";
import RandomWalkPlugin from "../../../docs/plugin-services/examples/random-walk/plugin";
import SimilarContentPlugin from "../../../docs/plugin-services/examples/similar-content/plugin";
import NoteSummaryPlugin from "../../../docs/plugin-services/examples/note-summary/plugin";

const blockedFetch = Object.assign(
  async () => { throw new Error("External network disabled"); },
  { preconnect: () => { throw new Error("External network disabled"); } },
);

if (process.env.PLUGIN_SERVICES_TEST_DB !== "1" || !process.env.DATABASE_URL)
  throw new Error("An isolated real PostgreSQL database is required.");
const db = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(db.hostname) || db.username !== "blinko_test")
  throw new Error("Wrong test database");
const cwd = process.cwd();
const temp = mkdtempSync(path.join(tmpdir(), "blinko-query-host-"));
process.chdir(temp);
mkdirSync(".blinko/vector", { recursive: true });
const client = createClient({ url: "file:.blinko/vector/embeddings.db" });
const repository = new VectorRepository(client);
const lifecycle = new IndexLifecycle(client, hostNoteSource);
const space = {
  dimensions: 3,
  modelFingerprint: "public-query-model",
  embeddingSpaceId: "public-query-space",
  preprocessingVersion: BODY_PREPROCESSING_VERSION,
};
let accountId = 0,
  foreignId = 0;
let ids: number[] = [];
let generation: Awaited<ReturnType<typeof lifecycle.createGeneration>>;
let tagIds: number[] = [];
let currentUser = "0";
const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "http://plugin-services.test/api/trpc",
      transformer: superjson,
      fetch: (input, init) =>
        fetchRequestHandler({
          endpoint: "/api/trpc",
          req: new Request(String(input), init),
          router: appRouter,
          createContext: () => ({
            id: currentUser,
            sub: currentUser,
            name: "synthetic-query-user",
            role: "superadmin",
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
beforeAll(async () => {
  await prisma.pluginServicePolicy.deleteMany();
  accountId = (await prisma.accounts.create({ data: { name: "synthetic-query-owner" } })).id;
  foreignId = (await prisma.accounts.create({ data: { name: "synthetic-query-foreign" } })).id;
  currentUser = String(accountId);
  for (let i = 0; i < 5; i++)
    ids.push(
      (
        await prisma.notes.create({
          data: {
            accountId: i === 4 ? foreignId : accountId,
            content: `Synthetic test note ${i}`,
            type: i === 3 ? 2 : 0,
            isArchived: i === 2,
            createdAt: new Date("2026-01-01T00:00:00Z"),
            updatedAt: new Date("2026-01-02T00:00:00Z"),
          },
        })
      ).id,
    );
  for (let i = 0; i < 2; i++)
    tagIds.push((await prisma.tag.create({ data: { accountId, name: `synthetic-tag-${i}` } })).id);
  await prisma.tagsToNote.createMany({
    data: [
      { noteId: ids[1], tagId: tagIds[0] },
      { noteId: ids[1], tagId: tagIds[1] },
    ],
  });
  await lifecycle.initialize();
  generation = await lifecycle.createGeneration(space);
  for (let i = 0; i < ids.length; i++) {
    const n = (await hostNoteSource.readNote(ids[i]))!;
    await lifecycle.indexBody(n, generation, async (values) =>
      values.map(() => (i === 0 ? [2, 0, 0] : [1, i === 1 ? 1 : 0, 0])),
    );
  }
  await lifecycle.activateGeneration(generation.generation);
});
afterAll(async () => {
  client.close();
  await prisma.tagsToNote.deleteMany({ where: { noteId: { in: ids } } });
  await prisma.tag.deleteMany({ where: { id: { in: tagIds } } });
  await prisma.notes.deleteMany({ where: { id: { in: ids } } });
  await prisma.pluginServiceRequests.deleteMany({
    where: { accountId: { in: [accountId, foreignId] } },
  });
  await prisma.pluginServiceDailyUsage.deleteMany({
    where: { accountId: { in: [accountId, foreignId] } },
  });
  await prisma.pluginServiceRate.deleteMany({
    where: { accountId: { in: [accountId, foreignId] } },
  });
  await prisma.accounts.deleteMany({ where: { id: { in: [accountId, foreignId] } } });
  await prisma.$disconnect();
  process.chdir(cwd);
});

test("actual SDK/appRouter/PostgreSQL/LibSQL note query has zero model resolution and zero HTTP", async () => {
  const resolve = spyOn(hostModelResolver, "resolveEmbedding").mockImplementation(async () => {
    throw new Error("No models configured");
  });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(blockedFetch);
  try {
    const r = await sdk.vector.query({ source: { kind: "note", noteId: ids[0] } });
    expect(r.items.map((i) => i.note.id)).toEqual([ids[1]]);
    expect(r.items[0].score).toBeCloseTo(Math.SQRT1_2, 12);
    expect(r.retrieval.remaining).toBe("no");
    expect(resolve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    resolve.mockRestore();
    fetch.mockRestore();
  }
});
test("real SQL scopes enforce all tags, archives, types and exclusive createdBefore", async () => {
  const source = { kind: "note" as const, noteId: ids[0] };
  expect(
    (await sdk.vector.query({ source, scope: { tagIds, tagMatch: "all" } })).items.map(
      (i) => i.note.id,
    ),
  ).toEqual([ids[1]]);
  expect(
    (await sdk.vector.query({ source, scope: { includeArchived: true, types: [2] } })).items.map(
      (i) => i.note.id,
    ),
  ).toEqual([ids[3]]);
  expect(
    (await sdk.vector.query({ source, scope: { createdBefore: "2026-01-01T00:00:00Z" } })).items,
  ).toHaveLength(0);
});
test("5000 exclusions preserve cursor pages, rechecks and the public SDK source exclusion", async () => {
  const notes = createQueryNoteSource(prisma);
  const padding = Array.from({ length: 4999 }, (_, i) => 2100000000 + i);
  // Exercise both leading and interleaved absent IDs. The database contains only
  // this synthetic fixture; padding IDs are valid PostgreSQL ints with no note.
  for (const excludeNoteIds of [[ids[1], ...padding], [...padding.slice(0, 2500), ids[1], ...padding.slice(2500)]]) {
    const selection = { scope: { includeArchived: true }, excludeNoteIds };
    const first = await notes.page(accountId, selection, 0, 1);
    expect(first.notes.map((n) => n.id)).toEqual([ids[0]]);
    expect(first.truncated).toBe(false);
    const second = await notes.page(accountId, selection, ids[0], 1);
    expect(second.notes.map((n) => n.id)).toEqual([ids[2]]);
    expect((await notes.page(accountId, selection, ids[2], 1)).notes).toEqual([]);
    expect((await notes.recheck(accountId, selection, ids)).map((n) => n.id).sort((a, b) => a - b)).toEqual([ids[0], ids[2]]);
  }
  const result = await sdk.vector.query({
    source: { kind: "note", noteId: ids[0] },
    excludeNoteIds: [ids[1], ...padding],
  });
  expect(result.items).toEqual([]);
  expect(result.retrieval.truncated).toBe(false);
  expect(result.retrieval.remaining).toBe("no");
});
test("large exclusions still enforce tags, time, archive, type, recycling and account visibility", async () => {
  const notes = createQueryNoteSource(prisma);
  const excludeNoteIds = Array.from({ length: 5000 }, (_, i) => 2100000000 + i);
  const scope = {
    types: [0] as Array<0 | 1 | 2>, tagIds, tagMatch: "all" as const,
    createdFrom: "2026-01-01T00:00:00Z", createdBefore: "2026-01-02T00:00:00Z",
  };
  const check = async (selection: Parameters<typeof notes.page>[1], expected: number[]) => {
    const page = await notes.page(accountId, selection, 0, 128);
    expect(page.truncated).toBe(false);
    expect(page.notes.map((n) => n.id)).toEqual(expected);
    expect((await notes.recheck(accountId, selection, ids)).map((n) => n.id).sort((a, b) => a - b)).toEqual(expected);
  };
  await check({ scope, excludeNoteIds }, [ids[1]]);
  await check({ scope, excludeNoteIds: [ids[1], ...excludeNoteIds.slice(1)] }, []);
  await check({ scope: { ...scope, createdBefore: scope.createdFrom }, excludeNoteIds }, []);
  await check({ scope: { types: [0] }, excludeNoteIds }, [ids[0], ids[1]]);
  await check({ scope: { types: [0], includeArchived: true }, excludeNoteIds }, [ids[0], ids[1], ids[2]]);
  await check({ scope: { types: [2], includeArchived: true }, excludeNoteIds }, [ids[3]]);
  try {
    await prisma.notes.update({ where: { id: ids[1] }, data: { isRecycle: true } });
    await check({ scope, excludeNoteIds }, []);
    expect(await notes.readOwned(accountId, ids[1])).toBe(null);
  } finally {
    await prisma.notes.update({ where: { id: ids[1] }, data: { isRecycle: false, updatedAt: new Date("2026-01-02T00:00:00Z") } });
  }
});
test("foreign source and nonexistent source expose the same error through the actual SDK", async () => {
  const codes: unknown[] = [];
  for (const noteId of [ids[4], 2147483647]) {
    const failure = await sdk.vector.query({ source: { kind: "note", noteId } }).catch((e) => e);
    codes.push(failure.code ?? decodeServiceError(failure.message)?.code);
  }
  expect(codes).toEqual(["NOT_FOUND_OR_FORBIDDEN", "NOT_FOUND_OR_FORBIDDEN"]);
});
test("shared PostgreSQL rate gate admits exactly the limit under concurrent callers and rejects zero limit first insert", async () => {
  const isolatedAccount = foreignId + 100000;
  const gates = [createAccountRateGate({ prisma }), createAccountRateGate({ prisma })];
  const results = await Promise.all(
    Array.from({ length: 25 }, (_, i) => gates[i % 2].acquire(isolatedAccount, 7)),
  );
  expect(results.filter((r) => r.allowed)).toHaveLength(7);
  expect((await gates[0].check(isolatedAccount, 7)).allowed).toBe(false);
  expect((await gates[0].acquire(isolatedAccount + 1, 0)).allowed).toBe(false);
  await prisma.pluginServiceRate.deleteMany({
    where: { accountId: { in: [isolatedAccount, isolatedAccount + 1] } },
  });
});
test("concurrent real SQL ownership change removes a scored candidate before projection", async () => {
  const notes = createQueryNoteSource(prisma);
  let changed = false;
  const service = createVectorQueryService({
    notes: {
      ...notes,
      recheck: async (...args) => {
        if (!changed) {
          changed = true;
          await prisma.notes.update({ where: { id: ids[1] }, data: { accountId: foreignId } });
        }
        return notes.recheck(...args);
      },
    },
    policyStore: createPolicyStore({ read: async () => null }),
    rateGate: createAccountRateGate({ prisma }),
    callPolicy: createCallPolicy({ prisma }),
    withReader: async (run) => run(repository),
    resolveEmbedding: async () => {
      throw new Error("No model");
    },
  });
  try {
    const r = await service.query(accountId, { source: { kind: "note", noteId: ids[0] } });
    expect(r.items).toHaveLength(0);
    expect(r.retrieval.remaining).toBe("unknown");
  } finally {
    await prisma.notes.update({
      where: { id: ids[1] },
      data: { accountId, updatedAt: new Date("2026-01-02T00:00:00Z") },
    });
  }
});
test("random walk example runs through the formal SDK and actual host services", async () => {
  const example = new RandomWalkPlugin(sdk);
  const first = await example.next(ids[0], 1);
  expect(first.map((i) => i.note.id)).toEqual([ids[1]]);
  expect(await example.next(ids[0], 1)).toEqual([]);
});
test("text SDK query and similar-content example use a local provider once per key with persistent ledger", async () => {
  let calls = 0;
  const resolver = spyOn(hostModelResolver, "resolveEmbedding").mockResolvedValue({
    modelId: 100000,
    space,
    embedBody: async () => {
      throw new Error("No rebuild");
    },
    embedQueryText: async (_text, _signal, before) => {
      await before?.();
      calls++;
      return { vector: [1, 0, 0], tokens: 5 };
    },
  });
  try {
    const input = {
      source: { kind: "text" as const, text: "synthetic similarity input" },
      idempotencyKey: "synthetic-query-once",
    };
    expect((await sdk.vector.query(input)).items.length).toBeGreaterThan(0);
    await expect(sdk.vector.query(input)).rejects.toThrow();
    expect(calls).toBe(1);
    const ledger = await prisma.pluginServiceRequests.findFirstOrThrow({
      where: { accountId, idempotencyKey: input.idempotencyKey },
    });
    expect(ledger.state).toBe("succeeded");
    expect(ledger.operation).toBe("vector.queryByText");
    const example = new SimilarContentPlugin(sdk);
    const related = await example.check("synthetic example", 0.7);
    expect(related.length).toBeGreaterThan(0);
    expect(calls).toBe(2);
  } finally {
    resolver.mockRestore();
  }
});

test("summary example uses real directory/context SQL, SDK/router, persistent ledger and a network-blocked local generator", async () => {
  const provider = await prisma.aiProviders.create({
    data: {
      title: "Synthetic local generator",
      provider: "openai",
      baseURL: "https://synthetic.invalid",
      apiKey: "synthetic-fixture-only",
    },
  });
  const model = await prisma.aiModels.create({
    data: {
      providerId: provider.id,
      title: "Synthetic summary model",
      modelKey: "synthetic-summary",
      capabilities: { inference: true },
    },
  });
  const config = await prisma.config.create({
    data: { key: "mainModelId", config: { type: "number", value: model.id } },
  });
  const requests: Array<Parameters<TextGenerator["generate"]>[0]> = [];
  const factory = spyOn(hostTextGeneratorFactory, "create").mockImplementation(async () => ({
    generate: async (request) => {
      requests.push(request);
      return {
        text: "Synthetic summary",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 2, status: "reported" },
      };
    },
  }));
  const fetch = spyOn(globalThis, "fetch").mockImplementation(blockedFetch);
  try {
    const models = await sdk.ai.listModels();
    expect(models.map((m) => m.id)).toEqual([model.id]);
    for (const forbidden of ["apiKey", "baseURL", "synthetic-fixture-only", "config"])
      expect(JSON.stringify(models)).not.toContain(forbidden);
    const noteBefore = await prisma.notes.findUniqueOrThrow({ where: { id: ids[0] } });
    const example = new NoteSummaryPlugin(sdk);
    expect(await example.summarize(ids[0])).toBe("Synthetic summary");
    expect(requests).toHaveLength(1);
    expect(requests[0].messages.at(-1)?.content).toContain(noteBefore.content);
    expect(Object.keys(requests[0]).sort()).toEqual([
      "maxOutputTokens",
      "messages",
      "modelId",
      "signal",
      "system",
      "temperature",
    ]);
    const input = {
      modelId: model.id,
      messages: [{ role: "user" as const, content: "summarize selected material" }],
      contextNoteIds: [ids[0]],
      idempotencyKey: "synthetic-generation-once",
      maxOutputTokens: 32,
    };
    expect((await sdk.ai.generateText(input)).text).toBe("Synthetic summary");
    await expect(sdk.ai.generateText(input)).rejects.toThrow();
    expect(requests).toHaveLength(2);
    await expect(
      sdk.ai.generateText({
        ...input,
        contextNoteIds: [ids[4]],
        idempotencyKey: "foreign-context",
      }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(2);
    await trpc.pluginServices.admin.setPolicy.mutate({
      features: { "ai.listModels": { enabled: false }, "ai.generateText": { enabled: false } },
    });
    expect((await sdk.capabilities()).features["ai.generateText"]).toEqual({
      available: false,
      reason: "disabled",
    });
    await expect(sdk.ai.listModels()).rejects.toThrow();
    await expect(
      sdk.ai.generateText({ ...input, idempotencyKey: "disabled-generation" }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(2);
    expect(await prisma.notes.findUniqueOrThrow({ where: { id: ids[0] } })).toEqual(noteBefore);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    factory.mockRestore();
    await prisma.pluginServicePolicy.deleteMany();
    await prisma.config.delete({ where: { id: config.id } });
    await prisma.aiModels.delete({ where: { id: model.id } });
    await prisma.aiProviders.delete({ where: { id: provider.id } });
  }
});
