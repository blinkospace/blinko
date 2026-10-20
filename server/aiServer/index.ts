import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { prisma } from '../prisma';
import { AiModelFactory } from './aiModelFactory';
import { ProgressResult } from '@shared/lib/types';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { CSVLoader } from '@langchain/community/document_loaders/fs/csv';
import { TextLoader } from 'langchain/document_loaders/fs/text';
import { UnstructuredLoader } from '@langchain/community/document_loaders/fs/unstructured';
import { BaseDocumentLoader } from '@langchain/core/document_loaders/base';
import { FileService } from '../lib/files';
import { Context } from '../context';
import { CreateNotification } from '../routerTrpc/notification';
import { NotificationType } from '@shared/lib/prismaZodType';
import { CoreMessage } from '@mastra/core';
import { MDocument } from '@mastra/rag';
import { embedMany } from 'ai';
import { RebuildEmbeddingJob } from '../jobs/rebuildEmbeddingJob';
import { commentWebhookInclude, sendCommentWebhook } from '@server/lib/commentWebhook';
import { LibSQLVector } from '@mastra/libsql';
import { RuntimeContext } from "@mastra/core/di";
import { AudioProvider } from './providers/AudioProvider';

export function isImage(filePath: string): boolean {
  if (!filePath) return false;
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
  return imageExtensions.some((ext) => filePath.toLowerCase().endsWith(ext));
}

export function isAudio(filePath: string): boolean {
  if (!filePath) return false;
  const audioExtensions = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma', '.opus', '.webm'];
  return audioExtensions.some((ext) => filePath.toLowerCase().endsWith(ext));
}

export class AiService {
  static isImage = isImage;
  static isAudio = isAudio;

  static async loadFileContent(filePath: string): Promise<string> {
    try {
      let loader: BaseDocumentLoader;
      switch (true) {
        case filePath.endsWith('.pdf'):
          loader = new PDFLoader(filePath);
          break;
        case filePath.endsWith('.docx') || filePath.endsWith('.doc'):
          loader = new DocxLoader(filePath);
          break;
        case filePath.endsWith('.txt'):
          loader = new TextLoader(filePath);
          break;
        case filePath.endsWith('.csv'):
          console.log('load csv');
          loader = new CSVLoader(filePath);
          break;
        default:
          loader = new UnstructuredLoader(filePath);
      }
      const docs = await loader.load();
      return docs.map((doc) => doc.pageContent).join('\n');
    } catch (error) {
      console.error('File loading error:', error);
      throw new Error(`can not load file: ${filePath}`);
    }
    return '';
  }

  static async embeddingDeleteAll(id: number, VectorStore: LibSQLVector) {
    await VectorStore.truncateIndex({ indexName: 'blinko' });
  }

  static async embeddingDeleteAllAttachments(filePath: string, VectorStore: LibSQLVector) {
    await VectorStore.truncateIndex({ indexName: 'blinko' });
  }

  private static embeddingTasks = new Map<number, Promise<any>>();

  static async embeddingUpsert(input: { id: number; content: string; type: 'update' | 'insert'; createTime: Date; updatedAt?: Date }) {
    const previous = this.embeddingTasks.get(input.id) || Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.embeddingUpsertCurrent(input));
    this.embeddingTasks.set(input.id, task);
    try { return await task; }
    finally { if (this.embeddingTasks.get(input.id) === task) this.embeddingTasks.delete(input.id); }
  }

  private static async embeddingUpsertCurrent({ id, content, type, createTime, updatedAt }: { id: number; content: string; type: 'update' | 'insert'; createTime: Date; updatedAt?: Date }) {
    try {
      const current = await prisma.notes.findUnique({ where: { id } });
      if (!current || current.isRecycle || current.content !== content) return { ok: false, error: 'NOTE_CHANGED' };
      const { VectorStore, Embeddings } = await AiModelFactory.GetProvider();
      if (!Embeddings) {
        throw new Error("No embeddings model config")
      }
      const config = await AiModelFactory.globalConfig();

      if (config.excludeEmbeddingTagId) {
        const tag = await prisma.tag.findUnique({ where: { id: config.excludeEmbeddingTagId } });
        if (tag && content.includes(tag.name)) {
          console.warn('this note is not allowed to be embedded:', tag.name);
          return { ok: false, msg: 'tag is not allowed to be embedded' };
        }
      }

      const chunks = content.trim() ? await MDocument.fromMarkdown(content).chunk() : [];

      const embeddings = chunks.length ? (await embedMany({
        values: chunks.map((chunk) => chunk.text + 'Create At: ' + createTime.toISOString() + ' Update At: ' + updatedAt?.toISOString()),
        model: Embeddings,
      })).embeddings : [];

      const latest = await prisma.notes.findUnique({ where: { id } });
      if (!latest || latest.isRecycle || latest.content !== content) return { ok: false, error: 'NOTE_CHANGED' };
      await AiModelFactory.queryAndDeleteVectorById(id, true);
      if (chunks.length) await VectorStore.upsert({
        indexName: 'blinko',
        vectors: embeddings,
        ids: chunks.map((_chunk, index) => `note-${id}-${index}`),
        metadata: chunks?.map((chunk) => ({ text: chunk.text, id, noteId: id, createTime, updatedAt })),
      });

      try {
        await prisma.$executeRaw`
          UPDATE notes SET metadata = (COALESCE(metadata::jsonb, '{}'::jsonb) || '{"isIndexed":true}'::jsonb)::json
          WHERE id = ${id} AND content = ${content} AND "isRecycle" = false`;
      } catch (error) {
        console.log(error);
      }

      return { ok: true };
    } catch (error) {
      return { ok: false, error: 'EMBEDDING_FAILED' };
    }
  }

  //api/file/123.pdf
  static async embeddingInsertAttachments({ id, updatedAt, filePath }: { id: number; updatedAt?: Date; filePath: string }) {
    try {

      const fileResult = await FileService.getFile(filePath);
      let content: string;
      try {
        if (AiService.isImage(filePath)) {
          content = await AiModelFactory.describeImage(fileResult.path);
        } else {
          content = await AiService.loadFileContent(fileResult.path);
        }
      } finally {
        // Clean up temporary file if needed
        if (fileResult.isTemporary && fileResult.cleanup) {
          await fileResult.cleanup();
        }
      }
      const { VectorStore, TokenTextSplitter, Embeddings } = await AiModelFactory.GetProvider();
      if (!Embeddings) {
        throw new Error("No embeddings model config")
      }
      const doc = MDocument.fromText(content);
      const chunks = await doc.chunk();

      const { embeddings } = await embedMany({
        values: chunks.map((chunk) => chunk.text + 'Create At: ' + updatedAt?.toISOString() + ' Update At: ' + updatedAt?.toISOString()),
        model: Embeddings,
      });

      await VectorStore.upsert({
        indexName: 'blinko',
        vectors: embeddings,
        metadata: chunks?.map((chunk) => ({ text: chunk.text, id, noteId: id, isAttachment: true, updatedAt })),
      });

      try {
        await prisma.$executeRaw`
          UPDATE notes SET metadata = (COALESCE(metadata::jsonb, '{}'::jsonb) || '{"isIndexed":true,"isAttachmentsIndexed":true}'::jsonb)::json
          WHERE id = ${id} AND "isRecycle" = false`;
      } catch (error) {
        console.log(error);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  static async embeddingDelete({ id }: { id: number }) {
    AiModelFactory.queryAndDeleteVectorById(id);
    return { ok: true };
  }

  static async *rebuildEmbeddingIndex({ force = false }: { force?: boolean }): AsyncGenerator<ProgressResult & { progress?: { current: number; total: number } }, void, unknown> {
    // This method is now a wrapper around the RebuildEmbeddingJob
    // We'll just return a simple message directing to use the job instead
    yield {
      type: 'info' as const,
      content: 'Rebuild embedding index task started - check task progress for details',
      progress: { current: 0, total: 0 },
    };

    // Start the job
    await RebuildEmbeddingJob.ForceRebuild(force);
  }

  static getChatHistory({ conversations }: { conversations: { role: string; content: string }[] }) {
    const conversationMessage = conversations.map((i) => {
      if (i.role == 'user') {
        return new HumanMessage(i.content);
      }
      return new AIMessage(i.content);
    });
    conversationMessage.pop();
    return conversationMessage;
  }

  static async enhanceQuery({ query, ctx }: { query: string; ctx: Context }) {
    try {
      const { notes } = await AiModelFactory.queryVector(query, Number(ctx.id));
      return notes;
    } catch (error) {
      console.error('Error in enhanceQuery:', error);
      return [];
    }
  }

  static async completions({
    question,
    conversations,
    withTools,
    withRAG = true,
    withOnline = false,
    systemPrompt,
    ctx,
  }: {
    question: string;
    conversations: CoreMessage[];
    withTools?: boolean;
    withRAG?: boolean;
    withOnline?: boolean;
    systemPrompt?: string;
    ctx: Context;
  }) {
    try {
      console.log('completions');

      // Fold all system context into a single agent instruction so that only ONE
      // system message reaches the model. Some providers (e.g. Qwen/DashScope) reject
      // multiple leading system messages with "System message must be at the beginning".
      // See https://github.com/blinkospace/blinko/issues/1122
      const historySystem = conversations
        .filter((m) => m.role === 'system')
        .map((m) => m.content as string);
      const cleanedConversations = conversations.filter((m) => m.role !== 'system');

      let ragNote: any[] = [];
      let ragNoteString = '';
      if (withRAG) {
        let { notes, aiContext } = await AiModelFactory.queryVector(question, Number(ctx.id));
        ragNote = notes;
        ragNoteString = `This is the note content ${ragNote.map((i) => i.content).join('\n')} ${aiContext}`;
      }

      const contextParts = [
        ...historySystem,
        `Current user name: ${ctx.name}`,
        systemPrompt,
        ragNoteString,
      ].filter(Boolean);

      cleanedConversations.push({
        role: 'user',
        content: question,
      });
      console.log(cleanedConversations, 'conversations');
      const runtimeContext = new RuntimeContext();
      runtimeContext.set('accountId', Number(ctx.id));
      const agent = await AiModelFactory.BaseChatAgent({
        withTools,
        withOnlineSearch: withOnline,
        extraInstructions: contextParts.join('\n\n'),
      });
      const result = await agent.stream(cleanedConversations, { runtimeContext });
      return { result, notes: ragNote };
    } catch (error) {
      console.log(error);
      throw new Error(error);
    }
  }

  static async AIComment({ content, noteId }: { content: string; noteId: number }) {
    try {
      const note = await prisma.notes.findUnique({
        where: { id: noteId },
        select: { content: true, accountId: true },
      });

      if (!note) {
        throw new Error('Note not found');
      }

      const agent = await AiModelFactory.CommentAgent();
      const result = await agent.generate([
        {
          role: 'user',
          content: content,
        },
        {
          role: 'user',
          content: `This is the note content: ${note.content}`,
        },
      ]);

      const comment = await prisma.comments.create({
        data: {
          content: result.text.trim(),
          noteId,
          guestName: 'Blinko AI',
          guestIP: '',
          guestUA: '',
        },
        include: commentWebhookInclude,
      });
      sendCommentWebhook('comment.created', comment, {});
      await CreateNotification({
        accountId: note.accountId ?? 0,
        title: 'comment-notification',
        content: 'comment-notification',
        type: NotificationType.COMMENT,
      });
      return comment;
    } catch (error) {
      console.log(error);
      throw new Error(error);
    }
  }


  /**
   * Transcribe audio file to text
   * @param filePath Audio file path
   * @param voiceModelId Voice model ID
   * @param accountId User account ID
   * @returns Transcribed text content
   */
  static async transcribeAudio({
    filePath,
    voiceModelId,
    accountId
  }: {
    filePath: string;
    voiceModelId: number;
    accountId: number;
  }): Promise<string> {
    try {
      // Get voice model configuration
      const voiceModel = await prisma.aiModels.findUnique({
        where: { id: voiceModelId },
        include: { provider: true },
      });

      if (!voiceModel || !(voiceModel.capabilities as any)?.audio) {
        throw new Error('Voice model not found or does not support audio');
      }

      // Get audio provider
      const client = await new AudioProvider().getTranscriptionClient({
        provider: voiceModel.provider.provider,
        apiKey: voiceModel.provider.apiKey,
        baseURL: voiceModel.provider.baseURL,
        modelKey: voiceModel.modelKey,
      });
      // Read audio file
      const fs = await import('fs');
      if (!fs.existsSync(filePath)) {
        throw new Error(`Audio file not found: ${filePath}`);
      }

      const audioStream = fs.createReadStream(filePath);
      try {
        const response = await client.audio.transcriptions.create({
          file: audioStream,
          model: voiceModel.modelKey || 'whisper-1',
          response_format: 'json',
        }, { signal: AbortSignal.timeout(120_000) });
        if (typeof response.text !== 'string') throw new Error('Invalid transcription response');
        return response.text.trim();
      } finally {
        audioStream.destroy();
      }
    } catch (error) {
      // Do not log provider errors: they may contain audio, credentials or file paths.
      throw new Error('Audio transcription failed');
    }
  }

  /**
   * Process audio attachments for transcription
   * @param attachments Array of attachments to process
   * @param voiceModelId Voice model ID
   * @param accountId User account ID
   * @returns Transcription results
   */
  static async processNoteAudioAttachments({
    attachments,
    voiceModelId,
    accountId
  }: {
    attachments: Array<{ name: string; path: string; type?: string }>;
    voiceModelId: number;
    accountId: number;
  }): Promise<{ success: boolean; transcriptions: Array<{ fileName: string; transcription: string }> }> {
    try {
      const audioAttachments = attachments.filter(attachment =>
        this.isAudio(attachment.name || attachment.path)
      );

      if (audioAttachments.length === 0) {
        return { success: true, transcriptions: [] };
      }

      const transcriptions: any = [];

      for (const attachment of audioAttachments) {
        let cleanup: (() => Promise<void>) | undefined;
        try {
          // Use FileService to get file path (handles both local and S3 storage)
          const fileResult = await FileService.getFile(attachment.path);
          cleanup = fileResult.cleanup;

          const transcription = await this.transcribeAudio({
            filePath: fileResult.path,
            voiceModelId,
            accountId,
          });

          transcriptions.push({
            fileName: attachment.name || attachment.path,
            transcription,
          });

          console.log(`Transcribed audio: ${attachment.name}`);
        } catch (error) {
          console.error(`Failed to transcribe audio ${attachment.name}:`, error);
        } finally {
          // Clean up temporary file if using S3 storage
          if (cleanup) {
            try {
              await cleanup();
            } catch (cleanupError) {
              console.error(`Failed to cleanup temporary file for ${attachment.name}:`, cleanupError);
            }
          }
        }
      }

      return { success: true, transcriptions };
    } catch (error) {
      console.error('Error processing note audio attachments:', error);
      return { success: false, transcriptions: [] };
    }
  }
}
