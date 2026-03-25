import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock the proxy module before importing LLMProvider
mock.module('@server/lib/proxy', () => ({
  fetchWithProxy: async () => fetch
}));

// Mock @ai-sdk/openai
const mockLanguageModel = { modelId: 'MiniMax-M2.5' };
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

describe('MiniMax LLM Provider', () => {
  beforeEach(() => {
    mockCreateOpenAI.mockClear();
  });

  it('should handle minimax provider case', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    const result = await provider.getLanguageModel({
      provider: 'minimax',
      apiKey: 'test-api-key',
      modelKey: 'MiniMax-M2.5'
    });

    expect(result).toBeDefined();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-api-key',
        baseURL: 'https://api.minimax.io/v1'
      })
    );
  });

  it('should use default MiniMax base URL when not provided', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'minimax',
      apiKey: 'test-key',
      modelKey: 'MiniMax-M2.7'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://api.minimax.io/v1'
      })
    );
  });

  it('should allow custom base URL override', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'minimax',
      apiKey: 'test-key',
      baseURL: 'https://custom.minimax.io/v1',
      modelKey: 'MiniMax-M2.5'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://custom.minimax.io/v1'
      })
    );
  });

  it('should be case-insensitive for provider name', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'MiniMax',
      apiKey: 'test-key',
      modelKey: 'MiniMax-M2.5'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://api.minimax.io/v1'
      })
    );
  });

  it('should support all MiniMax model keys', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();
    const models = ['MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed'];

    for (const modelKey of models) {
      mockCreateOpenAI.mockClear();
      await provider.getLanguageModel({
        provider: 'minimax',
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
      provider: 'minimax',
      apiKey: 'test-key',
      modelKey: 'MiniMax-M2.5'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        fetch: expect.any(Function)
      })
    );
  });
});
