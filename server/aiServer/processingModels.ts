import { AiModelFactory } from './aiModelFactory';
import { AiService } from './index';
import { FileService } from '../lib/files';
import { prisma } from '../prisma';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';
import { helper } from '@shared/lib/helper';
import type { ProcessingEffect, ProcessingModels } from './noteProcessing';
import { generatedTagEffects } from './tagProcessing';

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
    const signal = AbortSignal.timeout(120_000);
    const ownedTags = await prisma.tag.findMany({ where: { accountId: note.accountId } });
    const tagPaths = helper.buildHashTagTreeFromDb(ownedTags).flatMap(root => helper.generateTagPaths(root));
    if (step === 'comment') {
      const agent = await AiModelFactory.CommentAgent();
      const result = await agent.generate([
        { role: 'user', content: state.prompts.comment || 'Analyze the following note content and provide a brief summary.' },
        { role: 'user', content: `Note content: ${note.content}` },
      ], { abortSignal: signal });
      return [{ kind: 'comment', content: result.text.trim() }];
    }
    if (step === 'tags') {
      const agent = await AiModelFactory.TagAgent(state.prompts.tags || undefined);
      const result = await agent.generate(`Existing tags list: [${tagPaths.join(', ')}]\nNote content:\n${note.content}\nReturn at most 5 hashtags as plain text. Hierarchical tags use #Parent/Child.`, { abortSignal: signal });
      return generatedTagEffects(result.text, note.content);
    }

    // Tools collect local effects only. The worker commits effects and checkpoint
    // together, so a retry cannot duplicate already applied comments or new notes.
    const effects: ProcessingEffect[] = [];
    const localTools = {
      updateBlinkoTool: createTool({
        id: 'processing-update-note',
        description: 'Propose an update to the current note. Keep original transcripts intact.',
        inputSchema: z.object({ id: z.number(), content: z.string() }),
        execute: async ({ context }) => {
          if (context.id !== note.id) throw new Error('Only the current note can be updated');
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
    let prompt = step === 'smartEdit'
      ? state.prompts.smartEdit || 'Improve this note by organizing content and enhancing readability.'
      : state.prompts.custom || 'Analyze the following note and add a useful comment.';
    prompt = prompt.replaceAll('{note}', note.content).replaceAll('{tags}', tagPaths.join(', '));
    const agent = await AiModelFactory.BaseChatAgent({
      localTools, withMcpTools: false,
      extraInstructions: 'Process the current note using the available local tools. Preserve source transcripts. Changes are staged and checked before saving. External actions and deleting notes are not supported here.',
    });
    const result = await agent.generate([
      { role: 'user', content: `${prompt}\n\nNote ID: ${note.id}\nNote content:\n${note.content}` },
    ], { abortSignal: signal });
    if (!effects.length && result.text.trim()) effects.push({ kind: 'comment', content: result.text.trim() });
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
