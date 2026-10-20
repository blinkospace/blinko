import { AiModelFactory } from './aiModelFactory';
import { AiService } from './index';
import { FileService } from '../lib/files';
import { prisma } from '../prisma';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';
import { helper } from '@shared/lib/helper';
import type { ProcessingEffect, ProcessingModels } from './noteProcessing';
import { generatedTagEffects, withoutTagOnlyLines } from './tagProcessing';

export const processingModels: ProcessingModels = {
  async transcribe(audio, modelId) {
    const file = await FileService.getFile(audio.path);
    try {
      return await AiService.transcribeAudio({ filePath: file.path, voiceModelId: modelId, accountId: 0 });
    } finally {
      try { await file.cleanup?.(); }
      catch { console.warn('Temporary audio cleanup failed'); }
    }
  },

  async post(step, note, state) {
    const configuredTimeout = Number(process.env.AI_PROCESSING_TIMEOUT_MS) || 120_000;
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 120_000;
    const signal = AbortSignal.timeout(timeoutMs);
    const ownedTags = await prisma.tag.findMany({ where: { accountId: note.accountId } });
    const tagPaths = helper.buildHashTagTreeFromDb(ownedTags).flatMap(root => helper.generateTagPaths(root));
    if (step === 'comment') {
      const agent = await AiModelFactory.CommentAgent();
      const result = await agent.generate([
        { role: 'user', content: state.prompts.comment || 'Analyze the following note content and provide a brief summary.' },
        { role: 'user', content: `Note content: ${note.content}` },
      ], { abortSignal: signal });
      if (!result.text.trim()) throw new Error('NO_PROCESSING_ACTION');
      if (process.env.NOTE_PROCESSING_DEBUG === '1') console.info('note-processing', {
        noteId: note.id, postProcessingMode: state.mode, phase: step,
        toolsOffered: [], toolChoice: 'none', modelReturnedToolCalls: false, selectedAction: 'create-comment',
      });
      return [{ kind: 'comment', content: result.text.trim() }];
    }
    if (step === 'tags') {
      const agent = await AiModelFactory.TagAgent(state.prompts.tags || undefined);
      const result = await agent.generate(`Existing tags list: [${tagPaths.join(', ')}]\nNote content:\n${note.content}\nReturn only hashtags as plain text. Hierarchical tags use #Parent/Child. The application saves them as tag relations without modifying the note text.`, { abortSignal: signal });
      if (process.env.NOTE_PROCESSING_DEBUG === '1') console.info('note-processing', {
        noteId: note.id, postProcessingMode: state.mode, phase: step,
        toolsOffered: [], toolChoice: 'none', modelReturnedToolCalls: false, selectedAction: 'apply-tags',
      });
      return generatedTagEffects(result.text, note.content, state.prompts.tags ? undefined : 5, tagPaths);
    }

    // Tools collect local effects only. The worker commits effects and checkpoint
    // together, so a retry cannot duplicate already applied comments or new notes.
    const effects: ProcessingEffect[] = [];
    const localTools = {
      updateBlinkoTool: createTool({
        id: 'processing-update-note',
        description: 'Replace the current note body. Attachments, tags and the previous body in revision history are preserved by the application.',
        inputSchema: z.object({ id: z.number(), content: z.string() }),
        execute: async ({ context }) => {
          if (context.id !== note.id) throw new Error('Only the current note can be updated');
          // Multiple tool rounds may refine the same body; commit only the last.
          const previous = effects.findIndex(effect => effect.kind === 'replace');
          if (previous !== -1) effects.splice(previous, 1);
          effects.push({ kind: 'replace', content: context.content });
          return { staged: true };
        },
      }),
      createCommentTool: createTool({
        id: 'processing-comment',
        description: 'Add a comment to the current note.',
        inputSchema: z.object({ noteId: z.number(), content: z.string() }),
        execute: async ({ context }) => {
          if (context.noteId !== note.id) throw new Error('Only the current note can be commented on');
          effects.push({ kind: 'comment', content: context.content });
          return { staged: true };
        },
      }),
      upsertBlinkoTool: createTool({
        id: 'processing-create-note',
        description: 'Create a note for the current owner without starting recursive post-processing.',
        inputSchema: z.object({ content: z.string(), type: z.enum(['blinko', 'note', 'todo']).optional() }),
        execute: async ({ context }) => {
          effects.push({ kind: 'create', content: context.content, type: context.type === 'note' ? 1 : context.type === 'todo' ? 2 : 0 });
          return { staged: true };
        },
      }),
    };
    const editing = step === 'smartEdit' || state.customAction === 'replace';
    const commenting = step === 'custom' && state.customAction === 'comment';
    let prompt = step === 'smartEdit'
      ? state.prompts.smartEdit || 'Improve this note by organizing content and enhancing readability.'
      : state.prompts.custom || (editing ? 'Improve the readability of this note.' : 'Analyze the following note and add a useful comment using createCommentTool.');
    prompt = prompt.replaceAll('{note}', note.content).replaceAll('{tags}', tagPaths.join(', '));
    const agent = await AiModelFactory.BaseChatAgent({
      localTools: editing ? { updateBlinkoTool: localTools.updateBlinkoTool } : commenting ? {} : localTools,
      withMcpTools: false,
      extraInstructions: editing
        ? 'You are Blinko Note Editor. Follow the user editing instructions. Return only the complete replacement note body, or stage it with updateBlinkoTool. The application automatically saves the result to the current note. Do not return commentary, explanations, tag lists or a second version. Preserve all relevant details without inventing facts. Do not append the original transcript unless explicitly requested. Audio, existing tags and revision history are preserved separately. No confirmation is needed.'
        : commenting
          ? 'You are Blinko Custom Comment Assistant. Follow the user instructions and return only the comment to save.'
          : 'You are Blinko Custom Processing Assistant. Execute the requested action using the available local tools. Changes are staged and saved automatically. Prior note content is kept in revision history; do not append original transcripts unless requested. Plain text alone does not execute an action. External actions and deleting notes are not supported here.',
    });
    const result = await agent.generate([
      { role: 'user', content: `${prompt}\n\nNote ID: ${note.id}\nNote content:\n${note.content}` },
    ], { abortSignal: signal });
    if (!effects.length && result.text.trim() && (editing || commenting)) {
      effects.push({ kind: editing ? 'replace' : 'comment', content: result.text.trim() });
    }
    if (state.mode === 'smartEditTags') {
      for (const effect of effects) if (effect.kind === 'replace') effect.content = withoutTagOnlyLines(effect.content);
    }
    if (!effects.length || effects.some(effect => !effect.content.trim())) throw new Error('NO_PROCESSING_ACTION');
    if (process.env.NOTE_PROCESSING_DEBUG === '1') console.info('note-processing', {
      noteId: note.id, postProcessingMode: state.mode, phase: step,
      toolsOffered: editing ? ['updateBlinkoTool'] : commenting ? [] : Object.keys(localTools),
      toolChoice: 'auto', modelReturnedToolCalls: !!result.toolCalls?.length,
      selectedAction: effects.map(effect => effect.kind),
    });
    return effects;
  },

  async embed(note) {
    const config = await AiModelFactory.globalConfig();
    if (!config.embeddingModelId) return;
    const current = await prisma.notes.findUnique({ where: { id: note.id } });
    if (!current || current.isRecycle || current.content !== note.content) throw new Error('NOTE_CHANGED');
    const result = await AiService.embeddingUpsert({
      id: note.id, content: note.content, type: 'update', createTime: current.createdAt, updatedAt: current.updatedAt,
    });
    if (!result.ok) throw new Error('EMBEDDING_FAILED');
  },
};
