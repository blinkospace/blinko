/**
 * 反例：单个连接的小连接池下，登记事务占着唯一连接时不能再向事务外客户端借连接。
 *
 * 旧实现里频率门用的是事务外 `prisma`，`connection_limit=1` 时直接死锁：
 * 一个正常请求约 2 秒后报 P2024，且没有进入生成器（真实单连接池反例）。
 * 本用例要求：在只有一个连接的池上，一次正常调用能完成，且不出现 P2024。
 *
 * 默认测试入口显式纳入本文件，并只为它的子进程设置
 * `connection_limit=1` 与 `pool_timeout=2`，不改变其他套件的连接池。
 */
import { afterAll, expect, test } from "bun:test";
import { prisma } from "../../prisma";
import { createCallPolicy, type PaidCallSpec } from "../../services/pluginServices/CallPolicy";

if (process.env.PLUGIN_SERVICES_TEST_DB !== "1" || !process.env.DATABASE_URL)
  throw new Error("An isolated real PostgreSQL database is required.");
const db = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(db.hostname) || db.username !== "blinko_test")
  throw new Error("Wrong test database");

test("connection_limit=1 时登记事务不会向池外再借连接", async () => {
  expect(db.searchParams.get("connection_limit")).toBe("1");
  const accountId = (await prisma.accounts.create({ data: { name: "cjs-single-pool" } })).id;
  const policy = createCallPolicy({ prisma });
  const spec: PaidCallSpec = {
    accountId,
    operation: "ai.generateText",
    idempotencyKey: `pool-${process.pid}-${Date.now()}`,
    requestFingerprint: "fingerprint-pool",
    modelId: 1,
    reservedTokens: 100,
    maxOutputTokens: 16,
    timeoutMs: 5_000,
    dailyTokenLimit: 100_000,
    maxConcurrent: 2,
    maxRequestsPerMinute: 60,
  };

  const startedAt = Date.now();
  const result = await policy.runPaidOperation(spec, async (context) => {
    await context.markDispatched();
    return {
      result: "ok",
      usage: { inputTokens: 3, outputTokens: 4, status: "reported" as const },
    };
  });
  const elapsed = Date.now() - startedAt;

  expect(result).toBe("ok");
  // 旧实现在这里约 2 秒后抛 P2024；这里要求快速完成。
  expect(elapsed).toBeLessThan(1_000);

  await prisma.pluginServiceRequests.deleteMany({ where: { accountId } });
  await prisma.pluginServiceDailyUsage.deleteMany({ where: { accountId } });
  await prisma.pluginServiceRate.deleteMany({ where: { accountId } });
  await prisma.accounts.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});
