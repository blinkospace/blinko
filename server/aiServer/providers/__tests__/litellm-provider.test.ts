import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock the proxy module before importing LLMProvider
mock.module('@server/lib/proxy', () => ({
  fetchWithProxy: async () => fetch
}));

// Mock @ai-sdk/openai
const mockLanguageModel = { modelId: 'anthropic/claude-3-5-sonnet' };
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

describe('LiteLLM LLM Provider', () => {
  beforeEach(() => {
    mockCreateOpenAI.mockClear();
  });

  it('should handle litellm provider case', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    const result = await provider.getLanguageModel({
      provider: 'litellm',
      apiKey: 'sk-litellm-key',
      baseURL: 'http://localhost:4000/v1',
      modelKey: 'anthropic/claude-3-5-sonnet'
    });

    expect(result).toBeDefined();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-litellm-key',
        baseURL: 'http://localhost:4000/v1'
      })
    );
  });

  it('should use default LiteLLM proxy URL when not provided', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'litellm',
      apiKey: 'sk-litellm-key',
      modelKey: 'openai/gpt-4o-mini'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://localhost:4000/v1'
      })
    );
  });

  it('should allow custom proxy URL override', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'litellm',
      apiKey: 'sk-litellm-key',
      baseURL: 'https://my-proxy.example.com/v1',
      modelKey: 'anthropic/claude-3-5-sonnet'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://my-proxy.example.com/v1'
      })
    );
  });

  it('should be case-insensitive for provider name', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'LiteLLM',
      apiKey: 'sk-key',
      modelKey: 'openai/gpt-4o'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://localhost:4000/v1'
      })
    );
  });

  it('should support various litellm model key formats', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();
    const models = [
      'openai/gpt-4o',
      'anthropic/claude-3-5-sonnet',
      'azure/gpt-4',
      'bedrock/anthropic.claude-3-sonnet',
      'vertex_ai/gemini-pro'
    ];

    for (const modelKey of models) {
      mockCreateOpenAI.mockClear();
      await provider.getLanguageModel({
        provider: 'litellm',
        apiKey: 'sk-key',
        modelKey
      });
      expect(mockCreateOpenAI).toHaveBeenCalled();
    }
  });

  it('should pass proxiedFetch to createOpenAI', async () => {
    const { LLMProvider } = await import('../LLMProvider');
    const provider = new LLMProvider();

    await provider.getLanguageModel({
      provider: 'litellm',
      apiKey: 'sk-key',
      modelKey: 'openai/gpt-4o-mini'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        fetch: expect.any(Function)
      })
    );
  });
});

describe('LiteLLM Embedding Provider', () => {
  beforeEach(() => {
    mockCreateOpenAI.mockClear();
  });

  it('should handle litellm embedding provider', async () => {
    const { EmbeddingProvider } = await import('../EmbeddingProvider');
    const provider = new EmbeddingProvider();

    const result = await provider.getEmbeddingModel({
      provider: 'litellm',
      apiKey: 'sk-litellm-key',
      baseURL: 'http://localhost:4000/v1',
      modelKey: 'text-embedding-3-small'
    });

    expect(result).toBeDefined();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-litellm-key',
        baseURL: 'http://localhost:4000/v1'
      })
    );
  });

  it('should use default proxy URL for embeddings', async () => {
    const { EmbeddingProvider } = await import('../EmbeddingProvider');
    const provider = new EmbeddingProvider();

    await provider.getEmbeddingModel({
      provider: 'litellm',
      apiKey: 'sk-key',
      modelKey: 'text-embedding-3-small'
    });

    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://localhost:4000/v1'
      })
    );
  });
});
