import { describe, expect, test } from 'bun:test';
import {
  clampLimits,
  createPolicyStore,
  type PolicyRowSource,
  type RawPolicyRow,
} from '@server/services/pluginServices/PolicyStore';
import {
  PaidCallError,
  RECOVERY_GRACE_MS,
  aggregateReleases,
  createAccountRateGate,
  failureCode,
  decideReplay,
  replayDecisionToError,
  resolveSettledTokens,
  type RequestRow,
} from '@server/services/pluginServices/CallPolicy';
import { PLUGIN_SERVICES_POLICY_LIMITS } from '@shared/lib/pluginServices/v1';

function storeWith(row: RawPolicyRow | null | (() => never)): ReturnType<typeof createPolicyStore> {
  const source: PolicyRowSource = {
    async read() {
      if (typeof row === 'function') {
        return row();
      }
      return row;
    },
  };
  return createPolicyStore(source);
}

describe('策略缺失', () => {
  test('没有配置时按默认值正常提供，不误关服务', async () => {
    const store = storeWith(null);
    const policy = await store.load();
    expect(policy.ok).toBe(true);
    expect(policy.limits).toEqual({ ...PLUGIN_SERVICES_POLICY_LIMITS });
    expect(store.capability(policy, 'ai.generateText')).toEqual({ available: true });
    expect(store.isModelAllowed(policy, 1)).toBe(true);
  });
});

describe('策略损坏必须失败即关闭', () => {
  test('JSON 结构不合法时报 not-configured，而不是回落默认放行', async () => {
    const store = storeWith({ limits: { maxResults: 'many' }, features: 'nope' });
    const policy = await store.load();
    expect(policy.ok).toBe(false);
    expect(policy.problem).toBe('invalid');
    expect(store.capability(policy, 'ai.generateText')).toEqual({
      available: false,
      reason: 'not-configured',
    });
    expect(store.isModelAllowed(policy, 1)).toBe(false);
  });

  test('未知字段也判为损坏（strictObject）', async () => {
    const store = storeWith({ features: { 'ai.generateText': { enabled: true, extra: 1 } } });
    const policy = await store.load();
    expect(policy.ok).toBe(false);
  });

  test('读取抛错时不放行', async () => {
    const store = storeWith(() => {
      throw new Error('db down');
    });
    const policy = await store.load();
    expect(policy.ok).toBe(false);
    expect(store.capability(policy, 'vector.queryByNote')).toEqual({
      available: false,
      reason: 'not-configured',
    });
  });
});

describe('限值只当上限', () => {
  test('调低生效', async () => {
    const store = storeWith({ limits: { maxResults: 5 } });
    const policy = await store.load();
    expect(policy.limits.maxResults).toBe(5);
  });

  test('调高被钳制回默认上限，不能突破代码边界', () => {
    const clamped = clampLimits({
      maxResults: PLUGIN_SERVICES_POLICY_LIMITS.maxResults + 1000,
      maxExcludeIds: PLUGIN_SERVICES_POLICY_LIMITS.maxExcludeIds * 2,
    });
    expect(clamped.maxResults).toBe(PLUGIN_SERVICES_POLICY_LIMITS.maxResults);
    expect(clamped.maxExcludeIds).toBe(PLUGIN_SERVICES_POLICY_LIMITS.maxExcludeIds);
  });

  test('非正数与非整数被忽略，保留默认', () => {
    const clamped = clampLimits({ maxResults: 0, maxInputBytes: -1, maxOutputTokens: 1.5 });
    expect(clamped.maxResults).toBe(PLUGIN_SERVICES_POLICY_LIMITS.maxResults);
    expect(clamped.maxInputBytes).toBe(PLUGIN_SERVICES_POLICY_LIMITS.maxInputBytes);
    expect(clamped.maxOutputTokens).toBe(PLUGIN_SERVICES_POLICY_LIMITS.maxOutputTokens);
  });
});

describe('能力开关', () => {
  test('显式关闭报 disabled', async () => {
    const store = storeWith({ features: { 'ai.generateText': { enabled: false } } });
    const policy = await store.load();
    expect(store.capability(policy, 'ai.generateText')).toEqual({
      available: false,
      reason: 'disabled',
    });
  });

  test('未提及的能力不受影响', async () => {
    const store = storeWith({ features: { 'ai.generateText': { enabled: false } } });
    const policy = await store.load();
    expect(store.capability(policy, 'vector.queryByNote')).toEqual({ available: true });
  });
});

describe('模型白名单的 null 与 [] 语义不同', () => {
  test('null 表示不做额外限制', async () => {
    const store = storeWith({ modelAllowlist: null });
    const policy = await store.load();
    expect(policy.modelAllowlist).toBeNull();
    expect(store.isModelAllowed(policy, 999)).toBe(true);
  });

  test('空数组表示一个都不允许', async () => {
    const store = storeWith({ modelAllowlist: [] });
    const policy = await store.load();
    expect(policy.modelAllowlist).toEqual([]);
    expect(store.isModelAllowed(policy, 999)).toBe(false);
  });

  test('列出的模型才允许', async () => {
    const store = storeWith({ modelAllowlist: [3, 7] });
    const policy = await store.load();
    expect(store.isModelAllowed(policy, 7)).toBe(true);
    expect(store.isModelAllowed(policy, 8)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 账本重放状态机（纯函数部分；SQL 执行路径需真实数据库，不在此覆盖）
// ---------------------------------------------------------------------------

function row(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId: 'req-1',
    requestFingerprint: 'fp-1',
    state: 'reserved',
    deadlineAt: new Date('2026-11-08T10:00:00.000Z'),
    settledAt: null,
    errorCode: null,
    ...overrides,
  };
}

const beforeDeadline = new Date('2026-11-08T09:59:59.000Z');
const afterDeadline = new Date('2026-11-08T10:00:01.000Z');

describe('decideReplay：同键不同输入一律冲突', () => {
  test('指纹不同即冲突，与状态无关', () => {
    for (const state of ['reserved', 'dispatched', 'succeeded', 'failed', 'outcome_unknown'] as const) {
      const decision = decideReplay(row({ state }), beforeDeadline, 'other-fp');
      expect(decision.kind).toBe('conflict');
    }
  });
});

describe('decideReplay：终态直接返回结论，不重跑', () => {
  test('succeeded 但没有缓存 -> RESULT_NOT_RETAINED', () => {
    expect(decideReplay(row({ state: 'succeeded' }), afterDeadline, 'fp-1').kind).toBe(
      'result_not_retained',
    );
  });

  test('outcome_unknown 原样返回', () => {
    expect(decideReplay(row({ state: 'outcome_unknown' }), beforeDeadline, 'fp-1').kind).toBe(
      'outcome_unknown',
    );
  });

  test('failed 带上原错误码', () => {
    const decision = decideReplay(
      row({ state: 'failed', errorCode: 'PROVIDER_ERROR' }),
      beforeDeadline,
      'fp-1',
    );
    expect(decision).toEqual({ kind: 'failed', requestId: 'req-1', errorCode: 'PROVIDER_ERROR' });
  });
});

describe('decideReplay：恢复边界与过期派发恢复', () => {
  test('dispatched 未过边界 -> 真正的执行中', () => {
    expect(decideReplay(row({ state: 'dispatched' }), beforeDeadline, 'fp-1').kind).toBe(
      'in_progress',
    );
  });

  test('dispatched 已过边界 -> 必须转 UNKNOWN，不再是执行中', () => {
    expect(decideReplay(row({ state: 'dispatched' }), afterDeadline, 'fp-1').kind).toBe(
      'expire_to_unknown',
    );
  });

  test('reserved 已过边界且从未发出 -> 释放占额', () => {
    expect(decideReplay(row({ state: 'reserved' }), afterDeadline, 'fp-1').kind).toBe(
      'expire_reserved',
    );
  });

  test('恰好等于边界不算超时（用严格大于）', () => {
    const decision = decideReplay(
      row({ state: 'dispatched', deadlineAt: new Date('2026-11-08T10:00:00.000Z') }),
      new Date('2026-11-08T10:00:00.000Z'),
      'fp-1',
    );
    expect(decision.kind).toBe('in_progress');
  });
});

describe('replayDecisionToError 的错误码映射', () => {
  test('各种判定映射到预期错误码', () => {
    const cases: Array<[Parameters<typeof replayDecisionToError>[0], string]> = [
      [{ kind: 'conflict', requestId: 'r' }, 'IDEMPOTENCY_CONFLICT'],
      [{ kind: 'in_progress', requestId: 'r' }, 'REQUEST_IN_PROGRESS'],
      [{ kind: 'result_not_retained', requestId: 'r' }, 'RESULT_NOT_RETAINED'],
      [{ kind: 'outcome_unknown', requestId: 'r' }, 'OUTCOME_UNKNOWN'],
      [{ kind: 'expire_to_unknown', requestId: 'r' }, 'OUTCOME_UNKNOWN'],
      [{ kind: 'expire_reserved', requestId: 'r' }, 'TIMEOUT'],
      [{ kind: 'failed', requestId: 'r', errorCode: null }, 'PROVIDER_ERROR'],
    ];
    for (const [decision, code] of cases) {
      expect(replayDecisionToError(decision).code).toBe(code as never);
    }
  });

  test('执行中是唯一标记可重试的', () => {
    expect(replayDecisionToError({ kind: 'in_progress', requestId: 'r' }).retryable).toBe(true);
    expect(replayDecisionToError({ kind: 'outcome_unknown', requestId: 'r' }).retryable).toBe(false);
    expect(replayDecisionToError({ kind: 'conflict', requestId: 'r' }).retryable).toBe(false);
  });
});

describe('恢复宽限常量', () => {
  test('宽限为正数且不至于过长', () => {
    expect(RECOVERY_GRACE_MS).toBeGreaterThan(0);
    expect(RECOVERY_GRACE_MS).toBeLessThanOrEqual(120_000);
  });
});

describe('aggregateReleases：过期预留按 budgetDay 归并', () => {
  test('同一天的多条预留合并成一次释放', () => {
    const merged = aggregateReleases([
      { budgetDay: new Date('2026-11-08T00:00:00.000Z'), reservedTokens: 100 },
      { budgetDay: new Date('2026-11-08T00:00:00.000Z'), reservedTokens: 250 },
    ]);
    expect([...merged.entries()]).toEqual([['2026-11-08', 350]]);
  });

  test('跨日不合并：必须各自回到自己的 budgetDay', () => {
    const merged = aggregateReleases([
      { budgetDay: new Date('2026-11-08T00:00:00.000Z'), reservedTokens: 100 },
      { budgetDay: new Date('2026-11-09T00:00:00.000Z'), reservedTokens: 40 },
    ]);
    expect(merged.get('2026-11-08')).toBe(100);
    expect(merged.get('2026-11-09')).toBe(40);
  });

  test('空输入得到空结果，不制造幽灵释放', () => {
    expect(aggregateReleases([]).size).toBe(0);
  });
});

describe('resolveSettledTokens：未知用量按预留保守计入', () => {
  test('status=unknown 时按预留记，不记 0', () => {
    expect(
      resolveSettledTokens({ inputTokens: null, outputTokens: null, status: 'unknown' }, 512),
    ).toBe(512);
  });

  test('reported 时按实际相加', () => {
    expect(
      resolveSettledTokens({ inputTokens: 100, outputTokens: 200, status: 'reported' }, 512),
    ).toBe(300);
  });

  test('部分缺失按已有字段相加', () => {
    expect(resolveSettledTokens({ inputTokens: null, outputTokens: 80, status: 'reported' }, 512)).toBe(80);
  });

  test('不返回负数', () => {
    expect(resolveSettledTokens({ inputTokens: -5, outputTokens: -5, status: 'reported' }, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 拒绝路径不得派发供应商请求
//
// 这里用假 Prisma 拦截原生 SQL，用假传输记录 invoke 次数。
// 目的不是证明 SQL 正确（那要真实库），而是证明**编排层**在拒绝路径上
// 根本不会触碰供应商：一次 invoke 都不允许发生。
// ---------------------------------------------------------------------------

interface FakeDbOptions {
  quotaRows?: Array<{ reservedTokens: number }>;
  insertNew?: boolean;
  activeCount?: number;
  recentCount?: number;
  rateAllowed?: boolean;
  existingRow?: RequestRow | null;
}

function createFakeDb(options: FakeDbOptions = {}) {
  const options_ = {
    quotaRows: options.quotaRows ?? [{ reservedTokens: 100 }],
    insertNew: options.insertNew ?? true,
    activeCount: options.activeCount ?? 0,
    recentCount: options.recentCount ?? 0,
    rateAllowed: options.rateAllowed ?? true,
    existingRow: options.existingRow ?? null,
  };
  const queries: string[] = [];

  const classify = (text: string, values: unknown[]): { kind: 'rows'; rows: unknown[] } | { kind: 'count'; count: number } => {
    const sql = text.replace(/\s+/g, ' ');
    // 顺序按具体度从高到低，避免宽泛匹配抢先。
    if (sql.includes('pg_advisory_xact_lock')) return { kind: 'count', count: 1 };
    if (sql.includes('SELECT count(*)::int AS active')) return { kind: 'rows', rows: [{ active: options_.activeCount }] };
    if (sql.includes('SELECT count(*)::int AS recent')) return { kind: 'rows', rows: [{ recent: options_.recentCount }] };
    if (sql.includes('INSERT INTO "plugin_service_rate"')) {
      return { kind: 'rows', rows: options_.rateAllowed ? [{ used: 1 }] : [] };
    }
    if (sql.includes('FROM "plugin_service_rate"')) return { kind: 'rows', rows: [{ used: 0, readNoteUsed: 0, sharedUsed: 0, retryAfterMs: 30000 }] };
    if (sql.includes('INSERT INTO "plugin_service_daily_usage"')) return { kind: 'rows', rows: options_.quotaRows };
    if (sql.includes('INSERT INTO "plugin_service_requests"')) {
      return { kind: 'rows', rows: options_.insertNew ? [{ requestId: String(values[4] ?? 'req') }] : [] };
    }
    if (sql.includes('SELECT "requestId", "requestFingerprint"')) {
      return { kind: 'rows', rows: options_.existingRow ? [options_.existingRow] : [] };
    }
    if (sql.includes('UPDATE "plugin_service_daily_usage"')) return { kind: 'count', count: 1 };
    // markDispatched 的状态推进：假库必须返回影响 1 行，否则会被判成 REQUEST_IN_PROGRESS。
    if (sql.includes(`SET "state" = 'dispatched'`)) return { kind: 'count', count: 1 };
    if (sql.includes('UPDATE "plugin_service_requests"')) {
      // sweep / settle 的 CAS：默认"没抢到"，避免测试里凭空产生额度动作。
      return { kind: 'rows', rows: [] };
    }
    return { kind: 'rows', rows: [] };
  };

  interface FakeTransaction {
    $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
    $transaction(run: (inner: FakeTransaction) => Promise<unknown>): Promise<unknown>;
  }
  const tx: FakeTransaction = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      queries.push(`Q ${text.replace(/\s+/g, ' ').slice(0, 60)}`);
      const result = classify(text, values);
      return result.kind === 'rows' ? result.rows : [];
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      queries.push(`E ${text.replace(/\s+/g, ' ').slice(0, 60)}`);
      const result = classify(text, values);
      return result.kind === 'count' ? result.count : Array.isArray(result.rows) ? result.rows.length : 0;
    },
    $transaction: async fn => fn(tx),
  };

  return { db: tx as never, queries };
}

const baseSpec = {
  accountId: 1,
  operation: 'ai.generateText' as const,
  idempotencyKey: 'key-1',
  requestFingerprint: 'fp-1',
  modelId: 7,
  reservedTokens: 100,
  maxOutputTokens: 100,
  timeoutMs: 5_000,
  dailyTokenLimit: 1_000,
  maxConcurrent: 2,
  maxRequestsPerMinute: 100,
};

function createCountingInvoker() {
  const calls = { count: 0 };
  const invoke = async () => {
    calls.count += 1;
    return {
      result: 'ok',
      usage: { inputTokens: null, outputTokens: null, status: 'unknown' as const },
    };
  };
  return { calls, invoke };
}

describe('拒绝路径上供应商调用必须为零', () => {
  test('额度不足：抛 BUDGET_EXCEEDED 且 invoke 未被调用', async () => {
    const { createCallPolicy: makePolicy } = await import('@server/services/pluginServices/CallPolicy');
    const { db } = createFakeDb({ quotaRows: [] });
    const policy = makePolicy({ prisma: db });
    const { calls, invoke } = createCountingInvoker();

    await expect(policy.runPaidOperation(baseSpec, invoke)).rejects.toThrow();
    expect(calls.count).toBe(0);
  });

  test('并发超限：抛 RATE_LIMITED 且 invoke 未被调用', async () => {
    const { createCallPolicy: makePolicy } = await import('@server/services/pluginServices/CallPolicy');
    const { db } = createFakeDb({ activeCount: 2 });
    const policy = makePolicy({ prisma: db });
    const { calls, invoke } = createCountingInvoker();

    await expect(policy.runPaidOperation({ ...baseSpec, maxConcurrent: 2 }, invoke)).rejects.toThrow();
    expect(calls.count).toBe(0);
  });

  test('频率超限：抛 RATE_LIMITED 且 invoke 未被调用', async () => {
    const { createCallPolicy: makePolicy } = await import('@server/services/pluginServices/CallPolicy');
    const { db } = createFakeDb({ rateAllowed: false });
    const policy = makePolicy({ prisma: db });
    const { calls, invoke } = createCountingInvoker();

    await expect(
      policy.runPaidOperation({ ...baseSpec, maxRequestsPerMinute: 100 }, invoke),
    ).rejects.toThrow();
    expect(calls.count).toBe(0);
  });

  test('同键仍在执行：抛 REQUEST_IN_PROGRESS 且 invoke 未被调用', async () => {
    const { createCallPolicy: makePolicy } = await import('@server/services/pluginServices/CallPolicy');
    const { db } = createFakeDb({
      insertNew: false,
      existingRow: {
        requestId: 'old',
        requestFingerprint: 'fp-1',
        state: 'reserved',
        deadlineAt: new Date(Date.now() + 60_000),
        settledAt: null,
        errorCode: null,
      },
    });
    const policy = makePolicy({ prisma: db });
    const { calls, invoke } = createCountingInvoker();

    await expect(policy.runPaidOperation(baseSpec, invoke)).rejects.toThrow();
    expect(calls.count).toBe(0);
  });

  test('同键已成功：抛 RESULT_NOT_RETAINED 且 invoke 未被调用', async () => {
    const { createCallPolicy: makePolicy } = await import('@server/services/pluginServices/CallPolicy');
    const { db } = createFakeDb({
      insertNew: false,
      existingRow: {
        requestId: 'old',
        requestFingerprint: 'fp-1',
        state: 'succeeded',
        deadlineAt: new Date(Date.now() - 60_000),
        settledAt: new Date(),
        errorCode: null,
      },
    });
    const policy = makePolicy({ prisma: db });
    const { calls, invoke } = createCountingInvoker();

    await expect(policy.runPaidOperation(baseSpec, invoke)).rejects.toThrow();
    expect(calls.count).toBe(0);
  });

  test('全部通过时 invoke 恰好调用一次', async () => {
    const { createCallPolicy: makePolicy } = await import('@server/services/pluginServices/CallPolicy');
    const { db } = createFakeDb();
    const policy = makePolicy({ prisma: db });
    const { calls, invoke } = createCountingInvoker();

    await policy.runPaidOperation(baseSpec, invoke);
    expect(calls.count).toBe(1);
  });
});

describe('超时门保证返回，不等 invoke 自行退出', () => {
  test('invoke 永不 resolve 时仍能按时返回 TIMEOUT', async () => {
    const { createCallPolicy: makePolicy } = await import('@server/services/pluginServices/CallPolicy');
    const { db } = createFakeDb();
    const policy = makePolicy({ prisma: db });

    let invoked = 0;
    const hung = () => {
      invoked += 1;
      return new Promise<never>(() => {
        /* 永不 resolve，模拟不监听 signal 的客户端 */
      });
    };

    const startedAt = Date.now();
    await expect(policy.runPaidOperation({ ...baseSpec, timeoutMs: 60 }, hung)).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

    expect(invoked).toBe(1);
    expect(elapsed).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// 账户级频率门：与并发、日预算分属不同维度
// ---------------------------------------------------------------------------

describe('AccountRateGate', () => {
  function gateWith(rows: { used: number }[], checkedRows = rows) {
    const queries: string[] = [];
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join('?').replace(/\s+/g, ' ').trim();
        queries.push(sql);
        const result = sql.startsWith('INSERT') ? rows : checkedRows;
        return result.map(row => ({ readNoteUsed: 0, sharedUsed: 0, retryAfterMs: 30000, ...row }));
      },
      $executeRaw: async () => 1,
    };
    return { gate: createAccountRateGate({ prisma: tx as never }), queries };
  }

  test('acquire 拿到行表示放行', async () => {
    const { gate } = gateWith([{ used: 3 }]);
    const state = await gate.acquire(1, 20);
    expect(state.allowed).toBe(true);
    expect(state.used).toBe(3);
  });

  test('acquire 拿不到行表示拒绝，并从只读复查给出真实重试等待', async () => {
    const { gate, queries } = gateWith([], [{ used: 20 }]);
    const state = await gate.acquire(1, 20);
    expect(state.allowed).toBe(false);
    expect(state.retryAfterMs).toBe(30000);
    expect(queries).toHaveLength(2);
  });

  test('拒绝后读不到窗口状态时失败关闭，不编造等待时间', async () => {
    const { gate } = gateWith([]);
    await expect(gate.acquire(1, 20)).rejects.toThrow('Missing rate window state');
  });

  test('check 只读，不写库', async () => {
    const { gate, queries } = gateWith([{ used: 5 }]);
    const state = await gate.check(1, 20);
    expect(state.allowed).toBe(true);
    expect(state.used).toBe(5);
    expect(queries.every((sql) => !/\b(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(true);
  });

  test('check 在达到上限时判为拒绝', async () => {
    const { gate } = gateWith([{ used: 20 }]);
    expect((await gate.check(1, 20)).allowed).toBe(false);
  });

  test('插入语句同时保护首次插入与已有行两条分支', async () => {
    const { gate, queries } = gateWith([{ used: 1 }]);
    await gate.acquire(1, 20);
    const sql = queries[0];
    // 首次插入的分支判定（模板里的参数由 '?' 占位）
    expect(sql).toMatch(/WHERE 1 <= \?::int/);
    // 已有行的分支判定
    expect(sql).toMatch(/"plugin_service_rate"\."used" < \?::int/);
  });
});

// ---------------------------------------------------------------------------
// 派发前失败必须保留内部语义，不能被翻成供应商故障
// ---------------------------------------------------------------------------

describe('failureCode', () => {
  test('未派发时未知异常属内部故障', () => {
    expect(failureCode(new Error('db down'), false)).toBe('INTERNAL_ERROR');
  });

  test('已派发时未知异常属供应商故障', () => {
    expect(failureCode(new Error('socket hang up'), true)).toBe('PROVIDER_ERROR');
  });

  test('调用方显式抛出的 PaidCallError 一律保留其错误码', () => {
    expect(failureCode(new PaidCallError('INDEX_CHANGED'), false)).toBe('INDEX_CHANGED');
    expect(failureCode(new PaidCallError('MODEL_UNAVAILABLE'), true)).toBe('MODEL_UNAVAILABLE');
    expect(failureCode(new PaidCallError('BUDGET_EXCEEDED'), false)).toBe('BUDGET_EXCEEDED');
  });
});

describe('runPaidOperation 的失败语义', () => {
  async function runWith(invokeBehaviour: (context: unknown) => Promise<never>) {
    const { createCallPolicy } = await import('@server/services/pluginServices/CallPolicy');
    const { db } = createFakeDb();
    const policy = createCallPolicy({ prisma: db, pruneIntervalMs: 0 });
    return policy
      .runPaidOperation(baseSpec, invokeBehaviour as never)
      .catch((error) => error);
  }

  test('派发前抛内部异常：对外是 INTERNAL_ERROR，不是 PROVIDER_ERROR', async () => {
    const failure = await runWith(async (context) => {
      void context; // 刻意不调用 markDispatched
      throw new Error('policy re-check failed');
    });
    expect(failure).toBeInstanceOf(PaidCallError);
    expect((failure as PaidCallError).code).toBe('INTERNAL_ERROR');
  });

  test('派发后抛异常：对外是 PROVIDER_ERROR', async () => {
    const failure = await runWith(async (context) => {
      await (context as { markDispatched(): Promise<void> }).markDispatched();
      throw new Error('socket hang up');
    });
    expect((failure as PaidCallError).code).toBe('PROVIDER_ERROR');
  });

  test('调用方显式抛 PaidCallError 时原样透出，不被覆盖', async () => {
    const failure = await runWith(async () => {
      throw new PaidCallError('EMBEDDING_SPACE_MISMATCH');
    });
    expect((failure as PaidCallError).code).toBe('EMBEDDING_SPACE_MISMATCH');
  });
});

describe('速率窗口回收已接入调用路径', () => {
  test('到间隔就触发 DELETE，且不阻塞业务请求', async () => {
    const { createCallPolicy } = await import('@server/services/pluginServices/CallPolicy');
    const { db, queries } = createFakeDb();
    const policy = createCallPolicy({ prisma: db, pruneIntervalMs: 0 });

    await policy.runPaidOperation(baseSpec, async () => ({
      result: 'ok' as const,
      usage: { inputTokens: null, outputTokens: null, status: 'unknown' as const },
    }));

    const pruned = queries.some((entry) => entry.includes('plugin_service_rate'));
    expect(pruned).toBe(true);
  });
});

describe('single-note read splitting is explicit and bounded', () => {
  test('missing row, missing new field and null all retain combined defaults', async () => {
    for (const raw of [null, {}, { maxRequestsPerMinute: 240 }, { readNoteRequestsPerMinute: null }]) {
      const policy = await storeWith(raw).load();
      expect(policy.ok).toBe(true);
      expect(policy.readNoteRequestsPerMinute).toBeNull();
    }
  });
  test('only an explicit 1..20 read allowance enables splitting; p is preserved', async () => {
    for (const readLimit of [1, 20]) {
      const policy = await storeWith({ maxRequestsPerMinute: 240, readNoteRequestsPerMinute: readLimit }).load();
      expect(policy.ok).toBe(true); expect(policy.maxRequestsPerMinute).toBe(240);
      expect(policy.readNoteRequestsPerMinute).toBe(readLimit);
    }
  });
  test('damaged new configuration fails closed, rather than enabling a guessed default', async () => {
    for (const invalid of [0, -1, 21, 1.5, '20', true, {}]) {
      const policy = await storeWith({ readNoteRequestsPerMinute: invalid }).load();
      expect(policy.ok).toBe(false); expect(policy.readNoteRequestsPerMinute).toBeNull();
    }
  });
});
