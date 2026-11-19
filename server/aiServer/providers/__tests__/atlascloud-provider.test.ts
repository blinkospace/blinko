import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock the proxy module before importing LLMProvider
mock.module('@server/lib/proxy', () => ({
  fetchWithProxy: async () => fetch
}));

// Mock @ai-sdk/openai
const mockLanguageModel = { modelId: 'deepseek-ai/deepseek-v4-flash' };
const mockCreateOpenAI = mock((config: any) => ({
  languageModel: mock((modelKey: string) => mockLanguageModel)
}));

mock.module('@ai-sdk/openai', () => ({
  createOpenAI: mockCreateOpenAI
}));

// Mock other SDK modules to avoid import errors
mock.module('@ai-sdk/anthropic', () => ({
  createAnthropic: mock(() => ({ languageModel: mock(() => ({})) }))
}));
mock.module('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: mock(() => ({ languageModel: mock(() => ({})) }))
}));
mock.module('ollama-ai-provider', () => ({
  createOllama: mock(() => ({ languageModel: mock(() => ({})) }))
}));
mock.module('@ai-sdk/deepseek', () => ({
  createDeepSeek: mock(() => ({ languageModel: mock(() => ({})) }))
}));
mock.module('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: mock(() => ({ languageModel: mock(() => ({})) }))
}));
mock.module('@ai-sdk/xai', () => ({
  createXai: mock(() => ({ languageModel: mock(() => ({})) }))
}));
mock.module('@ai-sdk/azure', () => ({
  createAzure: mock(() => ({ languageModel: mock(() => ({})) }))
}));

describe('Atlas Cloud LLM Provider', () => {
  beforeEach(() => {
    mockCreateOpenAI.mockClear();
  });

  it('should handle atlascloud provider case', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    const result = await provider.getLanguageModel({
      provider: 'atlascloud',
      apiKey: 'test-api-key',
      modelKey: 'deepseek-ai/deepseek-v4-flash'
    });

    expect(result).toBeDefined();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-api-key',
        baseURL: 'https://api.atlascloud.ai/v1'
      })
    );
  });

  it('should use default Atlas Cloud base URL when not provided', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'atlascloud',
      apiKey: 'test-key',
      modelKey: 'deepseek-ai/deepseek-v4-pro'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://api.atlascloud.ai/v1'
      })
    );
  });

  it('should allow custom base URL override', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'atlascloud',
      apiKey: 'test-key',
      baseURL: 'https://custom.atlascloud.ai/v1',
      modelKey: 'deepseek-ai/deepseek-v4-flash'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://custom.atlascloud.ai/v1'
      })
    );
  });

  it('should be case-insensitive for provider name', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'AtlasCloud',
      apiKey: 'test-key',
      modelKey: 'deepseek-ai/deepseek-v4-flash'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://api.atlascloud.ai/v1'
      })
    );
  });

  it('should support all Atlas Cloud model keys', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();
    const models = ['deepseek-ai/deepseek-v4-flash', 'deepseek-ai/deepseek-v4-pro'];

    for (const modelKey of models) {
      mockCreateOpenAI.mockClear();
      await provider.getLanguageModel({
        provider: 'atlascloud',
        apiKey: 'test-key',
        modelKey
      });
      expect(mockCreateOpenAI).toHaveBeenCalled();
    }
  });

  it('should pass proxiedFetch to createOpenAI', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'atlascloud',
      apiKey: 'test-key',
      modelKey: 'deepseek-ai/deepseek-v4-flash'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        fetch: expect.any(Function)
      })
    );
  });
});
