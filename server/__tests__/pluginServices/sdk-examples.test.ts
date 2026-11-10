import { describe, expect, test } from 'bun:test';
import RandomWalkPlugin from '../../../docs/plugin-services/examples/random-walk/plugin';
import SimilarContentPlugin from '../../../docs/plugin-services/examples/similar-content/plugin';
import NoteSummaryPlugin from '../../../docs/plugin-services/examples/note-summary/plugin';
import { createPluginServices } from '../../../app/src/store/plugin/services';
import type { PluginServicesSdk, ServicesTransport } from '../../../app/src/store/plugin/services';
import {
  PLUGIN_SERVICES_API_VERSION,
  PLUGIN_SERVICES_POLICY_LIMITS,
  type VectorQueryItem,
} from '@shared/lib/pluginServices/v1';

/**
 * 三个示例只用正式 SDK，且 SDK 可注入——所以能在这里脱离宿主跑。
 * 这验证的是示例的**交互逻辑**，不是宿主路由；宿主链路由 db-sdk-host 负责。
 */

function item(id: number, score = 0.9): VectorQueryItem {
  return {
    note: {
      id,
      type: 0,
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
      excerpt: `note-${id}`,
    },
    score,
    matches: [{ targetChunkOrdinal: 0, excerpt: `note-${id}` }],
  };
}

/**
 * 造的是**传输层**，再交给真正的 createPluginServices 包成 SDK。
 * 直接造一个假的 SDK 会绕过 SDK 自己的参数规范化（例如文本查询自动补幂等键），
 * 那样测出来的就不是"示例 + 真实 SDK"的行为。
 */
function fakeSdk(options: {
  available?: Partial<Record<string, boolean>>;
  items?: VectorQueryItem[];
  text?: string;
  models?: Array<{ id: number; name: string; isDefault?: boolean }>;
}): PluginServicesSdk & { queries: unknown[]; generated: number; generatedInputs: unknown[] } {
  const state = {
    queries: [] as unknown[],
    generated: 0,
    generatedInputs: [] as unknown[],
    apiVersion: PLUGIN_SERVICES_API_VERSION,
    async capabilities() {
      const available = options.available ?? {};
      return {
        apiVersion: PLUGIN_SERVICES_API_VERSION,
        hostVersion: '1.8.9',
        features: Object.fromEntries(
          [
            'vector.queryByNote',
            'vector.queryByText',
            'ai.generateText',
          ].map((key) => [key, { available: available[key] ?? false }]),
        ),
        limits: { ...PLUGIN_SERVICES_POLICY_LIMITS },
      };
    },
    vector: {
      async status() {
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
      async query(input: unknown) {
        state.queries.push(input);
        return {
          requestId: 'req',
          items: options.items ?? [item(2), item(3, 0.4)],
          scoring: { metric: 'cosine' as const, aggregation: 'max_chunk_cosine_v1' as const, higherIsBetter: true as const },
          index: {
            embeddingSpaceId: 's',
            generation: 'g',
            corpusRevision: 'r',
            coverage: 'ready' as const,
            provenance: 'verified' as const,
          },
          retrieval: { algorithm: 'exact' as const, truncated: false, remaining: 'unknown' as const },
        };
      },
    },
    ai: {
      async listModels() {
        return (options.models ?? [{ id: 1, name: 'm' }]).map((model) => ({
          id: model.id,
          name: model.name,
          providerLabel: 'P',
          isDefault: model.isDefault ?? true,
          capabilities: { text: true, streaming: false, structuredOutput: null },
        }));
      },
      async generateText(input: unknown) {
        state.generated += 1;
        state.generatedInputs.push(input);
        return {
          requestId: 'req-ai',
          text: options.text ?? '摘要正文',
          model: { id: 1, name: 'm' },
          finishReason: 'stop' as const,
          usage: { inputTokens: null, outputTokens: null, status: 'unknown' as const },
          warnings: [],
        };
      },
    },
  };
  const transport: ServicesTransport = {
    capabilities: state.capabilities,
    vectorStatus: state.vector.status,
    vectorQuery: state.vector.query as ServicesTransport['vectorQuery'],
    listModels: state.ai.listModels,
    generateText: state.ai.generateText as ServicesTransport['generateText'],
  };
  const sdk = createPluginServices(transport);
  const wrapped = {
    apiVersion: sdk.apiVersion,
    capabilities: sdk.capabilities,
    vector: sdk.vector,
    ai: sdk.ai,
    queries: state.queries,
    get generated() {
      return state.generated;
    },
    generatedInputs: state.generatedInputs,
  };
  return wrapped as unknown as PluginServicesSdk & {
    queries: unknown[];
    generated: number;
    generatedInputs: unknown[];
  };
}

describe('随机漫步示例', () => {
  test('能力不可用时诚实返回空，不发起调用', async () => {
    const sdk = fakeSdk({ available: { 'vector.queryByNote': false } });
    const plugin = new RandomWalkPlugin(sdk as unknown as PluginServicesSdk);

    expect(await plugin.next(1)).toEqual([]);
    expect(sdk.queries).toHaveLength(0);
  });

  test('查询时排除已访问节点与源笔记', async () => {
    const sdk = fakeSdk({ available: { 'vector.queryByNote': true } });
    const plugin = new RandomWalkPlugin(sdk as unknown as PluginServicesSdk);

    await plugin.next(1);
    await plugin.next(2);

    const second = sdk.queries[1] as { excludeNoteIds: number[]; source: { noteId: number } };
    // 第二跳必须排除源笔记 2，以及第一跳记录过的节点。
    expect(second.source.noteId).toBe(2);
    expect(second.excludeNoteIds).toContain(2);
    expect(second.excludeNoteIds).toContain(1);
  });
});

describe('相似内容检查示例', () => {
  test('按阈值过滤，且不把分数当概率', async () => {
    const sdk = fakeSdk({ available: { 'vector.queryByText': true } });
    const plugin = new SimilarContentPlugin(sdk as unknown as PluginServicesSdk);

    const result = await plugin.check('草稿文本', 0.75);
    expect(result.map((entry) => entry.note.id)).toEqual([2]);

    const request = sdk.queries[0] as { source: { kind: string }; idempotencyKey?: string };
    expect(request.source.kind).toBe('text');
    // 幂等键交给 SDK 生成，示例不手写。
    expect(request.idempotencyKey).toBeDefined();
  });

  test('能力不可用时返回空', async () => {
    const sdk = fakeSdk({ available: { 'vector.queryByText': false } });
    const plugin = new SimilarContentPlugin(sdk as unknown as PluginServicesSdk);
    expect(await plugin.check('x')).toEqual([]);
    expect(sdk.queries).toHaveLength(0);
  });
});

describe('选定笔记摘要示例', () => {
  test('能力可用时生成一次，返回正文', async () => {
    const sdk = fakeSdk({ available: { 'ai.generateText': true }, text: '核心观点' });
    const plugin = new NoteSummaryPlugin(sdk as unknown as PluginServicesSdk);

    expect(await plugin.summarize(7)).toBe('核心观点');
    expect(sdk.generated).toBe(1);
  });

  test('能力不可用时返回 null，不发起生成', async () => {
    const sdk = fakeSdk({ available: { 'ai.generateText': false } });
    const plugin = new NoteSummaryPlugin(sdk as unknown as PluginServicesSdk);

    expect(await plugin.summarize(7)).toBeNull();
    expect(sdk.generated).toBe(0);
  });

  test('默认模型被白名单排除时，改用目录中实际可用的模型而不是发 default', async () => {
    const sdk = fakeSdk({
      available: { 'ai.generateText': true },
      models: [{ id: 7, name: 'allowed-model', isDefault: false }],
      text: '摘要正文',
    });
    const plugin = new NoteSummaryPlugin(sdk);
    expect(await plugin.summarize(1)).toBe('摘要正文');
    expect(sdk.generated).toBe(1);
    // 目录里没有 default（说明默认模型不在白名单），此时再发 'default' 必然失败。
    expect((sdk.generatedInputs[0] as { modelId: unknown }).modelId).toBe(7);
  });

  test('没有可用模型时返回 null，不发起生成', async () => {
    const sdk = fakeSdk({ available: { 'ai.generateText': true }, models: [] });
    const plugin = new NoteSummaryPlugin(sdk as unknown as PluginServicesSdk);

    expect(await plugin.summarize(7)).toBeNull();
    expect(sdk.generated).toBe(0);
  });
});
