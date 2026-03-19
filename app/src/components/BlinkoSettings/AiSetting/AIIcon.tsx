import {
  OpenAI,
  Anthropic,
  Microsoft,
  Google,
  Ollama,
  OpenRouter,
  DeepSeek,
  Grok,
  SiliconCloud,
  Meta,
  Qwen,
  BAAI,
  Voyage,
  Jina,
  Cohere,
  HuggingFace,
  Mistral,
  Perplexity,
  Together,
  LangChain,
  LlamaIndex,
  Alibaba
} from '@lobehub/icons';
import { Icon } from '@/components/Common/Iconify/icons';

// Provider Icon Component
interface ProviderIconProps {
  provider: string;
  className?: string;
}

const PROVIDER_ICONS: Record<string, React.ComponentType<any>> = {
  openai: OpenAI,
  anthropic: Anthropic,
  azure: Microsoft.Color,
  azureopenai: Microsoft.Color,
  google: Google.Color,
  gemini: Google.Color,
  ollama: Ollama,
  openrouter: OpenRouter,
  deepseek: DeepSeek.Color,
  grok: Grok,
  xai: Grok,
  siliconflow: SiliconCloud.Color,
  voyageai: Voyage.Color,
  voyage: Voyage.Color,
  custom: OpenAI,
};

export function ProviderIcon({ provider, className = "w-6 h-6" }: ProviderIconProps) {
  const normalizedProvider = provider.toLowerCase();
  const IconComponent = PROVIDER_ICONS[normalizedProvider] || PROVIDER_ICONS.custom;

  return <IconComponent className={className} />;
}

// Model Icon Component
interface ModelIconProps {
  modelName: string;
  className?: string;
}

const MODEL_ICON_MAP: Array<{
  keywords: string[];
  icon: React.ComponentType<any>;
}> = [
  // OpenAI models
  {
    keywords: ['gpt', 'openai', 'text-davinci', 'text-embedding'],
    icon: OpenAI
  },
  // Anthropic models
  {
    keywords: ['claude', 'anthropic'],
    icon: Anthropic
  },
  // Google models
  {
    keywords: ['gemini', 'google', 'bison', 'palm'],
    icon: Google.Color
  },
  // Meta models
  {
    keywords: ['llama', 'meta', 'code-llama'],
    icon: Meta.Color
  },
  // Microsoft models
  {
    keywords: ['azure', 'microsoft'],
    icon: Microsoft.Color
  },
  // Qwen models
  {
    keywords: ['qwen', 'tongyi'],
    icon: Qwen.Color
  },
  // DeepSeek models
  {
    keywords: ['deepseek'],
    icon: DeepSeek.Color
  },
  // Grok models
  {
    keywords: ['grok', 'xai'],
    icon: Grok
  },
  // Ollama models
  {
    keywords: ['ollama'],
    icon: Ollama
  },
  // OpenRouter models
  {
    keywords: ['openrouter'],
    icon: OpenRouter
  },
  // SiliconFlow models
  {
    keywords: ['siliconflow', 'silicon'],
    icon: SiliconCloud.Color
  },
  // BAAI models (Beijing Academy of Artificial Intelligence)
  {
    keywords: ['baai', 'bge', 'bge-large', 'bge-small', 'bge-base', 'bge-m3', 'bge-reranker'],
    icon: BAAI
  },
  // Sentence Transformers / HuggingFace models
  {
    keywords: ['sentence-transformers', 'all-mpnet', 'all-minilm', 'msmarco', 'distilbert', 'bert-base', 'huggingface', 'hf', 'instructor', 'e5-large', 'e5-base', 'e5-small'],
    icon: HuggingFace.Color
  },
  // Cohere embedding models
  {
    keywords: ['embed-english', 'embed-multilingual', 'cohere'],
    icon: Cohere.Color
  },
  // Voyage AI models
  {
    keywords: ['voyage', 'voyage-large', 'voyage-code', 'voyage-lite', 'voyage-law', 'voyage-multilingual', 'voyage-finance', 'rerank'],
    icon: Voyage.Color
  },
  // Jina AI models
  {
    keywords: ['jina', 'jina-embeddings'],
    icon: Jina
  },
  // Mistral models
  {
    keywords: ['mistral', 'mixtral'],
    icon: Mistral.Color
  },
  // Perplexity models
  {
    keywords: ['perplexity', 'pplx'],
    icon: Perplexity.Color
  },
  // Together AI models
  {
    keywords: ['together', 'togetherai'],
    icon: Together.Color
  },
  // Alibaba models
  {
    keywords: ['text2vec', 'gte-large', 'gte-base', 'gte-small', 'alibaba'],
    icon: Alibaba.Color
  },
  // MiniMax models
  {
    keywords: ['minimax'],
    icon: OpenAI
  },
  // LangChain models
  {
    keywords: ['langchain', 'langchain-community'],
    icon: LangChain
  },
  // LlamaIndex models
  {
    keywords: ['llamaindex', 'llama-index'],
    icon: LlamaIndex
  }
];

const DefaultModelIcon = OpenAI

export function ModelIcon({ modelName, className = "w-6 h-6" }: ModelIconProps) {
  const normalizedModelName = modelName.toLowerCase();

  const matchedIcon = MODEL_ICON_MAP.find(({ keywords }) =>
    keywords.some(keyword => normalizedModelName.includes(keyword))
  );

  const IconComponent = matchedIcon?.icon || DefaultModelIcon;

  return <IconComponent className={className} />;
}

// Export mapping tables for reuse
export { PROVIDER_ICONS, MODEL_ICON_MAP };