import { Icon } from '@/components/Common/Iconify/icons';
import { ModelCapabilities } from '@server/aiServer/types';
// Re-export from shared module for backward compatibility
export { DEFAULT_MODEL_TEMPLATES, inferModelCapabilities } from '@shared/lib/modelTemplates';

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
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1',
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
