/**
 * 反例：派发标记的 UPDATE 已经提交，但回执晚于期限。
 *
 * 旧行为下调用方先收到 TIMEOUT，而 invoke 继续走到生成器，形成"用户已看到失败、
 * 供应商却真的被调用一次"的付费调用。修复后必须满足两点：
 *   1. 生成器一次都不被调用；
 *   2. 那条已写标记的行按"未发出"结算（failed + 释放预留），不长期占预算与并发槽。
 */
import { afterAll, expect, test } from "bun:test";
import { prisma } from "../../prisma";
import { createCallPolicy, type PaidCallSpec } from "../../services/pluginServices/CallPolicy";

if (process.env.PLUGIN_SERVICES_TEST_DB !== "1" || !process.env.DATABASE_URL)
  throw new Error("An isolated real PostgreSQL database is required.");
const db = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(db.hostname) || db.username !== "blinko_test")
  throw new Error("Wrong test database");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 只让"写派发标记"这一条 $executeRaw 变慢，模拟回执延迟；其余照常。 */
function prismaWithSlowDispatchMarker(delayMs: number) {
  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === "$executeRaw") {
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const result = await (target.$executeRaw as (
            s: TemplateStringsArray,
            ...v: unknown[]
          ) => Promise<number>)(strings, ...values);
          if (String(strings).includes(`SET "state" = 'dispatched'`)) await sleep(delayMs);
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 只让"写派发标记"这一条 $executeRaw 永不返回；它不会真的落库。 */
function prismaWithHangingDispatchMarker() {
  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === "$executeRaw") {
        return (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (String(strings).includes(`SET "state" = 'dispatched'`))
            return new Promise<number>(() => undefined);
          return (target.$executeRaw as (
            s: TemplateStringsArray,
            ...v: unknown[]
          ) => Promise<number>)(strings, ...values);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function waitForSettled(accountId: number, idempotencyKey: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await prisma.pluginServiceRequests.findFirst({
      where: { accountId, idempotencyKey },
    });
    if (row?.settledAt) return row;
    if (Date.now() > deadline) throw new Error("dispatch row was never settled");
    await sleep(20);
  }
}

let accountId = 0;

afterAll(async () => {
  await prisma.pluginServiceRequests.deleteMany({ where: { accountId } });
  await prisma.pluginServiceDailyUsage.deleteMany({ where: { accountId } });
  await prisma.pluginServiceRate.deleteMany({ where: { accountId } });
  await prisma.accounts.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

test("派发标记回执晚于期限：不进入生成器，且按未发出结算并释放预留", async () => {
  accountId = (await prisma.accounts.create({ data: { name: "cjs-unsent-dispatch" } })).id;
  const policy = createCallPolicy({ prisma: prismaWithSlowDispatchMarker(120) });
  const idempotencyKey = `unsent-${process.pid}-${Date.now()}`;
  const spec: PaidCallSpec = {
    accountId,
    operation: "ai.generateText",
    idempotencyKey,
    requestFingerprint: "fingerprint-unsent",
    modelId: 1,
    reservedTokens: 1000,
    maxOutputTokens: 64,
    // 期限比标记回执短：超时必然发生在 UPDATE 提交之后、生成器之前。
    timeoutMs: 40,
    dailyTokenLimit: 100_000,
    maxConcurrent: 2,
    maxRequestsPerMinute: 60,
  };

  let generatorCalls = 0;
  const error = await policy
    .runPaidOperation(spec, async (context) => {
      await context.markDispatched();
      generatorCalls += 1;
      return {
        result: "should-never-run",
        usage: { inputTokens: 1, outputTokens: 1, status: "reported" as const },
      };
    })
    .catch((caught: unknown) => caught);

  expect((error as { code?: string }).code).toBe("TIMEOUT");
  expect(generatorCalls).toBe(0);

  // 迟到的写库会自行完成"未发送"收尾，所以要等它落定，而不是立刻读。
  const row = await waitForSettled(accountId, idempotencyKey);
  // 迟到的那次写库已经落定；它绝不能顺手把生成器也调起来。
  expect(generatorCalls).toBe(0);
  expect(row.state).toBe("failed");
  expect(row.errorCode).toBe("TIMEOUT");
  expect(row.settledAt).not.toBeNull();

  const usage = await prisma.pluginServiceDailyUsage.findFirstOrThrow({ where: { accountId } });
  // 没有任何请求发出，预留必须回到零，不能挂着等恢复流程按 UNKNOWN 处理。
  expect(usage.reservedTokens).toBe(0);
  expect(usage.settledTokens).toBe(0);
});

test("派发标记写库永不返回：调用方仍在期限内拿到 TIMEOUT，且不进入生成器", async () => {
  const owner = (await prisma.accounts.create({ data: { name: "cjs-hanging-marker" } })).id;
  const policy = createCallPolicy({ prisma: prismaWithHangingDispatchMarker() });
  const spec: PaidCallSpec = {
    accountId: owner,
    operation: "ai.generateText",
    idempotencyKey: `hanging-${process.pid}-${Date.now()}`,
    requestFingerprint: "fingerprint-hanging",
    modelId: 1,
    reservedTokens: 500,
    maxOutputTokens: 32,
    timeoutMs: 40,
    dailyTokenLimit: 100_000,
    maxConcurrent: 2,
    maxRequestsPerMinute: 60,
  };

  let generatorCalls = 0;
  const startedAt = Date.now();
  const error = await policy
    .runPaidOperation(spec, async (context) => {
      await context.markDispatched();
      generatorCalls += 1;
      return {
        result: "should-never-run",
        usage: { inputTokens: 1, outputTokens: 1, status: "reported" as const },
      };
    })
    .catch((caught: unknown) => caught);
  const elapsed = Date.now() - startedAt;

  // 关键：超时保护不能被一个永不返回的数据库调用拖住。
  expect((error as { code?: string }).code).toBe("TIMEOUT");
  expect(elapsed).toBeLessThan(1_000);
  expect(generatorCalls).toBe(0);

  await prisma.pluginServiceRequests.deleteMany({ where: { accountId: owner } });
  await prisma.pluginServiceDailyUsage.deleteMany({ where: { accountId: owner } });
  await prisma.pluginServiceRate.deleteMany({ where: { accountId: owner } });
  await prisma.accounts.deleteMany({ where: { id: owner } });
});
