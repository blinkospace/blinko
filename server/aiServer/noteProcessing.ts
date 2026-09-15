/** Pure coordination rules. External calls never run inside a database transaction. */
export type AudioStatus = 'pending' | 'succeeded' | 'empty' | 'failed' | 'skipped';
export type ProcessingStep = 'comment' | 'tags' | 'smartEdit' | 'custom';
export interface ProcessingAudio {
  id: number;
  path: string;
  name: string;
  status: AudioStatus;
  text?: string;
  error?: string;
}
export interface ProcessingState {
  version: 1;
  requestedBy: number;
  voiceModelId?: number;
  audio: ProcessingAudio[];
  post: boolean;
  mode: string;
  prompts: { comment?: string; tags?: string; smartEdit?: string; custom?: string };
  done: ProcessingStep[];
  postError?: string;
  embeddingError?: string;
  indexedContent?: string;
}
export interface ProcessingNote { id: number; content: string; accountId: number | null; }
export interface ProcessingEffect {
  kind: 'comment' | 'replace' | 'tags' | 'create';
  content: string;
  type?: number;
}
export interface ProcessingStore {
  // Implementations must validate the lease, note existence and current permission.
  load(): Promise<{ note: ProcessingNote; state: ProcessingState } | null>;
  audioExists(audio: ProcessingAudio): Promise<boolean>;
  saveAudio(audio: ProcessingAudio, text: string): Promise<void>;
  failAudio(audio: ProcessingAudio, code: string): Promise<void>;
  skipAudio(audio: ProcessingAudio): Promise<void>;
  saveStep(step: ProcessingStep, source: string, effects: ProcessingEffect[]): Promise<void>;
  postFailed(code: string): Promise<void>;
  indexed(content: string, error?: string): Promise<void>;
  finish(): Promise<void>;
}
export interface ProcessingModels {
  transcribe(audio: ProcessingAudio, modelId: number): Promise<string>;
  post(step: ProcessingStep, note: ProcessingNote, state: ProcessingState): Promise<ProcessingEffect[]>;
  embed(note: ProcessingNote): Promise<void>;
}

export function isVoiceRecording(file: { name: string; type?: string; metadata?: unknown }): boolean {
  const metadata = file.metadata as { isUserVoiceRecording?: boolean } | null;
  return metadata?.isUserVoiceRecording === true || /^my_recording_.*\.(webm|mp4|m4a|ogg)$/i.test(file.name);
}

export function isAudioAttachment(file: { name: string; path?: string; type?: string }): boolean {
  return !!file.type?.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac|wma|opus|webm)$/i.test(file.name || file.path || '');
}

export function appendTranscript(current: string, transcript: string): string {
  const text = transcript.trim();
  if (!text) return current;
  return current.trim() ? `${current}\n\n---\n\n${text}` : text;
}

// A stale editor may safely rebase over transcript-only appends. Other changes
// require a conflict response so the user's draft is not silently overwritten.
export function mergeTranscriptAppend(base: string, edited: string, current: string, audio: ProcessingAudio[]): string | null {
  if (base === current) return edited;
  const texts = audio.filter(a => a.status === 'succeeded' && a.text).map(a => a.text!);
  for (let start = 0; start < texts.length; start++) {
    const tail = texts.slice(start);
    if (tail.reduce(appendTranscript, base) === current) return tail.reduce(appendTranscript, edited);
  }
  return null;
}

export function processingSteps(state: ProcessingState): ProcessingStep[] {
  if (!state.post) return [];
  if (state.mode === 'both') return ['comment', 'tags', 'smartEdit'];
  return [(['comment', 'tags', 'smartEdit', 'custom'].includes(state.mode) ? state.mode : 'comment') as ProcessingStep];
}

export async function withProcessingTimeout<T>(work: () => Promise<T>, milliseconds = 150_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('PROCESSING_TIMEOUT')), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function runNoteProcessing(store: ProcessingStore, models: ProcessingModels): Promise<void> {
  let current = await store.load();
  if (!current) return;
  // Stable attachment order; checkpoint each result immediately, including empty speech.
  for (const audio of current.state.audio) {
    if (audio.status !== 'pending') continue;
    if (!(await store.load())) return;
    if (!(await store.audioExists(audio))) { await store.skipAudio(audio); continue; }
    try {
      if (!current.state.voiceModelId) throw new Error('VOICE_MODEL_MISSING');
      const text = await withProcessingTimeout(() => models.transcribe(audio, current!.state.voiceModelId!));
      if (typeof text !== 'string') throw new Error('INVALID_TRANSCRIPTION');
      await store.saveAudio(audio, text.trim());
    } catch {
      await store.failAudio(audio, 'TRANSCRIPTION_FAILED');
    }
  }
  current = await store.load();
  if (!current) return;
  const blocked = current.state.audio.some(a => a.status === 'failed' || a.status === 'pending');
  if (!blocked) {
    for (const step of processingSteps(current.state)) {
      current = await store.load();
      if (!current) return;
      if (current.state.done.includes(step)) continue;
      try {
        const effects = current.note.content.trim()
          ? await withProcessingTimeout(() => models.post(step, current!.note, current!.state)) : [];
        await store.saveStep(step, current.note.content, effects);
      } catch {
        await store.postFailed('POST_PROCESSING_FAILED');
        break;
      }
    }
  }
  // Index the saved text even if transcription was partial or post-processing failed.
  current = await store.load();
  if (!current) return;
  if (current.state.indexedContent !== current.note.content || current.state.embeddingError) {
    try {
      await withProcessingTimeout(() => models.embed(current!.note));
      await store.indexed(current.note.content);
    } catch {
      await store.indexed(current.note.content, 'EMBEDDING_FAILED');
    }
  }
  await store.finish();
}
