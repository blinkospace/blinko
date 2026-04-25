import { EmbeddingModelV1 } from '@ai-sdk/provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createAzure } from '@ai-sdk/azure';
import { createVoyage } from 'voyage-ai-provider';
import { createOllama } from 'ollama-ai-provider';
import { BaseProvider } from './BaseProvider';

interface EmbeddingConfig {
  provider: string;
  apiKey?: any;
  baseURL?: any;
  modelKey: string;
  apiVersion?: any;
}

export class EmbeddingProvider extends BaseProvider {

  async getEmbeddingModel(config: EmbeddingConfig): Promise<EmbeddingModelV1<string>| null> {
    await this.initializeFetch();

    switch (config.provider.toLowerCase()) {
      case 'openai':
        return createOpenAI({
          apiKey: config.apiKey,
          baseURL: config.baseURL || undefined,
          fetch: this.proxiedFetch
        }).textEmbeddingModel(config.modelKey);

      case 'azureopenai':
        return null;
      case 'azure':
        return createAzure({
          apiKey: config.apiKey,
          baseURL: config.baseURL || undefined,
          apiVersion: config.apiVersion || undefined,
          fetch: this.proxiedFetch
        }).textEmbeddingModel(config.modelKey);

      case 'voyageai':
        return createVoyage({
          apiKey: config.apiKey,
          fetch: this.proxiedFetch
        }).textEmbeddingModel(config.modelKey);

      case 'ollama':
        return createOllama({
          baseURL: config.baseURL?.trim().replace(/\/api$/, '') + '/api' || undefined,
          fetch: this.proxiedFetch,
          headers: config.apiKey?.trim() ? { 'Authorization': `Bearer ${config.apiKey.trim()}`} : undefined
        }).textEmbeddingModel(config.modelKey);

      case 'custom':
      default:
        // Default to OpenAI-compatible API
        return createOpenAI({
          apiKey: config.apiKey,
          baseURL: config.baseURL || undefined,
          fetch: this.proxiedFetch
        }).textEmbeddingModel(config.modelKey);
    }
  }
}