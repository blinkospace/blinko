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
import { userCaller } from '../routerTrpc/_app';

import { getAllPathTags } from '@server/lib/helper';
import { LibSQLVector } from '@mastra/libsql';
import { RuntimeContext } from "@mastra/core/di";

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

  static async embeddingUpsert({ id, content, type, createTime, updatedAt }: { id: number; content: string; type: 'update' | 'insert'; createTime: Date; updatedAt?: Date }) {
    try {
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

      const note = await prisma.notes.findUnique({
        where: { id },
        select: { metadata: true, attachments: true }
      });

      const chunks = await MDocument.fromMarkdown(content).chunk();
      if (type == 'update') {
        AiModelFactory.queryAndDeleteVectorById(id);
      }

      const { embeddings } = await embedMany({
        values: chunks.map((chunk) => chunk.text + 'Create At: ' + createTime.toISOString() + ' Update At: ' + updatedAt?.toISOString()),
        model: Embeddings,
      });

      await VectorStore.upsert({
        indexName: 'blinko',
        vectors: embeddings,
        metadata: chunks?.map((chunk) => ({ text: chunk.text, id, noteId: id, createTime, updatedAt })),
      });

      try {
        await prisma.notes.update({
          where: { id },
          data: {
            metadata: {
              //@ts-ignore
              ...(note?.metadata || {}),
              isIndexed: true,
            },
            updatedAt,
          },
        });
      } catch (error) {
        console.log(error);
      }

      return { ok: true };
    } catch (error) {
      console.log(error, 'embeddingUpsert error');
      return { ok: false, error: error?.message };
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
        const note = await prisma.notes.findUnique({
          where: { id },
          select: { metadata: true }
        });
        await prisma.notes.update({
          where: { id },
          data: {
            metadata: {
              //@ts-ignore
              ...(note?.metadata || {}),
              isIndexed: true,
              isAttachmentsIndexed: true,
            },
            updatedAt,
          },
        });
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
      conversations.push({
        role: 'user',
        content: question,
      });
      conversations.push({
        role: 'system',
        content: `Current user name: ${ctx.name}\n`,
      });
      if (systemPrompt) {
        conversations.push({
          role: 'system',
          content: systemPrompt,
        });
      }
      let ragNote: any[] = [];
      if (withRAG) {
        let { notes, aiContext } = await AiModelFactory.queryVector(question, Number(ctx.id));
        ragNote = notes;
        conversations.push({
          role: 'system',
          content: `This is the note content ${ragNote.map((i) => i.content).join('\n')} ${aiContext}`,
        });
      }
      console.log(conversations, 'conversations');
      const runtimeContext = new RuntimeContext();
      runtimeContext.set('accountId', Number(ctx.id));
      const agent = await AiModelFactory.BaseChatAgent({ withTools, withOnlineSearch: withOnline });
      const result = await agent.stream(conversations, { runtimeContext });
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
        include: {
          account: {
            select: {
              id: true,
              name: true,
              nickname: true,
              image: true,
            },
          },
        },
      });
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

  static async postProcessNote({ noteId, ctx }: { noteId: number; ctx: Context }) {
    try {
      const runtimeContext = new RuntimeContext();
      runtimeContext.set('accountId', ctx.id);

      const caller = userCaller(ctx);
      // Get the configuration
      const config = await AiModelFactory.globalConfig();

      // Check if post-processing is enabled
      if (!config.isUseAiPostProcessing) {
        return { success: false, message: 'AI post-processing not enabled' };
      }

      // Fetch the note
      const note = await prisma.notes.findUnique({
        where: { id: noteId },
        select: {
          content: true,
          accountId: true,
          type: true,
          tags: {
            include: {
              tag: true,
            },
          },
        },
      });
      let noteType = 'blinko'
      switch (note?.type) {
        case 0:
          noteType = 'blinko';
          break;
        case 1:
          noteType = 'note';
          break;
        case 2:
          noteType = 'todo';
          break;
        default:
          noteType = 'blinko';
      }

      if (!note) {
        return { success: false, message: 'Note not found' };
      }

      const processingMode = config.aiPostProcessingMode || 'comment';

      // Handle custom processing mode
      if (processingMode === 'custom') {
        console.log('[DEBUG] Custom mode processing started for note:', noteId);
        // Get all tags for tag replacement
        const tags = await getAllPathTags();
        const tagsList = tags.join(', ');

        // Get custom prompt and replace variables
        let customPrompt = config.aiCustomPrompt || 'Analyze the following note content and provide feedback.';
        customPrompt = customPrompt.replace('{tags}', tagsList).replace('{note}', note.content);
        console.log('[DEBUG] Custom prompt:', customPrompt);

        // Process with AI WITHOUT tools - just get text response
        console.log('[DEBUG] Creating agent without tools for text-only response...');
        const agent = await AiModelFactory.BaseChatAgent({ withTools: false, withOnlineSearch: false });
        console.log('[DEBUG] Generating AI response...');

        try {
          const result = await agent.generate([
            {
              role: 'user',
              content: `${customPrompt}\n\nText to fix:\n${note.content}\n\nReturn ONLY the corrected text, nothing else.`
            }
          ]);

          console.log('[DEBUG] AI response generated successfully.');
          const correctedText = result.text?.trim();

          if (!correctedText) {
            console.log('[DEBUG] No text returned from AI');
            return { success: false, message: 'AI returned empty response' };
          }

          console.log('[DEBUG] Corrected text:', correctedText);

          // Manually update the note with corrected text
          const { upsertBlinkoTool } = await import('./tools/createBlinko');
          await upsertBlinkoTool.execute({
            context: {
              id: noteId,
              content: correctedText,
              type: noteType
            },
            runtimeContext
          });

          console.log('[DEBUG] Note updated successfully with corrected text');

          // Broadcast update via SSE
          try {
            if (!note.accountId) {
              console.warn('[DEBUG] Skipping SSE broadcast: note has no accountId');
            } else {
              const { SSEService } = await import('../lib/sseService');
              SSEService.broadcastNoteUpdate(note.accountId, noteId);
              console.log('[DEBUG] SSE broadcast sent for note:', noteId);
            }
          } catch (error) {
            console.error('[DEBUG] Failed to broadcast SSE update:', error);
            // Don't fail the whole operation if SSE broadcast fails
          }

          return { success: true, message: 'Custom processing completed' };
        } catch (error) {
          console.error('[DEBUG] Error in custom processing:', error);
          throw error;
        }
      }

      // Get the custom prompt, or use default
      const prompt = config.aiCommentPrompt || 'Analyze the following note content. Extract key topics as tags and provide a brief summary of the main points.';

      // Process with AI
      const agent = await AiModelFactory.CommentAgent();
      const result = await agent.generate([
        {
          role: 'user',
          content: prompt,
        },
        {
          role: 'user',
          content: `Note content: ${note.content}`,
        },
      ]);

      const aiResponse = result.text.trim();

      // Handle based on the processing mode
      if (processingMode === 'comment' || processingMode === 'both') {
        // Add comment
        await prisma.comments.create({
          data: {
            content: aiResponse,
            noteId,
            guestName: 'Blinko AI',
            guestIP: '',
            guestUA: '',
          },
        });

        await CreateNotification({
          accountId: note.accountId ?? 0,
          title: 'ai-post-processing-notification',
          content: 'ai-processed-your-note',
          type: NotificationType.COMMENT,
        });
      }

      if (processingMode === 'tags' || processingMode === 'both') {
        try {
          let suggestedTags: string[] = [];
          // If no clear tag format, process with an agent specialized for tag extraction
          const aiTagsPrompt = config.aiTagsPrompt
          let tagAgent: any;
          if (aiTagsPrompt != '') {
            tagAgent = await AiModelFactory.TagAgent(aiTagsPrompt);
          } else {
            tagAgent = await AiModelFactory.TagAgent();
          }
          const tags = await getAllPathTags();
          const result = await tagAgent.generate(
            `Existing tags list:  [${tags.join(', ')}]\n Note content:\n${note.content}`
          )
          suggestedTags = result.text.split(',').map((tag) => tag.trim());
          // Filter out empty tags and limit to 5 tags max
          suggestedTags = suggestedTags.filter(Boolean).slice(0, 5);
          caller.notes.upsert({
            id: noteId,
            content: note.content + '\n' + suggestedTags.join(' '),
          });
        } catch (error) {
          console.error('Error processing tags:', error);
        }
      }

      if (processingMode === 'smartEdit' || processingMode === 'both') {
        try {
          const smartEditPrompt = config.aiSmartEditPrompt || 'Improve this note by organizing content, adding headers, and enhancing readability.';
          const agent = await AiModelFactory.BaseChatAgent({ withTools: true });
          const result = await agent.generate([
            {
              role: 'system',
              content: `You are an AI assistant that helps to improve notes. You'll be provided with a note content, and your task is to enhance it according to instructions. You have access to tools that can help you modify the note. Use these tools to make the requested improvements.`
            },
            {
              role: 'user',
              content: `\nCurrent user id: ${ctx.id}\nCurrent user name: ${ctx.name}\n${smartEditPrompt}\n\nNote ID: ${noteId}\nNote content:\n${note.content}`
            }
          ], {
            runtimeContext
          });
          await prisma.comments.create({
            data: {
              content: result.text,
              noteId,
              guestName: 'Blinko AI',
              guestIP: '',
              guestUA: '',
            },
          });
        } catch (error) {
          console.error('Error during smart edit:', error);
          await prisma.comments.create({
            data: {
              content: `⚠️ **Smart Edit Error**\n\nI encountered an error while trying to edit this note. This may happen if the AI model doesn't support function calling or if there was an issue with the edit process.\n\nError details: ${error.message}`,
              noteId,
              guestName: 'Blinko AI',
              guestIP: '',
              guestUA: '',
            },
          });
        }
      }

      return { success: true, message: 'Note processed successfully' };
    } catch (error) {
      console.error('Error in post-processing note:', error);
      return { success: false, message: error.message || 'Unknown error' };
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
      const { audioModel } = await AiModelFactory.GetProvider();
      // Read audio file
      const fs = await import('fs');
      if (!fs.existsSync(filePath)) {
        throw new Error(`Audio file not found: ${filePath}`);
      }

      // Get file extension to determine audio format
      const path = await import('path');
      const fileExtension = path.extname(filePath).toLowerCase().substring(1);
      // Create audio stream
      const audioStream = fs.createReadStream(filePath);
      // Execute speech to text, 
      // {
      //   filetype: fileExtension || 'mp3',
      // }
      const transcription = await audioModel?.listen(audioStream,
        {
          filetype: fileExtension || 'mp3',
        }
      );

      console.log(`Audio transcription completed for file: ${filePath},${transcription}`);
      return transcription?.toString() || '';
    } catch (error) {
      console.error('Error transcribing audio:', error);
      throw new Error(`Audio transcription failed: ${error.message}`);
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
