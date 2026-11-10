import { describe, test, expect, afterAll } from "bun:test";
import { PrismaClient } from "@prisma/client";
import {
  createCallPolicy,
  type PaidCallSpec,
  type PaidInvokeContext,
} from "../../../services/pluginServices/CallPolicy";

export function registerLedgerCases() {
  if (process.env.PLUGIN_SERVICES_TEST_DB !== "1" || !process.env.DATABASE_URL)
    throw new Error(
      "A dedicated real PostgreSQL test database is required; no skip or mock fallback.",
    );
  const url = new URL(process.env.DATABASE_URL);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username !== "blinko_test"
  )
    throw new Error(
      "Only the explicitly isolated local blinko_test database is allowed.",
    );
  const prisma = new PrismaClient();
  const accounts: number[] = [];
  afterAll(async () => {
    for (const accountId of accounts) {
      await prisma.pluginServiceRequests.deleteMany({ where: { accountId } });
      await prisma.pluginServiceDailyUsage.deleteMany({ where: { accountId } });
      await prisma.accounts.delete({ where: { id: accountId } });
    }
    await prisma.$disconnect();
  });
  async function spec(
    extra: Partial<PaidCallSpec> = {},
  ): Promise<PaidCallSpec> {
    const account = await prisma.accounts.create({
      data: { name: "plugin-services-synthetic-" + crypto.randomUUID() },
    });
    accounts.push(account.id);
    return {
      accountId: account.id,
      operation: "ai.generateText",
      idempotencyKey: crypto.randomUUID(),
      requestFingerprint: "synthetic-input",
      modelId: 1,
      reservedTokens: 20,
      maxOutputTokens: 10,
      timeoutMs: 10000,
      dailyTokenLimit: 100,
      maxConcurrent: 2,
      maxRequestsPerMinute: 240,
      ...extra,
    };
  }
  const result = () => ({
    result: "synthetic response",
    usage: { inputTokens: 4, outputTokens: 3, status: "reported" as const },
  });
  async function usage(accountId: number) {
    return prisma.pluginServiceDailyUsage.findMany({
      where: { accountId },
      orderBy: { day: "asc" },
    });
  }
  async function expired(
    base: PaidCallSpec,
    state: "reserved" | "dispatched",
    tokens = 25,
  ) {
    const day = new Date(new Date().toISOString().slice(0, 10));
    await prisma.pluginServiceDailyUsage.create({
      data: { accountId: base.accountId, day, reservedTokens: tokens },
    });
    return prisma.pluginServiceRequests.create({
      data: {
        accountId: base.accountId,
        operation: base.operation,
        idempotencyKey: "expired-" + crypto.randomUUID(),
        requestFingerprint: "synthetic-expired",
        requestId: crypto.randomUUID(),
        state,
        budgetDay: day,
        reservedTokens: tokens,
        timeoutMs: 10,
        deadlineAt: new Date(Date.now() - 60000),
        ...(state === "dispatched"
          ? { dispatchStartedAt: new Date(Date.now() - 60001) }
          : {}),
      },
    });
  }
  describe("real PostgreSQL paid-call ledger", () => {
    test("first request over budget rolls back registration and never invokes provider", async () => {
      const base = await spec({ reservedTokens: 101 });
      let calls = 0;
      await expect(
        createCallPolicy({ prisma }).runPaidOperation(base, async () => {
          calls++;
          return result();
        }),
      ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
      expect(calls).toBe(0);
      expect(
        await prisma.pluginServiceRequests.count({
          where: { accountId: base.accountId },
        }),
      ).toBe(0);
      expect(await usage(base.accountId)).toHaveLength(0);
    });
    test("16 simultaneous replays invoke once, replay after success does not settle twice", async () => {
      const base = await spec();
      let calls = 0;
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const policy = createCallPolicy({ prisma });
      const first = policy.runPaidOperation(base, async (context) => {
        calls++;
        await context.markDispatched();
        started();
        await gate;
        return result();
      });
      await ready;
      const replays = await Promise.allSettled(
        Array.from({ length: 16 }, () =>
          createCallPolicy({ prisma }).runPaidOperation(base, async () => {
            calls++;
            return result();
          }),
        ),
      );
      expect(
        replays.every(
          (item) =>
            item.status === "rejected" &&
            item.reason.code === "REQUEST_IN_PROGRESS",
        ),
      ).toBe(true);
      release();
      expect(await first).toBe("synthetic response");
      await expect(
        policy.runPaidOperation(base, async () => {
          calls++;
          return result();
        }),
      ).rejects.toMatchObject({ code: "RESULT_NOT_RETAINED" });
      expect(calls).toBe(1);
      expect((await usage(base.accountId))[0]).toMatchObject({
        reservedTokens: 0,
        settledTokens: 7,
      });
    });
    test("two database-backed instances share the account concurrency cap, replay bypasses full slots", async () => {
      const base = await spec();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready1!: () => void, ready2!: () => void;
      const one = new Promise<void>((resolve) => {
        ready1 = resolve;
      });
      const two = new Promise<void>((resolve) => {
        ready2 = resolve;
      });
      const policy = createCallPolicy({ prisma });
      const first = policy.runPaidOperation(base, async (context) => {
        await context.markDispatched();
        ready1();
        await gate;
        return result();
      });
      await one;
      const second = createCallPolicy({ prisma }).runPaidOperation(
        { ...base, idempotencyKey: "second" },
        async (context) => {
          await context.markDispatched();
          ready2();
          await gate;
          return result();
        },
      );
      await two;
      try {
        await expect(
          policy.runPaidOperation(
            { ...base, idempotencyKey: "third" },
            async () => result(),
          ),
        ).rejects.toMatchObject({ code: "RATE_LIMITED" });
        await expect(
          policy.runPaidOperation(base, async () => result()),
        ).rejects.toMatchObject({ code: "REQUEST_IN_PROGRESS" });
      } finally {
        release();
        await Promise.all([first, second]);
      }
      expect((await usage(base.accountId))[0]).toMatchObject({
        reservedTokens: 0,
        settledTokens: 14,
      });
    });
    test("settlement after UTC midnight targets the reservation day", async () => {
      const base = await spec();
      let at = new Date("2026-01-01T23:59:59Z");
      const policy = createCallPolicy({ prisma, now: () => at });
      await policy.runPaidOperation(base, async (context) => {
        await context.markDispatched();
        at = new Date("2026-01-02T00:00:01Z");
        return result();
      });
      const rows = await usage(base.accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0].day.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(rows[0]).toMatchObject({ reservedTokens: 0, settledTokens: 7 });
    });
    test("new key recovers an expired unsent reservation and releases quota once", async () => {
      const base = await spec({ maxConcurrent: 1 });
      const old = await expired(base, "reserved");
      const policy = createCallPolicy({ prisma });
      await policy.runPaidOperation(base, async (context) => {
        await context.markDispatched();
        return result();
      });
      expect(
        (await prisma.pluginServiceRequests.findUnique({
          where: { requestId: old.requestId },
        }))!.state,
      ).toBe("failed");
      expect(await policy.sweepExpired(base.accountId)).toEqual({
        released: 0,
        unknown: 0,
      });
      expect((await usage(base.accountId))[0]).toMatchObject({
        reservedTokens: 0,
        settledTokens: 7,
      });
    });
    test("new key reclaims a dispatched slot but retains unknown provider budget", async () => {
      const base = await spec({ maxConcurrent: 1 });
      const old = await expired(base, "dispatched");
      const policy = createCallPolicy({ prisma });
      await policy.runPaidOperation(base, async (context) => {
        await context.markDispatched();
        return result();
      });
      expect(
        (await prisma.pluginServiceRequests.findUnique({
          where: { requestId: old.requestId },
        }))!.state,
      ).toBe("outcome_unknown");
      expect((await usage(base.accountId))[0]).toMatchObject({
        reservedTokens: 25,
        settledTokens: 7,
      });
    });
    test("accounting mismatch rolls back success instead of hiding an unbalanced ledger", async () => {
      const base = await spec();
      await expect(
        createCallPolicy({ prisma }).runPaidOperation(base, async (context) => {
          await context.markDispatched();
          await prisma.pluginServiceDailyUsage.updateMany({
            where: { accountId: base.accountId },
            data: { reservedTokens: 0 },
          });
          return result();
        }),
      ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      const row = await prisma.pluginServiceRequests.findFirstOrThrow({
        where: { accountId: base.accountId },
      });
      expect(row.state).not.toBe("succeeded");
      expect(row.settledAt).toBeNull();
    });
    test("uncooperative invocation has bounded timeout and unknown result is never retried", async () => {
      const base = await spec({ timeoutMs: 40 });
      let calls = 0;
      const policy = createCallPolicy({ prisma });
      const start = Date.now();
      await expect(
        policy.runPaidOperation(base, async (context) => {
          calls++;
          await context.markDispatched();
          return new Promise<never>(() => {});
        }),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(Date.now() - start).toBeLessThan(2000);
      await expect(
        createCallPolicy({ prisma }).runPaidOperation(base, async () => {
          calls++;
          return result();
        }),
      ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(calls).toBe(1);
      expect((await usage(base.accountId))[0]).toMatchObject({
        reservedTokens: 20,
        settledTokens: 0,
      });
    });
    test("timeout before dispatch releases quota and blocks a late dispatch call", async () => {
      const base = await spec({ timeoutMs: 30 });
      let saved: PaidInvokeContext | undefined;
      await expect(
        createCallPolicy({ prisma }).runPaidOperation(base, async (context) => {
          saved = context;
          return new Promise<never>(() => {});
        }),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
      await expect(saved!.markDispatched()).rejects.toMatchObject({
        code: "TIMEOUT",
      });
      expect((await usage(base.accountId))[0]).toMatchObject({
        reservedTokens: 0,
        settledTokens: 0,
      });
      expect(
        (
          await prisma.pluginServiceRequests.findFirstOrThrow({
            where: { accountId: base.accountId },
          })
        ).state,
      ).toBe("failed");
    });
    test("same key different input conflicts without a second call", async () => {
      const base = await spec();
      const policy = createCallPolicy({ prisma });
      let calls = 0;
      await policy.runPaidOperation(base, async (context) => {
        calls++;
        await context.markDispatched();
        return result();
      });
      await expect(
        policy.runPaidOperation(
          { ...base, requestFingerprint: "other" },
          async () => {
            calls++;
            return result();
          },
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(calls).toBe(1);
    });
  });
}
