import { useState, useCallback, useRef, useEffect } from 'react';

export interface recorderControls {
  startRecording: () => Promise<MediaStream | undefined>;
  stopRecording: () => void;
  togglePauseResume: () => void;
  recordingBlob?: Blob;
  isRecording: boolean;
  isPaused: boolean;
  recordingTime: number;
  mediaRecorder?: MediaRecorder;
}

export type MediaAudioTrackConstraints = Pick<MediaTrackConstraints,
  'deviceId' | 'groupId' | 'autoGainControl' | 'channelCount' |
  'echoCancellation' | 'noiseSuppression' | 'sampleRate' | 'sampleSize'>;

export default function useAudioRecorder(
  audioTrackConstraints?: MediaAudioTrackConstraints,
  onNotAllowedOrFound?: (exception: DOMException) => any,
  mediaRecorderOptions?: MediaRecorderOptions,
): recorderControls {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder>();
  const [recordingBlob, setRecordingBlob] = useState<Blob>();
  const recorderRef = useRef<MediaRecorder>();
  const pendingRef = useRef<Promise<MediaStream | undefined>>();
  const generation = useRef(0);
  const mounted = useRef(true);
  const manualPause = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval>>();
  const elapsed = useRef(0);
  const startedAt = useRef<number>();
  const wakeLock = useRef<WakeLockSentinel>();
  const requestingWakeLock = useRef(false);

  const releaseWakeLock = useCallback(() => {
    const lock = wakeLock.current;
    wakeLock.current = undefined;
    void lock?.release().catch(() => {});
  }, []);

  const acquireWakeLock = useCallback(async () => {
    if (!mounted.current || document.visibilityState !== 'visible' ||
        recorderRef.current?.state !== 'recording' || wakeLock.current || requestingWakeLock.current ||
        !navigator.wakeLock) return;
    requestingWakeLock.current = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!mounted.current || document.visibilityState !== 'visible' || recorderRef.current?.state !== 'recording') {
        await lock.release();
      } else {
        wakeLock.current = lock;
        lock.addEventListener('release', () => {
          if (wakeLock.current === lock) wakeLock.current = undefined;
        }, { once: true });
      }
    } catch { /* Optional: unavailable browser API or power-saving policy. */ }
    finally { requestingWakeLock.current = false; }
  }, []);

  const updateClock = useCallback(() => {
    const recorder = recorderRef.current;
    const capturing = recorder?.state === 'recording' &&
      recorder.stream.getAudioTracks().some(track => track.readyState === 'live' && !track.muted);
    const now = performance.now();
    if (!capturing && startedAt.current !== undefined) {
      elapsed.current += now - startedAt.current;
      startedAt.current = undefined;
    } else if (capturing && startedAt.current === undefined) startedAt.current = now;
    if (mounted.current) {
      setRecordingTime(Math.floor((elapsed.current + (startedAt.current === undefined ? 0 : now - startedAt.current)) / 1000));
      setIsPaused(recorder?.state === 'paused');
    }
  }, []);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    // onstop follows the final dataavailable event. Keep elapsed time and chunks.
    updateClock();
    releaseWakeLock();
  }, [releaseWakeLock, updateClock]);

  const startRecording = useCallback((): Promise<MediaStream | undefined> => {
    if (pendingRef.current) return pendingRef.current;
    // One session per dialog, including after an unexpected stop.
    if (recorderRef.current) return Promise.resolve(
      recorderRef.current.state === 'inactive' ? undefined : recorderRef.current.stream);
    const attempt = generation.current;
    const pending = (async () => {
      let stream: MediaStream | undefined;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioTrackConstraints || {
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        } });
        if (!mounted.current || generation.current !== attempt) {
          stream.getTracks().forEach(track => track.stop());
          return undefined;
        }
        const options = { audioBitsPerSecond: 128000, ...mediaRecorderOptions };
        if (!options.mimeType) {
          const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
            .find(type => MediaRecorder.isTypeSupported(type));
          if (type) options.mimeType = type;
        }
        const recorder = new MediaRecorder(stream, options);
        const chunks: Blob[] = [];
        recorderRef.current = recorder;
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = () => {
          clearInterval(timer.current);
          updateClock();
          releaseWakeLock();
          stream!.getTracks().forEach(track => track.stop());
          if (mounted.current) {
            if (chunks.length) setRecordingBlob(new Blob(chunks, { type: recorder.mimeType || chunks[0]!.type }));
            setIsRecording(false);
            setIsPaused(false);
            setMediaRecorder(undefined);
          }
        };
        recorder.onpause = () => { updateClock(); releaseWakeLock(); };
        recorder.onresume = () => { updateClock(); void acquireWakeLock(); };
        recorder.onerror = () => {
          // MediaRecorder delivers remaining data and stop after an error.
          if (recorder.state !== 'inactive') stopRecording();
        };
        for (const track of stream.getAudioTracks()) {
          track.addEventListener('mute', updateClock);
          track.addEventListener('unmute', updateClock);
          track.addEventListener('ended', stopRecording);
        }
        recorder.start(100);
        setMediaRecorder(recorder);
        setIsRecording(true);
        updateClock();
        timer.current = setInterval(updateClock, 250);
        void acquireWakeLock();
        // A disabled localStorage must not abort an already running recorder.
        try { localStorage.setItem('microphone_permission_granted', 'true'); } catch {}
        return stream;
      } catch (error) {
        stream?.getTracks().forEach(track => track.stop());
        if (mounted.current && generation.current === attempt) {
          recorderRef.current = undefined;
          onNotAllowedOrFound?.(error as DOMException);
        }
        throw error;
      }
    })();
    pendingRef.current = pending;
    void pending.finally(() => { if (pendingRef.current === pending) pendingRef.current = undefined; }).catch(() => {});
    return pending;
  }, [audioTrackConstraints, mediaRecorderOptions, onNotAllowedOrFound, acquireWakeLock, releaseWakeLock, stopRecording, updateClock]);

  const togglePauseResume = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') { manualPause.current = true; recorder.pause(); }
    else if (recorder?.state === 'paused') { manualPause.current = false; recorder.resume(); }
    updateClock();
  }, [updateClock]);

  useEffect(() => {
    mounted.current = true;
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') { releaseWakeLock(); return; }
      const recorder = recorderRef.current;
      if (recorder?.state === 'paused' && !manualPause.current) {
        try { recorder.resume(); } catch { stopRecording(); }
      }
      updateClock();
      void acquireWakeLock();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mounted.current = false;
      generation.current++;
      pendingRef.current = undefined;
      stopRecording();
      recorderRef.current?.stream.getTracks().forEach(track => track.stop());
      clearInterval(timer.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [acquireWakeLock, releaseWakeLock, stopRecording, updateClock]);

  return { startRecording, stopRecording, togglePauseResume, recordingBlob, isRecording, isPaused, recordingTime, mediaRecorder };
}
