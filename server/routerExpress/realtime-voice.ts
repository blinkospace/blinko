import { Router } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { OpenAIRealtimeVoice } from '@mastra/voice-openai-realtime';
import { BaseProvider } from '@server/aiServer/providers/BaseProvider';
import { EventEmitter } from 'events';
import { prisma } from '@server/prisma';

// Global WebSocket server instance
let wss: WebSocketServer | null = null;

interface WebSocketWithAuth extends WebSocket {
  userId?: number;
  isAlive?: boolean;
}

// WebSocket connection management
const wsConnections = new Map<string, WebSocketWithAuth>();
const connectionSessions = new Map<string, RealTimeVoiceSession>();

// WebSocket message types
interface WSMessage {
  type: 'stop' | 'audio_data' | 'ping';
  payload?: any;
}

interface WSResponse {
  type: 'connected' | 'started' | 'stopped' | 'transcription' | 'error' | 'pong';
  payload?: any;
}

interface RealTimeVoiceSession {
  id: string;
  isConnected: boolean;
  mastraVoice?: any;
  startSession(ws: WebSocketWithAuth): Promise<void>;
  stopSession(): Promise<void>;
  sendAudio(audioData: Buffer): void;
  destroy(): void;
}

export const createRealTimeVoiceWebSocket = (server: any) => {
  console.log('[RealTimeVoice] Setting up WebSocket server...');

  // Create WebSocket server attached to HTTP server
  wss = new WebSocketServer({
    server,
    path: '/api/realtime-voice',
    verifyClient: (info) => {
      // Only accept connections to our specific path
      const url = new URL(info.req.url || '', 'http://localhost');
      const isRealtimeVoicePath = url.pathname === '/api/realtime-voice';
      console.log('[RealTimeVoice] WebSocket connection request to:', url.pathname, 'accepted:', isRealtimeVoicePath);
      return isRealtimeVoicePath;
    }
  });

  wss.on('connection', async (ws: WebSocketWithAuth, request: IncomingMessage) => {
    const connectionId = generateConnectionId();
    ws.isAlive = true;
    wsConnections.set(connectionId, ws);

    console.log(`[RealTimeVoice] New WebSocket connection: ${connectionId}`);

    // Heartbeat
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (data: Buffer) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());
        console.log(`[RealTimeVoice] Received message from ${connectionId}:`, message.type);

        await handleWebSocketMessage(ws, connectionId, message);
      } catch (error) {
        console.error(`[RealTimeVoice] Error handling message from ${connectionId}:`, error);
        sendWSMessage(ws, {
          type: 'error',
          payload: { error: error.message || 'Invalid message format' }
        });
      }
    });

    ws.on('close', () => {
      console.log(`[RealTimeVoice] WebSocket connection closed: ${connectionId}`);

      // Clean up session if exists
      const session = connectionSessions.get(connectionId);
      if (session) {
        session.destroy();
        connectionSessions.delete(connectionId);
        console.log(`[RealTimeVoice] Cleaned up session for connection: ${connectionId}`);
      }

      wsConnections.delete(connectionId);
    });

    ws.on('error', (error) => {
      console.error(`[RealTimeVoice] WebSocket error for ${connectionId}:`, error);
    });

    // Auto-start session with configured real-time voice model
    try {
      console.log(`[RealTimeVoice] Auto-starting session for connection ${connectionId}`);

      // Get global config to find the configured real-time voice model
      const { AiModelFactory } = await import('@server/aiServer/aiModelFactory');
      const globalConfig = await AiModelFactory.globalConfig();

      if (!globalConfig.realTimeVoiceModelId) {
        throw new Error('No real-time voice model configured. Please configure it in Settings > AI Settings.');
      }

      // Get the configured model
      const voiceModel = await prisma.aiModels.findUnique({
        where: { id: globalConfig.realTimeVoiceModelId },
        include: { provider: true }
      });

      if (!voiceModel || !voiceModel.provider) {
        throw new Error('Configured real-time voice model not found');
      }

      console.log(`[RealTimeVoice] Using configured model: ${voiceModel.title} (${voiceModel.modelKey}) from provider ${voiceModel.provider.title}`);

      // Create and start session directly
      await handleStart(ws, connectionId, {
        providerId: voiceModel.provider.id,
        modelKey: voiceModel.modelKey
      });

    } catch (error) {
      console.error(`[RealTimeVoice] Failed to auto-start session for ${connectionId}:`, error);
      sendWSMessage(ws, {
        type: 'error',
        payload: { error: error.message || 'Failed to start session' }
      });
    }
  });

  // Heartbeat interval
  const heartbeatInterval = setInterval(() => {
    wsConnections.forEach((ws, connectionId) => {
      if (!ws.isAlive) {
        console.log(`[RealTimeVoice] Terminating dead connection: ${connectionId}`);
        ws.terminate();
        wsConnections.delete(connectionId);
        return;
      }

      ws.isAlive = false;
      ws.ping();
    });
  }, 30000); // 30 seconds

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  console.log('[RealTimeVoice] WebSocket server setup complete');

  return wss;
};

async function handleWebSocketMessage(ws: WebSocketWithAuth, connectionId: string, message: WSMessage) {
  switch (message.type) {
    case 'stop':
      await handleStop(ws, connectionId);
      break;

    case 'audio_data':
      await handleAudioData(ws, connectionId, message.payload);
      break;

    case 'ping':
      sendWSMessage(ws, { type: 'pong' });
      break;

    default:
      sendWSMessage(ws, {
        type: 'error',
        payload: { error: `Unknown message type: ${message.type}` }
      });
  }
}

async function handleStart(ws: WebSocketWithAuth, connectionId: string, payload: any) {
  try {
    const { providerId, modelKey } = payload;

    if (!providerId || !modelKey) {
      throw new Error('providerId and modelKey are required');
    }

    // Get provider information
    const provider = await prisma.aiProviders.findUnique({
      where: { id: providerId }
    });

    if (!provider) {
      throw new Error('Provider not found');
    }

    console.log(`[RealTimeVoice] Starting session for connection ${connectionId} with provider ${provider.provider}`);

    // Create Mastra real-time voice session inline
    const sessionId = `rtv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    let mastraVoice: OpenAIRealtimeVoice | null = null;

    try {
      // Import Mastra realtime voice module
      const { OpenAIRealtimeVoice } = await import('@mastra/voice-openai-realtime');
      console.log({
        apiKey: provider.apiKey || '',
        model: modelKey || 'gpt-4o-mini-realtime-preview-2024-12-17',
        url: provider.baseURL || undefined
      })
      // Create Mastra realtime voice instance
      mastraVoice = new OpenAIRealtimeVoice({
        apiKey: provider.apiKey || '',
        model: modelKey || 'gpt-4o-mini-realtime-preview-2024-12-17',
        url: provider.baseURL || undefined
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
      isConnected: false,
      mastraVoice,

      async startSession(ws: WebSocketWithAuth) {
        try {
          console.log(`[RealTimeVoice] Starting session ${sessionId}...`);

          if (!mastraVoice) {
            console.error(`[RealTimeVoice] Mastra voice not initialized for session ${sessionId}`);
            throw new Error('Mastra voice not initialized');
          }

          console.log(`[RealTimeVoice] Establishing connection for session ${sessionId}...`);

          // Establish connection using correct Mastra API
          await mastraVoice.connect();
          sendWSMessage(ws, {
            type: 'started',
            payload: { connectionId }
          });
          this.isConnected = true;

          console.log(`[RealTimeVoice] Session ${sessionId} connected successfully`);

          // Set up event listeners for Mastra voice events
          mastraVoice.on('writing', ({ text, role }: any) => {
            console.log(`[RealTimeVoice] Writing received for session ${sessionId}:`, { text, role });
            sendWSMessage(ws, {
              type: 'transcription',
              payload: {
                text: text,
                timestamp: Date.now(),
                role: role
              }
            });
          });

          mastraVoice.on('speaker', ({ audio }: any) => {
            console.log(`[RealTimeVoice] Speaker audio received for session ${sessionId}, length:`, audio?.length);
            // Handle audio playback if needed - could send to client if needed
          });

          mastraVoice.on('error', (error: any) => {
            console.error(`[RealTimeVoice] Mastra voice error for session ${sessionId}:`, error);
            sendWSMessage(ws, {
              type: 'error',
              payload: { error: error.message || 'Session error' }
            });
            this.isConnected = false;
          });

          console.log(`[RealTimeVoice] Event listeners set up for session ${sessionId}`);

        } catch (error) {
          console.error(`[RealTimeVoice] Failed to start session ${sessionId}:`, error);
          sendWSMessage(ws, {
            type: 'error',
            payload: { error: error.message || 'Failed to start session' }
          });
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
        } catch (error) {
          console.error(`[RealTimeVoice] Error stopping session ${sessionId}:`, error);
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
          const int16Array = new Int16Array(audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength));

          console.log(`[RealTimeVoice] Converted to Int16Array, length:`, int16Array.length);
          mastraVoice.send(int16Array);
        } catch (error) {
          console.error(`[RealTimeVoice] Error sending audio for session ${sessionId}:`, error);
          throw error;
        }
      },

      destroy() {
        if (mastraVoice) {
          mastraVoice.disconnect()
        }
        this.isConnected = false;
      }
    };

    // Store session by connection ID
    connectionSessions.set(connectionId, session);

    // Start the session
    await session.startSession(ws);



  } catch (error) {
    console.error(`[RealTimeVoice] Failed to start session for ${connectionId}:`, error);
    sendWSMessage(ws, {
      type: 'error',
      payload: { error: error.message || 'Failed to start session' }
    });
  }
}

async function handleStop(ws: WebSocketWithAuth, connectionId: string) {
  try {
    const session = connectionSessions.get(connectionId);
    if (!session) {
      throw new Error('Session not found');
    }

    console.log(`[RealTimeVoice] Stopping session for connection ${connectionId}`);
    await session.stopSession();

    // Clean up session
    connectionSessions.delete(connectionId);

    sendWSMessage(ws, {
      type: 'stopped',
      payload: { connectionId }
    });

  } catch (error) {
    console.error(`[RealTimeVoice] Failed to stop session for ${connectionId}:`, error);
    sendWSMessage(ws, {
      type: 'error',
      payload: { error: error.message || 'Failed to stop session' }
    });
  }
}

async function handleAudioData(ws: WebSocketWithAuth, connectionId: string, payload: any) {
  try {
    const session = connectionSessions.get(connectionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const { audioData } = payload;
    if (!audioData) {
      throw new Error('No audio data provided');
    }

    // Convert array back to Buffer
    const audioBuffer = Buffer.from(audioData);
    console.log(`[RealTimeVoice] Sending audio data for ${connectionId}, size: ${audioBuffer.length} bytes`);

    session.sendAudio(audioBuffer);

  } catch (error) {
    console.error(`[RealTimeVoice] Failed to handle audio data for ${connectionId}:`, error);
    sendWSMessage(ws, {
      type: 'error',
      payload: { error: error.message || 'Failed to handle audio data' }
    });
  }
}

function sendWSMessage(ws: WebSocket, message: WSResponse) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function generateConnectionId(): string {
  return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Express router (if needed for REST endpoints)
export const realTimeVoiceRouter = Router();

realTimeVoiceRouter.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    activeConnections: wsConnections.size,
    activeSessions: connectionSessions.size
  });
});