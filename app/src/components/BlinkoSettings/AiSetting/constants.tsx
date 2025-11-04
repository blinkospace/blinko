import { Icon } from '@/components/Common/Iconify/icons';
import { ModelCapabilities } from '@server/aiServer/types';

export const CAPABILITY_ICONS = {
  inference: <Icon icon="hugeicons:chat" width="16" height="16" />,
  tools: <Icon icon="hugeicons:ai-beautify" width="16" height="16" />,
  image: <Icon icon="hugeicons:view" width="16" height="16" />,
  imageGeneration: <Icon icon="hugeicons:image-01" width="16" height="16" />,
  video: <Icon icon="hugeicons:video-01" width="16" height="16" />,
  audio: <Icon icon="mingcute:voice-line" width="16" height="16" />,
  embedding: <Icon icon="hugeicons:search-list-02" width="16" height="16" />,
  rerank: <Icon icon="hugeicons:arrow-up-down" width="16" height="16" />
};

export const CAPABILITY_LABELS = {
  inference: 'Chat',
  tools: 'Tools',
  image: 'Vision',
  imageGeneration: 'Image',
  video: 'Video',
  audio: 'Audio',
  embedding: 'Embedding',
  rerank: 'Rerank'
};

export const CAPABILITY_COLORS = {
  image: 'primary',
  tools: 'secondary',
  inference: 'success',
  imageGeneration: 'warning',
  video: 'danger',
  audio: 'success',
  embedding: 'warning',
  rerank: 'secondary'
} as const;

export interface ModelTemplate {
  modelKey: string;
  title: string;
  capabilities: Partial<ModelCapabilities>;
  config?: {
    embeddingDimensions?: number;
  };
}

export const PROVIDER_TEMPLATES = [
  {
    value: 'openai',
    label: 'OpenAI',
    defaultName: 'OpenAI',
    defaultBaseURL: 'https://api.openai.com/v1',
    website: 'https://openai.com',
    docs: 'https://platform.openai.com/docs',
    icon: 'openai',
    description: 'GPT-4, GPT-3.5 and other OpenAI models'
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    defaultName: 'Anthropic',
    defaultBaseURL: 'https://api.anthropic.com',
    website: 'https://anthropic.com',
    docs: 'https://docs.anthropic.com',
    icon: 'anthropic',
    description: 'Claude 3.5 Sonnet, Claude 3 Opus and other Claude models'
  },
  {
    value: 'azure',
    label: 'Azure OpenAI',
    defaultName: 'Azure OpenAI',
    defaultBaseURL: 'https://your-resource-name.openai.azure.com',
    website: 'https://azure.microsoft.com/en-us/products/ai-services/openai-service',
    docs: 'https://docs.microsoft.com/en-us/azure/cognitive-services/openai/',
    icon: 'azure',
    description: 'OpenAI models hosted on Microsoft Azure'
  },
  {
    value: 'google',
    label: 'Google AI',
    defaultName: 'Google AI',
    defaultBaseURL: 'https://generativelanguage.googleapis.com',
    website: 'https://ai.google.dev',
    docs: 'https://ai.google.dev/docs',
    icon: 'google',
    description: 'Gemini Pro, Gemini Flash and other Google models'
  },
  {
    value: 'ollama',
    label: 'Ollama',
    defaultName: 'Ollama',
    defaultBaseURL: 'http://localhost:11434',
    website: 'https://ollama.ai',
    docs: 'https://ollama.ai/docs',
    icon: 'ollama',
    description: 'Run large language models locally'
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    defaultName: 'OpenRouter',
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    website: 'https://openrouter.ai',
    docs: 'https://openrouter.ai/docs',
    icon: 'openrouter',
    description: 'Access to multiple AI models through one API'
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    defaultName: 'DeepSeek',
    defaultBaseURL: 'https://api.deepseek.com',
    website: 'https://www.deepseek.com',
    docs: 'https://api-docs.deepseek.com',
    icon: 'deepseek',
    description: 'DeepSeek AI models'
  },
  {
    value: 'siliconflow',
    label: 'SiliconFlow',
    defaultName: 'SiliconFlow',
    defaultBaseURL: 'https://api.siliconflow.cn/v1',
    website: 'https://siliconflow.cn',
    docs: 'https://docs.siliconflow.cn',
    icon: 'siliconflow',
    description: 'High-performance AI inference platform'
  },
  {
    value: 'grok',
    label: 'Grok (X.AI)',
    defaultName: 'Grok',
    defaultBaseURL: 'https://api.x.ai',
    website: 'https://x.ai',
    docs: 'https://docs.x.ai',
    icon: 'grok',
    description: 'Grok AI by X.AI'
  },
  {
    value: 'voyageai',
    label: 'Voyage AI',
    defaultName: 'Voyage AI',
    defaultBaseURL: 'https://api.voyageai.com/v1',
    website: 'https://www.voyageai.com',
    docs: 'https://docs.voyageai.com',
    icon: 'voyageai',
    description: 'High-quality embedding models for retrieval and search'
  }
];

export const DEFAULT_MODEL_TEMPLATES: ModelTemplate[] = [
  // OpenAI Models
  { modelKey: 'gpt-4o', title: 'GPT-4o', capabilities: { inference: true, tools: true, image: true } },
  { modelKey: 'gpt-4o-mini', title: 'GPT-4o Mini', capabilities: { inference: true, tools: true, image: true } },
  { modelKey: 'gpt-4-turbo', title: 'GPT-4 Turbo', capabilities: { inference: true, tools: true, image: true } },
  { modelKey: 'gpt-4-turbo-preview', title: 'GPT-4 Turbo Preview', capabilities: { inference: true, tools: true } },
  { modelKey: 'gpt-4', title: 'GPT-4', capabilities: { inference: true, tools: true } },
  { modelKey: 'gpt-4-vision-preview', title: 'GPT-4 Vision Preview', capabilities: { inference: true, image: true } },
  { modelKey: 'gpt-3.5-turbo', title: 'GPT-3.5 Turbo', capabilities: { inference: true, tools: true } },
  { modelKey: 'gpt-3.5-turbo-instruct', title: 'GPT-3.5 Turbo Instruct', capabilities: { inference: true } },
  { modelKey: 'text-embedding-3-large', title: 'Text Embedding 3 Large', capabilities: { embedding: true }, config: { embeddingDimensions: 3072 } },
  { modelKey: 'text-embedding-3-small', title: 'Text Embedding 3 Small', capabilities: { embedding: true }, config: { embeddingDimensions: 1536 } },
  { modelKey: 'text-embedding-ada-002', title: 'Text Embedding Ada 002', capabilities: { embedding: true }, config: { embeddingDimensions: 1536 } },
  { modelKey: 'dall-e-3', title: 'DALL-E 3', capabilities: { imageGeneration: true } },
  { modelKey: 'dall-e-2', title: 'DALL-E 2', capabilities: { imageGeneration: true } },
  { modelKey: 'tts-1', title: 'TTS 1', capabilities: { audio: true } },
  { modelKey: 'tts-1-hd', title: 'TTS 1 HD', capabilities: { audio: true } },

  // Anthropic Models
  { modelKey: 'claude-3-5-sonnet-20241022', title: 'Claude 3.5 Sonnet', capabilities: { inference: true, tools: true, image: true } },
  { modelKey: 'claude-3-5-haiku-20241022', title: 'Claude 3.5 Haiku', capabilities: { inference: true, tools: true, image: true } },
  { modelKey: 'claude-3-opus-20240229', title: 'Claude 3 Opus', capabilities: { inference: true, tools: true, image: true } },
  { modelKey: 'claude-3-sonnet-20240229', title: 'Claude 3 Sonnet', capabilities: { inference: true, tools: true, image: true } },
  { modelKey: 'claude-3-haiku-20240307', title: 'Claude 3 Haiku', capabilities: { inference: true, tools: true, image: true } },
  { modelKey: 'claude-2.1', title: 'Claude 2.1', capabilities: { inference: true } },
  { modelKey: 'claude-2.0', title: 'Claude 2.0', capabilities: { inference: true } },
  { modelKey: 'claude-instant-1.2', title: 'Claude Instant 1.2', capabilities: { inference: true } },

  // Google Models
  { modelKey: 'gemini-1.5-pro', title: 'Gemini 1.5 Pro', capabilities: { inference: true, tools: true, image: true, video: true, audio: true } },
  { modelKey: 'gemini-1.5-flash', title: 'Gemini 1.5 Flash', capabilities: { inference: true, tools: true, image: true, video: true, audio: true } },
  { modelKey: 'gemini-pro', title: 'Gemini Pro', capabilities: { inference: true, tools: true } },
  { modelKey: 'gemini-pro-vision', title: 'Gemini Pro Vision', capabilities: { inference: true, image: true } },
  { modelKey: 'text-embedding-004', title: 'Text Embedding 004', capabilities: { embedding: true }, config: { embeddingDimensions: 768 } },
  { modelKey: 'text-embedding-gecko', title: 'Text Embedding Gecko', capabilities: { embedding: true }, config: { embeddingDimensions: 768 } },

  // Meta Llama Models
  { modelKey: 'llama-3.1-405b-instruct', title: 'Llama 3.1 405B Instruct', capabilities: { inference: true, tools: true } },
  { modelKey: 'llama-3.1-70b-instruct', title: 'Llama 3.1 70B Instruct', capabilities: { inference: true, tools: true } },
  { modelKey: 'llama-3.1-8b-instruct', title: 'Llama 3.1 8B Instruct', capabilities: { inference: true, tools: true } },
  { modelKey: 'llama-3-70b-instruct', title: 'Llama 3 70B Instruct', capabilities: { inference: true, tools: true } },
  { modelKey: 'llama-3-8b-instruct', title: 'Llama 3 8B Instruct', capabilities: { inference: true, tools: true } },
  { modelKey: 'llama-2-70b-chat', title: 'Llama 2 70B Chat', capabilities: { inference: true } },
  { modelKey: 'llama-2-13b-chat', title: 'Llama 2 13B Chat', capabilities: { inference: true } },
  { modelKey: 'llama-2-7b-chat', title: 'Llama 2 7B Chat', capabilities: { inference: true } },

  // Mistral Models
  { modelKey: 'mistral-large-2407', title: 'Mistral Large 2407', capabilities: { inference: true, tools: true } },
  { modelKey: 'mistral-large-2402', title: 'Mistral Large 2402', capabilities: { inference: true, tools: true } },
  { modelKey: 'mistral-medium', title: 'Mistral Medium', capabilities: { inference: true } },
  { modelKey: 'mistral-small', title: 'Mistral Small', capabilities: { inference: true } },
  { modelKey: 'mistral-tiny', title: 'Mistral Tiny', capabilities: { inference: true } },
  { modelKey: 'mixtral-8x7b-instruct', title: 'Mixtral 8x7B Instruct', capabilities: { inference: true } },
  { modelKey: 'mixtral-8x22b-instruct', title: 'Mixtral 8x22B Instruct', capabilities: { inference: true } },
  { modelKey: 'mistral-7b-instruct', title: 'Mistral 7B Instruct', capabilities: { inference: true } },

  // Qwen Models
  { modelKey: 'qwen2.5-72b-instruct', title: 'Qwen 2.5 72B Instruct', capabilities: { inference: true, tools: true } },
  { modelKey: 'qwen2.5-32b-instruct', title: 'Qwen 2.5 32B Instruct', capabilities: { inference: true, tools: true } },
  { modelKey: 'qwen2.5-14b-instruct', title: 'Qwen 2.5 14B Instruct', capabilities: { inference: true, tools: true } },
  { modelKey: 'qwen2.5-7b-instruct', title: 'Qwen 2.5 7B Instruct', capabilities: { inference: true, tools: true } },
  { modelKey: 'qwen2-72b-instruct', title: 'Qwen 2 72B Instruct', capabilities: { inference: true, tools: true } },
  { modelKey: 'qwen2-7b-instruct', title: 'Qwen 2 7B Instruct', capabilities: { inference: true, tools: true } },
  { modelKey: 'qwen-vl-plus', title: 'Qwen VL Plus', capabilities: { inference: true, image: true } },
  { modelKey: 'qwen-vl-max', title: 'Qwen VL Max', capabilities: { inference: true, image: true } },

  // DeepSeek Models
  { modelKey: 'deepseek-chat', title: 'DeepSeek Chat', capabilities: { inference: true, tools: true } },
  { modelKey: 'deepseek-coder', title: 'DeepSeek Coder', capabilities: { inference: true, tools: true } },
  { modelKey: 'deepseek-v2.5', title: 'DeepSeek V2.5', capabilities: { inference: true, tools: true } },

  // Yi Models
  { modelKey: 'yi-large', title: 'Yi Large', capabilities: { inference: true, tools: true } },
  { modelKey: 'yi-medium', title: 'Yi Medium', capabilities: { inference: true } },
  { modelKey: 'yi-vision', title: 'Yi Vision', capabilities: { inference: true, image: true } },

  // Cohere Models
  { modelKey: 'command-r-plus', title: 'Command R+', capabilities: { inference: true, tools: true } },
  { modelKey: 'command-r', title: 'Command R', capabilities: { inference: true, tools: true } },
  { modelKey: 'command', title: 'Command', capabilities: { inference: true } },
  { modelKey: 'command-light', title: 'Command Light', capabilities: { inference: true } },
  { modelKey: 'embed-english-v3.0', title: 'Embed English v3.0', capabilities: { embedding: true } },
  { modelKey: 'embed-multilingual-v3.0', title: 'Embed Multilingual v3.0', capabilities: { embedding: true } },
  { modelKey: 'rerank-english-v3.0', title: 'Rerank English v3.0', capabilities: { rerank: true } },
  { modelKey: 'rerank-multilingual-v3.0', title: 'Rerank Multilingual v3.0', capabilities: { rerank: true } },

  // Popular Ollama Models
  { modelKey: 'llama3.1:70b', title: 'Llama 3.1 70B (Ollama)', capabilities: { inference: true, tools: true } },
  { modelKey: 'llama3.1:8b', title: 'Llama 3.1 8B (Ollama)', capabilities: { inference: true, tools: true } },
  { modelKey: 'qwen2.5:72b', title: 'Qwen 2.5 72B (Ollama)', capabilities: { inference: true, tools: true } },
  { modelKey: 'qwen2.5:32b', title: 'Qwen 2.5 32B (Ollama)', capabilities: { inference: true, tools: true } },
  { modelKey: 'qwen2.5:14b', title: 'Qwen 2.5 14B (Ollama)', capabilities: { inference: true, tools: true } },
  { modelKey: 'qwen2.5:7b', title: 'Qwen 2.5 7B (Ollama)', capabilities: { inference: true, tools: true } },
  { modelKey: 'mistral-nemo:12b', title: 'Mistral Nemo 12B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'codestral:22b', title: 'Codestral 22B (Ollama)', capabilities: { inference: true, tools: true } },
  { modelKey: 'codeqwen:7b', title: 'CodeQwen 7B (Ollama)', capabilities: { inference: true, tools: true } },
  { modelKey: 'deepseek-coder-v2:16b', title: 'DeepSeek Coder V2 16B (Ollama)', capabilities: { inference: true, tools: true } },
  { modelKey: 'phi3.5:3.8b', title: 'Phi 3.5 3.8B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'gemma2:27b', title: 'Gemma 2 27B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'gemma2:9b', title: 'Gemma 2 9B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'llava:34b', title: 'LLaVA 34B (Ollama)', capabilities: { inference: true, image: true } },
  { modelKey: 'llava:13b', title: 'LLaVA 13B (Ollama)', capabilities: { inference: true, image: true } },
  { modelKey: 'llava:7b', title: 'LLaVA 7B (Ollama)', capabilities: { inference: true, image: true } },
  { modelKey: 'bakllava:7b', title: 'BakLLaVA 7B (Ollama)', capabilities: { inference: true, image: true } },
  { modelKey: 'dolphin-llama3:70b', title: 'Dolphin Llama 3 70B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'dolphin-llama3:8b', title: 'Dolphin Llama 3 8B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'nous-hermes2:34b', title: 'Nous Hermes 2 34B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'wizardlm2:7b', title: 'WizardLM 2 7B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'neural-chat:7b', title: 'Neural Chat 7B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'starling-lm:7b', title: 'Starling LM 7B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'openchat:7b', title: 'OpenChat 7B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'solar:10.7b', title: 'Solar 10.7B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'orca-mini:3b', title: 'Orca Mini 3B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'tinyllama:1.1b', title: 'TinyLlama 1.1B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'stable-code:3b', title: 'Stable Code 3B (Ollama)', capabilities: { inference: true } },
  { modelKey: 'nomic-embed-text', title: 'Nomic Embed Text (Ollama)', capabilities: { embedding: true }, config: { embeddingDimensions: 768 } },
  { modelKey: 'mxbai-embed-large', title: 'MxBai Embed Large (Ollama)', capabilities: { embedding: true }, config: { embeddingDimensions: 1024 } },
  { modelKey: 'all-minilm:l6-v2', title: 'All MiniLM L6 v2 (Ollama)', capabilities: { embedding: true }, config: { embeddingDimensions: 384 } },

  // Azure OpenAI Models
  { modelKey: 'gpt-4o-azure', title: 'GPT-4o (Azure)', capabilities: { inference: true, tools: true, image: true } },
  { modelKey: 'gpt-4-turbo-azure', title: 'GPT-4 Turbo (Azure)', capabilities: { inference: true, tools: true, image: true } },
  { modelKey: 'gpt-35-turbo-azure', title: 'GPT-3.5 Turbo (Azure)', capabilities: { inference: true, tools: true } },

  // Perplexity Models
  { modelKey: 'llama-3.1-sonar-large-128k-online', title: 'Llama 3.1 Sonar Large Online', capabilities: { inference: true, tools: true } },
  { modelKey: 'llama-3.1-sonar-small-128k-online', title: 'Llama 3.1 Sonar Small Online', capabilities: { inference: true, tools: true } },
  { modelKey: 'llama-3.1-sonar-large-128k-chat', title: 'Llama 3.1 Sonar Large Chat', capabilities: { inference: true, tools: true } },
  { modelKey: 'llama-3.1-sonar-small-128k-chat', title: 'Llama 3.1 Sonar Small Chat', capabilities: { inference: true, tools: true } },

  // Voyage AI Models
  { modelKey: 'voyage-3', title: 'Voyage 3', capabilities: { embedding: true }, config: { embeddingDimensions: 1024 } },
  { modelKey: 'voyage-3-lite', title: 'Voyage 3 Lite', capabilities: { embedding: true }, config: { embeddingDimensions: 512 } },
  { modelKey: 'voyage-large-2-instruct', title: 'Voyage Large 2 Instruct', capabilities: { embedding: true }, config: { embeddingDimensions: 1536 } },
  { modelKey: 'voyage-law-2', title: 'Voyage Law 2', capabilities: { embedding: true }, config: { embeddingDimensions: 1024 } },
  { modelKey: 'voyage-code-2', title: 'Voyage Code 2', capabilities: { embedding: true }, config: { embeddingDimensions: 1536 } },
  { modelKey: 'voyage-large-2', title: 'Voyage Large 2', capabilities: { embedding: true }, config: { embeddingDimensions: 1536 } },
  { modelKey: 'voyage-2', title: 'Voyage 2', capabilities: { embedding: true }, config: { embeddingDimensions: 1024 } },
  { modelKey: 'voyage-lite-02-instruct', title: 'Voyage Lite 02 Instruct', capabilities: { embedding: true }, config: { embeddingDimensions: 1024 } },
  { modelKey: 'voyage-multilingual-2', title: 'Voyage Multilingual 2', capabilities: { embedding: true }, config: { embeddingDimensions: 1024 } },
  { modelKey: 'voyage-finance-2', title: 'Voyage Finance 2', capabilities: { embedding: true }, config: { embeddingDimensions: 1024 } },
  { modelKey: 'rerank-2', title: 'Rerank 2', capabilities: { rerank: true } },
  { modelKey: 'rerank-lite-1', title: 'Rerank Lite 1', capabilities: { rerank: true } }
];
