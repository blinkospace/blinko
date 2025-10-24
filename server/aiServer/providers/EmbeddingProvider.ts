import { EmbeddingModelV1 } from '@ai-sdk/provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createAzure } from '@ai-sdk/azure';
import { createVoyage } from 'voyage-ai-provider';
import { createOllama } from 'ollama-ai-provider';
import { BaseProvider } from './BaseProvider';
import { AuthenticationConfig, buildAuthHeaders } from '../authTypes';

interface EmbeddingConfig {
  provider: string;
  apiKey?: any;
  baseURL?: any;
  modelKey: string;
  apiVersion?: any;
  auth?: AuthenticationConfig;
}

export class EmbeddingProvider extends BaseProvider {

  async getEmbeddingModel(config: EmbeddingConfig): Promise<EmbeddingModelV1<string>| null> {
    await this.initializeFetch();

    // Use enhanced authentication if provided
    const apiKey = config.auth?.apiKey || config.apiKey;
    const baseURL = config.baseURL;

    switch (config.provider.toLowerCase()) {
      case 'openai':
        return createOpenAI({
          apiKey: apiKey,
          baseURL: baseURL || undefined,
          fetch: this.proxiedFetch
        }).textEmbeddingModel(config.modelKey);

      case 'azureopenai':
        return null;
      case 'azure':
        return createAzure({
          apiKey: apiKey,
          baseURL: baseURL || undefined,
          apiVersion: config.apiVersion || undefined,
          fetch: this.proxiedFetch
        }).textEmbeddingModel(config.modelKey);

      case 'voyageai':
        return createVoyage({
          apiKey: apiKey,
          fetch: this.proxiedFetch
        }).textEmbeddingModel(config.modelKey);

      case 'ollama':
        return createOllama({
          baseURL: baseURL?.trim() || undefined,
          fetch: this.proxiedFetch
        }).textEmbeddingModel(config.modelKey);

      case 'custom':
      default:
        // Enhanced custom provider with flexible authentication
        if (config.auth && config.auth.type !== 'none') {
          // Create custom fetch with enhanced authentication
          const customFetch = async (url: string, options: RequestInit = {}) => {
            const authHeaders = buildAuthHeaders(config.auth!);
            const headers = {
              ...options.headers,
              ...authHeaders
            };

            const fetchOptions = {
              ...options,
              headers
            };

            return this.proxiedFetch ?
              this.proxiedFetch(url, fetchOptions) :
              fetch(url, fetchOptions);
          };

          // Create OpenAI-compatible provider with custom authentication
          return createOpenAI({
            apiKey: apiKey || 'dummy-key', // Required by AI SDK but won't be used in headers
            baseURL: baseURL || undefined,
            fetch: customFetch
          }).textEmbeddingModel(config.modelKey);
        }

        // Fallback to OpenAI-compatible API with basic auth
        return createOpenAI({
          apiKey: apiKey,
          baseURL: baseURL || undefined,
          fetch: this.proxiedFetch
        }).textEmbeddingModel(config.modelKey);
    }
  }
}