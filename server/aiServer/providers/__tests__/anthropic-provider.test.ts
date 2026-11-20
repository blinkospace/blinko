import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock the proxy module before importing LLMProvider
mock.module('@server/lib/proxy', () => ({
  fetchWithProxy: async () => fetch
}));

// Mock @ai-sdk/anthropic
const mockLanguageModel = { modelId: 'claude-3-5-sonnet' };
const mockCreateAnthropic = mock((config: any) => ({
  languageModel: mock((modelKey: string) => mockLanguageModel)
}));

mock.module('@ai-sdk/anthropic', () => ({
  createAnthropic: mockCreateAnthropic
}));

// Mock other SDK modules to avoid import errors
mock.module('@ai-sdk/openai', () => ({
  createOpenAI: mock(() => ({ languageModel: mock(() => ({})) }))
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

describe('Anthropic LLM Provider', () => {
  beforeEach(() => {
    mockCreateAnthropic.mockClear();
  });

  it('should normalize bare Anthropic baseURL to /v1', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    const result = await provider.getLanguageModel({
      provider: 'anthropic',
      apiKey: 'test-api-key',
      baseURL: 'https://api.anthropic.com',
      modelKey: 'claude-3-5-sonnet'
    });

    expect(result).toBeDefined();
    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-api-key',
        baseURL: 'https://api.anthropic.com/v1'
      })
    );
  });

  it('should preserve baseURL that already includes /v1', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'anthropic',
      apiKey: 'test-key',
      baseURL: 'https://api.anthropic.com/v1',
      modelKey: 'claude-3-5-sonnet'
    });

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://api.anthropic.com/v1'
      })
    );
  });

  it('should strip trailing slashes and normalize to /v1', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'anthropic',
      apiKey: 'test-key',
      baseURL: 'https://api.anthropic.com/',
      modelKey: 'claude-3-5-sonnet'
    });

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://api.anthropic.com/v1'
      })
    );
  });

  it('should leave undefined when no baseURL is provided', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'anthropic',
      apiKey: 'test-key',
      modelKey: 'claude-3-5-sonnet'
    });

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: undefined
      })
    );
  });
});
