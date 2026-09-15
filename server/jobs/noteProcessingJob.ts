import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { getPgBoss } from '../lib/pgBoss';
import { processingModels } from '../aiServer/processingModels';
import {
  appendTranscript, isAudioAttachment, isVoiceRecording, processingSteps, runNoteProcessing,
  type ProcessingState, type ProcessingStore, type ProcessingAudio,
} from '../aiServer/noteProcessing';
import type { GlobalConfig } from '@shared/lib/types';
import { helper, type TagTreeNode } from '@shared/lib/helper';

const QUEUE = 'note-processing';
const DISPATCH = 'note-processing-dispatch';
const LEASE_MS = 5 * 60_000;
const json = (state: ProcessingState): Prisma.InputJsonValue => JSON.parse(JSON.stringify(state));
export const readProcessingState = (value: unknown): ProcessingState => {
  const state = value as ProcessingState;
  if (state?.version !== 1) throw new Error('Unsupported note processing state');
  return state;
};

export function createProcessingState(config: GlobalConfig, requestedBy: number, attachments: Array<{
  id: number; name: string; path: string; type?: string; metadata?: unknown;
}>, options?: { manual?: boolean; transcribe?: boolean }): ProcessingState {
  const audio = attachments.filter(a => options?.manual
    ? options.transcribe && (isAudioAttachment(a) || isVoiceRecording(a))
    : isVoiceRecording(a));
  return {
    version: 1, requestedBy,
    ...(config.voiceModelId ? { voiceModelId: config.voiceModelId } : {}),
    audio: audio.map(a => ({ id: a.id, path: a.path, name: a.name, status: 'pending' })),
    post: options?.manual || !!config.isUseAiPostProcessing,
    mode: config.aiPostProcessingMode || 'comment',
    prompts: { comment: config.aiCommentPrompt, tags: config.aiTagsPrompt, smartEdit: config.aiSmartEditPrompt, custom: config.aiCustomPrompt },
    done: [],
  };
}

// The same row lock is used by job commits and manual controls. It is never held
// during a model request. Foreign key cascade removes checkpoints with the note.
export async function lockProcessingNote(tx: Prisma.TransactionClient, noteId: number) {
  await tx.$queryRaw`SELECT id FROM notes WHERE id = ${noteId} FOR UPDATE`;
  return tx.notes.findUnique({ where: { id: noteId } });
}

export async function canProcessNote(tx: Prisma.TransactionClient, noteId: number, accountId: number) {
  const account = await tx.accounts.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!account) return false;
  const note = await tx.notes.findFirst({ where: {
    id: noteId, isRecycle: false,
    OR: [{ accountId }, { internalShares: { some: { accountId, canEdit: true } } }],
  } });
  return !!note;
}

async function syncTags(tx: Prisma.TransactionClient, noteId: number, accountId: number, content: string) {
  const tags = helper.extractHashtags(content);
  const ids: number[] = [];
  async function visit(nodes: TagTreeNode[], parent = 0) {
    for (const node of nodes) {
      let tag = await tx.tag.findFirst({ where: { accountId, parent, name: node.name } });
      if (!tag) tag = await tx.tag.create({ data: { accountId, parent, name: node.name } });
      ids.push(tag.id);
      if (node.children) await visit(node.children, tag.id);
    }
  }
  await visit(helper.buildHashTagTreeFromHashString(tags));
  await tx.tagsToNote.deleteMany({ where: { noteId, tagId: { notIn: ids } } });
  await tx.tagsToNote.createMany({ data: ids.map(tagId => ({ noteId, tagId })), skipDuplicates: true });
}

async function writeContent(tx: Prisma.TransactionClient, note: { id: number; content: string; accountId: number | null }, content: string) {
  if (content === note.content) return;
  const version = await tx.noteHistory.findFirst({ where: { noteId: note.id }, orderBy: { version: 'desc' }, select: { version: true } });
  await tx.noteHistory.create({ data: {
    noteId: note.id, content: note.content, accountId: note.accountId,
    version: (version?.version || 0) + 1,
  } });
  await tx.notes.update({ where: { id: note.id }, data: { content } });
  await syncTags(tx, note.id, note.accountId!, content);
  note.content = content;
}

export function createProcessingStore(noteId: number, token: string): ProcessingStore {
  async function mutate<T>(fn: (tx: Prisma.TransactionClient, note: NonNullable<Awaited<ReturnType<typeof lockProcessingNote>>>, state: ProcessingState) => Promise<T>) {
    return prisma.$transaction(async tx => {
      const note = await lockProcessingNote(tx, noteId);
      const job = await tx.noteProcessing.findUnique({ where: { noteId } });
      if (!note || !job || job.token !== token || job.status !== 'running' || !job.leaseUntil || job.leaseUntil <= new Date()) return null;
      const state = readProcessingState(job.state);
      if (!await canProcessNote(tx, noteId, state.requestedBy)) {
        await tx.noteProcessing.update({ where: { noteId }, data: { status: 'cancelled', token: null, leaseUntil: null } });
        return null;
      }
      const result = await fn(tx, note, state);
      await tx.noteProcessing.update({ where: { noteId }, data: { state: json(state), leaseUntil: new Date(Date.now() + LEASE_MS) } });
      return result;
    }, { timeout: 15_000 });
  }
  const sameAudio = (a: ProcessingAudio, b: ProcessingAudio) => a.id === b.id && a.path === b.path;
  async function audioExists(tx: Prisma.TransactionClient, audio: ProcessingAudio) {
    // Lock attachment too: removal/reassignment must not race the append commit.
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM attachments WHERE id = ${audio.id} AND "noteId" = ${noteId} AND path = ${audio.path} FOR UPDATE`;
    return rows.length > 0;
  }
  return {
    load: () => mutate(async (_tx, note, state) => ({ note, state })),
    audioExists: async audio => !!await mutate(tx => audioExists(tx, audio)),
    saveAudio: async (audio, text) => {
      await mutate(async (tx, note, state) => {
        const item = state.audio.find(a => sameAudio(a, audio));
        if (!item || item.status !== 'pending') return;
        if (!await audioExists(tx, item)) { item.status = 'skipped'; return; }
        await writeContent(tx, note, appendTranscript(note.content, text));
        item.text = text;
        item.status = text ? 'succeeded' : 'empty';
        delete item.error;
      });
    },
    failAudio: async (audio, code) => {
      await mutate(async (tx, _note, state) => {
        const item = state.audio.find(a => sameAudio(a, audio));
        if (item?.status === 'pending') {
          item.status = await audioExists(tx, item) ? 'failed' : 'skipped';
          item.error = code;
        }
      });
    },
    skipAudio: async audio => { await mutate(async (_tx, _note, state) => {
      const item = state.audio.find(a => sameAudio(a, audio));
      if (item?.status === 'pending') item.status = 'skipped';
    }); },
    saveStep: async (step, source, effects) => {
      await mutate(async (tx, note, state) => {
        if (state.done.includes(step)) return;
        const changed = note.content !== source;
        let commented = false;
        for (const effect of effects) {
          if (!effect.content.trim()) continue;
          if (effect.kind === 'create') {
            const created = await tx.notes.create({ data: { content: effect.content, accountId: note.accountId, type: effect.type || 0 } });
            await syncTags(tx, created.id, note.accountId!, created.content);
          } else if (effect.kind === 'tags') {
            await writeContent(tx, note, `${note.content}\n\n${effect.content}`);
          } else if (effect.kind === 'replace' && !changed && state.audio.every(a => !a.text || effect.content.includes(a.text))) {
            await writeContent(tx, note, effect.content);
          } else {
            // A stale or destructive rewrite becomes a suggestion, never a lost edit.
            await tx.comments.create({ data: {
              noteId, guestName: 'Blinko AI', guestIP: '', guestUA: '',
              content: effect.kind === 'replace'
                ? `AI suggestion (original note preserved):\n\n${effect.content}` : effect.content,
            } });
            commented = true;
          }
        }
        if (commented) await tx.notifications.create({ data: {
          accountId: note.accountId!, type: 'comment', title: 'ai-post-processing-notification',
          content: 'ai-processed-your-note', metadata: { noteId },
        } });
        state.done.push(step);
        delete state.postError;
      });
    },
    postFailed: async code => { await mutate(async (_tx, _note, state) => { state.postError = code; }); },
    indexed: async (content, error) => { await mutate(async (_tx, note, state) => {
      if (error || note.content !== content) state.embeddingError = error || 'NOTE_CHANGED';
      else { state.indexedContent = content; delete state.embeddingError; }
    }); },
    finish: async () => {
      await mutate(async (tx, _note, state) => {
        const failed = state.audio.some(a => ['pending', 'failed'].includes(a.status)) || state.postError || state.embeddingError;
        await tx.noteProcessing.update({ where: { noteId }, data: { status: failed ? 'failed' : 'completed', token: null } });
      });
    },
  };
}

export class NoteProcessingJob {
  private static initialized = false;

  static async wake(noteId: number) {
    try {
      const boss = await getPgBoss();
      await boss.send(QUEUE, { noteId }, { singletonKey: String(noteId), retryLimit: 0, expireInSeconds: 3600 });
    } catch {
      // The durable queued row is the outbox. Dispatch recovers failed sends.
      console.warn('Note processing dispatch deferred');
    }
  }

  static async dispatch() {
    const jobs = await prisma.noteProcessing.findMany({ where: { OR: [
      { status: 'queued' }, { status: 'running', leaseUntil: { lt: new Date() } },
    ] }, select: { noteId: true }, take: 100, orderBy: { updatedAt: 'asc' } });
    for (const job of jobs) await this.wake(job.noteId);
  }

  static async run(noteId: number) {
    const token = randomUUID();
    const claimed = await prisma.noteProcessing.updateMany({ where: { noteId, OR: [
      { status: 'queued' }, { status: 'running', leaseUntil: { lt: new Date() } },
    ] }, data: { status: 'running', token, leaseUntil: new Date(Date.now() + LEASE_MS) } });
    if (!claimed.count) return;
    try {
      await runNoteProcessing(createProcessingStore(noteId, token), processingModels);
    } catch {
      await prisma.noteProcessing.updateMany({ where: { noteId, token }, data: { status: 'failed', token: null, leaseUntil: null } });
      console.warn('Note processing interrupted; retry is available');
    }
  }

  static async initialize() {
    if (this.initialized) return;
    const boss = await getPgBoss();
    // Deduplicate queued deliveries, but allow recovery while pg-boss still has
    // an old active delivery after a crash. The DB lease/token fences execution.
    await boss.createQueue(QUEUE, { policy: 'short' });
    await boss.createQueue(DISPATCH);
    await boss.work<{ noteId: number }>(QUEUE, { batchSize: 1 }, async jobs => {
      for (const job of jobs) await this.run(job.data.noteId);
    });
    await boss.work(DISPATCH, async () => { await this.dispatch(); });
    await boss.schedule(DISPATCH, '* * * * *');
    this.initialized = true;
    await this.dispatch();
  }
}
