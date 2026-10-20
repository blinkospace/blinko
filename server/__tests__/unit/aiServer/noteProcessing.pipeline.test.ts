import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { runNoteProcessing, processingSteps, type ProcessingState } from '../../../aiServer/noteProcessing';

const raw = 'Ich habe geträumt, dass ich blau bin und dann grün und dann war alles gelb und dann kam Pizza und dann habe ich gesagt, meine Güte, heute kann ich auch mal eine Leberkasse mit frühstücken. Dann war noch irgendwas, nee, am Anfang des Traumes war dann noch irgendwas, dass mich Hasen verfolgt haben.';
const edited = '### Farbwechsel und die verfolgenden Hasen\n\nAm Anfang des Traums wurde ich von Hasen verfolgt.\n\nSpäter war ich blau, dann grün, schließlich war alles gelb. Danach kam Pizza. Ich dachte, heute kann ich auch eine Leberkasse zum Frühstück essen.';
let state: ProcessingState;
let note: any;
let job: any;
let tags: any[];
let relations: any[];
let history: any[];
let comments: any[];
let attachments: any[];
let modelReply: 'text' | 'tool' | 'multiple' | 'empty' | 'textWithTags';
let agentOptions: any;
let mutateDuringRequest = false;
const wake = mock(async () => {});
const updateNote = mock(async ({ data }: any) => { Object.assign(note, data); return { ...note }; });
const db: any = {
  $transaction: async (fn: any) => fn(db),
  $queryRaw: async () => attachments.map(a => ({ id: a.id })),
  notes: { findUnique: async () => ({ ...note }), findFirst: async () => ({ ...note }), update: updateNote },
  accounts: { findUnique: async () => ({ id: 1 }) },
  noteProcessing: {
    findUnique: async () => ({ ...job, state: structuredClone(state) }),
    update: async ({ data }: any) => { if (data.state) state = structuredClone(data.state); Object.assign(job, data); },
  },
  noteHistory: {
    findFirst: async () => history.at(-1),
    create: async ({ data }: any) => { history.push(data); },
  },
  tag: {
    findMany: async () => tags,
    findFirst: async ({ where }: any) => tags.find(t => t.name === where.name && t.parent === where.parent && t.accountId === where.accountId),
    create: async ({ data }: any) => { const tag = { id: tags.length + 1, ...data }; tags.push(tag); return tag; },
  },
  tagsToNote: {
    createMany: async ({ data }: any) => { for (const r of data) if (!relations.some(e => e.tagId === r.tagId && e.noteId === r.noteId)) relations.push(r); },
  },
  comments: { create: async ({ data }: any) => { comments.push(data); } },
  notifications: { create: async () => {} },
};
mock.module('../../../prisma', () => ({ prisma: db }));
mock.module('../../../lib/pgBoss', () => ({ getPgBoss: async () => ({ send: wake }) }));
mock.module('../../../lib/files', () => ({ FileService: { getFile: async () => ({ path: 'audio.webm' }) } }));
mock.module('../../../aiServer/index', () => ({ AiService: { transcribeAudio: async () => raw } }));
const generate = mock(async () => {
  if (mutateDuringRequest) note.content = 'Manuelle Änderung';
  if (modelReply === 'empty') return { text: '', toolCalls: [] };
  if (modelReply === 'tool' || modelReply === 'multiple') {
    if (modelReply === 'multiple') await agentOptions.localTools.updateBlinkoTool.execute({ context: { id: 7, content: 'Intermediate' } });
    await agentOptions.localTools.updateBlinkoTool.execute({ context: { id: 7, content: edited } });
    return { text: 'Updated successfully', toolCalls: [{ toolName: 'updateBlinkoTool' }] };
  }
  return { text: modelReply === 'textWithTags' ? `${edited}\n\n#Traum #Essen #Pizza` : edited, toolCalls: [] };
});
const commentGenerate = mock(async () => ({ text: 'Ein Kommentar' }));
const tagGenerate = mock(async (_prompt: string, _options: unknown) => ({ text: '#traum #Essen #Farbe #Hasen #Pizza #Ort' }));
mock.module('../../../aiServer/aiModelFactory', () => ({ AiModelFactory: {
  BaseChatAgent: async (options: any) => { agentOptions = options; return { generate }; },
  CommentAgent: async () => ({ generate: commentGenerate }),
  TagAgent: async () => ({ generate: tagGenerate }),
  globalConfig: async () => ({}),
} }));
const { processingModels } = await import('../../../aiServer/processingModels');
const { createProcessingStore, createProcessingState } = await import('../../../jobs/noteProcessingJob');

beforeEach(() => {
  state = { version: 1, requestedBy: 1, audio: [], post: true, mode: 'smartEdit', prompts: {}, done: [] };
  note = { id: 7, accountId: 1, content: raw, metadata: { private: true }, type: 1 };
  job = { token: 'token', status: 'running', leaseUntil: new Date(Date.now() + 60_000) };
  tags = [{ id: 1, name: 'Traum', parent: 0, accountId: 1 }];
  relations = [{ noteId: 7, tagId: 1 }];
  history = []; comments = []; attachments = [{ id: 3, noteId: 7, path: '/audio.webm' }];
  modelReply = 'text'; mutateDuringRequest = false;
  updateNote.mockClear(); generate.mockClear(); wake.mockClear(); commentGenerate.mockClear(); tagGenerate.mockClear();
});
const run = () => runNoteProcessing(createProcessingStore(7, 'token'), processingModels);

describe('real model adapter + processing worker + store (mocked provider/database)', () => {
  for (const reply of ['text', 'tool', 'multiple'] as const) {
    it(`Smart Edit commits one replacement and no comments for ${reply}`, async () => {
      modelReply = reply;
      state.audio = [{ id: 3, path: '/audio.webm', name: 'audio.webm', status: 'succeeded', text: raw }];
      await run();
      expect(note.content).toBe(edited);
      expect(updateNote).toHaveBeenCalledTimes(1);
      expect(comments).toEqual([]);
      expect(history.map(h => h.content)).toEqual([raw]);
      expect(attachments).toEqual([{ id: 3, noteId: 7, path: '/audio.webm' }]);
      expect(note.metadata).toEqual({ private: true });
      expect(relations).toEqual([{ noteId: 7, tagId: 1 }]);
      expect(wake).not.toHaveBeenCalled();
      expect(Object.keys(agentOptions.localTools)).toEqual(['updateBlinkoTool']);
      expect(agentOptions.extraInstructions).not.toContain('Comment Assistant');
      expect(note.content).not.toContain(raw);
      expect(state.done).toEqual(['smartEdit']);
    });
  }

  it('Comment creates exactly one comment without editing', async () => {
    state.mode = 'comment'; await run();
    expect(comments.map(c => c.content)).toEqual(['Ein Kommentar']);
    expect(note.content).toBe(raw); expect(updateNote).not.toHaveBeenCalled();
  });
  it('Tags adds real relations without modifying content or creating comments', async () => {
    state.mode = 'tags'; state.prompts.tags = '3 bis maximal 6 Tags'; await run();
    expect(relations).toHaveLength(6); expect(tags[0].name).toBe('Traum');
    expect(note.content).toBe(raw); expect(comments).toEqual([]); expect(updateNote).not.toHaveBeenCalled();
  });
  it('combined editing and tags runs once, in order, without comments', async () => {
    state.mode = 'smartEditTags'; await run();
    expect(note.content).toBe(edited); expect(relations).toHaveLength(5);
    expect(updateNote).toHaveBeenCalledTimes(1); expect(comments).toEqual([]);
    expect(state.done).toEqual(['smartEdit', 'tags']);
    expect(commentGenerate).not.toHaveBeenCalled();
    expect(tagGenerate.mock.calls[0]?.[0]).toContain(edited);
    // A redelivery with an expired/completed token cannot repeat mutations.
    await run(); expect(updateNote).toHaveBeenCalledTimes(1);
  });
  it('Both retains comment + tags semantics, without a hidden smart edit', async () => {
    state.mode = 'both'; await run();
    expect(comments).toHaveLength(1); expect(note.content).toBe(raw);
    expect(generate).not.toHaveBeenCalled(); expect(relations).toHaveLength(5);
  });
  it('combined mode removes a model-generated hashtag line from the body', async () => {
    state.mode = 'smartEditTags'; modelReply = 'textWithTags'; await run();
    expect(note.content).toBe(edited); expect(relations).toHaveLength(5);
    expect(updateNote).toHaveBeenCalledTimes(1); expect(comments).toEqual([]);
  });
  it('an expired worker cannot apply an update', async () => {
    job.leaseUntil = new Date(0); await run();
    expect(note.content).toBe(raw); expect(comments).toEqual([]);
    expect(generate).not.toHaveBeenCalled(); expect(updateNote).not.toHaveBeenCalled();
  });
  it('Custom comment action saves one comment without tools', async () => {
    state.mode = 'custom'; state.customAction = 'comment'; await run();
    expect(note.content).toBe(raw); expect(comments.map(c => c.content)).toEqual([edited]);
    expect(Object.keys(agentOptions.localTools)).toEqual([]);
  });
  it('transcribes before editing and retains audio and internal source transcript', async () => {
    state = createProcessingState({ voiceModelId: 2, isUseAiPostProcessing: true, aiPostProcessingMode: 'smartEditTags' } as any,
      1, [{ id: 3, name: 'my_recording_1.webm', path: '/audio.webm' }]);
    note.content = ''; await run();
    expect(note.content).toBe(edited); expect(state.audio[0]?.text).toBe(raw);
    expect(history.map(h => h.content)).toEqual(['', raw]);
    expect(attachments).toHaveLength(1); expect(comments).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });
  it('Custom can explicitly update using a tool, without a fallback comment', async () => {
    state.mode = 'custom'; state.prompts.custom = 'Ersetze die Hauptnotiz'; modelReply = 'tool'; await run();
    expect(note.content).toBe(edited); expect(comments).toEqual([]);
  });
  it('Custom replace action deterministically saves plain content', async () => {
    state.mode = 'custom'; state.customAction = 'replace'; await run();
    expect(note.content).toBe(edited); expect(comments).toEqual([]);
  });
  it('Custom tools with no action fails retryably instead of guessing a comment', async () => {
    state.mode = 'custom'; await run();
    expect(state.postError).toBe('POST_PROCESSING_FAILED'); expect(state.done).toEqual([]);
    expect(note.content).toBe(raw); expect(comments).toEqual([]);
  });
  it('empty edits leave content untouched and the step retryable', async () => {
    modelReply = 'empty'; await run();
    expect(note.content).toBe(raw); expect(comments).toEqual([]);
    expect(state.done).toEqual([]); expect(job.status).toBe('failed');
  });
  it('concurrent manual edits are preserved without a suggestion comment', async () => {
    mutateDuringRequest = true; await run();
    expect(note.content).toBe('Manuelle Änderung'); expect(comments).toEqual([]);
    expect(state.done).toEqual([]); expect(job.status).toBe('failed');
    expect(updateNote).not.toHaveBeenCalled();
  });
  it('checkpointed stages are skipped on retry', async () => {
    state.mode = 'smartEditTags'; state.done = ['smartEdit']; note.content = edited; await run();
    expect(generate).not.toHaveBeenCalled(); expect(updateNote).not.toHaveBeenCalled();
    expect(relations).toHaveLength(5); expect(comments).toEqual([]);
  });
  it('post-processing can be disabled', () => {
    state.post = false; expect(processingSteps(state)).toEqual([]);
  });
});
