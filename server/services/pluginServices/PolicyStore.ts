/**
 * 插件服务 · 管理员策略读取与生效
 *
 * 为什么带一个注入式数据源：
 *  1. 策略读取按结构化行注入，避免绑定某一生成客户端的模型类型；
 *  2. 单测可以不碰数据库，直接把行喂进来；
 *  3. 宿主接线只有一行：`createPolicyStore({ read: () => prisma.pluginServicePolicy.findFirst() })`。
 *
 * 生效原则（管理员可配，当前不新增管理页面）：
 *  - 策略值是**上限**，不是覆盖值：实际生效取 min(策略值, 代码默认值)；
 *  - 策略缺失 = 未配置，按默认值正常工作；
 *  - 策略内容损坏 = 无法判断管理员意图，**一律按 not-configured 关闭服务**，
 *    不猜、不放行。损坏的配置放行等于把管理员想关掉的能力重新打开。
 */

import { z } from 'zod';
import {
  PLUGIN_SERVICES_POLICY_LIMITS,
  type CapabilityState,
  type PluginServiceFeature,
  type ServicesLimits,
} from '@shared/lib/pluginServices/v1';

// ---------------------------------------------------------------------------
// 存储行形状（与 Prisma 模型 pluginServicePolicy 对应）
// ---------------------------------------------------------------------------

export interface RawPolicyRow {
  limits?: unknown;
  features?: unknown;
  modelAllowlist?: unknown;
  dailyTokenBudget?: unknown;
  maxRequestsPerMinute?: unknown;
  readNoteRequestsPerMinute?: unknown;
}

/** 宿主提供的最小读取面。`read()` 返回 null 表示没有配置过策略。 */
export interface PolicyRowSource {
  read(): Promise<RawPolicyRow | null>;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

const featureStateSchema = z.strictObject({
  enabled: z.boolean(),
  reason: z.string().max(200).optional(),
});

const featuresSchema = z.record(z.string(), featureStateSchema);

const limitsSchema = z
  .strictObject({
    maxResults: z.number().int().positive().optional(),
    maxExcludeIds: z.number().int().positive().optional(),
    maxInputBytes: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    maxConcurrentGeneration: z.number().int().positive().optional(),
  })
  .partial();

const policySchema = z.strictObject({
  limits: limitsSchema.optional(),
  features: featuresSchema.optional(),
  modelAllowlist: z.array(z.number().int().positive()).nullable().optional(),
  dailyTokenBudget: z.number().int().positive().optional(),
  maxRequestsPerMinute: z.number().int().positive().optional(),
  readNoteRequestsPerMinute: z.number().int().min(1).max(20).nullable().optional(),
});

/**
 * 账户每日 token 预算。这是"每日总量"，与 `limits.maxOutputTokens`（单次输出上限）
 * 不是同一维度，不能相乘凑出来。管理员可在策略里调整，但不能超过硬上限。
 */
export const DEFAULT_DAILY_TOKEN_BUDGET = 200_000;

/** 账户每分钟新增请求上限。与并发上限是两个维度，不能互相替代。 */
export const DEFAULT_REQUESTS_PER_MINUTE = 20;
export const MAX_REQUESTS_PER_MINUTE = 240;
export const MAX_DAILY_TOKEN_BUDGET = 5_000_000;

export function clampRequestsPerMinute(stored: number | undefined): number {
  if (typeof stored !== 'number' || !Number.isInteger(stored) || stored <= 0) {
    return DEFAULT_REQUESTS_PER_MINUTE;
  }
  return Math.min(stored, MAX_REQUESTS_PER_MINUTE);
}

export function clampDailyTokenBudget(stored: number | undefined): number {
  if (typeof stored !== 'number' || !Number.isInteger(stored) || stored <= 0) {
    return DEFAULT_DAILY_TOKEN_BUDGET;
  }
  return Math.min(stored, MAX_DAILY_TOKEN_BUDGET);
}

export type StoredPolicy = z.infer<typeof policySchema>;

// ---------------------------------------------------------------------------
// 解析结果
// ---------------------------------------------------------------------------

export type PolicyProblem = 'invalid';

export interface ResolvedPolicy {
  /**
   * false 表示策略内容损坏、无法判断管理员意图。
   * 此时所有能力都必须报 not-configured，不得回落默认值继续提供。
   */
  ok: boolean;
  problem?: PolicyProblem;
  /** 已按 min(策略, 默认) 钳制并填充默认值的生效限值。 */
  limits: ServicesLimits;
  /** 被管理员显式关闭的能力。未出现在这里的按"未额外限制"处理。 */
  features: Partial<Record<PluginServiceFeature, { enabled: boolean; reason?: string }>>;
  /** null 表示不做额外模型限制；[] 表示一个都不允许。两者语义不同。 */
  modelAllowlist: number[] | null;
  /** 账户每日 token 总量预算（与单次输出上限不同维度）。 */
  dailyTokenBudget: number;
  /** 账户每分钟新增请求上限（与并发上限不同维度）。 */
  maxRequestsPerMinute: number;
  /** null preserves combined admission. An explicit 1..20 enables a separate read lane. */
  readNoteRequestsPerMinute: number | null;
}

const DEFAULT_POLICY: ResolvedPolicy = Object.freeze({
  ok: true,
  limits: { ...PLUGIN_SERVICES_POLICY_LIMITS },
  features: {},
  modelAllowlist: null,
  dailyTokenBudget: DEFAULT_DAILY_TOKEN_BUDGET,
  maxRequestsPerMinute: DEFAULT_REQUESTS_PER_MINUTE,
  readNoteRequestsPerMinute: null,
}) as ResolvedPolicy;

/** 无效策略的统一结果：ok=false，限值仍取默认以便响应结构稳定。 */
function invalidPolicy(): ResolvedPolicy {
  return {
    ok: false,
    problem: 'invalid',
    limits: { ...PLUGIN_SERVICES_POLICY_LIMITS },
    features: {},
    modelAllowlist: null,
    dailyTokenBudget: DEFAULT_DAILY_TOKEN_BUDGET,
    maxRequestsPerMinute: DEFAULT_REQUESTS_PER_MINUTE,
    readNoteRequestsPerMinute: null,
  };
}

// ---------------------------------------------------------------------------
// 钳制
// ---------------------------------------------------------------------------

const LIMIT_KEYS = [
  'maxResults',
  'maxExcludeIds',
  'maxInputBytes',
  'maxOutputTokens',
  'maxConcurrentGeneration',
] as const;

type LimitKey = (typeof LIMIT_KEYS)[number];

/**
 * 生效限值 = min(策略值, 代码默认值)。
 * 管理员可以调低，但不能把上限抬到代码硬边界之外——否则一次手误就能让
 * 服务端接受超出设计容量的请求，而这类问题只会在压力下暴露。
 */
export function clampLimits(stored: Partial<ServicesLimits> | undefined): ServicesLimits {
  const resolved = { ...PLUGIN_SERVICES_POLICY_LIMITS };
  if (!stored) {
    return resolved;
  }
  for (const key of LIMIT_KEYS) {
    const value = stored[key as LimitKey];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      resolved[key] = Math.min(value, PLUGIN_SERVICES_POLICY_LIMITS[key]);
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

export interface PolicyStore {
  /** 读取并解析当前策略。永不抛错：损坏的配置以 ok=false 表达。 */
  load(): Promise<ResolvedPolicy>;
  /** 把策略与模块自身状态合成为能力状态。 */
  capability(resolved: ResolvedPolicy, feature: PluginServiceFeature): CapabilityState;
  /** 按白名单过滤模型 ID；null 表示不过滤。 */
  isModelAllowed(resolved: ResolvedPolicy, modelId: number): boolean;
}

export function createPolicyStore(source: PolicyRowSource): PolicyStore {
  return {
    async load(): Promise<ResolvedPolicy> {
      let row: RawPolicyRow | null;
      try {
        row = await source.read();
      } catch {
        // 读不到策略不等于没有策略：可能是数据库故障。按无法判断处理，失败即关闭。
        return invalidPolicy();
      }
      if (!row) {
        return { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits }, features: {} };
      }

      const parsed = policySchema.safeParse({
        limits: row.limits ?? undefined,
        features: row.features ?? undefined,
        modelAllowlist: row.modelAllowlist ?? undefined,
        dailyTokenBudget: row.dailyTokenBudget ?? undefined,
        maxRequestsPerMinute: row.maxRequestsPerMinute ?? undefined,
        readNoteRequestsPerMinute: row.readNoteRequestsPerMinute,
      });
      if (!parsed.success) {
        return invalidPolicy();
      }

      const features: ResolvedPolicy['features'] = {};
      for (const [key, value] of Object.entries(parsed.data.features ?? {})) {
        features[key as PluginServiceFeature] = {
          enabled: value.enabled,
          ...(value.reason ? { reason: value.reason } : {}),
        };
      }

      return {
        ok: true,
        limits: clampLimits(parsed.data.limits),
        features,
        modelAllowlist: parsed.data.modelAllowlist ?? null,
        dailyTokenBudget: clampDailyTokenBudget(parsed.data.dailyTokenBudget),
        maxRequestsPerMinute: clampRequestsPerMinute(parsed.data.maxRequestsPerMinute),
        readNoteRequestsPerMinute: parsed.data.readNoteRequestsPerMinute ?? null,
      };
    },

    capability(resolved: ResolvedPolicy, feature: PluginServiceFeature): CapabilityState {
      if (!resolved.ok) {
        return { available: false, reason: 'not-configured' };
      }
      const state = resolved.features[feature];
      if (state && !state.enabled) {
        return { available: false, reason: 'disabled' };
      }
      return { available: true };
    },

    isModelAllowed(resolved: ResolvedPolicy, modelId: number): boolean {
      if (!resolved.ok) {
        return false;
      }
      if (resolved.modelAllowlist === null) {
        return true;
      }
      return resolved.modelAllowlist.includes(modelId);
    },
  };
}

/** 测试与调用方用的默认值快照，避免各自复制一份数字。 */
export function defaultPolicyLimits(): ServicesLimits {
  return { ...PLUGIN_SERVICES_POLICY_LIMITS };
}
