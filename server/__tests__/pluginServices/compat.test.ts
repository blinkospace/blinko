import { describe, expect, test } from 'bun:test';
import {
  PluginServiceUnavailableError,
  PluginServiceCallError,
  createPluginServices,
  createPluginServicesTransport,
  normalizeGenerateText,
  normalizeVectorQuery,
  requireCapability,
} from '../../../app/src/store/plugin/services';
import type { ServicesTransport } from '../../../app/src/store/plugin/services';
import {
  PLUGIN_SERVICES_API_VERSION,
  PLUGIN_SERVICES_POLICY_LIMITS,
} from '@shared/lib/pluginServices/v1';
import type {
  GenerateTextInput,
  GenerateTextResult,
  PublicModel,
  ServicesCapabilities,
  VectorIndexStatus,
  VectorQueryInput,
  VectorQueryResult,
} from '@shared/lib/pluginServices/v1';

const capabilities: ServicesCapabilities = {
  apiVersion: PLUGIN_SERVICES_API_VERSION,
  hostVersion: '1.8.9',
  features: {
    'vector.queryByNote': { available: true },
    'vector.queryByText': { available: false, reason: 'not-configured' },
    'ai.generateText': { available: true },
  },
  limits: { ...PLUGIN_SERVICES_POLICY_LIMITS },
};

const emptyStatus: VectorIndexStatus = {
  available: false,
  reason: 'index-not-ready',
  embeddingSpaceId: null,
  generation: null,
  corpusRevision: null,
  coverage: 'unknown',
  provenance: 'none',
};

function createFakeTransport(): ServicesTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async capabilities() {
      calls.push('capabilities');
      return capabilities;
    },
    async vectorStatus() {
      calls.push('vectorStatus');
      return emptyStatus;
    },
    async vectorQuery(input: VectorQueryInput) {
      calls.push('vectorQuery');
      return {
        requestId: 'req-vector',
        items: [],
        scoring: { metric: 'cosine', aggregation: 'max_chunk_cosine_v1', higherIsBetter: true },
        index: {
          embeddingSpaceId: 'space-1',
          generation: 'gen-1',
          corpusRevision: 'rev-1',
          coverage: 'ready',
          provenance: 'verified',
        },
        retrieval: { algorithm: 'exact', truncated: false, remaining: 'unknown' },
      } satisfies VectorQueryResult;
    },
    async listModels() {
      calls.push('listModels');
      return [] as PublicModel[];
    },
    async generateText(input: GenerateTextInput) {
      calls.push('generateText');
      return {
        requestId: 'req-ai',
        text: 'ok',
        model: { id: 1, name: 'm' },
        finishReason: 'stop',
        usage: { inputTokens: null, outputTokens: null, status: 'unknown' },
        warnings: [],
        echoedKey: input.idempotencyKey,
      } as unknown as GenerateTextResult;
    },
  };
}

describe('normalizeVectorQuery', () => {
  test('文本查询缺幂等键时自动补齐', () => {
    const normalized = normalizeVectorQuery({ source: { kind: 'text', text: '相关笔记' } });
    expect(typeof normalized.idempotencyKey).toBe('string');
    expect((normalized.idempotencyKey ?? '').length).toBeGreaterThan(8);
  });

  test('文本查询已有幂等键时原样保留（显式重试语义）', () => {
    const normalized = normalizeVectorQuery({
      source: { kind: 'text', text: 'x' },
      idempotencyKey: 'keep-me',
    });
    expect(normalized.idempotencyKey).toBe('keep-me');
  });

  test('按笔记查询丢弃幂等键：不产生付费调用，留着会误导', () => {
    const normalized = normalizeVectorQuery({
      source: { kind: 'note', noteId: 42 },
      idempotencyKey: 'should-be-dropped',
    });
    expect('idempotencyKey' in normalized).toBe(false);
  });

  test('每次新的文本调用产生不同幂等键', () => {
    const a = normalizeVectorQuery({ source: { kind: 'text', text: 'x' } });
    const b = normalizeVectorQuery({ source: { kind: 'text', text: 'x' } });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });
});

describe('normalizeGenerateText', () => {
  const base: GenerateTextInput = {
    messages: [{ role: 'user', content: 'hi' }],
    idempotencyKey: 'abc',
  };

  test('合法键保留', () => {
    expect(normalizeGenerateText(base).idempotencyKey).toBe('abc');
  });

  test('空串与纯空白键被替换，避免不同调用被串成一次', () => {
    expect(normalizeGenerateText({ ...base, idempotencyKey: '' }).idempotencyKey).not.toBe('');
    expect(normalizeGenerateText({ ...base, idempotencyKey: '   ' }).idempotencyKey.trim()).not.toBe('');
  });
});

describe('createPluginServices', () => {
  test('暴露冻结的 apiVersion 与三组命名空间', () => {
    const sdk = createPluginServices(createFakeTransport());
    expect(sdk.apiVersion).toBe(PLUGIN_SERVICES_API_VERSION);
    expect(typeof sdk.capabilities).toBe('function');
    expect(typeof sdk.vector.query).toBe('function');
    expect(typeof sdk.ai.generateText).toBe('function');
  });

  test('每次调用都走 transport，不缓存会话', async () => {
    const transport = createFakeTransport();
    const sdk = createPluginServices(transport);
    await sdk.capabilities();
    await sdk.capabilities();
    expect(transport.calls.filter((name) => name === 'capabilities').length).toBe(2);
  });

  test('向量查询在 SDK 层完成规范化后再交给 transport', async () => {
    const seen: VectorQueryInput[] = [];
    const transport = createFakeTransport();
    const original = transport.vectorQuery.bind(transport);
    transport.vectorQuery = async (input, options) => {
      seen.push(input);
      return original(input, options);
    };
    const sdk = createPluginServices(transport);
    await sdk.vector.query({ source: { kind: 'note', noteId: 1 }, idempotencyKey: 'drop-me' });
    expect('idempotencyKey' in seen[0]).toBe(false);
  });
});

describe('requireCapability', () => {
  test('可用时不抛错', () => {
    expect(() => requireCapability(capabilities, 'vector.queryByNote')).not.toThrow();
  });

  test('不可用时抛错并带上原因', () => {
    try {
      requireCapability(capabilities, 'vector.queryByText');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginServiceUnavailableError);
      expect((error as PluginServiceUnavailableError).state.reason).toBe('not-configured');
    }
  });

  test('capabilities 未声明该 feature 时按不支持处理', () => {
    try {
      requireCapability(capabilities, 'vector.approximate');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as PluginServiceUnavailableError).state.reason).toBe('unsupported');
    }
  });
});

// ---------------------------------------------------------------------------
// 宿主挂载链路：经 SDK 真正调到宿主 capabilities / vector.status
//
// 这里用假的 tRPC 客户端形状，验证的是**接线**：SDK → transport → 宿主 procedure。
// 不启动真实服务，也不宣称这是端到端路由测试。
// ---------------------------------------------------------------------------

function hostShape(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    pluginServices: {
      capabilities: {
        async query() {
          calls.push('capabilities');
          return {
            apiVersion: PLUGIN_SERVICES_API_VERSION,
            hostVersion: '1.8.9',
            features: {
              'vector.status': { available: true },
              'ai.generateText': { available: false, reason: 'unsupported' as const },
            },
            limits: { ...PLUGIN_SERVICES_POLICY_LIMITS },
          };
        },
      },
      vector: {
        status: {
          async query() {
            calls.push('vector.status');
            return {
              available: false,
              reason: 'index-not-ready' as const,
              embeddingSpaceId: null,
              generation: null,
              corpusRevision: null,
              coverage: 'unknown' as const,
              provenance: 'none' as const,
            };
          },
        },
      },
      ...overrides,
    },
  };
}

describe('SDK 挂载后能真实调到宿主能力与状态', () => {
  test('capabilities 经 SDK 返回宿主原值', async () => {
    const host = hostShape();
    const sdk = createPluginServices(createPluginServicesTransport(() => host));

    const caps = await sdk.capabilities();
    expect(caps.apiVersion).toBe(PLUGIN_SERVICES_API_VERSION);
    expect(caps.hostVersion).toBe('1.8.9');
    expect(caps.features['vector.status']?.available).toBe(true);
    expect(host.calls).toContain('capabilities');
  });

  test('vector.status 经 SDK 返回宿主原值，未就绪如实透出', async () => {
    const host = hostShape();
    const sdk = createPluginServices(createPluginServicesTransport(() => host));

    const status = await sdk.vector.status();
    expect(status.available).toBe(false);
    expect(status.reason).toBe('index-not-ready');
    expect(host.calls).toContain('vector.status');
  });

  test('transport 层：取不到 procedure 时诚实报"不支持"（仅适用于非 Proxy 客户端）', async () => {
    const host = hostShape();
    const sdk = createPluginServices(createPluginServicesTransport(() => host));

    await expect(sdk.ai.listModels()).rejects.toBeInstanceOf(PluginServiceUnavailableError);
    await expect(
      sdk.ai.generateText({ messages: [{ role: 'user', content: 'x' }], idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(PluginServiceUnavailableError);
  });

  test('transport 每次取当前客户端：换掉客户端立刻生效，不沿用旧引用', async () => {
    const first = hostShape();
    const second = hostShape();
    let current: ReturnType<typeof hostShape> = first;
    const sdk = createPluginServices(createPluginServicesTransport(() => current));

    await sdk.capabilities();
    current = second;
    await sdk.capabilities();

    expect(first.calls.filter((name) => name === 'capabilities').length).toBe(1);
    expect(second.calls.filter((name) => name === 'capabilities').length).toBe(1);
  });

  test('调用前探测能力可以拦住不可用功能，不发出请求', async () => {
    const host = hostShape();
    const sdk = createPluginServices(createPluginServicesTransport(() => host));
    const caps = await sdk.capabilities();

    expect(() => requireCapability(caps, 'ai.generateText')).toThrow(/unavailable/);
    expect(host.calls).not.toContain('ai.generateText');
  });
});

// ---------------------------------------------------------------------------
// 真实 tRPC 客户端的行为：动态 Proxy 不会在取属性时给出 undefined
//
// 这段是为了纠正一个错误的证明方式：用假 shape 断言"未挂端点会返回
// undefined"是站不住的——真实客户端的属性访问永远返回函数。
// 能判定的只有调用失败后的 NOT_FOUND，或服务端错误信封。
// ---------------------------------------------------------------------------

function proxyLikeClient(rejectWith: unknown) {
  const node = {
    query: async () => {
      throw rejectWith;
    },
    mutate: async () => {
      throw rejectWith;
    },
  };
  return {
    pluginServices: {
      capabilities: node,
      vector: { status: node },
      ai: { listModels: node, generateText: node },
    },
  };
}

describe('transport 对真实客户端失败的翻译', () => {
  test('NOT_FOUND 翻译成"不支持"，而不是把 TRPCClientError 抛给插件', async () => {
    const sdkOverNotFound = createPluginServices(
      createPluginServicesTransport(() =>
        proxyLikeClient({ data: { code: 'NOT_FOUND', httpStatus: 404 }, message: 'No procedure' }),
      ),
    );

    const failure = await sdkOverNotFound.ai.listModels().catch((error) => error);
    expect(failure).toBeInstanceOf(PluginServiceUnavailableError);
    expect((failure as PluginServiceUnavailableError).state.reason).toBe('unsupported');
  });

  test('服务端错误信封被还原成强类型错误，插件不必 parse 字符串', async () => {
    const dto = {
      code: 'BUDGET_EXCEEDED',
      requestId: 'req-42',
      message: 'The account budget was reached.',
      retryable: false,
    };
    const sdkOverEnvelope = createPluginServices(
      createPluginServicesTransport(() =>
        proxyLikeClient({ message: JSON.stringify(dto), data: { code: 'BAD_REQUEST' } }),
      ),
    );

    const failure = await sdkOverEnvelope.ai.generateText({
      messages: [{ role: 'user', content: 'x' }],
      idempotencyKey: 'k',
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(PluginServiceCallError);
    expect((failure as PluginServiceCallError).code).toBe('BUDGET_EXCEEDED');
    expect((failure as PluginServiceCallError).requestId).toBe('req-42');
    expect((failure as PluginServiceCallError).retryable).toBe(false);
  });

  test('非 NOT_FOUND 的其它错误原样透出，不被误译成"不支持"', async () => {
    const boom = new Error('network down');
    const sdkOverError = createPluginServices(
      createPluginServicesTransport(() => proxyLikeClient(boom)),
    );
    const failure = await sdkOverError.ai.listModels().catch((error) => error);
    expect(failure).toBe(boom);
  });
});
