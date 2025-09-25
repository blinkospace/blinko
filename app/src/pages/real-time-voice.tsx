import { useState, useRef, useEffect, useCallback } from 'react';
import { observer } from 'mobx-react-lite';
import { Button, Card, CardBody, Select, SelectItem, Chip } from '@heroui/react';
import { Icon } from '@/components/Common/Iconify/icons';
import { RootStore } from '@/store';
import { AiSettingStore } from '@/store/aiSettingStore';
import { useTranslation } from 'react-i18next';

// WebSocket message types
interface WSMessage {
  type: 'stop' | 'audio_data' | 'ping';
  payload?: any;
}

interface WSResponse {
  type: 'connected' | 'stopped' | 'transcription' | 'error' | 'pong';
  payload?: any;
}

export const RealTimeVoicePage = observer(() => {
  const { t } = useTranslation();
  const aiSettingStore = RootStore.Get(AiSettingStore);

  // State management
  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [transcriptionResults, setTranscriptionResults] = useState<{
    text: string;
    timestamp: number;
    confidence?: number;
  }[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');

  // WebSocket and audio recording refs
  const wsRef = useRef<WebSocket | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioDevice, setSelectedAudioDevice] = useState<string>('');
  const [audioLevel, setAudioLevel] = useState<number>(0);

  useEffect(() => {
    aiSettingStore.aiProviders.call();
    aiSettingStore.allModels.call();
    loadAudioDevices();

    // Cleanup on unmount
    return () => {
      disconnectWebSocket();
      stopAudioRecording();
    };
  }, []);

  // Load available audio devices
  const loadAudioDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(device => device.kind === 'audioinput');
      setAudioDevices(audioInputs);
      if (audioInputs.length > 0 && !selectedAudioDevice) {
        setSelectedAudioDevice(audioInputs[0].deviceId);
      }
    } catch (error) {
      console.error('[AudioDevices] Error loading audio devices:', error);
    }
  };

  // WebSocket connection management
  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log('[WebSocket] Already connected');
      return;
    }

    console.log('[WebSocket] Connecting to real-time voice service...');
    setConnectionStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/realtime-voice`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WebSocket] WebSocket opened, waiting for server confirmation');
      setConnectionStatus('connecting');
    };

    ws.onmessage = (event) => {
      try {
        const message: WSResponse = JSON.parse(event.data);
        console.log('[WebSocket] Received message:', message);
        handleWebSocketMessage(message);
      } catch (error) {
        console.error('[WebSocket] Error parsing message:', error);
      }
    };

    ws.onclose = (event) => {
      console.log('[WebSocket] Connection closed:', event.code, event.reason);
      setWsConnected(false);
      setIsConnected(false);
      setConnectionStatus('disconnected');

      // Auto-reconnect after 3 seconds if it wasn't intentional
      if (event.code !== 1000 && isConnected) {
        setTimeout(() => {
          console.log('[WebSocket] Attempting to reconnect...');
          connectWebSocket();
        }, 3000);
      }
    };

    ws.onerror = (error) => {
      console.error('[WebSocket] Connection error:', error);
      setConnectionStatus('disconnected');
    };

  }, [isConnected]);

  const disconnectWebSocket = () => {
    if (wsRef.current) {
      console.log('[WebSocket] Disconnecting...');
      wsRef.current.close(1000, 'User initiated disconnect');
      wsRef.current = null;
    }
    setWsConnected(false);
    setIsConnected(false);
    setConnectionStatus('disconnected');
  };

  // Handle WebSocket messages
  const handleWebSocketMessage = (message: WSResponse) => {
    switch (message.type) {
      case 'connected':
        console.log('[WebSocket] Connected and session ready:', message.payload);
        setWsConnected(true);
        setConnectionStatus('connected');
        setIsConnected(true);
        // Start recording now that session is ready
        startAudioRecording();
        break;

      case 'stopped':
        console.log('[Session] Session stopped:', message.payload);
        setIsConnected(false);
        stopAudioRecording();
        break;

      case 'transcription':
        console.log('[Transcription] Received:', message.payload);
        setTranscriptionResults(prev => [...prev, {
          text: message.payload.text,
          timestamp: message.payload.timestamp,
          confidence: message.payload.confidence
        }]);
        break;

      case 'error':
        console.error('[Session] Error:', message.payload);
        setIsConnected(false);
        stopAudioRecording();
        break;

      case 'pong':
        console.log('[WebSocket] Pong received');
        break;

      default:
        console.log('[WebSocket] Unknown message type:', message.type);
    }
  };

  // Send WebSocket message
  const sendWSMessage = (message: WSMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
      console.log('[WebSocket] Sent message:', message.type);
    } else {
      console.error('[WebSocket] Cannot send message - not connected');
    }
  };

  // Start real-time voice session
  const startSession = async () => {
    try {
      // Connect WebSocket if not connected - backend will auto-start session with configured model
      if (!wsConnected) {
        connectWebSocket();

        // Wait for WebSocket connection and session initialization
        await new Promise((resolve) => {
          const checkConnection = () => {
            if (wsConnected && isConnected) {
              resolve(true);
            } else {
              setTimeout(checkConnection, 100);
            }
          };
          checkConnection();
        });
      }

    } catch (error) {
      console.error('[Session] Failed to start real-time voice session:', error);
    }
  };

  // Stop real-time voice session
  const stopSession = async () => {
    try {
      // Stop recording first
      stopAudioRecording();

      // Stop session
      sendWSMessage({ type: 'stop' });

      // Disconnect WebSocket
      setTimeout(() => {
        disconnectWebSocket();
      }, 1000);

    } catch (error) {
      console.error('[Session] Failed to stop real-time voice session:', error);
    }
  };

  // Start audio recording using WebRTC AudioWorklet for PCM data
  const startAudioRecording = async () => {
    try {
      console.log('[AudioRecording] Starting WebRTC audio recording...');
      console.log('[AudioRecording] Selected audio device:', selectedAudioDevice);

      const constraints = {
        audio: {
          deviceId: selectedAudioDevice ? { exact: selectedAudioDevice } : undefined,
          sampleRate: 16000, // Match Mastra expected sample rate
          channelCount: 1,   // Mono audio
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      };

      console.log('[AudioRecording] Audio constraints:', constraints);

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      audioStreamRef.current = stream;

      console.log('[AudioRecording] Media stream obtained:', {
        tracks: stream.getTracks().map(track => ({
          id: track.id,
          kind: track.kind,
          enabled: track.enabled,
          readyState: track.readyState,
          settings: track.getSettings()
        }))
      });

      // Create AudioContext for WebRTC processing
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);

      console.log('[AudioRecording] AudioContext created:', {
        sampleRate: audioContext.sampleRate,
        state: audioContext.state
      });

      // Load AudioWorklet processor
      try {
        await audioContext.audioWorklet.addModule('/audio-processor-worklet.js');
        console.log('[AudioRecording] AudioWorklet module loaded successfully');
      } catch (error) {
        console.error('[AudioRecording] Failed to load AudioWorklet:', error);
        throw error;
      }

      // Create AudioWorklet node with optimized settings
      const workletNode = new AudioWorkletNode(audioContext, 'audio-processor', {
        processorOptions: {
          chunkSize: 1024 // 1024 samples = ~64ms at 16kHz
        }
      });

      // Handle PCM audio data from AudioWorklet
      workletNode.port.onmessage = (event) => {
        const { type, audioData, audioLevel } = event.data;
        console.log('[AudioWorklet] Message received:', type, wsConnected, event.data);

        if (type === 'audioData') {
          console.log('[AudioRecording] Received PCM data:', {
            length: audioData?.length,
            wsConnected,
            sampleRate: event.data.sampleRate,
            bitDepth: event.data.bitDepth
          });

          if (wsConnected) {
            try {
              // Send Int16Array PCM data via WebSocket
              sendWSMessage({
                type: 'audio_data',
                payload: {
                  audioData: Array.from(audioData) // Convert Int16Array to regular array
                }
              });

              console.log('[AudioRecording] PCM data sent successfully');
            } catch (error) {
              console.error('[AudioRecording] Failed to send PCM data:', error);
            }
          } else {
            console.warn('[AudioRecording] WebSocket not connected, skipping audio data send');
          }
        } else if (type === 'audioLevel') {
          // Update audio level for UI feedback
          console.log('[AudioRecording] Audio level:', audioLevel);
          setAudioLevel(audioLevel);
        }
      };

      // Connect audio processing chain
      source.connect(workletNode);
      // Note: We don't connect to destination to avoid feedback

      // Store references for cleanup
      audioContextRef.current = audioContext;
      workletNodeRef.current = workletNode;
      setIsRecording(true);

      console.log('[AudioRecording] WebRTC audio recording started successfully');

    } catch (error) {
      console.error('[AudioRecording] Error starting WebRTC audio recording:', error);
    }
  };

  // Stop audio recording and cleanup WebRTC resources
  const stopAudioRecording = () => {
    console.log('[AudioRecording] Stopping WebRTC audio recording...');

    try {
      // Disconnect and cleanup AudioWorklet
      if (workletNodeRef.current) {
        workletNodeRef.current.disconnect();
        workletNodeRef.current = null;
        console.log('[AudioRecording] AudioWorklet node disconnected');
      }

      // Close AudioContext
      if (audioContextRef.current) {
        if (audioContextRef.current.state !== 'closed') {
          audioContextRef.current.close();
          console.log('[AudioRecording] AudioContext closed');
        }
        audioContextRef.current = null;
      }

      // Stop media tracks
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(track => {
          track.stop();
          console.log(`[AudioRecording] Stopped track: ${track.kind} (${track.id})`);
        });
        audioStreamRef.current = null;
      }

      setIsRecording(false);
      setAudioLevel(0);
      console.log('[AudioRecording] WebRTC audio recording stopped successfully');

    } catch (error) {
      console.error('[AudioRecording] Error stopping audio recording:', error);
      setIsRecording(false);
      setAudioLevel(0);
    }
  };

  // No longer need model selection - backend uses configured model

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Icon icon="hugeicons:mic-01" width="32" height="32" className="text-primary" />
          <h1 className="text-2xl font-bold">Real-Time Voice Transcription</h1>
        </div>

        {/* Audio Configuration */}
        <Card>
          <CardBody className="space-y-4">
            <h3 className="text-lg font-semibold">Audio Configuration</h3>

            <div className="grid grid-cols-1 md:grid-cols-1 gap-4">
              <Select
                label="Audio Input Device"
                placeholder="Select microphone"
                selectedKeys={selectedAudioDevice ? [selectedAudioDevice] : []}
                onSelectionChange={(keys) => {
                  const value = Array.from(keys)[0];
                  setSelectedAudioDevice(String(value));
                }}
                disabled={isConnected}
              >
                {audioDevices.map(device => (
                  <SelectItem key={device.deviceId} textValue={device.label}>
                    {device.label || `Microphone ${device.deviceId.slice(0, 8)}`}
                  </SelectItem>
                ))}
              </Select>
            </div>
          </CardBody>
        </Card>

        {/* Controls */}
        <Card>
          <CardBody className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Button
                  color={isConnected ? "danger" : "primary"}
                  size="lg"
                  startContent={
                    <Icon
                      icon={isConnected ? "hugeicons:stop" : "hugeicons:play"}
                      width="20"
                      height="20"
                    />
                  }
                  onPress={isConnected ? stopSession : startSession}
                  disabled={connectionStatus === 'connecting'}
                  isLoading={connectionStatus === 'connecting'}
                >
                  {isConnected ? 'Stop Session' : 'Start Session'}
                </Button>
              </div>

              <div className="flex items-center gap-2">
                <Chip
                  color={
                    connectionStatus === 'connected' ? "success" :
                    connectionStatus === 'connecting' ? "warning" : "default"
                  }
                  variant="flat"
                  startContent={
                    <Icon
                      icon={
                        connectionStatus === 'connected' ? "hugeicons:wifi" :
                        connectionStatus === 'connecting' ? "hugeicons:loading" : "hugeicons:wifi-off"
                      }
                      width="16"
                      height="16"
                      className={connectionStatus === 'connecting' ? 'animate-spin' : ''}
                    />
                  }
                >
                  {connectionStatus === 'connected' ? 'Connected' :
                   connectionStatus === 'connecting' ? 'Connecting' : 'Disconnected'}
                </Chip>

                {isRecording && (
                  <div className="flex items-center gap-2">
                    <Chip
                      color="danger"
                      variant="flat"
                      startContent={
                        <Icon
                          icon="hugeicons:mic-01"
                          width="16"
                          height="16"
                          className="animate-pulse"
                        />
                      }
                    >
                      Recording
                    </Chip>

                    {/* Audio Level Indicator */}
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-default-500">Level:</span>
                      <div className="w-16 h-2 bg-default-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-green-500 via-yellow-500 to-red-500 transition-all duration-100"
                          style={{ width: `${Math.min(100, audioLevel * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-default-500 w-8">
                        {Math.round(audioLevel * 100)}%
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </CardBody>
        </Card>

        {/* Transcription Results */}
        <Card>
          <CardBody>
            <h3 className="text-lg font-semibold mb-4">Live Transcription</h3>

            <div className="space-y-2 max-h-96 overflow-y-auto">
              {transcriptionResults.length === 0 ? (
                <p className="text-default-500 text-center py-8">
                  {isConnected ? 'Start speaking to see transcription results...' : 'Connect to start transcription'}
                </p>
              ) : (
                transcriptionResults.map((result, index) => (
                  <div key={index} className="p-3 bg-default-50 rounded-lg">
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-xs text-default-500">
                        {new Date(result.timestamp).toLocaleTimeString()}
                      </span>
                      {result.confidence && (
                        <Chip size="sm" variant="flat" color="success">
                          {Math.round(result.confidence * 100)}% confidence
                        </Chip>
                      )}
                    </div>
                    <p className="text-sm">{result.text}</p>
                  </div>
                ))
              )}
            </div>

            {transcriptionResults.length > 0 && (
              <div className="mt-4">
                <Button
                  size="sm"
                  variant="flat"
                  onPress={() => setTranscriptionResults([])}
                >
                  Clear Results
                </Button>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
});

export default RealTimeVoicePage;