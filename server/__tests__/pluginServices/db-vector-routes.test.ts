import { test, expect, afterAll } from "bun:test";
import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma";
import { router } from "../../middleware";
import { pluginServicesRouter } from "../../routerTrpc/pluginServices";
import {
  hostNoteSource,
  markHostNoteIndexed,
} from "../../services/pluginServices/HostIndex";

if (process.env.PLUGIN_SERVICES_TEST_DB !== "1" || !process.env.DATABASE_URL)
  throw new Error("An isolated real PostgreSQL database is required.");
const url = new URL(process.env.DATABASE_URL);
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  url.username !== "blinko_test"
)
  throw new Error("Wrong test database.");
const app = router({ pluginServices: pluginServicesRouter });
const admin = app.createCaller({
  id: "1",
  sub: "1",
  name: "synthetic-admin",
  role: "superadmin",
} as never);
afterAll(async () => {
  await prisma.pluginServicePolicy.deleteMany();
  await prisma.$disconnect();
});

test("status capability describes permission to inspect readiness and policy stores effective limits", async () => {
  const policy = await admin.pluginServices.admin.setPolicy({
    limits: { maxResults: 9999 },
  });
  expect(policy.limits.maxResults).toBe(50);
  const stored = await prisma.pluginServicePolicy.findUniqueOrThrow({
    where: { id: 1 },
  });
  expect((stored.limits as { maxResults: number }).maxResults).toBe(50);
  expect(
    (await admin.pluginServices.capabilities()).features["vector.status"],
  ).toEqual({ available: true });
  expect((await admin.pluginServices.vector.status()).available).toBe(false);
});
test("administrator can persist policy through the real router, including daily budget", async () => {
  const value = await admin.pluginServices.admin.setPolicy({
    dailyTokenBudget: 12345,
    limits: { maxResults: 3, maxOutputTokens: 128 },
    features: { "vector.status": { enabled: false } },
    modelAllowlist: [],
  });
  expect(value.dailyTokenBudget).toBe(12345);
  expect(value.limits.maxResults).toBe(3);
  expect(value.modelAllowlist).toEqual([]);
  const stored = await prisma.pluginServicePolicy.findUniqueOrThrow({
    where: { id: 1 },
  });
  expect(stored.dailyTokenBudget).toBe(12345);
  const status = await admin.pluginServices.vector.status();
  expect(status).toMatchObject({
    available: false,
    reason: "disabled",
    provenance: "none",
  });
  const capabilities = await admin.pluginServices.capabilities();
  expect(capabilities.limits.maxOutputTokens).toBe(128);
  expect(capabilities.features["vector.approximate"]).toEqual({
    available: false,
    reason: "unsupported",
  });
});
test("non-admin and substring token cannot maintain policy", async () => {
  await expect(
    app
      .createCaller({
        id: "2",
        sub: "2",
        name: "synthetic-user",
        role: "user",
      } as never)
      .pluginServices.admin.getPolicy(),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    app
      .createCaller({
        id: "1",
        sub: "1",
        name: "synthetic-admin",
        role: "superadmin",
        permissions: ["plugin"],
      } as never)
      .pluginServices.admin.getPolicy(),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
test("index UI flag preserves SQL timestamp and concurrent metadata, and rejects stale snapshots", async () => {
  const account = await prisma.accounts.create({
    data: { name: "synthetic-index-cas" },
  });
  const note = await prisma.notes.create({
    data: {
      accountId: account.id,
      content: "Synthetic current body",
      metadata: { keep: "original" },
    },
  });
  try {
    const snapshot = (await hostNoteSource.readNote(note.id))!;
    await markHostNoteIndexed(snapshot);
    const after = await prisma.notes.findUniqueOrThrow({
      where: { id: note.id },
    });
    expect(after.updatedAt.toISOString()).toBe(note.updatedAt.toISOString());
    expect(after.metadata).toEqual({ keep: "original", isIndexed: true });
    await prisma.notes.update({
      where: { id: note.id },
      data: {
        content: "Changed body",
        metadata: { keep: "newer", isIndexed: false },
      },
    });
    await markHostNoteIndexed(snapshot);
    expect(
      (await prisma.notes.findUniqueOrThrow({ where: { id: note.id } }))
        .metadata,
    ).toEqual({ keep: "newer", isIndexed: false });
  } finally {
    await prisma.notes.delete({ where: { id: note.id } });
    await prisma.accounts.delete({ where: { id: account.id } });
  }
});
test("malformed stored policy closes service rather than reverting to defaults", async () => {
  await prisma.pluginServicePolicy.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      limits: { bad: "data" },
      features: {},
      modelAllowlist: Prisma.DbNull,
    },
    update: { limits: { bad: "data" } },
  });
  const capabilities = await admin.pluginServices.capabilities();
  expect(capabilities.features["vector.status"]).toEqual({
    available: false,
    reason: "not-configured",
  });
});

test('admin explicitly enables or disables read splitting; omission preserves it and counters', async () => {
  await prisma.pluginServicePolicy.deleteMany();
  expect((await admin.pluginServices.admin.getPolicy()).readNoteRequestsPerMinute).toBeNull();
  const created = await admin.pluginServices.admin.setPolicy({ maxRequestsPerMinute: 240 });
  expect(created.readNoteRequestsPerMinute).toBeNull();
  const account = await prisma.accounts.create({ data: { name: 'synthetic-policy-rate-toggle' } });
  try {
    await prisma.pluginServiceRate.create({ data: { accountId: account.id, windowStart: new Date(), used: 9, sharedUsed: 5, readNoteUsed: 4 } });
    expect((await admin.pluginServices.admin.setPolicy({ maxRequestsPerMinute: 240, readNoteRequestsPerMinute: 20 })).readNoteRequestsPerMinute).toBe(20);
    // Older clients cannot accidentally enable, disable or reset the new field.
    expect((await admin.pluginServices.admin.setPolicy({ maxRequestsPerMinute: 240, limits: { maxResults: 7 } })).readNoteRequestsPerMinute).toBe(20);
    expect((await admin.pluginServices.admin.setPolicy({ maxRequestsPerMinute: 240, readNoteRequestsPerMinute: null })).readNoteRequestsPerMinute).toBeNull();
    expect((await admin.pluginServices.admin.getPolicy()).maxRequestsPerMinute).toBe(240);
    expect(await prisma.pluginServiceRate.findFirstOrThrow({ where: { accountId: account.id } })).toMatchObject({ used: 9, sharedUsed: 5, readNoteUsed: 4 });
    for (const invalid of [0, 21, 1.5]) await expect(admin.pluginServices.admin.setPolicy({ readNoteRequestsPerMinute: invalid })).rejects.toBeDefined();
  } finally {
    await prisma.pluginServiceRate.deleteMany({ where: { accountId: account.id } });
    await prisma.accounts.delete({ where: { id: account.id } });
  }
});
