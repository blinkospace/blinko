import React, { useEffect, useState, useRef } from 'react';
import { api } from '@/lib/trpc';
import { FileType } from '../Editor/type';
import { DeleteIcon, DownloadIcon } from './icons';
import { Icon } from '@/components/Common/Iconify/icons';
import { RootStore } from '@/store';
import { MusicManagerStore } from '@/store/musicManagerStore';
import { UserStore } from '@/store/user';
import { observer } from 'mobx-react-lite';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { getBlinkoEndpoint } from '@/lib/blinkoEndpoint';

interface AudioMetadata {
  coverUrl?: string;
  trackName?: string;
  albumName?: string;
  artists?: string[];
  previewUrl?: string;
}

interface Props {
  files: FileType[];
  preview?: boolean;
}

const INITIAL_DISPLAY_COUNT = 3;

export const AudioRender = observer(({ files, preview = false }: Props) => {
  const [audioMetadata, setAudioMetadata] = useState<Record<string, AudioMetadata>>({});
  const musicManager = RootStore.Get(MusicManagerStore);
  const [isPlaying, setIsPlaying] = useState<Record<string, boolean>>({});
  const progressRefs = useRef<Record<string, HTMLDivElement>>({});
  const [currentTime, setCurrentTime] = useState<Record<string, string>>({});
  const [duration, setDuration] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const { t } = useTranslation()

  const getMetadata = async (file: FileType) => {
    try {
      const metadata = await api.public.musicMetadata.query({
        filePath: file.preview.includes('s3file') ? new URL(file.preview, window.location.href).href : file.preview
      });
      setAudioMetadata(prev => ({
        ...prev,
        [file.name]: metadata
      }));
    } catch (error) {
      console.error('Failed to fetch audio metadata:', error);
    }
  };

  useEffect(() => {
    files?.filter(i => i.previewType === 'audio').forEach(file => {
      // Get metadata for all audio files (for music info)
      getMetadata(file);

      // Set initial duration from metadata or file properties
      const fileDuration = getDuration(file);
      if (fileDuration) {
        setDuration(prev => ({
          ...prev,
          [file.name]: fileDuration
        }));
      }
    });
  }, [files]);

  const isCurrentPlaying = (fileName: string) => {
    return musicManager.isPlaying && musicManager.currentTrack?.file.name === fileName;
  };

  const togglePlay = async (fileName: string) => {
    const audioFiles = files.filter(i => i.previewType === 'audio');
    const file = audioFiles.find(f => f.name === fileName);
    if (!file) {
      return;
    }

    if (musicManager.currentTrack?.file.name === fileName) {
      await musicManager.togglePlay();
      return;
    }

    musicManager.addToPlaylist(file, audioMetadata[fileName], true);

    const otherFiles = audioFiles.filter(f => f.name !== fileName);
    otherFiles.forEach(f => {
      musicManager.addToPlaylist(f, audioMetadata[f.name], false);
    });
  };

  const formatTime = (seconds: number): string => {
    // Handle invalid input
    if (!isFinite(seconds) || isNaN(seconds)) {
      return "0:00";
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  // Get duration from metadata first, then fallback to other sources
  const getDuration = (file: FileType): string => {
    // Priority 1: Check attachment metadata with duration (from database)
    const attachmentMetadata = (file as any).metadata;
    if (attachmentMetadata?.audioDuration) {
      return attachmentMetadata.audioDuration;
    }

    // Priority 2: Check file properties (for user recordings)
    if ((file as any).audioDuration) {
      return (file as any).audioDuration;
    }

    // Priority 3: Check state duration (calculated from audio element)
    if (duration[file.name]) {
      return duration[file.name];
    }

    // Priority 4: Try to get duration from audio element if available
    if (musicManager.audioElement && musicManager.currentTrack?.file.name === file.name) {
      const rawDuration = musicManager.audioElement.duration;
      if (rawDuration && isFinite(rawDuration) && !isNaN(rawDuration)) {
        return formatTime(rawDuration);
      }
    }

    return "";
  };

  // Check if this is a user voice recording
  const isUserVoiceRecording = (file: FileType): boolean => {
    // Check file properties for user voice recording flag
    const fileProperty = (file as any).isUserVoiceRecording;
    // Check attachment metadata for user voice recording flag
    const attachmentMetadata = (file as any).metadata;
    // Check file name pattern for user recordings
    const isRecordingFile = file.name.startsWith('my_recording_');

    return fileProperty === true || attachmentMetadata?.isUserVoiceRecording === true || isRecordingFile;
  };

  useEffect(() => {
    const updateProgress = () => {
      if (!musicManager.audioElement) return;

      const fileName = musicManager.currentTrack?.file.name;
      if (!fileName) return;

      const progress = progressRefs.current[fileName];
      if (!progress) return;

      const rawDuration = musicManager.audioElement?.duration;
      const dur = (rawDuration && isFinite(rawDuration) && !isNaN(rawDuration)) ? rawDuration : musicManager.duration;
      const percentage = dur > 0
        ? (musicManager.currentTime / dur) * 100
        : 0;
      progress.style.width = `${percentage}%`;

      setCurrentTime(prev => ({
        ...prev,
        [fileName]: formatTime(musicManager.currentTime)
      }));

      if (dur && isFinite(dur) && !isNaN(dur)) {
        setDuration(prev => ({
          ...prev,
          [fileName]: formatTime(dur)
        }));
      }
    };

    const interval = setInterval(updateProgress, 100);
    return () => clearInterval(interval);
  }, [musicManager.currentTrack]);


  const handleProgressBarClick = (e: React.MouseEvent<HTMLDivElement>, fileName: string) => {
    if (!musicManager.audioElement || musicManager.currentTrack?.file.name !== fileName) return;

    const progressBar = e.currentTarget;
    const rect = progressBar.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = x / rect.width;

    const rawDuration = musicManager.audioElement?.duration;
    const dur = (rawDuration && isFinite(rawDuration) && !isNaN(rawDuration)) ? rawDuration : musicManager.duration;
    if (!dur || !isFinite(dur) || isNaN(dur) || dur <= 0) return;
    musicManager.seek(dur * percentage);
  };


  const handleProgressBarDrag = (e: React.MouseEvent<HTMLDivElement>, fileName: string) => {
    if (!musicManager.audioElement || musicManager.currentTrack?.file.name !== fileName) return;

    const progressBar = e.currentTarget;
    const updateTimeFromMousePosition = (e: MouseEvent) => {
      const rect = progressBar.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const percentage = x / rect.width;
      const rawDuration = musicManager.audioElement?.duration;
      const dur = (rawDuration && isFinite(rawDuration) && !isNaN(rawDuration)) ? rawDuration : musicManager.duration;
      if (!dur || !isFinite(dur) || isNaN(dur) || dur <= 0) return;
      musicManager.seek(dur * percentage);
    };

    const handleMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      updateTimeFromMousePosition(e);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const getBackgroundStyle = (coverUrl?: string) => {
    if (!coverUrl) {
      return 'bg-blue-500/10 hover:bg-blue-500/20 border border-blue-200/20 dark:border-blue-700/20';
    }
    return 'bg-cover bg-center relative overflow-hidden hover:bg-opacity-90';
  };

  // Voice message component (Telegram-style) with independent audio
  const VoiceMessageRender = ({ file }: { file: FileType }) => {
    const fileDuration = getDuration(file);
    const [isVoicePlaying, setIsVoicePlaying] = useState(false);
    const [voiceCurrentTime, setVoiceCurrentTime] = useState(0);
    const [voiceProgress, setVoiceProgress] = useState(0);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const animationFrameRef = useRef<number | null>(null);

    // Initialize independent audio element for this voice message
    useEffect(() => {
      if (!audioRef.current) {
        audioRef.current = new Audio();

        // Use file preview and construct proper URL like music manager does
        if (file.preview) {
          let audioUrl = getBlinkoEndpoint(file.preview);
          const token = RootStore.Get(UserStore).tokenData?.value?.token;
          if (token) {
            audioUrl = `${audioUrl}?token=${token}`;
          }

          audioRef.current.src = audioUrl;

          // Add error handling for audio loading
          audioRef.current.addEventListener('error', (e) => {
            console.error('Audio loading error:', e, 'Source:', audioRef.current?.src);
          });
        } else {
          console.error('No audio preview available for file:', file);
        }

        audioRef.current.addEventListener('ended', handleVoiceEnded);
        audioRef.current.addEventListener('timeupdate', updateVoiceProgress);
      }

      return () => {
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
        }
        if (audioRef.current) {
          audioRef.current.removeEventListener('ended', handleVoiceEnded);
          audioRef.current.removeEventListener('timeupdate', updateVoiceProgress);
          audioRef.current.removeEventListener('error', () => {});
          audioRef.current.removeEventListener('canplaythrough', () => {});
          audioRef.current.pause();
          audioRef.current = null;
        }
      };
    }, [file.preview]);

    const updateVoiceProgress = () => {
      if (!audioRef.current) return;

      const current = audioRef.current.currentTime;
      let duration = audioRef.current.duration;

      // If audio duration is not available, try to get it from metadata
      if (!duration || !isFinite(duration)) {
        const metadataDuration = (file as any).metadata?.audioDurationSeconds;
        if (metadataDuration) {
          duration = metadataDuration;
        }
      }

      setVoiceCurrentTime(current);
      if (duration && isFinite(duration) && duration > 0) {
        setVoiceProgress((current / duration) * 100);
      }
    };

    const handleVoiceEnded = () => {
      setIsVoicePlaying(false);
      setVoiceCurrentTime(0);
      setVoiceProgress(0);
    };

    const toggleVoicePlay = async () => {
      if (!audioRef.current) return;

      try {
        if (isVoicePlaying) {
          audioRef.current.pause();
          setIsVoicePlaying(false);
        } else {
          // Check if audio source is valid before playing
          if (!audioRef.current.src || audioRef.current.src === window.location.href) {
            console.error('Invalid audio source:', audioRef.current.src);
            return;
          }

          // Load the audio if not already loaded
          if (audioRef.current.readyState < 2) {
            audioRef.current.load();
            await new Promise((resolve, reject) => {
              const onCanPlay = () => {
                audioRef.current?.removeEventListener('canplay', onCanPlay);
                audioRef.current?.removeEventListener('error', onError);
                resolve(null);
              };
              const onError = (e: Event) => {
                audioRef.current?.removeEventListener('canplay', onCanPlay);
                audioRef.current?.removeEventListener('error', onError);
                reject(e);
              };
              audioRef.current?.addEventListener('canplay', onCanPlay);
              audioRef.current?.addEventListener('error', onError);
            });
          }

          await audioRef.current.play();
          setIsVoicePlaying(true);
        }
      } catch (error) {
        console.error('Voice playback error:', error);
        setIsVoicePlaying(false);
      }
    };

    const handleVoiceProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
      if (!audioRef.current) return;

      // Get the waveform container
      const waveformContainer = e.currentTarget;
      const rect = waveformContainer.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percentage = Math.max(0, Math.min(1, x / rect.width));

      let duration = audioRef.current.duration;

      // If audio duration is not available, try to get it from metadata
      if (!duration || !isFinite(duration)) {
        const metadataDuration = (file as any).metadata?.audioDurationSeconds;
        if (metadataDuration) {
          duration = metadataDuration;
        }
      }

      if (duration && isFinite(duration) && duration > 0) {
        audioRef.current.currentTime = duration * percentage;
      }
    };

    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2 }}
        className="group"
      >
        <div
          className="voice-message relative flex items-center gap-3 p-3 bg-blue-500/10 hover:bg-blue-500/20 rounded-2xl cursor-pointer transition-all duration-200 max-w-xs"
          onPointerEnter={event => { event.currentTarget.dataset.pointer = event.pointerType; }}
          onPointerDown={event => { event.currentTarget.dataset.pointer = event.pointerType; }}
          onClick={toggleVoicePlay}
        >
          {/* Play button */}
          <div className="relative min-w-[40px] h-[40px] bg-blue-500 rounded-full flex items-center justify-center shadow-lg hover:bg-blue-600 transition-colors">
            <Icon
              icon={isVoicePlaying ? "ph:pause-fill" : "ph:play-fill"}
              className="w-5 h-5 text-white ml-0.5"
            />
          </div>

          {/* Waveform as progress visualization */}
          <div
            className="flex items-center gap-1 flex-1 min-w-0 cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              handleVoiceProgressClick(e);
            }}
          >
            {[...Array(20)].map((_, i) => {
              const progress = voiceProgress / 100;
              const barProgress = (i + 0.5) / 20; // Center the bar's progress point
              const isPlayed = barProgress <= progress;

              return (
                <div
                  key={i}
                  className={`w-1 rounded-full transition-all duration-200 ${
                    isPlayed
                      ? 'bg-blue-500 shadow-sm'
                      : 'bg-blue-300/60 hover:bg-blue-300/80'
                  }`}
                  style={{
                    height: `${12 + Math.sin(i * 0.5) * 4}px`,
                    animation: isVoicePlaying && isPlayed ? `pulse 1.5s ease-in-out infinite ${i * 50}ms` : 'none',
                    transform: isPlayed ? 'scaleY(1.1)' : 'scaleY(1)'
                  }}
                />
              );
            })}
          </div>

          {/* Duration */}
          <div className="text-xs text-gray-600 dark:text-gray-400 font-medium min-w-[35px] text-right">
            {isVoicePlaying && voiceCurrentTime > 0
              ? formatTime(voiceCurrentTime)
              : fileDuration || "0:00"
            }
          </div>

          {/* Delete button for voice messages */}
          {!preview && (
            <DeleteIcon
              files={files}
              voice
              className="ml-1 shrink-0 text-gray-400 hover:text-red-500"
              file={file}
            />
          )}
          {preview && (
            <DownloadIcon
              inline
              className="ml-1 text-gray-400 hover:text-blue-500"
              file={file}
            />
          )}
        </div>
      </motion.div>
    );
  };

  const audioFiles = files?.filter(i => i.previewType === 'audio') || [];

  return (
    <div className="flex flex-col gap-2">
      {audioFiles.map((file, index) => {
        const metadata = audioMetadata[file.name];
        const isVoiceMessage = isUserVoiceRecording(file);

        return (
          <AnimatePresence mode="wait" key={`${file.name}-${index}`}>
            {(!showAll && index >= INITIAL_DISPLAY_COUNT) ? null : (
              <motion.div
                initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                animate={{ opacity: 1, height: "auto", marginBottom: 8 }}
                exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                transition={{
                  duration: 0.2,
                  ease: "easeInOut"
                }}
              >
                {isVoiceMessage ? (
                  <VoiceMessageRender file={file} />
                ) : (
                <div className={`group relative flex items-center gap-3 p-2 md:p-3 cursor-pointer !transition-all rounded-xl ${getBackgroundStyle(metadata?.coverUrl)}`}>
                  {metadata?.coverUrl && (
                    <>
                      <div
                        className="absolute inset-0 bg-cover bg-center blur-2xl opacity-40"
                        style={{ backgroundImage: `url(${metadata.coverUrl})` }}
                      />
                      <div className="absolute inset-0 bg-black bg-opacity-20" />
                    </>
                  )}

                  <div className="relative flex items-center gap-3 w-full z-10">
                    <div
                      className="relative min-w-[40px] md:min-w-[50px] h-[40px] md:h-[50px] cursor-pointer"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        togglePlay(file.name);
                      }}>
                      {metadata?.coverUrl ? (
                        <>
                          <img
                            src={metadata.coverUrl}
                            alt="Album Cover"
                            className="w-full h-full rounded-md object-cover pointer-events-none"
                          />
                          <div className="absolute inset-0 flex items-center justify-center hover:bg-black/20 rounded-md !transition-all pointer-events-none">
                            <Icon
                              icon={isCurrentPlaying(file.name) ? "ph:pause-fill" : "ph:play-fill"}
                              className="w-6 h-6 text-white drop-shadow-lg"
                            />
                          </div>
                        </>
                      ) : (
                        <div className="w-full h-full rounded-full bg-blue-500 flex items-center justify-center pointer-events-none shadow-lg hover:bg-blue-600 transition-colors">
                          {!isCurrentPlaying(file.name) && (
                            <Icon icon="ph:music-notes-fill" className="w-5 h-5 text-white" />
                          )}
                          {isCurrentPlaying(file.name) && (
                            <Icon
                              icon="ph:pause-fill"
                              className="w-4 h-4 text-white"
                            />
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <div className={`font-medium truncate max-w-[90%] ${metadata?.coverUrl ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}>
                          {metadata?.trackName || file.name}
                        </div>
                        <AnimatePresence>
                          {isCurrentPlaying(file.name) && (
                            <motion.div
                              className={`text-xs ${metadata?.coverUrl ? 'text-white/80' : 'text-gray-600 dark:text-gray-400'}`}
                              initial={{ opacity: 0, x: -10 }}
                              animate={{ opacity: 1, x: 0 }}
                              exit={{ opacity: 0, x: -10 }}
                              transition={{ type: "spring", stiffness: 300, damping: 25 }}
                            >
                              {currentTime[file.name]} / {getDuration(file) || formatTime((() => {
                                 const rawDuration = musicManager.audioElement?.duration;
                                 const dur = (rawDuration && isFinite(rawDuration) && !isNaN(rawDuration)) ? rawDuration : musicManager.duration;
                                 return dur || 0;
                               })())}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                      {metadata?.artists && metadata.artists.length > 0 && (
                        <div className={`text-sm truncate ${metadata?.coverUrl ? 'text-white/80' : 'text-gray-600 dark:text-gray-400'}`}>
                          {metadata.artists.join(', ')}
                        </div>
                      )}

                      {!isCurrentPlaying(file.name) && !metadata?.artists && getDuration(file) && (
                        <div className={`text-sm ${metadata?.coverUrl ? 'text-white/80' : 'text-gray-600 dark:text-gray-400'}`}>
                          {getDuration(file)}
                        </div>
                      )}

                      <AnimatePresence>
                        {isCurrentPlaying(file.name) && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ type: "spring", stiffness: 300, damping: 25 }}
                          >
                            <div
                              className="relative h-1 bg-black/20 rounded-full mt-2 cursor-pointer"
                              onClick={(e) => handleProgressBarClick(e, file.name)}
                              onMouseDown={(e) => handleProgressBarDrag(e, file.name)}
                            >
                              <div
                                ref={el => {
                                  if (el) {
                                    progressRefs.current[file.name] = el;
                                  }
                                }}
                                className={`absolute h-full rounded-full !transition-all duration-100 ${metadata?.coverUrl ? 'bg-white' : 'bg-primary'
                                  }`}
                              />
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {!file.uploadPromise?.loading?.value && !preview && (
                      <DeleteIcon
                        files={files}
                        className={`ml-2 group-hover:opacity-100 opacity-0 ${metadata?.coverUrl ? 'text-white' : 'text-gray-400 hover:text-red-500'
                          }`}
                        file={file}
                      />
                    )}
                    {preview && (
                      <DownloadIcon
                        className={`ml-2 ${metadata?.coverUrl ? 'text-white' : 'text-gray-400 hover:text-blue-500'}`}
                        file={file}
                      />
                    )}
                  </div>
                </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        );
      })}

      {audioFiles.length > INITIAL_DISPLAY_COUNT && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className='w-full flex justify-center'
        >
          <Button
            variant="light"
            className="mt-2 w-fit mx-auto"
            onPress={() => setShowAll(!showAll)}
          >
            <Icon
              icon={showAll ? "ph:caret-up" : "ph:caret-down"}
              className="mr-2"
            />
            {showAll ? t('collapse') : `${t('show-all')} (${audioFiles.length})`}
          </Button>
        </motion.div>
      )}
    </div>
  );
})
