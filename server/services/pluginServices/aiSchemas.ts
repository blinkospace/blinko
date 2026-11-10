/**
 * 插件服务 · AI 子域输入校验与公共模型 DTO 构造
 *
 * 规则：公共 DTO 一律显式白名单构造，对管理员与普通用户一致；
 * 不复用管理接口的响应形状，也不依赖"删掉 apiKey 字段"式的黑名单。
 */

import { z } from 'zod';
import {
  PLUGIN_SERVICES_DEFAULT_OUTPUT_TOKENS,
  PLUGIN_SERVICES_MAX_CONTEXT_NOTES,
  PLUGIN_SERVICES_MAX_MESSAGES,
  PLUGIN_SERVICES_POLICY_LIMITS,
} from '@shared/lib/pluginServices/v1';
import type { CapabilityState, PublicModel, ServicesLimits } from '@shared/lib/pluginServices/v1';

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

const safeIntSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const chatMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(65_536),
});

function byteLengthOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * 非流式生成的输入。strictObject：未知字段直接拒绝，不静默丢弃——
 * 否则插件写了 `stream: true` 会以为生效了。
 */
export const generateTextInputSchema = z
  .strictObject({
    modelId: z.union([safeIntSchema, z.literal('default')]).optional(),
    system: z.string().max(32_768).optional(),
    messages: z.array(chatMessageSchema).min(1).max(PLUGIN_SERVICES_MAX_MESSAGES),
    contextNoteIds: z.array(safeIntSchema).max(PLUGIN_SERVICES_MAX_CONTEXT_NOTES).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z
      .number()
      .int()
      .min(1)
      .max(PLUGIN_SERVICES_POLICY_LIMITS.maxOutputTokens)
      .optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .superRefine((value, ctx) => {
    const bytes = byteLengthOf(value);
    if (bytes > PLUGIN_SERVICES_POLICY_LIMITS.maxInputBytes) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: `input exceeds ${PLUGIN_SERVICES_POLICY_LIMITS.maxInputBytes} bytes`,
      });
    }
  });

export type GenerateTextInputParsed = z.infer<typeof generateTextInputSchema>;

/** 模型目录无入参；显式空对象，拒绝任何多余字段。 */
export const listModelsInputSchema = z.strictObject({}).optional();

/**
 * 未显式指定时套用默认输出上限，并始终受策略上限约束。
 * 服务端预留预算与最终 Provider 参数都走这一个函数，避免两处各算一遍。
 */
export function resolveMaxOutputTokens(requested: number | undefined): number {
  const ceiling = PLUGIN_SERVICES_POLICY_LIMITS.maxOutputTokens;
  const value = requested ?? PLUGIN_SERVICES_DEFAULT_OUTPUT_TOKENS;
  return Math.min(value, ceiling);
}

// ---------------------------------------------------------------------------
// 公共模型 DTO（白名单构造）
// ---------------------------------------------------------------------------

/** 公共模型 DTO 允许出现的顶层字段，测试以此做"允许字段集"断言。 */
export const PUBLIC_MODEL_KEYS = [
  'id',
  'name',
  'providerLabel',
  'isDefault',
  'capabilities',
] as const;

/** capabilities 子对象允许出现的字段。 */
export const PUBLIC_MODEL_CAPABILITY_KEYS = [
  'text',
  'streaming',
  'structuredOutput',
] as const;

/**
 * 构造公共 DTO 所需的最小结构化输入。
 * 故意不引用 Prisma 生成类型，避免公共构造器被 schema 变更拖着走。
 */
export interface AuthorizedModelRecord {
  id: number;
  /** 宿主展示名，来自 aiModels.title。 */
  title: string;
  /** 供应商展示名，来自 aiProviders.title。 */
  providerLabel: string;
  capabilities: {
    inference?: boolean;
  } | null;
}

/**
 * 构造公共模型 DTO。
 *
 * 能力映射说明（重要，别想当然）：
 *  - 宿主 `ModelCapabilities` 只有 inference/tools/image/... 八个字段，
 *    **没有 streaming 和 structuredOutput**。因此：
 *  - `text` 直接取 `inference`，这是真实已知的；
 *  - `streaming` 恒为 false：V1 不提供流式服务（ai.streamText 不在本轮），
 *    模型层面的流式能力宿主没有记录，不猜测为 true；
 *  - `structuredOutput` 恒为 null：契约规定未确认时为 null，不当 false 也不当 true。
 */
export function toPublicModel(
  record: AuthorizedModelRecord,
  options: { defaultModelId: number | null },
): PublicModel {
  return {
    id: record.id,
    name: record.title,
    providerLabel: record.providerLabel,
    isDefault: options.defaultModelId !== null && options.defaultModelId === record.id,
    capabilities: {
      text: record.capabilities?.inference === true,
      streaming: false,
      structuredOutput: null,
    },
  };
}

/**
 * 只保留具备文字生成能力的模型，并按调用方可见性过滤后构造 DTO。
 * 授权判断在调用方完成；这里只做形状构造。
 */
export function buildPublicModelList(
  records: readonly AuthorizedModelRecord[],
  options: { defaultModelId: number | null },
): PublicModel[] {
  return records
    .filter((record) => record.capabilities?.inference === true)
    .map((record) => toPublicModel(record, options));
}

// ---------------------------------------------------------------------------
// 形状断言（服务端与测试共用，防止内部对象被当 DTO 透出）
// ---------------------------------------------------------------------------

function ownKeysOf(value: object): string[] {
  return Object.keys(value).filter((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true;
  });
}

/**
 * 断言对象键集合恰好等于白名单。
 * 用"等于"而不是"包含"：多出字段即失败，这正是本断言存在的理由。
 */
export function assertPublicModelShape(value: unknown): asserts value is PublicModel {
  if (typeof value !== 'object' || value === null) {
    throw new Error('public model DTO must be an object');
  }
  const keys = ownKeysOf(value).sort();
  const allowed = [...PUBLIC_MODEL_KEYS].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new Error(
      `public model DTO field set mismatch: got [${keys.join(', ')}], allowed [${allowed.join(', ')}]`,
    );
  }
  const capabilities = (value as { capabilities?: unknown }).capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    throw new Error('public model DTO capabilities must be an object');
  }
  const capabilityKeys = ownKeysOf(capabilities).sort();
  const allowedCapabilities = [...PUBLIC_MODEL_CAPABILITY_KEYS].sort();
  if (
    capabilityKeys.length !== allowedCapabilities.length ||
    capabilityKeys.some((key, index) => key !== allowedCapabilities[index])
  ) {
    throw new Error(
      `public model capabilities field set mismatch: got [${capabilityKeys.join(', ')}], allowed [${allowedCapabilities.join(', ')}]`,
    );
  }
}

/** capabilities 中报告的限值，供汇总方（capabilities.ts）直接取用。 */
export function aiPolicyLimits(): ServicesLimits {
  return { ...PLUGIN_SERVICES_POLICY_LIMITS };
}

// ---------------------------------------------------------------------------
// 能力状态汇总
// ---------------------------------------------------------------------------

export type AiFeatureKey = 'ai.listModels' | 'ai.generateText';

/**
 * 把"策略允许"与"确实有可用模型"合成 AI 能力状态。
 *
 * 单独抽成纯函数是为了可测：接线层需要 prisma 与 Provider，单独类型检查会
 * 拉起整张服务端类型图（实测在 4 GiB 处 OOM），而这段判断恰恰是最容易写错的
 * 地方——策略说允许但一个模型都没有时，报 available:true 就是骗调用方。
 */
export function resolveAiFeatureStates(input: {
  listed: CapabilityState;
  generate: CapabilityState;
  authorizedModelIds: readonly number[];
  allowlist: readonly number[] | null;
}): Record<AiFeatureKey, CapabilityState> {
  const hasUsableModel =
    input.authorizedModelIds.length > 0 &&
    (input.allowlist === null ||
      input.authorizedModelIds.some((id) => input.allowlist!.includes(id)));

  const configured: CapabilityState = hasUsableModel
    ? { available: true }
    : { available: false, reason: 'not-configured' };

  return {
    'ai.listModels': input.listed.available ? configured : input.listed,
    'ai.generateText': input.generate.available ? configured : input.generate,
  };
}
