import { RootStore } from "@/store";
import { useCallback, useState, useEffect, useRef, useMemo } from "react";
import useAudioRecorder from "../AudioRecorder/hook";
import { Icon } from '@/components/Common/Iconify/icons';
import { DialogStandaloneStore } from "@/store/module/DialogStandalone";
import { requestMicrophonePermission, checkMicrophonePermission } from "@/lib/tauriHelper";
import { Button } from "@heroui/react";
import { useTranslation } from "react-i18next";

interface MyAudioRecorderProps {
  onComplete?: (file: File) => void;
}

export const MyAudioRecorder = ({ onComplete }: MyAudioRecorderProps) => {
  const [audioPermissionGranted, setAudioPermissionGranted] = useState<boolean>(() => {
    // Initialize with cached permission status
    return localStorage.getItem('microphone_permission_granted') === 'true';
  });
  const [audioLevel, setAudioLevel] = useState<number[]>(Array(30).fill(0));
  const animationFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const {
    startRecording,
    stopRecording,
    recordingBlob,
    isRecording,
    recordingTime,
  } = useAudioRecorder();

  // Setup audio analyzer
  const setupAudioAnalyser = useCallback((stream: MediaStream) => {
    try {
      // Close existing AudioContext if any
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
        analyserRef.current = null;
        sourceRef.current = null;
      }

      // Create new AudioContext
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioContext;

      // Create analyzer node
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 128; // Smaller FFT size for better performance
      analyser.smoothingTimeConstant = 0.7; // Enhanced smoothing
      analyserRef.current = analyser;

      // Connect audio source to analyzer
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      sourceRef.current = source;

      // Initialize audio level array with minimum height values
      setAudioLevel(Array(30).fill(3));

      // Create update function for audio levels
      const updateAudioLevel = () => {
        if (!analyserRef.current) return;

        // Get frequency data even when not recording for smooth animation
        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(dataArray);

        // Calculate weighted average volume, emphasizing low and mid frequencies
        const sum = dataArray.reduce((acc, val, i) => {
          // Weight low and mid frequencies more
          const weight = i < dataArray.length / 3 ? 1.5 :
            i < dataArray.length * 2 / 3 ? 1.2 : 0.8;
          return acc + (val * weight);
        }, 0);

        const average = sum / dataArray.length;
        // Ensure value is always a number
        const scaledValue: number = Math.max(average * 1.5, 3);

        // Update audio level display with smooth animation
        setAudioLevel(prevLevels => {
          const newLevels = [...prevLevels].map(n => n || 0); // Ensure all values are numbers
          // Shift array left, add new value at end
          for (let i = 0; i < newLevels.length - 1; i++) {
            newLevels[i] = newLevels[i + 1] || 0;
          }
          newLevels[newLevels.length - 1] = scaledValue;
          return newLevels;
        });

        // Continue animation loop
        animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
      };

      // Start animation immediately
      animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
      console.log("Audio visualization started");
    } catch (error) {
      console.error("Failed to setup audio analyzer:", error);
    }
  }, []);

  // Cleanup audio analyzer resources
  const cleanupAudioAnalyser = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try {
        audioContextRef.current.close();
      } catch (error) {
        console.error("Failed to close AudioContext:", error);
      }
    }

    audioContextRef.current = null;
    analyserRef.current = null;
  }, []);

  // Start recording automatically when component mounts
  useEffect(() => {
    let cancelled = false;
    const initRecording = async () => {
      try {
        // If we already have cached permission, skip permission check
        const cachedPermission = localStorage.getItem('microphone_permission_granted') === 'true';

        if (!cachedPermission) {
          // First check/request permission
          const hasPermission = await checkMicrophonePermission();
          if (!hasPermission) {
            const granted = await requestMicrophonePermission();
            if (!granted) {
              setAudioPermissionGranted(false);
              console.error('Microphone permission denied');
              return;
            }
          }
          // Permission granted, update state
          setAudioPermissionGranted(true);
        }

        if (cancelled) return;
        const stream = await startRecording();
        if (cancelled) return;
        if (stream) {
          setupAudioAnalyser(stream);
        } else {
          console.error('Failed to start recording');
          return;
        }

      } catch (error) {
        console.error("Failed to start recording:", error);
        // Clear cached permission on error
        localStorage.removeItem('microphone_permission_granted');
        setAudioPermissionGranted(false);
      }
    };

    initRecording();

    return () => {
      cancelled = true;
      cleanupAudioAnalyser();
    };
  }, []);

  useEffect(() => {
    if (!isRecording) cleanupAudioAnalyser();
    const resumeAnalyser = () => {
      if (document.visibilityState === 'visible' && isRecording && audioContextRef.current?.state === 'suspended') {
        void audioContextRef.current.resume().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', resumeAnalyser);
    return () => document.removeEventListener('visibilitychange', resumeAnalyser);
  }, [isRecording, cleanupAudioAnalyser]);

  const handleStopRecording = stopRecording;

  const handleComplete = useCallback(() => {
    if (recordingBlob?.size && !isRecording) {
      const mimeType = recordingBlob.type;
      const extension = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
      const file = new File([recordingBlob], `my_recording_${Date.now()}.${extension}`, {
        type: mimeType
      });

      // Add duration as a custom property to the file
      const minutes = Math.floor(recordingTime / 60).toString().padStart(2, '0');
      const seconds = Math.floor(recordingTime % 60).toString().padStart(2, '0');
      const durationStr = `${minutes}:${seconds}`;
      Object.defineProperty(file, 'audioDuration', {
        value: durationStr,
        writable: false
      });

      // Add metadata to mark this as user voice recording with duration
      Object.defineProperty(file, 'isUserVoiceRecording', {
        value: true,
        writable: false
      });

      Object.defineProperty(file, 'audioDurationSeconds', {
        value: recordingTime,
        writable: false
      });

      onComplete?.(file);
    }
  }, [recordingBlob, onComplete, recordingTime, isRecording]);

  const handleDelete = useCallback(() => {
    // Stop current recording
    stopRecording();

    // Close the dialog
    RootStore.Get(DialogStandaloneStore).close();
  }, [stopRecording]);

  // One recorder-owned clock; preserve elapsed time after stopping.
  const formattedTime = useMemo(() => {
    const minutes = Math.floor(recordingTime / 60).toString().padStart(2, '0');
    const seconds = Math.floor(recordingTime % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }, [recordingTime]);

  const { t } = useTranslation();

  return (
    <div className="relative flex flex-col items-center overflow-hidden w-full h-[450px]">
      {!audioPermissionGranted ? (
        // Permission Request UI - Clean and Professional
        <div className="flex flex-col items-center justify-center w-full h-full p-8 rounded-lg">
          <div className="flex flex-col items-center text-center gap-6">
            <div className="p-4 rounded-full">
              <Icon icon="solar:microphone-3-bold" className="text-white text-4xl" />
            </div>

            <div className="space-y-2">
              <h3 className="text-xl font-semibold text-white">{t('microphone-access-required')}</h3>
              <p className="text-sm text-slate-300">
                {t('to-record-audio-notes-we-need-permission-to-access-your-microphone')}
              </p>
            </div>

            <Button
              onPress={async () => {
                const granted = await requestMicrophonePermission();
                if (granted) {
                  window.location.reload();
                }
              }}
              color="danger"
              variant="shadow"
              size="lg"
              startContent={<Icon icon="solar:shield-check-bold" />}
              className="w-full font-medium"
            >
              {t('grant-microphone-permission')}
            </Button>
          </div>
        </div>
      ) : (
        // Recording UI - Original design when permission is granted
        <div className="flex flex-col items-center w-full h-full p-4 bg-neutral-900 rounded-lg">
          <div className="w-full h-8 flex items-center">
            <span className="text-white font-bold">REC</span>
            <span className={`ml-2 w-2 h-2 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-gray-500'}`}></span>
          </div>

          <div className="w-full flex-1 flex flex-col items-center justify-center py-4 min-h-[200px]">
            <div className="my-4 w-full">
              <div className="w-full h-[40px] flex items-center justify-center rounded">
                <div className="w-full h-full flex items-end justify-center space-x-1 px-2">
                  {audioLevel.map((level, index) => (
                    <div
                      key={index}
                      className="w-[3px] bg-green-500 rounded-t-sm"
                      style={{
                        height: `${Math.min(level, 100)}%`,
                        transition: 'height 0.2s cubic-bezier(0.4, 0.0, 0.2, 1)',
                        opacity: isRecording ? 1 : 0.5,
                        transform: `translateY(${isRecording ? 0 : 2}px)`,
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="text-white text-7xl font-bold mt-4">
              {formattedTime}
            </div>
          </div>

          <div className="flex justify-center mt-4 w-full h-16">
            {isRecording ? (
              <button
                className="w-16 h-16 rounded-full bg-green-500 flex items-center justify-center focus:outline-none active:transform active:scale-95 transition-transform"
                onClick={handleStopRecording}
              >
                <div className="w-6 h-6 bg-white rounded"></div>
              </button>
            ) : (
              <div className="flex gap-5 items-center justify-center h-full">
                <button
                  className="w-16 h-16 rounded-full bg-neutral-800 flex items-center justify-center focus:outline-none active:transform active:scale-95 transition-transform"
                  onClick={handleDelete}
                >
                  <Icon icon="mdi:close" className="text-red-500" width="30" height="30" />
                </button>
                <button
                  className="w-16 h-16 rounded-full bg-green-500 flex items-center justify-center focus:outline-none active:transform active:scale-95 transition-transform"
                  disabled={!recordingBlob?.size}
                  onClick={handleComplete}
                >
                  <Icon icon="mdi:check" className="text-white" width="30" height="30" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export const ShowAudioDialog = ((onComplete: (file: File) => void) => {
  return RootStore.Get(DialogStandaloneStore).setData({
    size: 'sm',
    onlyContent: true,
    isOpen: true,
    content: <MyAudioRecorder onComplete={(file) => {
      onComplete(file)
      RootStore.Get(DialogStandaloneStore).close();
    }} />
  })
})
