import { OpenAIRealtimeVoice } from '@mastra/voice-openai-realtime';
import { BaseProvider } from './BaseProvider';
import { EventEmitter } from 'events';

interface RealTimeVoiceConfig {
  provider: string;
  apiKey: string;
  baseURL?: string;
  modelKey: string;
  apiVersion?: string;
}

export interface RealTimeVoiceSession {
  id: string;
  eventEmitter: EventEmitter;
  isConnected: boolean;
  mastraVoice?: any;
  startSession(): Promise<void>;
  stopSession(): Promise<void>;
  sendAudio(audioData: Buffer): void;
  destroy(): void;
}

export class RealTimeVoiceProvider extends BaseProvider {
  private activeSessions = new Map<string, RealTimeVoiceSession>();

  async createSession(config: RealTimeVoiceConfig): Promise<RealTimeVoiceSession> {
    await this.initializeFetch();

    switch (config.provider.toLowerCase()) {
      case 'openai':
        return this.createMastraRealtimeSession(config);
      case 'custom':
        return this.createMastraRealtimeSession(config);
      default:
        throw new Error(`Provider ${config.provider} not supported for real-time voice`);
    }
  }

  private async createMastraRealtimeSession(config: RealTimeVoiceConfig): Promise<RealTimeVoiceSession> {
    if (!config.apiKey) {
      throw new Error('OpenAI API key is required for real-time voice');
    }

    const sessionId = this.generateSessionId();
    const eventEmitter = new EventEmitter();
    let mastraVoice: OpenAIRealtimeVoice | null = null;

    try {
      // Import Mastra realtime voice module
      const { OpenAIRealtimeVoice } = await import('@mastra/voice-openai-realtime');

      // Create Mastra realtime voice instance with correct configuration
      mastraVoice = new OpenAIRealtimeVoice({
        apiKey: config.apiKey,
        model: config.modelKey || 'gpt-4o-mini-realtime-preview-2024-12-17',
        url: config.baseURL
      });

      // Configure session settings
      mastraVoice.updateConfig({
        turn_detection: {
          type: "server_vad",
          threshold: 0.6,
          silence_duration_ms: 1200,
        },
      });

    } catch (error) {
      console.error('Failed to initialize Mastra realtime voice:', error);
      throw new Error('Failed to initialize real-time voice service');
    }

    const session: RealTimeVoiceSession = {
      id: sessionId,
      eventEmitter,
      isConnected: false,
      mastraVoice,

      async startSession() {
        try {
          console.log(`[RealTimeVoice] Starting session ${sessionId}...`);

          if (!mastraVoice) {
            console.error(`[RealTimeVoice] Mastra voice not initialized for session ${sessionId}`);
            throw new Error('Mastra voice not initialized');
          }

          console.log(`[RealTimeVoice] Establishing connection for session ${sessionId}...`);

          // Establish connection using correct Mastra API
          await mastraVoice.connect();
          this.isConnected = true;

          console.log(`[RealTimeVoice] Session ${sessionId} connected successfully`);
          eventEmitter.emit('connected', { sessionId });

          // Set up event listeners for Mastra voice events using correct event names
          mastraVoice.on('writing', ({ text, role }: any) => {
            console.log(`[RealTimeVoice] Writing received for session ${sessionId}:`, { text, role });
            eventEmitter.emit('transcription', {
              text: text,
              timestamp: Date.now(),
              role: role
            });
          });

          mastraVoice.on('speaker', ({ audio }: any) => {
            console.log(`[RealTimeVoice] Speaker audio received for session ${sessionId}, length:`, audio?.length);
            // Handle audio playback if needed
            eventEmitter.emit('speaker_audio', { audio });
          });

          mastraVoice.on('error', (error: any) => {
            console.error(`[RealTimeVoice] Mastra voice error for session ${sessionId}:`, error);
            eventEmitter.emit('error', error);
            this.isConnected = false;
          });

          console.log(`[RealTimeVoice] Event listeners set up for session ${sessionId}`);

        } catch (error) {
          console.error(`[RealTimeVoice] Failed to start session ${sessionId}:`, error);
          eventEmitter.emit('error', error);
          throw error;
        }
      },

      async stopSession() {
        try {
          console.log(`[RealTimeVoice] Stopping session ${sessionId}...`);

          if (mastraVoice && this.isConnected) {
            mastraVoice.disconnect();
          }

          this.isConnected = false;
          console.log(`[RealTimeVoice] Session ${sessionId} stopped successfully`);
          eventEmitter.emit('disconnected', { sessionId });
        } catch (error) {
          console.error(`[RealTimeVoice] Error stopping session ${sessionId}:`, error);
          eventEmitter.emit('error', error);
          throw error;
        }
      },

      sendAudio(audioData: Buffer) {
        if (!this.isConnected || !mastraVoice) {
          throw new Error('Session not connected');
        }

        try {
          console.log(`[RealTimeVoice] Sending audio data for session ${sessionId}, size:`, audioData.length);

          // Convert Buffer to Int16Array as required by Mastra
          // Assuming the audio data is PCM 16-bit
          const int16Array = new Int16Array(audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength));

          console.log(`[RealTimeVoice] Converted to Int16Array, length:`, int16Array.length);
          mastraVoice.send(int16Array);
        } catch (error) {
          console.error(`[RealTimeVoice] Error sending audio for session ${sessionId}:`, error);
          eventEmitter.emit('error', error);
        }
      },

      destroy() {
        if (mastraVoice) {
          mastraVoice.disconnect()
        }
        eventEmitter.removeAllListeners();
        this.isConnected = false;
      }
    };

    this.activeSessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): RealTimeVoiceSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  destroySession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.destroy();
      this.activeSessions.delete(sessionId);
    }
  }

  private generateSessionId(): string {
    return `rtv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Get all active sessions (for debugging/monitoring)
  getActiveSessions(): string[] {
    return Array.from(this.activeSessions.keys());
  }
}