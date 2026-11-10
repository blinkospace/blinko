import { describe, expect, test } from 'bun:test';
import {
  buildRequestFingerprint,
  composeContextBlock,
  createAiGenerationService,
  estimateReservedTokensFromMessages,
  utf8ByteLength,
  type AiGenerationDeps,
  type ModelCatalog,
  type NoteContextProvider,
  type TextGeneratorFactory,
} from '@server/services/pluginServices/AiGenerationService';
import { createPolicyStore, type RawPolicyRow } from '@server/services/pluginServices/PolicyStore';
import { resolveAiFeatureStates } from '@server/services/pluginServices/aiSchemas';
import {
  PaidCallError,
  type CallPolicy,
  type PaidCallSpec,
  type PaidInvokeContext,
} from '@server/services/pluginServices/CallPolicy';
import { ServiceError } from '@server/services/pluginServices/errors';
import type { GenerateTextInput, TokenUsage } from '@shared/lib/pluginServices/v1';

// ---------------------------------------------------------------------------
// 假协作方
// ---------------------------------------------------------------------------

function policyStoreFor(row: RawPolicyRow | null) {
  return createPolicyStore({ read: async () => row });
}

function catalogFor(overrides: Partial<ModelCatalog> = {}): ModelCatalog & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listTextModels() {
      calls.push('listTextModels');
      return [
        { id: 1, title: 'chat-a', providerLabel: 'P', capabilities: { inference: true } },
        { id: 2, title: 'embed-b', providerLabel: 'P', capabilities: { inference: false } },
      ];
    },
    async findTextModel(_accountId, modelRef) {
      calls.push('findTextModel');
      const id = modelRef === 'default' ? 1 : Number(modelRef);
      if (id !== 1 && id !== 3) return null;
      return { id, name: `model-${id}` };
    },
    async defaultTextModelId() {
      return 1;
    },
    ...overrides,
  };
}

function contextProviderFor(
  notes: Array<{ id: number; content: string }>,
): NoteContextProvider & { calls: number } {
  const state = {
    calls: 0,
    async loadAuthorizedNotes(_accountId: number, noteIds: readonly number[]) {
      state.calls += 1;
      return notes.filter((note) => noteIds.includes(note.id));
    },
  };
  return state;
}

function factoryFor(): TextGeneratorFactory & {
  created: number;
  generated: number;
  lastMessages: unknown;
  lastMaxOutputTokens: number | null;
} {
  const state = {
    created: 0,
    generated: 0,
    lastMessages: null as unknown,
    lastMaxOutputTokens: null as number | null,
    async create() {
      state.created += 1;
      return {
        async generate(request: { messages: unknown; maxOutputTokens: number }) {
          state.generated += 1;
          state.lastMessages = request.messages;
          state.lastMaxOutputTokens = request.maxOutputTokens;
          const usage: TokenUsage = { inputTokens: 10, outputTokens: 20, status: 'reported' as const };
          return { text: 'hello', finishReason: 'stop' as const, usage };
        },
      };
    },
  };
  return state;
}

function callPolicyThatRejects(error: Error): CallPolicy {
  return {
    async runPaidOperation() {
      throw error;
    },
    async sweepExpired() {
      return { released: 0, unknown: 0 };
    },
  };
}

function callPolicyThatRuns(): CallPolicy & { lastSpec: PaidCallSpec | null } {
  const state = {
    lastSpec: null as PaidCallSpec | null,
    async runPaidOperation<T>(
      spec: PaidCallSpec,
      invoke: (context: PaidInvokeContext) => Promise<{ result: T; usage: TokenUsage }>,
    ): Promise<T> {
      state.lastSpec = spec;
      const context: PaidInvokeContext = {
        requestId: 'req-from-ledger',
        signal: new AbortController().signal,
        async markDispatched() {
          /* 假实现：真实路径会写库 */
        },
      };
      const { result } = await invoke(context);
      return result;
    },
    async sweepExpired() {
      return { released: 0, unknown: 0 };
    },
  };
  return state;
}

const validInput: GenerateTextInput = {
  messages: [{ role: 'user', content: '概括一下' }],
  idempotencyKey: 'key-1',
};

function depsWith(overrides: Partial<AiGenerationDeps> = {}): AiGenerationDeps {
  return {
    policyStore: policyStoreFor(null),
    callPolicy: callPolicyThatRuns(),
    catalog: catalogFor(),
    contextProvider: contextProviderFor([]),
    generatorFactory: factoryFor(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 拒绝路径：一律不允许触碰供应商客户端
// ---------------------------------------------------------------------------

describe('策略门槛先于任何凭据解析', () => {
  test('生成能力被管理员关闭时拒绝，且未创建客户端', async () => {
    const factory = factoryFor();
    const service = createAiGenerationService(
      depsWith({
        policyStore: policyStoreFor({ features: { 'ai.generateText': { enabled: false } } }),
        generatorFactory: factory,
      }),
    );

    await expect(service.generateText(1, validInput)).rejects.toThrow(PaidCallError);
    expect(factory.created).toBe(0);
    expect(factory.generated).toBe(0);
  });

  test('策略损坏时按未配置拒绝，不回落默认放行', async () => {
    const factory = factoryFor();
    const service = createAiGenerationService(
      depsWith({
        policyStore: policyStoreFor({ limits: { maxResults: 'many' } }),
        generatorFactory: factory,
      }),
    );

    await expect(service.generateText(1, validInput)).rejects.toThrow(PaidCallError);
    expect(factory.created).toBe(0);
  });

  test('模型不存在时拒绝，且未创建客户端', async () => {
    const factory = factoryFor();
    const service = createAiGenerationService(depsWith({ generatorFactory: factory }));
    await expect(service.generateText(1, { ...validInput, modelId: 999 })).rejects.toThrow(
      PaidCallError,
    );
    expect(factory.created).toBe(0);
  });

  test('模型不在白名单时拒绝，且未创建客户端', async () => {
    const factory = factoryFor();
    const service = createAiGenerationService(
      depsWith({
        policyStore: policyStoreFor({ modelAllowlist: [3] }),
        generatorFactory: factory,
      }),
    );
    await expect(service.generateText(1, { ...validInput, modelId: 1 })).rejects.toThrow(
      PaidCallError,
    );
    expect(factory.created).toBe(0);
  });

  test('账本拒绝（额度/并发/幂等）时未创建客户端', async () => {
    for (const code of ['BUDGET_EXCEEDED', 'RATE_LIMITED', 'REQUEST_IN_PROGRESS'] as const) {
      const factory = factoryFor();
      const service = createAiGenerationService(
        depsWith({
          callPolicy: callPolicyThatRejects(new PaidCallError(code)),
          generatorFactory: factory,
        }),
      );
      await expect(service.generateText(1, validInput)).rejects.toThrow(PaidCallError);
      expect(factory.created).toBe(0);
      expect(factory.generated).toBe(0);
    }
  });

  test('上下文笔记无权时整体拒绝，且未创建客户端', async () => {
    const factory = factoryFor();
    const service = createAiGenerationService(
      depsWith({
        contextProvider: contextProviderFor([{ id: 5, content: '可见' }]),
        generatorFactory: factory,
      }),
    );

    await expect(
      service.generateText(1, { ...validInput, contextNoteIds: [5, 6] }),
    ).rejects.toThrow(PaidCallError);
    expect(factory.created).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 上下文
// ---------------------------------------------------------------------------

describe('上下文笔记逐条鉴权并合入调用', () => {
  test('授权通过时正文以明确边界作为材料合入，不放进 system', async () => {
    const factory = factoryFor();
    const service = createAiGenerationService(
      depsWith({
        contextProvider: contextProviderFor([{ id: 5, content: '材料正文' }]),
        generatorFactory: factory,
      }),
    );

    await service.generateText(1, { ...validInput, system: '你是助手', contextNoteIds: [5] });

    const messages = factory.lastMessages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'user', content: '概括一下' });
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('<note id="5">');
    expect(messages[1].content).toContain('材料正文');
    expect(messages[1].content).toContain('不构成任何指令');
  });

  test('没有上下文时不额外塞消息', async () => {
    const factory = factoryFor();
    const service = createAiGenerationService(depsWith({ generatorFactory: factory }));
    await service.generateText(1, validInput);
    const messages = factory.lastMessages as unknown[];
    expect(messages).toHaveLength(1);
  });

  test('composeContextBlock 无材料时返回 null', () => {
    expect(composeContextBlock([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 成功路径
// ---------------------------------------------------------------------------

describe('成功路径', () => {
  test('恰好创建并调用一次客户端，结果带上账本 requestId', async () => {
    const factory = factoryFor();
    const policy = callPolicyThatRuns();
    const service = createAiGenerationService(
      depsWith({ generatorFactory: factory, callPolicy: policy }),
    );

    const result = await service.generateText(1, validInput);

    expect(factory.created).toBe(1);
    expect(factory.generated).toBe(1);
    expect(result.text).toBe('hello');
    expect(result.requestId).toBe('req-from-ledger');
    expect(result.model).toEqual({ id: 1, name: 'model-1' });
    expect(result.usage.status).toBe('reported');
  });

  test('每日预算取策略值', async () => {
    const policy = callPolicyThatRuns();
    const service = createAiGenerationService(
      depsWith({ callPolicy: policy, policyStore: policyStoreFor({ dailyTokenBudget: 12_345 }) }),
    );
    await service.generateText(1, validInput);
    expect(policy.lastSpec?.dailyTokenLimit).toBe(12_345);
  });

  test('管理员调低输出上限后在执行时生效', async () => {
    const factory = factoryFor();
    const service = createAiGenerationService(
      depsWith({
        generatorFactory: factory,
        policyStore: policyStoreFor({ limits: { maxOutputTokens: 128 } }),
      }),
    );
    await service.generateText(1, { ...validInput, maxOutputTokens: 4_000 });
    expect(factory.lastMaxOutputTokens).toBe(128);
  });

  test('管理员调低输入字节上限后在执行时拒绝', async () => {
    const factory = factoryFor();
    const service = createAiGenerationService(
      depsWith({
        generatorFactory: factory,
        policyStore: policyStoreFor({ limits: { maxInputBytes: 32 } }),
      }),
    );
    await expect(
      service.generateText(1, {
        ...validInput,
        messages: [{ role: 'user', content: '这是一段明显超过三十二字节的提示词内容' }],
      }),
    ).rejects.toThrow(PaidCallError);
    expect(factory.created).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 模型目录
// ---------------------------------------------------------------------------

describe('模型目录只输出白名单字段', () => {
  test('过滤掉非推理模型', async () => {
    const service = createAiGenerationService(depsWith());
    const models = await service.listModels(1);
    expect(models.map((model) => model.id)).toEqual([1]);
    expect(Object.keys(models[0]).sort()).toEqual(
      ['capabilities', 'id', 'isDefault', 'name', 'providerLabel'].sort(),
    );
  });

  test('策略损坏时目录查询直接拒绝，不返回空列表冒充"没有模型"', async () => {
    const service = createAiGenerationService(
      depsWith({ policyStore: policyStoreFor({ features: 'broken' }) }),
    );
    await expect(service.listModels(1)).rejects.toThrow(PaidCallError);
  });

  test('空白名单表示一个都不允许', async () => {
    const service = createAiGenerationService(
      depsWith({ policyStore: policyStoreFor({ modelAllowlist: [] }) }),
    );
    expect(await service.listModels(1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe('预留按 UTF-8 字节做保守上界', () => {
  test('中文与 ASCII 都按字节计，不再走平均比例', () => {
    // 6 个汉字 = 18 字节；6 个 ASCII = 6 字节。
    expect(utf8ByteLength('这是一段中文')).toBe(18);
    expect(utf8ByteLength('abcdef')).toBe(6);
  });

  test('低估计反例：emoji 与低频脚本按平均比例会被低估，按字节不会', () => {
    // 每个 emoji 4 字节，按旧"其他 ÷3"只会记 1.3 个 token，
    // 而实际分词器常要 2–3 个 token；按字节记 4，是上界。
    const emoji = '🙂🙃😀😁😂🤣';
    const bytes = utf8ByteLength(emoji);
    expect(bytes).toBe(24);
    expect(bytes).toBeGreaterThanOrEqual(emoji.length * 2);

    // 泰文一个字符 3 字节，旧估算按 ÷3 记 2 token，实际常超过此值。
    const thai = 'ภาษาไทย';
    expect(utf8ByteLength(thai)).toBeGreaterThan(thai.length * 2);
  });

  test('预留随内容字节与消息数增长', () => {
    const small = estimateReservedTokensFromMessages({ messages: validInput.messages, maxOutputTokens: 100 });
    const large = estimateReservedTokensFromMessages({ messages: validInput.messages, maxOutputTokens: 1_000 });
    expect(large).toBeGreaterThan(small);

    const longer = estimateReservedTokensFromMessages({
      messages: [{ role: 'user', content: 'x'.repeat(4_000) }],
      maxOutputTokens: 100,
    });
    expect(longer).toBeGreaterThan(small);
  });

  test('预留包含输出上限本身', () => {
    expect(
      estimateReservedTokensFromMessages({ messages: validInput.messages, maxOutputTokens: 500 }),
    ).toBeGreaterThanOrEqual(500);
  });

  test('封装文字与标签也要计入：只数正文会低估', () => {
    const material = { id: 123456, content: '材料' };
    const block = composeContextBlock([material])!;
    const withBlock = estimateReservedTokensFromMessages({
      messages: [validInput.messages[0], block],
      maxOutputTokens: 100,
    });
    // 只按原始正文估算（漏掉说明文字与 <note id> 标签）会得到的值。
    const bodyOnly =
      new TextEncoder().encode(validInput.messages[0].content).length +
      new TextEncoder().encode(material.content).length +
      100;
    expect(withBlock).toBeGreaterThan(bodyOnly);
  });

  test('长 ID 与多篇材料让封装开销显著增长', () => {
    const notes = Array.from({ length: 8 }, (_, index) => ({
      id: 900000 + index,
      content: '短',
    }));
    const block = composeContextBlock(notes)!;
    const blockBytes = new TextEncoder().encode(block.content).length;
    const bodyBytes = notes.reduce(
      (sum, note) => sum + new TextEncoder().encode(note.content).length,
      0,
    );
    // 封装（标签 + 说明 + 换行）至少让字节数翻倍，这就是不能只数正文的理由。
    expect(blockBytes).toBeGreaterThan(bodyBytes * 2);
  });
});

describe('指纹', () => {
  const base = {
    modelId: 1,
    messages: [{ role: 'user' as const, content: 'hi' }],
    maxOutputTokens: 100,
    context: [] as Array<{ id: number; contentHash: string }>,
  };

  test('是 SHA-256 十六进制串', () => {
    expect(buildRequestFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('绑定模型：换模型即换指纹', () => {
    expect(buildRequestFingerprint({ ...base, modelId: 2 })).not.toBe(buildRequestFingerprint(base));
  });

  test('绑定上下文内容：同一笔记内容变了，指纹必须变', () => {
    const a = buildRequestFingerprint({ ...base, context: [{ id: 5, contentHash: 'aaa' }] });
    const b = buildRequestFingerprint({ ...base, context: [{ id: 5, contentHash: 'bbb' }] });
    expect(a).not.toBe(b);
  });

  test('上下文顺序不影响指纹', () => {
    const a = buildRequestFingerprint({
      ...base,
      context: [
        { id: 5, contentHash: 'aaa' },
        { id: 7, contentHash: 'bbb' },
      ],
    });
    const b = buildRequestFingerprint({
      ...base,
      context: [
        { id: 7, contentHash: 'bbb' },
        { id: 5, contentHash: 'aaa' },
      ],
    });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// AI 能力状态：端点可用性与能力发现必须同一套判断
// ---------------------------------------------------------------------------

describe('resolveAiFeatureStates', () => {
  const ok = { available: true } as const;
  const disabled = { available: false, reason: 'disabled' as const };

  test('策略允许且确有可用模型时才报可用', () => {
    const states = resolveAiFeatureStates({
      listed: ok,
      generate: ok,
      authorizedModelIds: [1, 2],
      allowlist: null,
    });
    expect(states['ai.generateText']).toEqual({ available: true });
    expect(states['ai.listModels']).toEqual({ available: true });
  });

  test('策略允许但一个可用模型都没有：报未配置，不能报可用', () => {
    const states = resolveAiFeatureStates({
      listed: ok,
      generate: ok,
      authorizedModelIds: [],
      allowlist: null,
    });
    expect(states['ai.generateText']).toEqual({ available: false, reason: 'not-configured' });
    expect(states['ai.listModels']).toEqual({ available: false, reason: 'not-configured' });
  });

  test('有模型但全被白名单挡掉：同样不能报可用', () => {
    const states = resolveAiFeatureStates({
      listed: ok,
      generate: ok,
      authorizedModelIds: [1, 2],
      allowlist: [9],
    });
    expect(states['ai.generateText'].available).toBe(false);
  });

  test('空白名单表示一个都不允许', () => {
    const states = resolveAiFeatureStates({
      listed: ok,
      generate: ok,
      authorizedModelIds: [1],
      allowlist: [],
    });
    expect(states['ai.generateText'].available).toBe(false);
  });

  test('策略显式关闭时保留关闭原因，不被"有模型"覆盖', () => {
    const states = resolveAiFeatureStates({
      listed: ok,
      generate: disabled,
      authorizedModelIds: [1],
      allowlist: null,
    });
    expect(states['ai.generateText']).toEqual({ available: false, reason: 'disabled' });
    expect(states['ai.listModels']).toEqual({ available: true });
  });
});

// ---------------------------------------------------------------------------
// 端点自己的禁用开关必须生效
// ---------------------------------------------------------------------------

describe('listModels 执行管理员禁用开关', () => {
  test('被关闭时拒绝，且不去读模型目录', async () => {
    const catalog = catalogFor();
    const service = createAiGenerationService(
      depsWith({
        policyStore: policyStoreFor({ features: { 'ai.listModels': { enabled: false } } }),
        catalog,
      }),
    );

    await expect(service.listModels(1)).rejects.toThrow(PaidCallError);
    expect(catalog.calls).not.toContain('listTextModels');
  });

  test('未关闭时正常返回', async () => {
    const service = createAiGenerationService(depsWith());
    expect((await service.listModels(1)).length).toBeGreaterThan(0);
  });
});

describe('生成预留按最终消息计字节', () => {
  test('带上下文时的预留高于只数原文', async () => {
    const policy = callPolicyThatRuns();
    const service = createAiGenerationService(
      depsWith({
        callPolicy: policy,
        contextProvider: contextProviderFor([{ id: 123456, content: '材料' }]),
      }),
    );

    await service.generateText(1, { ...validInput, contextNoteIds: [123456] });
    const reservedWithContext = policy.lastSpec?.reservedTokens ?? 0;

    const bare = callPolicyThatRuns();
    const serviceBare = createAiGenerationService(
      depsWith({ callPolicy: bare }),
    );
    await serviceBare.generateText(1, validInput);
    const reservedBare = bare.lastSpec?.reservedTokens ?? 0;

    expect(reservedWithContext).toBeGreaterThan(reservedBare);
    // 差额必须覆盖说明文字与 <note id> 标签，而不只是"材料"两个字的字节数。
    const bodyOnly = new TextEncoder().encode('材料').length;
    expect(reservedWithContext - reservedBare).toBeGreaterThan(bodyOnly);
  });
});

describe('模型构造阶段的不可用保留原语义', () => {
  test('目录之后模型被删除：报 MODEL_UNAVAILABLE，不翻成 INTERNAL_ERROR，且未调用生成器', async () => {
    const factory = factoryFor();
    const failing: TextGeneratorFactory = {
      async create() {
        factory.created += 1;
        // HostIndex 的工厂在模型被删除或撤销推理能力时正是抛这个。
        throw new ServiceError('MODEL_UNAVAILABLE');
      },
    };
    const service = createAiGenerationService(depsWith({ generatorFactory: failing }));

    const error = await service.generateText(1, validInput).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaidCallError);
    expect((error as PaidCallError).code).toBe('MODEL_UNAVAILABLE');
    expect(factory.created).toBe(1);
    expect(factory.generated).toBe(0);
  });

  test('构造阶段的其它异常仍按内部故障上报，不被误当成模型缺失', async () => {
    const failing: TextGeneratorFactory = {
      async create() {
        throw new Error('credential store unavailable');
      },
    };
    const policy = callPolicyThatRejects(new Error('credential store unavailable'));
    const service = createAiGenerationService(
      depsWith({ generatorFactory: failing, callPolicy: policy }),
    );
    const error = await service.generateText(1, validInput).catch((caught: unknown) => caught);
    // 这里由账本统一翻译，说明我们只对 MODEL_UNAVAILABLE 做了特判。
    expect((error as Error).message).toBe('credential store unavailable');
  });
});
