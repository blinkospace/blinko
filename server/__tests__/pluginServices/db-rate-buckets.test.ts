import { afterAll, expect, test } from 'bun:test';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { createAccountRateGate, createCallPolicy, type PaidCallSpec, type RateGateOptions } from '../../services/pluginServices/CallPolicy';
import { toPublicError } from '../../services/pluginServices/errors';

if (process.env.PLUGIN_SERVICES_TEST_DB !== '1' || !process.env.DATABASE_URL) throw Error('Isolated PG required');
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.username !== 'blinko_test') throw Error('Owned synthetic PG required');
const prisma = new PrismaClient();
const oneUrl = new URL(url); oneUrl.searchParams.set('connection_limit', '1'); oneUrl.searchParams.set('pool_timeout', '2');
const one = new PrismaClient({ datasources: { db: { url: oneUrl.toString() } } });
const accounts: number[] = [];
const readLane: RateGateOptions = { lane: 'readNote', readNoteRequestsPerMinute: 20 };
const sharedLane: RateGateOptions = { lane: 'shared', readNoteRequestsPerMinute: 20 };
async function account() {
  const id = (await prisma.accounts.create({ data: { name: 'synthetic-rate-' + crypto.randomUUID() } })).id;
  accounts.push(id); return id;
}
async function alignedWindow() {
  const [row] = await prisma.$queryRaw<Array<{ remaining: number }>>`SELECT EXTRACT(EPOCH FROM date_trunc('minute',clock_timestamp())+interval '1 minute'-clock_timestamp())::float8 AS remaining`;
  if (row.remaining < 8) await new Promise(resolve => setTimeout(resolve, Math.ceil(row.remaining * 1000) + 100));
}
async function counts(id: number) {
  const rows = await prisma.pluginServiceRate.findMany({ where: { accountId: id } });
  expect(rows).toHaveLength(1);
  return rows[0];
}
function spec(accountId: number, extra: Partial<PaidCallSpec> = {}): PaidCallSpec {
  return { accountId, operation: 'ai.generateText', idempotencyKey: crypto.randomUUID(), requestFingerprint: 'synthetic-rate-paid', modelId: 1, reservedTokens: 8, maxOutputTokens: 4, timeoutMs: 2000, dailyTokenLimit: 100, maxConcurrent: 2, maxRequestsPerMinute: 2, readNoteRequestsPerMinute: 2, ...extra };
}
afterAll(async () => {
  for (const accountId of accounts) {
    await prisma.pluginServiceRequests.deleteMany({ where: { accountId } });
    await prisma.pluginServiceDailyUsage.deleteMany({ where: { accountId } });
    await prisma.pluginServiceRate.deleteMany({ where: { accountId } });
    await prisma.accounts.delete({ where: { id: accountId } });
  }
  await one.$disconnect(); await prisma.$disconnect();
});

for (const p of [1, 20, 240]) test(`combined p=${p} retains one atomic account limit for both operations`, async () => {
  await alignedWindow(); const id = await account(); const gate = createAccountRateGate({ prisma });
  const outcomes = await Promise.all(Array.from({ length: p + 4 }, (_, i) => gate.acquire(id, p, { lane: i % 2 ? 'readNote' : 'shared' })));
  expect(outcomes.filter(r => r.allowed)).toHaveLength(p);
  const row = await counts(id); expect(row.used).toBe(p); expect(row.readNoteUsed + row.sharedUsed).toBe(p);
  expect((await gate.check(id, p)).allowed).toBe(false);
});

test('concurrent mixed readers and shared callers on separate connections share one p+r row', async () => {
  await alignedWindow(); const id = await account(), foreign = await account();
  const gates = [createAccountRateGate({ prisma }), createAccountRateGate({ prisma: one })];
  const requests = Array.from({ length: 36 }, (_, i) => gates[i % 2].acquire(id, 5, { lane: i % 3 ? 'readNote' : 'shared', readNoteRequestsPerMinute: 7 }));
  const outcomes = await Promise.all(requests);
  expect(outcomes.filter(r => r.allowed)).toHaveLength(12);
  expect(await counts(id)).toMatchObject({ used: 12, sharedUsed: 5, readNoteUsed: 7 });
  expect((await gates[1].acquire(foreign, 5, { ...sharedLane, readNoteRequestsPerMinute: 7 })).allowed).toBe(true);
  expect(await counts(foreign)).toMatchObject({ used: 1, sharedUsed: 1, readNoteUsed: 0 });
  console.log(JSON.stringify({ mixedBucketAdmission: { total: 12, shared: 5, read: 7, foreign: 1 }, connectionLimitOne: true }));
});

test('mode toggles, a smaller read allowance and a restarted client retain same-window usage', async () => {
  await alignedWindow(); const id = await account(); const gate = createAccountRateGate({ prisma });
  for (let i = 0; i < 3; i++) expect((await gate.acquire(id, 20)).allowed).toBe(true);
  for (let i = 0; i < 2; i++) expect((await gate.acquire(id, 20, { lane: 'readNote' })).allowed).toBe(true);
  expect(await gate.check(id, 20, readLane)).toMatchObject({ used: 2, allowed: true });
  expect((await gate.acquire(id, 20, readLane)).allowed).toBe(true);
  expect(await gate.check(id, 5)).toMatchObject({ used: 6, allowed: false });
  expect((await gate.acquire(id, 5)).allowed).toBe(false);
  const restarted = new PrismaClient();
  try {
    const other = createAccountRateGate({ prisma: restarted });
    for (let i = 0; i < 3; i++) {
      expect(await other.check(id, 20, { lane: 'readNote', readNoteRequestsPerMinute: 2 })).toMatchObject({ allowed: false, used: 3 });
      expect(await other.check(id, 5, { lane: 'readNote', readNoteRequestsPerMinute: null })).toMatchObject({ allowed: false, used: 6 });
    }
    expect(await other.check(id, 20, readLane)).toMatchObject({ used: 3, allowed: true });
  } finally { await restarted.$disconnect(); }
  expect(await counts(id)).toMatchObject({ used: 6, sharedUsed: 3, readNoteUsed: 3 });
});

test('switching off after split admission rejects above restored p, without wiping counts', async () => {
  await alignedWindow(); const id = await account(), gate = createAccountRateGate({ prisma });
  for (let i = 0; i < 3; i++) expect((await gate.acquire(id, 3, sharedLane)).allowed).toBe(true);
  for (let i = 0; i < 4; i++) expect((await gate.acquire(id, 3, readLane)).allowed).toBe(true);
  expect(await gate.check(id, 3)).toMatchObject({ allowed: false, used: 7 });
  expect((await gate.acquire(id, 3)).allowed).toBe(false);
  expect((await gate.acquire(id, 3, { lane: 'readNote' })).allowed).toBe(false);
  expect((await gate.acquire(id, 3, sharedLane)).allowed).toBe(false);
  expect(await counts(id)).toMatchObject({ used: 7, sharedUsed: 3, readNoteUsed: 4 });
});

test('lowering r applies the new aggregate p+r as well as the lane bound', async () => {
  await alignedWindow(); const id = await account(), gate = createAccountRateGate({ prisma });
  for (let i = 0; i < 5; i++) await gate.acquire(id, 5, readLane);
  // r=1 makes total limit 6: one shared call fits, the next must be refused
  // even though this shared lane itself is below p=5.
  expect((await gate.acquire(id, 5, { readNoteRequestsPerMinute: 1 })).allowed).toBe(true);
  expect((await gate.acquire(id, 5, { readNoteRequestsPerMinute: 1 })).allowed).toBe(false);
  expect(await counts(id)).toMatchObject({ used: 6, sharedUsed: 1, readNoteUsed: 5 });
});

test('the actual migration preserves legacy usage and does not guess a classification', async () => {
  const sql = readFileSync(new URL('../../../prisma/migrations/20261109130000_plugin_service_read_rate/migration.sql', import.meta.url), 'utf8');
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('CREATE TEMP TABLE plugin_service_rate ("accountId" int,"windowStart" timestamptz,"used" int NOT NULL DEFAULT 0,PRIMARY KEY("accountId","windowStart")) ON COMMIT DROP');
    await tx.$executeRawUnsafe('CREATE TEMP TABLE plugin_service_policy ("maxRequestsPerMinute" int NOT NULL DEFAULT 20) ON COMMIT DROP');
    await tx.$executeRaw`INSERT INTO plugin_service_rate VALUES (123, date_trunc('minute',statement_timestamp()),20)`;
    await tx.$executeRaw`INSERT INTO plugin_service_policy DEFAULT VALUES`;
    for (const statement of sql.split(';').filter(value => value.trim())) await tx.$executeRawUnsafe(statement);
    const [legacy] = await tx.$queryRaw<Array<{ used: number; readNoteUsed: number; sharedUsed: number }>>`SELECT * FROM plugin_service_rate`;
    expect(legacy).toMatchObject({ used: 20, readNoteUsed: 0, sharedUsed: 0 });
    expect((await tx.$queryRaw<Array<{ readNoteRequestsPerMinute: number | null }>>`SELECT * FROM plugin_service_policy`)[0].readNoteRequestsPerMinute).toBeNull();
    const gate = createAccountRateGate({ prisma: tx });
    expect(await gate.acquire(123, 20, readLane)).toMatchObject({ allowed: false, used: 20 });
    expect(await gate.acquire(123, 20, sharedLane)).toMatchObject({ allowed: false, used: 20 });
    expect((await tx.$queryRaw<Array<{ used: number }>>`SELECT used FROM plugin_service_rate`)[0].used).toBe(20);
  });
});

test('a refusal returns the real remaining database window, not an unconditional minute', async () => {
  await alignedWindow(); const id = await account(), gate = createAccountRateGate({ prisma });
  await gate.acquire(id, 1);
  const [before] = await prisma.$queryRaw<Array<{ wait: number }>>`SELECT ceil(EXTRACT(EPOCH FROM(date_trunc('minute',clock_timestamp())+interval '1 minute'-clock_timestamp()))*1000)::int AS wait`;
  const refused = await gate.acquire(id, 1);
  const [after] = await prisma.$queryRaw<Array<{ wait: number }>>`SELECT ceil(EXTRACT(EPOCH FROM(date_trunc('minute',clock_timestamp())+interval '1 minute'-clock_timestamp()))*1000)::int AS wait`;
  expect(refused.allowed).toBe(false); expect(refused.retryAfterMs).toBeGreaterThan(0);
  expect(refused.retryAfterMs!).toBeLessThanOrEqual(before.wait + 20);
  expect(refused.retryAfterMs!).toBeGreaterThanOrEqual(after.wait - 20);
  expect(await counts(id)).toMatchObject({ used: 1 });
  console.log(JSON.stringify({ realWindowWait: { before: before.wait, hint: refused.retryAfterMs, after: after.wait } }));
});

test('paid and free heavy calls share p; reads do not give paid work a second quota', async () => {
  await alignedWindow(); const id = await account(), gate = createAccountRateGate({ prisma: one });
  const read = { lane: 'readNote' as const, readNoteRequestsPerMinute: 2 };
  await gate.acquire(id, 2, read); await gate.acquire(id, 2, read);
  await gate.acquire(id, 2, { readNoteRequestsPerMinute: 2 });
  const policy = createCallPolicy({ prisma: one }), request = spec(id); let invoked = 0;
  const invoke = async (ctx: { markDispatched(): Promise<void> }) => { invoked++; await ctx.markDispatched(); return { result: 'synthetic', usage: { status: 'reported' as const, inputTokens: 2, outputTokens: 1 } }; };
  expect(await policy.runPaidOperation(request, invoke)).toBe('synthetic');
  const denied = await policy.runPaidOperation({ ...request, idempotencyKey: crypto.randomUUID() }, invoke).catch(error => error);
  expect(denied.code).toBe('RATE_LIMITED'); expect(denied.retryAfterMs).toBeGreaterThan(0);
  expect((await policy.runPaidOperation(request, invoke).catch(error => error)).code).toBe('RESULT_NOT_RETAINED');
  expect(invoked).toBe(1); expect(await counts(id)).toMatchObject({ used: 4, readNoteUsed: 2, sharedUsed: 2 });
  expect(await prisma.pluginServiceRequests.count({ where: { accountId: id } })).toBe(1);
  expect(await prisma.pluginServiceDailyUsage.findFirstOrThrow({ where: { accountId: id } })).toMatchObject({ reservedTokens: 0, settledTokens: 3 });
});

test('budget refusal rolls back registration and rate together in split mode', async () => {
  await alignedWindow(); const id = await account(), policy = createCallPolicy({ prisma: one }); let invoked = 0;
  const denied = await policy.runPaidOperation(spec(id, { dailyTokenLimit: 1 }), async () => { invoked++; throw Error('Must not invoke'); }).catch(error => error);
  expect(toPublicError(denied).code).toBe('BUDGET_EXCEEDED'); expect(invoked).toBe(0);
  expect(await prisma.pluginServiceRate.count({ where: { accountId: id } })).toBe(0);
  expect(await prisma.pluginServiceRequests.count({ where: { accountId: id } })).toBe(0);
  expect(await prisma.pluginServiceDailyUsage.count({ where: { accountId: id } })).toBe(0);
});

test('concurrency refusal does not invent a fixed-window wait or consume another rate slot', async () => {
  await alignedWindow(); const id = await account(), policy = createCallPolicy({ prisma: one });
  let enter!: () => void, leave!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { leave = resolve; });
  const request = spec(id, { maxConcurrent: 1, timeoutMs: 4000 });
  const first = policy.runPaidOperation(request, async context => { await context.markDispatched(); enter(); await held; return { result: 'done', usage: { status: 'reported' as const, inputTokens: 1, outputTokens: 1 } }; });
  try {
    await entered;
    const denied = await policy.runPaidOperation({ ...request, idempotencyKey: crypto.randomUUID() }, async () => { throw Error('Must not dispatch'); }).catch(error => error);
    expect(toPublicError(denied)).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(toPublicError(denied).retryAfterMs).toBeUndefined();
    expect(await counts(id)).toMatchObject({ used: 1, sharedUsed: 1, readNoteUsed: 0 });
  } finally { leave(); await first; }
});
