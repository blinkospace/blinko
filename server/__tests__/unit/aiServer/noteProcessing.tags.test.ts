import { describe, expect, it } from 'bun:test';
import {
  runNoteProcessing,
  type ProcessingEffect,
  type ProcessingState,
  type ProcessingStore,
} from '../../../aiServer/noteProcessing';
import { generatedTagEffects } from '../../../aiServer/tagProcessing';
import { helper } from '../../../../shared/lib/helper';

function createState(): ProcessingState {
  return { version: 1, requestedBy: 1, audio: [], post: true, mode: 'tags', prompts: {}, done: [] };
}

describe('tag post-processing coordination', () => {
  it('keeps an existing tag while adding transcript text and generated tags', () => {
    const note = '#Traum\n\n---\n\nDas ist das Transkript.';
    const [effect] = generatedTagEffects('#Traum #Auto #Identität', note);
    const saved = `${note}\n\n${effect!.content}`;

    expect(saved).toContain('#Traum\n\n---\n\nDas ist das Transkript.');
    expect(helper.extractHashtags(saved)).toEqual(['#Traum', '#Auto', '#Identität']);
  });

  it('does not complete the tags step when the model produces no usable tags', async () => {
    const processing = createState();
    const savedSteps: string[] = [];
    const store: ProcessingStore = {
      load: async () => ({ note: { id: 1, accountId: 1, content: 'private note' }, state: processing }),
      audioExists: async () => true,
      saveAudio: async () => {},
      failAudio: async () => {},
      skipAudio: async () => {},
      saveStep: async (step, _source, _effects: ProcessingEffect[]) => {
        savedSteps.push(step);
        processing.done.push(step);
      },
      postFailed: async code => { processing.postError = code; },
      indexed: async () => {},
      finish: async () => {},
    };

    await runNoteProcessing(store, {
      transcribe: async () => '',
      post: async () => generatedTagEffects('No suitable tags.', 'private note'),
      embed: async () => {},
    });

    expect(savedSteps).toEqual([]);
    expect(processing.done).toEqual([]);
    expect(processing.postError).toBe('POST_PROCESSING_FAILED');
  });

  it('enforces the five-tag maximum after deduplication', () => {
    expect(generatedTagEffects('#one #two #one #three #four #five #six', '')).toEqual([
      { kind: 'tags', content: '#one #two #three #four #five' },
    ]);
  });
});
