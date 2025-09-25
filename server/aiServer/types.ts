export interface ModelCapabilities {
  inference: boolean;
  tools: boolean;
  image: boolean;
  imageGeneration: boolean;
  video: boolean;
  audio: boolean;
  embedding: boolean;
  rerank: boolean;
  realTimeVoice: boolean;
}

export interface AiProviderWithModels {
  id: number;
  title: string;
  provider: string;
  baseURL?: string;
  apiKey?: string;
  config?: any;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  models: AiModelWithProvider[];
}

export interface AiModelWithProvider {
  id: number;
  providerId: number;
  title: string;
  modelKey: string;
  capabilities: ModelCapabilities;
  config?: any;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  provider?: AiProviderWithModels;
}

export interface ProviderModelList {
  providerId: number;
  models: {
    id: string;
    name: string;
    description?: string;
    capabilities?: Partial<ModelCapabilities>;
  }[];
}