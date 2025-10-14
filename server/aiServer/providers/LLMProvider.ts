import { LanguageModelV1, ProviderV1 } from '@ai-sdk/provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOllama } from 'ollama-ai-provider';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createXai } from '@ai-sdk/xai';
import { createAzure } from '@ai-sdk/azure';
import { BaseProvider } from './BaseProvider';
import { AuthenticationConfig, buildAuthHeaders } from '../authTypes';

interface LLMConfig {
  provider: string;
  apiKey?: any;
  baseURL?: any;
  modelKey: string;
  apiVersion?: any;
  auth?: AuthenticationConfig;
}

export class LLMProvider extends BaseProvider {
  async getLanguageModel(config: LLMConfig): Promise<LanguageModelV1> {
    await this.ensureInitialized();

    // Use enhanced authentication if provided
    const apiKey = config.auth?.apiKey || config.apiKey;
    const baseURL = config.baseURL;

    switch (config.provider.toLowerCase()) {
      case 'openai':
        return createOpenAI({
          apiKey: apiKey,
          baseURL: baseURL || undefined,
          fetch: this.proxiedFetch
        }).languageModel(config.modelKey);

      case 'anthropic':
        return createAnthropic({
          apiKey: apiKey,
          baseURL: baseURL || undefined,
          fetch: this.proxiedFetch
        }).languageModel(config.modelKey);

      case 'gemini':
      case 'google':
        return createGoogleGenerativeAI({
          apiKey: apiKey,
          fetch: this.proxiedFetch
        }).languageModel(config.modelKey);

      case 'ollama':
        return createOllama({
          baseURL: baseURL?.trim().replace(/\/api$/, '') + '/api' || undefined,
          fetch: this.proxiedFetch
        }).languageModel(config.modelKey);

      case 'deepseek':
        return createDeepSeek({
          apiKey: apiKey,
          fetch: this.proxiedFetch
        }).languageModel(config.modelKey);

      case 'openrouter':
        return createOpenRouter({
          apiKey: apiKey,
          fetch: this.proxiedFetch
        }).languageModel(config.modelKey);

      case 'grok':
      case 'xai':
        return createXai({
          apiKey: apiKey,
          fetch: this.proxiedFetch
        }).languageModel(config.modelKey);

      case 'azureopenai':
      case 'azure':
        return createAzure({
          apiKey: apiKey,
          baseURL: baseURL || undefined,
          apiVersion: config.apiVersion || undefined,
          fetch: this.proxiedFetch
        }).languageModel(config.modelKey);

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
          }).languageModel(config.modelKey);
        }

        // Fallback to OpenAI-compatible API with basic auth
        return createOpenAI({
          apiKey: apiKey,
          baseURL: baseURL || undefined,
          fetch: this.proxiedFetch
        }).languageModel(config.modelKey);
    }
  }
}