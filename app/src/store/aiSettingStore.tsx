import { makeAutoObservable } from 'mobx';
import { Store } from './standard/base';
import { PromiseCall, PromiseState } from './standard/PromiseState';
import { api } from '@/lib/trpc';
import { aiProviders, aiModels } from '@shared/lib/prismaZodType';
import { DEFAULT_MODEL_TEMPLATES } from '@/components/BlinkoSettings/AiSetting/constants';
import { RootStore } from './root';
import { ToastPlugin } from './module/Toast/Toast';
import i18n from '@/lib/i18n';
import { defaultUrlTransform } from 'react-markdown';

// Enhanced authentication configuration types
export type AuthenticationType = 'bearer' | 'api-key' | 'custom' | 'none';

export interface AuthenticationConfig {
  type: AuthenticationType;
  apiKey?: string;
  headerName?: string;
  customHeaders?: { [key: string]: string };
  options?: {
    includeContentType?: boolean;
    userAgent?: string;
    queryParams?: { [key: string]: string };
  };
}

export interface ModelCapabilities {
    inference: boolean;
    tools: boolean;
    image: boolean;
    imageGeneration: boolean;
    video: boolean;
    audio: boolean;
    embedding: boolean;
    rerank: boolean;
}

export interface ProviderModel {
    id: string;
    name: string;
    description?: string;
    capabilities: ModelCapabilities;
}

export type AiProvider = aiProviders & { models?: AiModel[]; authConfig?: AuthenticationConfig };
export type AiModel = aiModels & { provider?: AiProvider; capabilities: ModelCapabilities };

export class AiSettingStore implements Store {
    sid = 'AiSettingStore'
    constructor() {
        makeAutoObservable(this);
    }

    // Provider management
    aiProviders = new PromiseState({
        function: async () => {
            const res = await api.ai.getAllProviders.query();
            return res;
        },
    });

    // Model management
    allModels = new PromiseState({
        function: async () => {
            const res = await api.ai.getAllModels.query();
            return res.map(model => ({
                ...model,
                capabilities: model.capabilities as any
            }));
        },
    });

    // Provider CRUD operations
    createProvider = new PromiseState({
        function: async (data: { title: string; provider: string; baseURL?: string; apiKey?: string; config?: any; sortOrder: number }) => {
            await PromiseCall(api.ai.createProvider.mutate(data));
            await this.aiProviders.call();
        },
    });

    updateProvider = new PromiseState({
        function: async (data: { id: number; title?: string; provider?: string; baseURL?: string; apiKey?: string; config?: any; sortOrder?: number }) => {
            await PromiseCall(api.ai.updateProvider.mutate(data));
            await this.aiProviders.call();
        },
    });

    deleteProvider = new PromiseState({
        function: async (id: number) => {
            await PromiseCall(api.ai.deleteProvider.mutate({ id }));
            await this.aiProviders.call();
        },
    });

    // Model CRUD operations
    createModel = new PromiseState({
        function: async (data: { title: string; modelKey: string; providerId: number; capabilities: ModelCapabilities; config?: any; sortOrder: number }) => {
            await PromiseCall(api.ai.createModel.mutate(data));
            await this.aiProviders.call();
            await this.allModels.call();
        },
    });

    updateModel = new PromiseState({
        function: async (data: { id: number; title?: string; modelKey?: string; capabilities?: ModelCapabilities; config?: any; sortOrder?: number }) => {
            await PromiseCall(api.ai.updateModel.mutate(data));
            await this.aiProviders.call();
            await this.allModels.call();
        },
    });

    deleteModel = new PromiseState({
        function: async (data: { id: number }) => {
            await PromiseCall(api.ai.deleteModel.mutate({ id: data.id }));
            await this.aiProviders.call();
            await this.allModels.call();
        },
    });

    createModelsFromProvider = new PromiseState({
        function: async (data: { providerId: number; models: { modelKey: string; title: string; capabilities: ModelCapabilities; config?: any }[] }) => {
            await PromiseCall(api.ai.createModelsFromProvider.mutate(data as any));
            await this.aiProviders.call();
            await this.allModels.call();
        },
    });

    // Provider model fetching with enhanced authentication support
    fetchProviderModels = new PromiseState({
        successMsg: i18n.t('model-list-updated'),
        function: async (provider: AiProvider) => {
            try {
                let modelList: any = [];
                const authConfig = provider.authConfig;

                // Helper function to build headers from authentication config
                const buildHeaders = (): { [key: string]: string } => {
                    const headers: { [key: string]: string } = {};

                    if (!authConfig || authConfig.type === 'none') {
                        return headers;
                    }

                    switch (authConfig.type) {
                        case 'bearer':
                            if (authConfig.apiKey) {
                                const headerName = authConfig.headerName || 'Authorization';
                                headers[headerName] = `Bearer ${authConfig.apiKey}`;
                            }
                            break;

                        case 'api-key':
                            if (authConfig.apiKey && authConfig.headerName) {
                                headers[authConfig.headerName] = authConfig.apiKey;
                            }
                            break;

                        case 'custom':
                            if (authConfig.customHeaders) {
                                Object.assign(headers, authConfig.customHeaders);
                            }
                            break;
                    }

                    // Add content-type if specified
                    if (authConfig.options?.includeContentType) {
                        headers['Content-Type'] = 'application/json';
                    }

                    // Add user agent if specified
                    if (authConfig.options?.userAgent) {
                        headers['User-Agent'] = authConfig.options.userAgent;
                    }

                    return headers;
                };

                // Helper function to build URL with query parameters
                const buildUrl = (baseUrl: string, path: string): string => {
                    const url = new URL(path, baseUrl);

                    if (authConfig?.options?.queryParams) {
                        Object.entries(authConfig.options.queryParams).forEach(([key, value]) => {
                            url.searchParams.append(key, value);
                        });
                    }

                    return url.toString();
                };

                switch (provider.provider) {
                    case 'ollama': {
                        const endpoint = provider.baseURL || 'http://127.0.0.1:11434';
                        const response = await fetch(buildUrl(endpoint, '/api/tags'));
                        const data = await response.json();
                        modelList = data.models.map((model: any) => ({
                            id: model.name,
                            name: model.name,
                            description: model.description || '',
                            capabilities: this.inferModelCapabilities(model.name)
                        }));
                        break;
                    }
                    case 'openai': {
                        const endpoint = provider.baseURL || 'https://api.openai.com/v1';
                        const headers = buildHeaders();

                        // If no auth config, fall back to legacy auth
                        if (!authConfig && provider.apiKey) {
                            headers['Authorization'] = `Bearer ${provider.apiKey}`;
                        }

                        const response = await fetch(buildUrl(endpoint, '/models'), { headers });
                        const data = await response.json();
                        modelList = data.data.map((model: any) => ({
                            id: model.id,
                            name: model.id,
                            description: '',
                            capabilities: this.inferModelCapabilities(model.id)
                        }));
                        break;
                    }
                    case 'anthropic': {
                        modelList = [
                            { id: 'claude-3-5-sonnet-20241022', name: 'claude-3-5-sonnet-20241022', capabilities: this.inferModelCapabilities('claude-3-5-sonnet-20241022') },
                            { id: 'claude-3-5-sonnet-20240620', name: 'claude-3-5-sonnet-20240620', capabilities: this.inferModelCapabilities('claude-3-5-sonnet-20240620') },
                            { id: 'claude-3-5-haiku-20241022', name: 'claude-3-5-haiku-20241022', capabilities: this.inferModelCapabilities('claude-3-5-haiku-20241022') },
                            { id: 'claude-3-opus-20240229', name: 'claude-3-opus-20240229', capabilities: this.inferModelCapabilities('claude-3-opus-20240229') },
                            { id: 'claude-3-sonnet-20240229', name: 'claude-3-sonnet-20240229', capabilities: this.inferModelCapabilities('claude-3-sonnet-20240229') },
                            { id: 'claude-3-haiku-20240307', name: 'claude-3-haiku-20240307', capabilities: this.inferModelCapabilities('claude-3-haiku-20240307') }
                        ];
                        break;
                    }
                    case 'voyageai': {
                        modelList = [
                            { id: 'voyage-3', name: 'voyage-3', capabilities: this.inferModelCapabilities('voyage-3') },
                            { id: 'voyage-3-lite', name: 'voyage-3-lite', capabilities: this.inferModelCapabilities('voyage-3-lite') },
                            { id: 'voyage-finance-2', name: 'voyage-finance-2', capabilities: this.inferModelCapabilities('voyage-finance-2') },
                            { id: 'voyage-multilingual-2', name: 'voyage-multilingual-2', capabilities: this.inferModelCapabilities('voyage-multilingual-2') },
                            { id: 'voyage-law-2', name: 'voyage-law-2', capabilities: this.inferModelCapabilities('voyage-law-2') },
                            { id: 'voyage-code-2', name: 'voyage-code-2', capabilities: this.inferModelCapabilities('voyage-code-2') },
                            { id: 'voyage-large-2-instruct', name: 'voyage-large-2-instruct', capabilities: this.inferModelCapabilities('voyage-large-2-instruct') },
                            { id: 'voyage-large-2', name: 'voyage-large-2', capabilities: this.inferModelCapabilities('voyage-large-2') }
                        ];
                        break;
                    }
                    case 'google': {
                        const endpoint = provider.baseURL || 'https://generativelanguage.googleapis.com/v1beta';
                        const headers = buildHeaders();

                        // If no auth config, fall back to legacy auth with query param
                        let url: string;
                        if (!authConfig && provider.apiKey) {
                            url = `${endpoint}/models?key=${provider.apiKey}`;
                        } else {
                            url = buildUrl(endpoint, '/models');
                        }

                        const response = await fetch(url, { headers });
                        const data = await response.json();
                        modelList = data.models?.map((model: any) => ({
                            id: model.name.replace('models/', ''),
                            name: model.displayName || model.name.replace('models/', ''),
                            description: model.description || '',
                            capabilities: this.inferModelCapabilities(model.name)
                        })) || [];
                        break;
                    }
                    case 'azure': {
                        const endpoint = provider.baseURL;
                        const headers = buildHeaders();

                        // If no auth config, fall back to legacy auth
                        if (!authConfig && provider.apiKey) {
                            headers['api-key'] = provider.apiKey;
                        }

                        const response = await fetch(buildUrl(endpoint, '/openai/models?api-version=2024-02-01'), { headers });
                        const data = await response.json();
                        modelList = data.data.map((model: any) => ({
                            id: model.id,
                            name: model.id,
                            description: '',
                            capabilities: this.inferModelCapabilities(model.id)
                        }));
                        break;
                    }
                    case 'custom':
                    default: {
                        // Enhanced custom provider with flexible authentication
                        if (provider.baseURL) {
                            const endpoint = provider.baseURL;
                            const headers = buildHeaders();

                            // If no auth config, fall back to legacy auth
                            if (!authConfig && provider.apiKey) {
                                headers['Authorization'] = `Bearer ${provider.apiKey}`;
                            }

                            try {
                                const response = await fetch(buildUrl(endpoint, '/models'), { headers });
                                const data = await response.json();

                                // Handle different response formats
                                if (data.data && Array.isArray(data.data)) {
                                    modelList = data.data.map((model: any) => ({
                                        id: model.id,
                                        name: model.id,
                                        description: model.description || '',
                                        capabilities: this.inferModelCapabilities(model.id)
                                    }));
                                } else if (Array.isArray(data)) {
                                    modelList = data.map((model: any) => ({
                                        id: model.id || model.name,
                                        name: model.name || model.id,
                                        description: model.description || '',
                                        capabilities: this.inferModelCapabilities(model.id || model.name)
                                    }));
                                }
                            } catch (error) {
                                console.warn(`Failed to fetch models from ${endpoint}:`, error);
                                // Continue with empty model list
                            }
                        }
                        break;
                    }
                }

                // Save models and auth config to provider config
                const updatedConfig = {
                    ...provider.config,
                    models: modelList,
                    authConfig: authConfig // Save auth config for future use
                };

                await this.updateProvider.call({
                    id: provider.id,
                    config: updatedConfig
                });

                return modelList;
            } catch (error) {
                console.error('Error fetching provider models:', error);
                throw error;
            }
        },
    });

    getProviderModels = (providerId: number): ProviderModel[] => {
        // Get models from provider config stored in database
        const provider = this.aiProviders.value?.find(p => p.id === providerId);
        const configModels = (provider?.config as any)?.models;
        if (configModels && Array.isArray(configModels)) {
            return configModels;
        }

        return [];
    };

    inferModelCapabilities = (modelName: string): ModelCapabilities => {
        const name = modelName.toLowerCase();

        // Try to find exact or partial match in DEFAULT_MODEL_TEMPLATES
        const template = DEFAULT_MODEL_TEMPLATES.find(t =>
            name.includes(t.modelKey.toLowerCase()) ||
            t.modelKey.toLowerCase().includes(name)
        );

        if (template) {
            // Return capabilities from template, ensuring all required fields are present
            return {
                inference: template.capabilities.inference || false,
                tools: template.capabilities.tools || false,
                image: template.capabilities.image || false,
                imageGeneration: template.capabilities.imageGeneration || false,
                video: template.capabilities.video || false,
                audio: template.capabilities.audio || false,
                embedding: template.capabilities.embedding || false,
                rerank: template.capabilities.rerank || false
            };
        }

        // Fallback: Default capabilities for unknown models
        return {
            inference: true,
            tools: false,
            image: false,
            imageGeneration: false,
            video: false,
            audio: false,
            embedding: false,
            rerank: false
        };
    };

    // Getter methods for different model types
    get inferenceModels(): AiModel[] {
        return this.allModels.value?.filter(model => model.capabilities.inference) || [];
    }

    get embeddingModels(): AiModel[] {
        return this.allModels.value?.filter(model => model.capabilities.embedding) || [];
    }

    get audioModels(): AiModel[] {
        return this.allModels.value?.filter(model => model.capabilities.audio) || [];
    }

    get imageModels(): AiModel[] {
        return this.allModels.value?.filter(model => model.capabilities.image) || [];
    }

    get imageGenerationModels(): AiModel[] {
        return this.allModels.value?.filter(model => model.capabilities.imageGeneration) || [];
    }

    get voiceModels(): AiModel[] {
        return this.allModels.value?.filter(model => model.capabilities.audio) || [];
    }

    get rerankModels(): AiModel[] {
        return this.allModels.value?.filter(model => model.capabilities.rerank) || [];
    }
}