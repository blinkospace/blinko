/**
 * 插件服务 · 付费调用治理（账本 + 额度 + 并发）
 *
 * 分两层，目的是把"测了什么、没测什么"说清楚：
 *  - `decideReplay()` 等纯函数：完整单测覆盖，不碰数据库；
 *  - Prisma 原生 SQL 执行层：**需要真实 PostgreSQL 才能验证**，单测不覆盖，
 *    数据库、进程与连接池反例由独立的 db-ledger 测试覆盖。
 *
 * 正确性不变量：
 *  1. 日额度预留同时保护"首次插入"与"已有行"两条分支；
 *  2. 结算/释放用 `settledAt IS NULL` CAS 抢占，抢不到不动额度，不用 GREATEST 掩盖；
 *  3. `reserved` 超时未发出 → 释放占额；`dispatched` 超时 → 转 UNKNOWN，保留预算占额；
 *  4. 结算与释放回到账本行的 `budgetDay`，不用 CURRENT_DATE；
 *  5. **额度 UPDATE 的影响行数必须检查**，账目不平不能提交成功；
 *  6. **必须有超时计时器**，否则 invoke 永不结束时占额和并发槽永远不释放；
 *  7. **恢复不能只在同键重放时触发**，新键也要能回收过期请求占用的并发槽；
 *  8. **账户并发限制在数据库事务内判定**，不用进程内计数。
 */

import type { PrismaClient } from '@prisma/client';
import type { PluginServiceErrorCode, TokenUsage } from '@shared/lib/pluginServices/v1';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 恢复边界宽限：deadline = now + timeoutMs + grace。 */
export const RECOVERY_GRACE_MS = 30_000;

/** 账户级并发判定用的 advisory lock 命名空间，避免与其他用途的锁碰撞。 */
const CONCURRENCY_LOCK_NAMESPACE = 742_311;

export const PAID_OPERATIONS = ['ai.generateText', 'vector.queryByText'] as const;
export type PaidOperation = (typeof PAID_OPERATIONS)[number];

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export class PaidCallError extends Error {
  readonly code: PluginServiceErrorCode;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: PluginServiceErrorCode,
    options: { requestId?: string; message?: string; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(options.message ?? code);
    this.name = 'PaidCallError';
    this.code = code;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// 第一层：纯状态机与纯计算
// ---------------------------------------------------------------------------

export type RequestState =
  | 'reserved'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown';

export interface RequestRow {
  requestId: string;
  requestFingerprint: string;
  state: RequestState;
  deadlineAt: Date;
  settledAt: Date | null;
  errorCode: string | null;
}

export type ReplayDecision =
  | { kind: 'conflict'; requestId: string }
  | { kind: 'in_progress'; requestId: string }
  | { kind: 'result_not_retained'; requestId: string }
  | { kind: 'outcome_unknown'; requestId: string }
  | { kind: 'failed'; requestId: string; errorCode: string | null }
  | { kind: 'expire_reserved'; requestId: string }
  | { kind: 'expire_to_unknown'; requestId: string };

/**
 * 重放判定。**纯函数**：不读时钟、不读数据库，`now` 由调用方传入。
 *
 * 最关键的一条：`dispatched` 不等于永远进行中。超过恢复边界必须转 UNKNOWN，
 * 否则进程崩溃会把幂等键永久锁死在 REQUEST_IN_PROGRESS。
 */
export function decideReplay(row: RequestRow, now: Date, requestFingerprint: string): ReplayDecision {
  if (row.requestFingerprint !== requestFingerprint) {
    return { kind: 'conflict', requestId: row.requestId };
  }

  switch (row.state) {
    case 'succeeded':
      return { kind: 'result_not_retained', requestId: row.requestId };
    case 'outcome_unknown':
      return { kind: 'outcome_unknown', requestId: row.requestId };
    case 'failed':
      return { kind: 'failed', requestId: row.requestId, errorCode: row.errorCode };
    case 'reserved':
      return now.getTime() > row.deadlineAt.getTime()
        ? { kind: 'expire_reserved', requestId: row.requestId }
        : { kind: 'in_progress', requestId: row.requestId };
    case 'dispatched':
      return now.getTime() > row.deadlineAt.getTime()
        ? { kind: 'expire_to_unknown', requestId: row.requestId }
        : { kind: 'in_progress', requestId: row.requestId };
    default: {
      const exhaustive: never = row.state;
      throw new Error(`unknown request state: ${String(exhaustive)}`);
    }
  }
}

/**
 * 失败码推导。规则只有一条：**没派发出去就还没碰过供应商**。
 *
 * 派发前抛出的异常（策略复查、代次不匹配、读库失败）都是我方内部故障，
 * 报成 PROVIDER_ERROR 会让调用方去重试或找供应商，方向完全错。
 * 调用方显式抛出 PaidCallError 时一律保留其错误码——那是它已经判定的语义，
 * 不能被这里覆盖成笼统的供应商故障。
 */
export function failureCode(error: unknown, dispatched: boolean): PluginServiceErrorCode {
  if (error instanceof PaidCallError) return error.code;
  return dispatched ? 'PROVIDER_ERROR' : 'INTERNAL_ERROR';
}

export function replayDecisionToError(decision: ReplayDecision): PaidCallError {
  switch (decision.kind) {
    case 'conflict':
      return new PaidCallError('IDEMPOTENCY_CONFLICT', { requestId: decision.requestId });
    case 'in_progress':
      return new PaidCallError('REQUEST_IN_PROGRESS', {
        requestId: decision.requestId,
        retryable: true,
        retryAfterMs: 2_000,
      });
    case 'result_not_retained':
      return new PaidCallError('RESULT_NOT_RETAINED', { requestId: decision.requestId });
    case 'outcome_unknown':
    case 'expire_to_unknown':
      return new PaidCallError('OUTCOME_UNKNOWN', { requestId: decision.requestId });
    case 'failed':
      return new PaidCallError((decision.errorCode as PluginServiceErrorCode) ?? 'PROVIDER_ERROR', {
        requestId: decision.requestId,
      });
    case 'expire_reserved':
      return new PaidCallError('TIMEOUT', { requestId: decision.requestId, retryable: true });
  }
}

/** 过期 `reserved` 行按 budgetDay 聚合成需要释放的额度。 */
export interface ExpiredReservation {
  budgetDay: Date;
  reservedTokens: number;
}

export function aggregateReleases(rows: readonly ExpiredReservation[]): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const row of rows) {
    const key = row.budgetDay.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + row.reservedTokens);
  }
  return byDay;
}

/**
 * 实际用量口径：供应商未报告时按预留保守计入，不记 0。
 * 供应商可能已经计费，记 0 会让账户看起来没花钱。
 */
export function resolveSettledTokens(usage: TokenUsage, reservedTokens: number): number {
  if (usage.status === 'unknown') {
    return Math.max(reservedTokens, 0);
  }
  const reported = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return Math.max(reported, 0);
}

// ---------------------------------------------------------------------------
// 账户级频率门（与并发、日 token 预算都不同维度）
// ---------------------------------------------------------------------------
//
// 三个限制各管一件事，不能互相替代：
//   并发上限  —— 同一瞬间在跑几个；
//   频率上限  —— 每分钟发起几次（慢而密的调用并发永远是 1，并发门拦不住）；
//   日 token 预算 —— 一天总共花多少。
//
// 按笔记的向量查询不消耗模型，但会扫库、占 CPU，所以也要过频率门；
// 它没有账本行可数，因此频率门必须有独立计数表，不能靠数请求账本。

export interface RateGateState {
  allowed: boolean;
  used: number;
  limit: number;
  /** 只在 allowed=false 时给出，供 retryAfterMs 使用。 */
  retryAfterMs?: number;
}

export interface RateGateOptions {
  /** null/omitted keeps the original combined limit. Only an administrator enables this. */
  readNoteRequestsPerMinute?: number | null;
  /** Classification is retained even while split admission is disabled. */
  lane?: 'shared' | 'readNote';
}
export interface AccountRateGate {
  /** Read-only, without reserving capacity for the next request. */
  check(accountId: number, limit: number, options?: RateGateOptions): Promise<RateGateState>;
  /** Atomically increments the total and its classification in one row. */
  acquire(accountId: number, limit: number, options?: RateGateOptions): Promise<RateGateState>;
}

/** Fixed minute windows; SQL uses database statement time rather than transaction start. */
export const RATE_WINDOW_MS = 60_000;

/**
 * 频率门只需要执行 `$queryRaw`。把它收窄成最小形状，是为了能在事务内传入 `tx`：
 * 事务已经占着一条连接，若这里再用事务外客户端借第二条，小连接池
 * （例如 `connection_limit=1`）就会变成"事务等连接、连接等事务"，真库上报 P2024。
 */
export interface RateGateClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface AccountRateGateDeps {
  prisma: RateGateClient;
  now?: () => Date;
}

interface RateCounts {
  used: number;
  readNoteUsed: number;
  sharedUsed: number;
  retryAfterMs?: number;
}
function rateSettings(limit: number, options: RateGateOptions = {}) {
  const readLimit = options.readNoteRequestsPerMinute ?? null;
  if (readLimit !== null && (!Number.isInteger(readLimit) || readLimit < 1 || readLimit > 20))
    throw new Error('Invalid single-note read rate policy');
  const split = readLimit !== null;
  const reading = options.lane === 'readNote';
  return { split, reading, readLimit: readLimit ?? 0, laneLimit: split && reading ? readLimit! : limit };
}
function countedUsage(row: RateCounts, split: boolean, reading: boolean): number {
  // Rows from before this migration (or older writers) have unclassified usage.
  // Charge that debt against BOTH possible lanes until this minute ends.
  return split ? row.used - (reading ? row.sharedUsed : row.readNoteUsed) : row.used;
}
export function createAccountRateGate(deps: AccountRateGateDeps): AccountRateGate {
  const { prisma } = deps;
  const check: AccountRateGate['check'] = async (accountId, limit, options) => {
    const settings = rateSettings(limit, options);
    const rows = await prisma.$queryRaw<RateCounts[]>`
      WITH current_window AS (
        SELECT date_trunc('minute', statement_timestamp()) AS start
      ), counts AS (
        SELECT "used", "readNoteUsed", "sharedUsed" FROM "plugin_service_rate"
         WHERE "accountId"=${accountId}::int
           AND "windowStart"=(SELECT start FROM current_window)
      )
      SELECT COALESCE(c.used,0)::int AS used,
             COALESCE(c."readNoteUsed",0)::int AS "readNoteUsed",
             COALESCE(c."sharedUsed",0)::int AS "sharedUsed",
             GREATEST(1,LEAST(60000,ceil(EXTRACT(EPOCH FROM
               (w.start + interval '1 minute' - clock_timestamp())) * 1000)))::int AS "retryAfterMs"
        FROM current_window w LEFT JOIN counts c ON true
    `;
    const row = rows[0];
    if (!row || !Number.isFinite(row.retryAfterMs)) throw new Error('Missing rate window state');
    const used = countedUsage(row, settings.split, settings.reading);
    const allowed = used < settings.laneLimit && (!settings.split || row.used < limit + settings.readLimit);
    return { allowed, used, limit: settings.laneLimit, ...(!allowed ? { retryAfterMs: row.retryAfterMs } : {}) };
  };
  return {
    check,
    async acquire(accountId, limit, options) {
      const { split, reading, readLimit, laneLimit } = rateSettings(limit, options);
      // A single account/window row serializes total AND lane admission. Combined
      // mode also records each classification, so toggling never resets usage.
      const rows = await prisma.$queryRaw<RateCounts[]>`
        INSERT INTO "plugin_service_rate" ("accountId","windowStart","used","readNoteUsed","sharedUsed")
        SELECT ${accountId}::int, date_trunc('minute', statement_timestamp()), 1,
               ${reading ? 1 : 0}::int, ${reading ? 0 : 1}::int
         WHERE 1 <= ${limit}::int AND (NOT ${split}::boolean OR 1 <= ${laneLimit}::int)
        ON CONFLICT ("accountId","windowStart") DO UPDATE
          SET "used" = "plugin_service_rate"."used" + 1,
              "readNoteUsed" = "plugin_service_rate"."readNoteUsed" + EXCLUDED."readNoteUsed",
              "sharedUsed" = "plugin_service_rate"."sharedUsed" + EXCLUDED."sharedUsed"
          WHERE (NOT ${split}::boolean AND "plugin_service_rate"."used" < ${limit}::int)
             OR (${split}::boolean AND "plugin_service_rate"."used" < ${limit + readLimit}::int
                 AND "plugin_service_rate"."used" - CASE WHEN ${reading}::boolean
                       THEN "plugin_service_rate"."sharedUsed" ELSE "plugin_service_rate"."readNoteUsed" END < ${laneLimit}::int)
        RETURNING "used","readNoteUsed","sharedUsed"
      `;
      if (!rows.length) {
        // Recheck only on rejection, using this SAME transaction client for paid
        // calls. A crossed minute can already be available; return a 1ms hint
        // without silently replaying the refused request.
        const state = await check(accountId, limit, options);
        return { ...state, allowed: false, retryAfterMs: state.retryAfterMs ?? 1 };
      }
      return { allowed: true, used: countedUsage(rows[0], split, reading), limit: laneLimit };
    },
  };
}

/**
 * 清理过期窗口。表随时间线性增长，必须有回收路径，
 * 否则一个长期运行实例会把这张表撑成主要体积。
 */
export async function pruneRateWindows(
  prisma: PrismaClient,
  keepMinutes = 10,
): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "plugin_service_rate"
     WHERE "windowStart" < now() - (${keepMinutes}::int * interval '1 minute')
  `;
}

// ---------------------------------------------------------------------------
// 第二层：执行契约
// ---------------------------------------------------------------------------

export interface PaidCallSpec {
  accountId: number;
  operation: PaidOperation;
  idempotencyKey: string;
  requestFingerprint: string;
  modelId: number;
  reservedTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** 账户当日 token 预算上限（策略与默认取 min 后传入）。 */
  dailyTokenLimit: number;
  /** 账户并发上限（策略与默认取 min 后传入）。 */
  maxConcurrent: number;
  /** 账户每分钟新增请求上限（与并发是两个维度，不能互相替代）。 */
  maxRequestsPerMinute: number;
  /** Paid operations stay in the shared lane; this never grants a second paid quota. */
  readNoteRequestsPerMinute?: number | null;
}

export interface PaidInvokeContext {
  requestId: string;
  signal: AbortSignal;
  markDispatched(): Promise<void>;
}

export interface PaidInvokeResult<T> {
  result: T;
  usage: TokenUsage;
}

export interface CallPolicy {
  runPaidOperation<T>(
    spec: PaidCallSpec,
    invoke: (context: PaidInvokeContext) => Promise<PaidInvokeResult<T>>,
  ): Promise<T>;
  /** 回收该账户所有过期请求的并发槽与（未发出的）额度占额。 */
  sweepExpired(accountId: number): Promise<{ released: number; unknown: number }>;
}

export interface CallPolicyDeps {
  prisma: PrismaClient;
  now?: () => Date;
  recoveryGraceMs?: number;
  /** 速率窗口清理间隔；0 表示每次预留都清理（测试用）。 */
  pruneIntervalMs?: number;
  /** 账户级频率门。与并发、日预算分属不同维度，必须共用同一实现。 */
  rateGate?: AccountRateGate;
}

// ---------------------------------------------------------------------------
// 第二层：实现
// ---------------------------------------------------------------------------

function utcDayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function newRequestId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return typeof cryptoRef?.randomUUID === 'function'
    ? cryptoRef.randomUUID()
    : `req-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function createCallPolicy(deps: CallPolicyDeps): CallPolicy {
  const { prisma } = deps;
  const now = deps.now ?? (() => new Date());
  const graceMs = deps.recoveryGraceMs ?? RECOVERY_GRACE_MS;
  const rateGate = deps.rateGate ?? createAccountRateGate({ prisma });
  const pruneIntervalMs = deps.pruneIntervalMs ?? 5 * 60_000;
  let lastPruneAt = 0;

  /**
   * 回收过期请求。两个分支语义不同：
   *  - reserved 过期且从未发出 → 释放额度占额；
   *  - dispatched 过期 → 转 UNKNOWN，**保留**预算占额，但并发槽被释放
   *    （因为它已不在执行，继续占槽会让账户并发永久降级）。
   */
  async function sweepExpired(accountId: number): Promise<{ released: number; unknown: number }> {
    return prisma.$transaction(async (tx) => {
      const expiredReserved = await tx.$queryRaw<ExpiredReservation[]>`
        UPDATE "plugin_service_requests"
           SET "state" = 'failed', "settledAt" = now(), "errorCode" = 'TIMEOUT', "updatedAt" = now()
         WHERE "accountId" = ${accountId}::int
           AND "state" = 'reserved'
           AND "settledAt" IS NULL
           AND "deadlineAt" < now()
         RETURNING "budgetDay", "reservedTokens"
      `;

      for (const [day, tokens] of aggregateReleases(expiredReserved)) {
        const affected = await tx.$executeRaw`
          UPDATE "plugin_service_daily_usage"
             SET "reservedTokens" = "reservedTokens" - ${tokens}::int
           WHERE "accountId" = ${accountId}::int
             AND "day" = ${day}::date
             AND "reservedTokens" >= ${tokens}::int
        `;
        if (affected === 0 && tokens > 0) {
          // 账目不平：占用早就被别处释放。不静默吞掉，抛出以回滚并暴露问题。
          throw new PaidCallError('OUTCOME_UNKNOWN', {
            message: `quota release mismatch for ${day}: expected >= ${tokens}`,
          });
        }
      }

      const expiredDispatched = await tx.$queryRaw<Array<{ requestId: string }>>`
        UPDATE "plugin_service_requests"
           SET "state" = 'outcome_unknown', "outcomeUnknownAt" = now(), "updatedAt" = now()
         WHERE "accountId" = ${accountId}::int
           AND "state" = 'dispatched'
           AND "deadlineAt" < now()
         RETURNING "requestId"
      `;

      return { released: expiredReserved.length, unknown: expiredDispatched.length };
    });
  }

  /** 并发判定必须在事务内，并且先回收过期行，否则死请求会永久压低并发上限。 */
  /**
   * 速率窗口的机会式回收。不引调度器：这里没有常驻任务的位置，
   * 而这张表不清理会无界增长。清理失败绝不影响业务请求，最多留到下次。
   */
  function maybePruneRateWindows(): void {
    const at = now().getTime();
    if (pruneIntervalMs > 0 && at - lastPruneAt < pruneIntervalMs) return;
    lastPruneAt = at;
    void pruneRateWindows(prisma).catch(() => undefined);
  }

  async function reserveOrReplay(spec: PaidCallSpec, requestId: string): Promise<void> {
    maybePruneRateWindows();
    await sweepExpired(spec.accountId);

    const at = now();
    const budgetDay = utcDayOf(at);
    const deadline = new Date(at.getTime() + spec.timeoutMs + graceMs);

    const outcome = await prisma.$transaction(async (tx) => {
      // 账户级串行化：没有这把锁，两个并发事务会同时读到"未超限"再各自插入。
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(${CONCURRENCY_LOCK_NAMESPACE}::int, ${spec.accountId}::int)
      `;

      const inserted = await tx.$queryRaw<Array<{ requestId: string }>>`
        INSERT INTO "plugin_service_requests"
          ("accountId","operation","idempotencyKey","requestFingerprint","requestId","modelId",
           "state","budgetDay","reservedTokens","usageStatus","timeoutMs","deadlineAt","updatedAt")
        VALUES (${spec.accountId}::int, ${spec.operation}, ${spec.idempotencyKey},
                ${spec.requestFingerprint}, ${requestId}, ${spec.modelId}::int,
                'reserved', ${budgetDay}::date, ${spec.reservedTokens}::int, 'unknown',
                ${spec.timeoutMs}::int, ${deadline}, now())
        ON CONFLICT ("accountId","operation","idempotencyKey") DO NOTHING
        RETURNING "requestId"
      `;
      if (inserted.length === 0) {
        return { kind: 'existing' as const };
      }

      // 并发计数必须排除刚插入的这行，否则第一条请求就会把自己算进去。
      const loaded = await tx.$queryRaw<Array<{ active: number }>>`
        SELECT count(*)::int AS active
          FROM "plugin_service_requests"
         WHERE "accountId" = ${spec.accountId}::int
           AND "state" IN ('reserved','dispatched')
           AND "requestId" <> ${requestId}
      `;
      if ((loaded[0]?.active ?? 0) >= spec.maxConcurrent) {
        // 抛出以回滚登记：这次是新增调用，超额就必须拒绝，不能占着槽位。
        throw new PaidCallError('RATE_LIMITED', {
          requestId,
          message: 'account concurrency limit reached',
          // Completion time is unknown; do not present concurrency as a timed
          // frequency window. The existing optional DTO field stays absent.
          retryable: true,
        });
      }

      // 首次插入由 SELECT 的 WHERE 保护，已有行由 DO UPDATE 的 WHERE 保护。
      const quota = await tx.$queryRaw<Array<{ reservedTokens: number }>>`
        INSERT INTO "plugin_service_daily_usage" ("accountId","day","reservedTokens")
        SELECT ${spec.accountId}::int, ${budgetDay}::date, ${spec.reservedTokens}::int
         WHERE ${spec.reservedTokens}::int <= ${spec.dailyTokenLimit}::int
        ON CONFLICT ("accountId","day") DO UPDATE
          SET "reservedTokens" = "plugin_service_daily_usage"."reservedTokens" + EXCLUDED."reservedTokens"
          WHERE "plugin_service_daily_usage"."reservedTokens"
              + "plugin_service_daily_usage"."settledTokens"
              + EXCLUDED."reservedTokens" <= ${spec.dailyTokenLimit}::int
        RETURNING "reservedTokens"
      `;
      if (quota.length === 0) {
        // 抛出以回滚上面的登记：不留永久占用幂等键的空账。
        throw new PaidCallError('BUDGET_EXCEEDED', {
          requestId,
          message: 'daily token budget exceeded',
        });
      }

      // 频率计数放在预算判定之后，有两点原因：
      //  1. 它和登记同处一个事务。事务外的客户端会再借一条连接，小连接池下
      //     与"事务占着唯一连接"直接死锁（单连接池可出现 P2024）；
      //  2. 放在最后，前面任何一步拒绝都会连同本次计数一起回滚，只有真正被
      //     放行的请求才占一分钟的配额——否则被预算挡下的请求也会偷偷吃限流额度。
      // 并发与频率仍分开判定：并发管"同时在跑几个"，频率管"一分钟发起几次"。
      const rate = await createAccountRateGate({ prisma: tx }).acquire(
        spec.accountId,
        spec.maxRequestsPerMinute,
        { readNoteRequestsPerMinute: spec.readNoteRequestsPerMinute, lane: 'shared' },
      );
      if (!rate.allowed) {
        throw new PaidCallError('RATE_LIMITED', {
          requestId,
          message: 'account request rate limit reached',
          retryable: true,
          retryAfterMs: rate.retryAfterMs ?? 30_000,
        });
      }

      return { kind: 'reserved' as const };
    });

    if (outcome.kind === 'existing') {
      await handleReplay(spec);
    }
  }

  async function loadRow(accountId: number, operation: string, idempotencyKey: string) {
    const rows = await prisma.$queryRaw<RequestRow[]>`
      SELECT "requestId", "requestFingerprint", "state", "deadlineAt", "settledAt", "errorCode"
        FROM "plugin_service_requests"
       WHERE "accountId" = ${accountId}::int
         AND "operation" = ${operation}
         AND "idempotencyKey" = ${idempotencyKey}
       LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async function handleReplay(spec: PaidCallSpec): Promise<void> {
    const row = await loadRow(spec.accountId, spec.operation, spec.idempotencyKey);
    if (!row) {
      throw new PaidCallError('REQUEST_IN_PROGRESS', { retryable: true, retryAfterMs: 2_000 });
    }
    const decision = decideReplay(row, now(), spec.requestFingerprint);
    // 过期分支的状态推进已由 sweepExpired 在进入事务前完成，这里只翻译结果。
    throw replayDecisionToError(decision);
  }

  /** 成功结算：CAS 抢结算权 → 释放预留并计入实耗。影响行数必须检查。 */
  async function settleSucceeded(
    requestId: string,
    accountId: number,
    usage: TokenUsage,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<Array<{ budgetDay: Date; reservedTokens: number }>>`
        UPDATE "plugin_service_requests"
           SET "state" = 'succeeded',
               "settledAt" = now(),
               "inputTokens" = ${usage.inputTokens}::int,
               "outputTokens" = ${usage.outputTokens}::int,
               "usageStatus" = ${usage.status},
               "updatedAt" = now()
         WHERE "requestId" = ${requestId}
           AND "settledAt" IS NULL
           AND "state" IN ('reserved','dispatched')
         RETURNING "budgetDay", "reservedTokens"
      `;
      const row = claimed[0];
      if (!row) {
        // 已被其他路径结算：按既有结果返回即可，不动额度。
        return;
      }

      const actual = resolveSettledTokens(usage, row.reservedTokens);
      const affected = await tx.$executeRaw`
        UPDATE "plugin_service_daily_usage"
           SET "reservedTokens" = "reservedTokens" - ${row.reservedTokens}::int,
               "settledTokens"  = "settledTokens" + ${actual}::int
         WHERE "accountId" = ${accountId}::int
           AND "day" = ${row.budgetDay}::date
           AND "reservedTokens" >= ${row.reservedTokens}::int
      `;
      if (affected === 0) {
        throw new PaidCallError('OUTCOME_UNKNOWN', {
          requestId,
          message: 'quota settle mismatch: reservation already released',
        });
      }
    });
  }

  /** 把行推进到 outcome_unknown：保留预算占额，但并发槽随之释放。 */
  async function markOutcomeUnknown(requestId: string, code: string): Promise<void> {
    await prisma.$executeRaw`
      UPDATE "plugin_service_requests"
         SET "state" = 'outcome_unknown',
             "outcomeUnknownAt" = now(),
             "errorCode" = ${code},
             "updatedAt" = now()
       WHERE "requestId" = ${requestId}
         AND "state" = 'dispatched'
    `;
  }

  /**
   * 失败收尾：已发送转 UNKNOWN 保留占额；未发送释放占额。影响行数必须检查。
   *
   * 有一处竞态要注意：`markDispatched()` 的 UPDATE 可能已经提交，而本地
   * `dispatched` 标志还没置位（它在 await 之后才赋值）。这时按"未发送"去释放占额
   * 会 CAS 不到行，若就此返回，就会留下一条 dispatched 行一直占着预算和并发槽。
   * 所以拿不到行时还要补一次转 UNKNOWN。
   */
  async function settleFailed(
    requestId: string,
    accountId: number,
    dispatched: boolean,
    error: unknown,
  ): Promise<void> {
    const code = failureCode(error, dispatched);
    if (dispatched) {
      await markOutcomeUnknown(requestId, code);
      return;
    }

    const released = await prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<Array<{ budgetDay: Date; reservedTokens: number }>>`
        UPDATE "plugin_service_requests"
           SET "state" = 'failed', "settledAt" = now(), "errorCode" = ${code}, "updatedAt" = now()
         WHERE "requestId" = ${requestId}
           AND "settledAt" IS NULL
           AND "state" = 'reserved'
         RETURNING "budgetDay", "reservedTokens"
      `;
      const row = claimed[0];
      if (!row) return false;

      const affected = await tx.$executeRaw`
        UPDATE "plugin_service_daily_usage"
           SET "reservedTokens" = "reservedTokens" - ${row.reservedTokens}::int
         WHERE "accountId" = ${accountId}::int
           AND "day" = ${row.budgetDay}::date
           AND "reservedTokens" >= ${row.reservedTokens}::int
      `;
      if (affected === 0) {
        throw new PaidCallError('OUTCOME_UNKNOWN', {
          requestId,
          message: 'quota release mismatch: reservation already released',
        });
      }
      return true;
    });

    if (!released) {
      // 竞态：行已经被推进到 dispatched，按"已发送、结果不明"处理。
      await markOutcomeUnknown(requestId, code);
    }
  }

  /**
   * 收回一条"派发标记已写入、但生成器从未被调用"的请求。
   *
   * 与 `settleFailed(dispatched=false)` 的区别：那条路只认 `state='reserved'`，
   * 这里行已经是 `dispatched`，但事实是该请求一步都没发出去。把这种行留给
   * 恢复流程会按 OUTCOME_UNKNOWN 长期占着预算和并发槽，其实并没有人在跑；
   * 因此这里显式转 failed 并释放预留，口径与"未派发失败"一致。
   */
  async function releaseUnsentDispatch(requestId: string, accountId: number): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<Array<{ budgetDay: Date; reservedTokens: number }>>`
        UPDATE "plugin_service_requests"
           SET "state" = 'failed',
               "settledAt" = now(),
               "errorCode" = 'TIMEOUT',
               "updatedAt" = now()
         WHERE "requestId" = ${requestId}
           AND "settledAt" IS NULL
           AND "state" = 'dispatched'
         RETURNING "budgetDay", "reservedTokens"
      `;
      const row = claimed[0];
      if (!row) return;
      const affected = await tx.$executeRaw`
        UPDATE "plugin_service_daily_usage"
           SET "reservedTokens" = "reservedTokens" - ${row.reservedTokens}::int
         WHERE "accountId" = ${accountId}::int
           AND "day" = ${row.budgetDay}::date
           AND "reservedTokens" >= ${row.reservedTokens}::int
      `;
      if (affected === 0) {
        // 额度行对不上就整笔回滚：宁可留成 dispatched 交给恢复流程按未知处理，
        // 也不能出现"行说失败、预算却还挂着"的两本账。
        throw new PaidCallError('OUTCOME_UNKNOWN', {
          requestId,
          message: 'quota release mismatch during unsent-dispatch cleanup',
        });
      }
    });
  }

  return {
    sweepExpired,

    async runPaidOperation<T>(
      spec: PaidCallSpec,
      invoke: (context: PaidInvokeContext) => Promise<PaidInvokeResult<T>>,
    ): Promise<T> {
      const requestId = newRequestId();
      await reserveOrReplay(spec, requestId);

      const controller = new AbortController();
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      // abort() 只是通知，invoke 若不配合退出就永远不返回。
      // 用一个竞速的拒绝门保证"到点必返回"，而不是指望 provider 客户端守规矩。
      const timeoutGate = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new PaidCallError('TIMEOUT', { requestId, retryable: true }));
        }, spec.timeoutMs);
      });
      // 超时后 invoke 仍可能迟到地失败；先挂一个空处理器，避免未处理拒绝。
      timeoutGate.catch(() => undefined);

      let dispatched = false;
      let dispatchPromise: Promise<void> | null = null;
      // 这次派发标记写库是否已经有结论。超时那一刻若写库还在飞，
      // 结算必须让位给它，否则会把"已提交、回执未到"的行当成未派发。
      let markerSettled = true;

      const markDispatched = (): Promise<void> => {
        // 超时之后绝不允许推进到 dispatched：调用方已拿到 TIMEOUT，
        // 再标"已发送"会让账本结论和用户看到的互相矛盾。
        if (timedOut) {
          return Promise.reject(new PaidCallError('TIMEOUT', { requestId, retryable: true }));
        }
        if (!dispatchPromise) {
          markerSettled = false;
          dispatchPromise = (async () => {
            try {
              const at = now();
              const deadline = new Date(at.getTime() + spec.timeoutMs + graceMs);
              const updated = await prisma.$executeRaw`
                UPDATE "plugin_service_requests"
                   SET "state" = 'dispatched',
                       "dispatchStartedAt" = ${at},
                       "deadlineAt" = ${deadline},
                       "updatedAt" = now()
                 WHERE "requestId" = ${requestId}
                   AND "state" = 'reserved'
              `;
              if (updated === 0) {
                throw new PaidCallError('REQUEST_IN_PROGRESS', { requestId });
              }
              // 写库可能比期限更慢：回执回来时调用方早已拿到 TIMEOUT。
              // 此刻还没有调用生成器，属于"标记已写、请求未发"，必须当场收回，
              // 否则一次真实的付费调用会发生在用户已经看到失败之后。
              if (timedOut || controller.signal.aborted) {
                await releaseUnsentDispatch(requestId, spec.accountId);
                throw new PaidCallError('TIMEOUT', { requestId, retryable: true });
              }
              dispatched = true;
            } finally {
              // 无论写库成功、失败还是永不返回，这里只在它真的落定时置位。
              markerSettled = true;
            }
          })();
        }
        return dispatchPromise;
      };

      try {
        const invocation = invoke({
          requestId,
          signal: controller.signal,
          markDispatched,
        });
        // 竞速落败的一方必须被消费掉，否则会变成未处理的 Promise 拒绝。
        invocation.catch(() => undefined);
        const { result, usage } = await Promise.race([invocation, timeoutGate]);
        await settleSucceeded(requestId, spec.accountId, usage);
        return result;
      } catch (error) {
        const asPublicError = (): PaidCallError =>
          error instanceof PaidCallError
            ? error
            : new PaidCallError(failureCode(error, dispatched), {
                requestId,
                message: dispatched ? 'provider call failed' : 'internal failure before dispatch',
              });

        // 超时落在派发标记写库途中：按期返回 TIMEOUT，结算让位给这次写库。
        // 它会自行完成"未发送"收尾（转 failed 并释放预留）。这里绝不可以等它——
        // 数据库调用若永不返回，超时保护本身就会被拖死。
        if (dispatchPromise && !markerSettled) {
          throw asPublicError();
        }

        try {
          await settleFailed(requestId, spec.accountId, dispatched, error);
        } catch (settleError) {
          if (settleError instanceof Error && error instanceof Error) {
            (settleError as Error & { cause?: unknown }).cause = error;
          }
          throw settleError;
        }
        throw asPublicError();
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
}
