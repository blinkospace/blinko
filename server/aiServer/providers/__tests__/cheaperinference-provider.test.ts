import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock the proxy module before importing LLMProvider
mock.module('@server/lib/proxy', () => ({
  fetchWithProxy: async () => fetch
}));

// Mock @ai-sdk/openai
const mockLanguageModel = { modelId: 'gpt-5.4-mini' };
const mockEmbeddingModel = { modelId: 'text-embedding-3-small' };
const mockCreateOpenAI = mock((config: any) => ({
  languageModel: mock((modelKey: string) => mockLanguageModel),
  textEmbeddingModel: mock((modelKey: string) => mockEmbeddingModel)
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
  createOllama: mock(() => ({ languageModel: mock(() => ({})), textEmbeddingModel: mock(() => ({})) }))
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
  createAzure: mock(() => ({ languageModel: mock(() => ({})), textEmbeddingModel: mock(() => ({})) }))
}));
mock.module('voyage-ai-provider', () => ({
  createVoyage: mock(() => ({ textEmbeddingModel: mock(() => ({})) }))
}));

describe('Cheaper Inference LLM Provider', () => {
  beforeEach(() => {
    mockCreateOpenAI.mockClear();
  });

  it('should handle cheaperinference provider case', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    const result = await provider.getLanguageModel({
      provider: 'cheaperinference',
      apiKey: 'test-key',
      baseURL: 'https://api.cheaperinference.com/v1',
      modelKey: 'gpt-5.4-mini'
    });

    expect(result).toBeDefined();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-key',
        baseURL: 'https://api.cheaperinference.com/v1'
      })
    );
  });

  it('should use default Cheaper Inference URL when not provided', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'cheaperinference',
      apiKey: 'test-key',
      modelKey: 'gpt-5.4-mini'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://api.cheaperinference.com/v1'
      })
    );
  });

  it('should be case-insensitive for provider name', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'CheaperInference',
      apiKey: 'test-key',
      modelKey: 'deepseek-v4-flash'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://api.cheaperinference.com/v1'
      })
    );
  });

  it('should pass proxiedFetch to createOpenAI', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'cheaperinference',
      apiKey: 'test-key',
      modelKey: 'gpt-5.4-mini'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        fetch: expect.any(Function)
      })
    );
  });
});

describe('Cheaper Inference Embedding Provider', () => {
  beforeEach(() => {
    mockCreateOpenAI.mockClear();
  });

  it('should use default Cheaper Inference URL for embeddings', async () => {
    const { EmbeddingProvider } = await import('../EmbeddingProvider');
    const provider = new EmbeddingProvider();

    const result = await provider.getEmbeddingModel({
      provider: 'cheaperinference',
      apiKey: 'test-key',
      modelKey: 'text-embedding-3-small'
    });

    expect(result).toBeDefined();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-key',
        baseURL: 'https://api.cheaperinference.com/v1'
      })
    );
  });
});
