/**
 * 插件服务 · AI 子路由
 *
 * 根路由把 `ai: aiRouter` 合并进 `pluginServicesRouter`，并把
 * `describeAiFeatures()` 的结果传给 `describeServices({ ai })`。
 *
 * 所有 procedure 都用服务专用工厂 `serviceProcedure`，鉴权随 procedure 生效，
 * 不依赖"根路由只 merge 一次"这种结构约定当安全保证。
 */

import type { CapabilityState } from '@shared/lib/pluginServices/v1';
import { prisma } from '../../prisma';
import { router } from '../../middleware';
import { serviceProcedure } from './procedure';
import { createPolicyStore } from './PolicyStore';
import { createCallPolicy } from './CallPolicy';
import { createAiGenerationService } from './AiGenerationService';
import type { AiGenerationService, NoteContextProvider } from './AiGenerationService';
import { generateTextInputSchema, resolveAiFeatureStates } from './aiSchemas';
import { hostModelCatalog, hostTextGeneratorFactory } from './HostIndex';

/**
 * 策略以数据库单行为唯一事实来源。这里独立构造一个读取实例，
 * 而不是从根路由 import——那样会形成 pluginServices ↔ aiRouter 的循环依赖，
 * 且模块初始化顺序会影响常量可用性。两个实例读同一行，不存在两份真相。
 */
const policyStore = createPolicyStore({
  read: () => prisma.pluginServicePolicy.findUnique({ where: { id: 1 } }),
});

const callPolicy = createCallPolicy({ prisma });

/**
 * 上下文笔记取正文。逐条鉴权：只返回本账户、未进回收站的笔记；
 * 少一条由上层整体拒绝，不在这里"跳过无权材料继续生成"。
 */
const noteContextProvider: NoteContextProvider = {
  async loadAuthorizedNotes(accountId, noteIds) {
    const rows = await prisma.notes.findMany({
      where: {
        id: { in: [...noteIds] },
        accountId,
        isRecycle: false,
      },
      select: { id: true, content: true },
    });
    return rows.map((row) => ({ id: row.id, content: row.content ?? '' }));
  },
};

export const aiGenerationService: AiGenerationService = createAiGenerationService({
  policyStore,
  callPolicy,
  catalog: hostModelCatalog,
  contextProvider: noteContextProvider,
  generatorFactory: hostTextGeneratorFactory,
});

/**
 * AI 能力状态。根路由把它合并进 capabilities，保证"端点可用"与
 * "能力发现说可用"是同一套判断，不会一处说能用、一处拒绝。
 *
 * 这里只判断配置与策略；瞬时额度（预算/并发/频率）仍由每次调用重新核验，
 * capabilities 不构成预授权。
 */
export async function describeAiFeatures(
  accountId: number,
): Promise<Partial<Record<'ai.listModels' | 'ai.generateText', CapabilityState>>> {
  const policy = await policyStore.load();
  const models = policy.ok ? await hostModelCatalog.listTextModels(accountId) : [];

  return resolveAiFeatureStates({
    listed: policyStore.capability(policy, 'ai.listModels'),
    generate: policyStore.capability(policy, 'ai.generateText'),
    authorizedModelIds: models
      .filter((model) => model.capabilities?.inference === true)
      .map((model) => model.id),
    allowlist: policy.modelAllowlist,
  });
}

export const aiRouter = router({
  listModels: serviceProcedure('ai.listModels').query(async ({ ctx }) =>
    aiGenerationService.listModels(Number(ctx.id)),
  ),

  generateText: serviceProcedure('ai.generateText')
    .input(generateTextInputSchema)
    .mutation(async ({ ctx, input }) =>
      aiGenerationService.generateText(Number(ctx.id), input),
    ),
});
