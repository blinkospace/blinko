import { describe, expect, it } from 'bun:test';
import {
  runNoteProcessing,
  type ProcessingEffect,
  type ProcessingState,
  type ProcessingStore,
} from '../../../aiServer/noteProcessing';
import { generatedTagEffects, inlineTagIds, withoutTagOnlyLines } from '../../../aiServer/tagProcessing';
import { helper } from '../../../../shared/lib/helper';

function createState(): ProcessingState {
  return { version: 1, requestedBy: 1, audio: [], post: true, mode: 'tags', prompts: {}, done: [] };
}

describe('tag post-processing coordination', () => {
  it('removes tag-only lines without stripping Markdown titles or prose', () => {
    expect(withoutTagOnlyLines('# Traum\n\nIch sah #Pizza.\n\n#Traum #Essen')).toBe('# Traum\n\nIch sah #Pizza.');
  });
  it('preserves independent tags when editing, while allowing removal of inline tags', () => {
    const tags = [
      { id: 1, name: 'Traum', parent: 0 },
      { id: 2, name: 'Ort', parent: 0 },
      { id: 3, name: 'Wald', parent: 2 },
      { id: 4, name: 'Wald', parent: 0 },
    ];
    expect([...inlineTagIds('Text ohne Tags', tags)]).toEqual([]);
    expect([...inlineTagIds('Text #Ort/Wald', tags)]).toEqual([2, 3]);
  });
  it('emits only missing tags without altering the transcript', () => {
    const note = '#Traum\n\n---\n\nDas ist das Transkript.';
    const [effect] = generatedTagEffects('#Traum #Auto #Identität', note);
    expect(note).toBe('#Traum\n\n---\n\nDas ist das Transkript.');
    expect(helper.extractHashtags(effect!.content)).toEqual(['#Auto', '#Identität']);
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

  it('enforces an explicit default maximum after deduplication', () => {
    expect(generatedTagEffects('#one #two #one #three #four #five #six', '', 5)).toEqual([
      { kind: 'tags', content: '#one #two #three #four #five' },
    ]);
  });

  it('allows six user-requested tags and reuses existing spelling', () => {
    expect(generatedTagEffects('#traum #Essen #Farbe #Hasen #Pizza #Ort', '', undefined, ['Traum'])).toEqual([
      { kind: 'tags', content: '#Traum #Essen #Farbe #Hasen #Pizza #Ort' },
    ]);
  });
});
