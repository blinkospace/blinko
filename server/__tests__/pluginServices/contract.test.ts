import { describe, expect, test } from 'bun:test';
import {
  PUBLIC_MODEL_CAPABILITY_KEYS,
  PUBLIC_MODEL_KEYS,
  assertPublicModelShape,
  buildPublicModelList,
  generateTextInputSchema,
  resolveMaxOutputTokens,
  toPublicModel,
} from '@server/services/pluginServices/aiSchemas';
import { PLUGIN_SERVICES_POLICY_LIMITS } from '@shared/lib/pluginServices/v1';

const validInput = {
  messages: [{ role: 'user' as const, content: '概括指定材料的核心观点。' }],
  idempotencyKey: 'c0ffee00-0000-4000-8000-000000000000',
};

describe('generateTextInputSchema', () => {
  test('接受最小合法输入', () => {
    const parsed = generateTextInputSchema.safeParse(validInput);
    expect(parsed.success).toBe(true);
  });

  test('拒绝未知字段而不是静默丢弃', () => {
    const parsed = generateTextInputSchema.safeParse({ ...validInput, stream: true });
    expect(parsed.success).toBe(false);
  });

  test('拒绝缺少幂等键', () => {
    const parsed = generateTextInputSchema.safeParse({
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(parsed.success).toBe(false);
  });

  test('拒绝空消息列表', () => {
    const parsed = generateTextInputSchema.safeParse({ ...validInput, messages: [] });
    expect(parsed.success).toBe(false);
  });

  test('拒绝系统角色混入 messages', () => {
    const parsed = generateTextInputSchema.safeParse({
      ...validInput,
      messages: [{ role: 'system', content: 'x' }],
    });
    expect(parsed.success).toBe(false);
  });

  test('拒绝超过策略上限的输出 token', () => {
    const parsed = generateTextInputSchema.safeParse({
      ...validInput,
      maxOutputTokens: PLUGIN_SERVICES_POLICY_LIMITS.maxOutputTokens + 1,
    });
    expect(parsed.success).toBe(false);
  });

  test('拒绝超出输入字节上限的请求', () => {
    const parsed = generateTextInputSchema.safeParse({
      ...validInput,
      messages: [{ role: 'user', content: 'a'.repeat(PLUGIN_SERVICES_POLICY_LIMITS.maxInputBytes) }],
    });
    expect(parsed.success).toBe(false);
  });

  test('拒绝非正安全整数的 modelId', () => {
    for (const modelId of [0, -1, 1.5]) {
      const parsed = generateTextInputSchema.safeParse({ ...validInput, modelId });
      expect(parsed.success).toBe(false);
    }
  });
});

describe('resolveMaxOutputTokens', () => {
  test('未指定时套用默认值', () => {
    expect(resolveMaxOutputTokens(undefined)).toBe(2048);
  });

  test('显式值不超过策略上限', () => {
    expect(resolveMaxOutputTokens(PLUGIN_SERVICES_POLICY_LIMITS.maxOutputTokens + 500)).toBe(
      PLUGIN_SERVICES_POLICY_LIMITS.maxOutputTokens,
    );
  });
});

describe('toPublicModel 白名单形状', () => {
  const record = {
    id: 7,
    title: 'deepseek-v4.1-flash',
    providerLabel: 'Ollama Cloud',
    capabilities: { inference: true },
    apiKey: 'sk-should-never-appear',
    baseURL: 'https://internal.example',
    config: { secret: true },
    modelKey: 'internal-key',
  };

  test('只输出白名单字段，内部字段不透出', () => {
    const dto = toPublicModel(record, { defaultModelId: 7 });
    expect(() => assertPublicModelShape(dto)).not.toThrow();
    expect(Object.keys(dto).sort()).toEqual([...PUBLIC_MODEL_KEYS].sort());
    expect(JSON.stringify(dto)).not.toContain('sk-should-never-appear');
    expect(JSON.stringify(dto)).not.toContain('internal.example');
    expect(JSON.stringify(dto)).not.toContain('internal-key');
  });

  test('capabilities 子对象字段集固定', () => {
    const dto = toPublicModel(record, { defaultModelId: null });
    expect(Object.keys(dto.capabilities).sort()).toEqual([...PUBLIC_MODEL_CAPABILITY_KEYS].sort());
    expect(dto.capabilities.structuredOutput).toBeNull();
    expect(dto.capabilities.streaming).toBe(false);
  });

  test('isDefault 只由 defaultModelId 决定', () => {
    expect(toPublicModel(record, { defaultModelId: 7 }).isDefault).toBe(true);
    expect(toPublicModel(record, { defaultModelId: 8 }).isDefault).toBe(false);
    expect(toPublicModel(record, { defaultModelId: null }).isDefault).toBe(false);
  });

  test('构造器没有角色参数：管理员与普通用户得到同一形状', () => {
    // 以参数个数断言，防止将来有人偷偷加 isAdmin 分支。
    expect(toPublicModel.length).toBe(2);
  });
});

describe('assertPublicModelShape 必须能抓到多字段', () => {
  test('多一个字段即失败', () => {
    const leaked = {
      id: 1,
      name: 'm',
      providerLabel: 'p',
      isDefault: false,
      capabilities: { text: true, streaming: false, structuredOutput: null },
      apiKey: 'x',
    };
    expect(() => assertPublicModelShape(leaked)).toThrow(/field set mismatch/);
  });

  test('capabilities 多一个字段即失败', () => {
    const leaked = {
      id: 1,
      name: 'm',
      providerLabel: 'p',
      isDefault: false,
      capabilities: { text: true, streaming: false, structuredOutput: null, tools: true },
    };
    expect(() => assertPublicModelShape(leaked)).toThrow(/capabilities field set mismatch/);
  });
});

describe('buildPublicModelList', () => {
  test('过滤掉不具备文字生成能力的模型', () => {
    const list = buildPublicModelList(
      [
        { id: 1, title: 'chat', providerLabel: 'p', capabilities: { inference: true } },
        { id: 2, title: 'embed', providerLabel: 'p', capabilities: { inference: false } },
        { id: 3, title: 'image', providerLabel: 'p', capabilities: null },
      ],
      { defaultModelId: 1 },
    );
    expect(list.map((item) => item.id)).toEqual([1]);
  });
});
