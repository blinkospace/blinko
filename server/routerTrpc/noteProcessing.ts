import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { authProcedure } from '../middleware';
import { prisma } from '../prisma';
import { AiModelFactory } from '../aiServer/aiModelFactory';
import {
  canProcessNote, createProcessingState, lockProcessingNote, NoteProcessingJob, readProcessingState,
} from '../jobs/noteProcessingJob';

async function status(noteId: number, accountId: number) {
  return prisma.$transaction(async tx => {
    const allowed = await canProcessNote(tx, noteId, accountId);
    if (!allowed) return { allowed: false, status: 'unavailable', audio: [], post: false, error: false, canStart: false, canRetry: false, canSkip: false };
    const job = await tx.noteProcessing.findUnique({ where: { noteId } });
    if (!job) return { allowed: true, status: 'not-started', audio: [], post: false, error: false, canStart: true, canRetry: false, canSkip: false };
    const state = readProcessingState(job.state);
    const note = await tx.notes.findUnique({ where: { id: noteId }, select: { content: true } });
    const active = ['queued', 'running'].includes(job.status);
    return {
      allowed: true, status: job.status, post: state.post,
      content: note?.content,
      audio: state.audio.map(a => ({ id: a.id, name: a.name, status: a.status })),
      error: !!(state.postError || state.embeddingError || state.audio.some(a => a.status === 'failed')),
      canStart: job.status === 'completed' && !state.post,
      canRetry: job.status === 'failed' || job.status === 'cancelled',
      canSkip: (active || job.status === 'failed') && state.audio.some(a => ['pending', 'failed'].includes(a.status)),
    };
  });
}

export const processingStatus = authProcedure.input(z.object({ noteId: z.number() }))
  .query(({ input, ctx }) => status(input.noteId, Number(ctx.id)));

export const processingControl = authProcedure.input(z.object({
  noteId: z.number(), action: z.enum(['start', 'retry', 'skip']), transcribe: z.boolean().default(false),
})).mutation(async ({ input, ctx }) => {
  const config = await AiModelFactory.globalConfig();
  await prisma.$transaction(async tx => {
    const note = await lockProcessingNote(tx, input.noteId);
    if (!note || !await canProcessNote(tx, input.noteId, Number(ctx.id))) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to process this note' });
    }
    const job = await tx.noteProcessing.findUnique({ where: { noteId: input.noteId } });
    if (job && ['queued', 'running'].includes(job.status) && input.action !== 'skip') return;
    const attachments = await tx.attachments.findMany({ where: { noteId: input.noteId }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    const state = job ? readProcessingState(job.state) : createProcessingState(config, Number(ctx.id), attachments, { manual: true, transcribe: input.transcribe });
    if (!job && input.action !== 'start') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Start processing first' });
    if (input.action === 'start' && job) {
      if (job.status !== 'completed' || state.post) return;
      state.post = true;
      const settings = createProcessingState(config, Number(ctx.id), [], { manual: true });
      state.mode = settings.mode;
      state.prompts = settings.prompts;
    }
    if (input.action === 'retry') {
      if (!job || !['failed', 'cancelled'].includes(job.status)) return;
      for (const audio of state.audio) if (audio.status === 'failed') { audio.status = 'pending'; delete audio.error; }
      delete state.postError;
      delete state.embeddingError;
    }
    if (input.action === 'skip') {
      if (!job || !['queued', 'running', 'failed'].includes(job.status)) return;
      for (const audio of state.audio) if (['pending', 'failed'].includes(audio.status)) { audio.status = 'skipped'; delete audio.error; }
    }
    // Retry keeps selected model and prompts. A previously missing model may now be configured.
    state.voiceModelId ||= config.voiceModelId;
    if (state.audio.some(a => a.status === 'pending') && !state.voiceModelId) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Configure a voice model or skip transcription' });
    }
    if (state.post && !config.mainModelId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Configure a main AI model first' });
    state.requestedBy = Number(ctx.id);
    const data = { state: JSON.parse(JSON.stringify(state)), status: 'queued', token: null, leaseUntil: null };
    await tx.noteProcessing.upsert({ where: { noteId: input.noteId }, create: { noteId: input.noteId, ...data }, update: data });
  });
  void NoteProcessingJob.wake(input.noteId);
  return status(input.noteId, Number(ctx.id));
});
