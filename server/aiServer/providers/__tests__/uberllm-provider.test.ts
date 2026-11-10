import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock the proxy module before importing LLMProvider
mock.module('@server/lib/proxy', () => ({
  fetchWithProxy: async () => fetch
}));

// Mock @ai-sdk/openai
const mockLanguageModel = { modelId: 'deepseek/deepseek-v4.1-flash' };
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

describe('UberLLM LLM Provider', () => {
  beforeEach(() => {
    mockCreateOpenAI.mockClear();
  });

  it('should handle uberllm provider case', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    const result = await provider.getLanguageModel({
      provider: 'uberllm',
      apiKey: 'test-api-key',
      baseURL: 'https://api.uberllm.dev/v1',
      modelKey: 'deepseek/deepseek-v4.1-flash'
    });

    expect(result).toBeDefined();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-api-key',
        baseURL: 'https://api.uberllm.dev/v1'
      })
    );
  });

  it('should use the default UberLLM base URL when not provided', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'uberllm',
      apiKey: 'test-api-key',
      modelKey: 'anthropic/claude-sonnet-4.6'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://api.uberllm.dev/v1'
      })
    );
  });

  it('should be case-insensitive for provider name', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'UberLLM',
      apiKey: 'test-api-key',
      modelKey: 'openai/gpt-5-mini'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://api.uberllm.dev/v1'
      })
    );
  });

  it('should pass proxiedFetch to createOpenAI', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'uberllm',
      apiKey: 'test-api-key',
      modelKey: 'deepseek/deepseek-v4.1-flash'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        fetch: expect.any(Function)
      })
    );
  });
});
