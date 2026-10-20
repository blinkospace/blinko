import { BaseProvider } from './BaseProvider';
import { OpenAIVoice } from '@mastra/voice-openai';
import { MastraVoice } from '@mastra/core/voice';
import OpenAI from 'openai';

interface AudioConfig {
  provider: string;
  apiKey?: any;
  baseURL?: any;
  modelKey: string;
  apiVersion?: string;
  speaker?: string;
  speed?: number;
}

export class AudioProvider extends BaseProvider {
  async getTranscriptionClient(config: AudioConfig): Promise<OpenAI> {
    await this.initializeFetch();
    if (['azure', 'azureopenai'].includes(config.provider.toLowerCase())) {
      throw new Error('Azure audio transcription is not supported');
    }
    return this.createListeningClient(config);
  }

  private createListeningClient(config: AudioConfig): OpenAI {
    if (!config.apiKey) throw new Error('Audio provider API key is missing');
    if (config.baseURL) {
      const url = new URL(config.baseURL);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid audio provider URL');
    }
    return new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL || undefined,
      fetch: this.proxiedFetch,
      timeout: 120_000,
      maxRetries: 0,
    });
  }

  async getAudioModel(config: AudioConfig): Promise<MastraVoice | null> {
    await this.initializeFetch();

    switch (config.provider.toLowerCase()) {
      case 'openai':
      case 'custom':
      case 'litellm':
        return this.createCompatibleVoice(config);
      case 'azureopenai':
        return null;
      case 'azure':
        // TODO: Implement Azure OpenAI audio support
        return null;
      default:
        return this.createCompatibleVoice(config);
    }
  }

  private createCompatibleVoice(config: AudioConfig): MastraVoice | null {
    if (!config.apiKey) return null;
    const openAIVoice = new OpenAIVoice({
      speechModel: { apiKey: config.apiKey },
      listeningModel: { name: config.modelKey as any || 'whisper-1', apiKey: config.apiKey },
    });
    openAIVoice.listeningClient = this.createListeningClient(config);
    return openAIVoice as unknown as MastraVoice;
  }
}
