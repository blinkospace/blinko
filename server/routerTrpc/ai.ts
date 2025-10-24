import { router, authProcedure } from '../middleware';
import { z } from 'zod';
import { AiService } from '@server/aiServer';
import { prisma } from '../prisma';
import { TRPCError } from '@trpc/server';
import { CoreMessage } from '@mastra/core';
import { AiModelFactory } from '@server/aiServer/aiModelFactory';
import { RebuildEmbeddingJob } from '../jobs/rebuildEmbeddingJob';
import { getAllPathTags } from '@server/lib/helper';
import { ModelCapabilities } from '@server/aiServer/types';
import { aiProviders, aiModels } from '@shared/lib/prismaZodType';

export const aiRouter = router({
  embeddingUpsert: authProcedure
    .input(z.object({
      id: z.number(),
      content: z.string(),
      type: z.enum(['update', 'insert'])
    }))
    .mutation(async ({ input }) => {
      const { id, content, type } = input
      const createTime = await prisma.notes.findUnique({ where: { id } }).then(i => i?.createdAt)
      const { ok, error } = await AiService.embeddingUpsert({ id, content, type, createTime: createTime! })
      if (!ok) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error
        })
      }
      return { ok }
    }),

  embeddingInsertAttachments: authProcedure
    .input(z.object({
      id: z.number(),
      filePath: z.string() //api/file/text.pdf
    }))
    .mutation(async ({ input }) => {
      const { id, filePath } = input
      try {
        const res = await AiService.embeddingInsertAttachments({ id, filePath })
        return res
      } catch (error) {
        return { ok: false, msg: error?.message }
      }
    }),

  embeddingDelete: authProcedure
    .input(z.object({
      id: z.number()
    }))
    .mutation(async ({ input }) => {
      const { id } = input
      try {
        const res = await AiService.embeddingDelete({ id })
        return res
      } catch (error) {
        return { ok: false, msg: error?.message }
      }
    }),

  completions: authProcedure
    .input(z.object({
      question: z.string(),
      withTools: z.boolean().optional(),
      withOnline: z.boolean().optional(),
      withRAG: z.boolean().optional(),
      conversations: z.array(z.object({ role: z.string(), content: z.string() })),
      systemPrompt: z.string().optional()
    }))
    .mutation(async function* ({ input, ctx }) {
      try {
        const { question, conversations, withTools = false, withOnline = false, withRAG = true, systemPrompt } = input
        let _conversations = conversations as CoreMessage[]
        const { result: responseStream, notes } = await AiService.completions({
          question,
          conversations: _conversations,
          ctx,
          withTools,
          withOnline,
          withRAG,
          systemPrompt
        })
        yield { notes }
        for await (const chunk of responseStream.fullStream) {
          yield { chunk }
        }
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error?.message
        })
      }
    }),

  speechToText: authProcedure
    .input(z.object({
      filePath: z.string()
    }))
    .mutation(async function ({ input }) {
      // const { filePath } = input
      // try {
      //   const localFilePath = await FileService.getFile(filePath)
      //   const doc = await AiService.speechToText(localFilePath)
      //   return doc
      // } catch (error) {
      //   throw new Error(error)
      // }
    }),

  rebuildingEmbeddings: authProcedure
    .input(z.object({
      force: z.boolean().optional()
    }))
    .mutation(async function* ({ input }) {
      const { force } = input
      try {
        for await (const result of AiService.rebuildEmbeddingIndex({ force })) {
          yield result;
        }
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error?.message
        })
      }
    }),

  summarizeConversationTitle: authProcedure
    .input(z.object({
      conversations: z.array(z.object({ role: z.string(), content: z.string() })),
      conversationId: z.number()
    }))
    .mutation(async function ({ input }) {
      const { conversations, conversationId } = input
      const agent = await AiModelFactory.SummarizeAgent()
      const conversationString = JSON.stringify(
        conversations.map(i => ({
          role: i.role,
          content: i.content.replace(/\n/g, '\\n')
        })),
        null, 2
      );
      const result = await agent.generate(conversationString)
      const conversation = await prisma.conversation.update({
        where: { id: conversationId },
        data: { title: result?.text }
      })
      return conversation
    }),

  writing: authProcedure
    .input(z.object({
      question: z.string(),
      type: z.enum(['expand', 'polish', 'custom']).optional(),
      content: z.string().optional()
    }))
    .mutation(async function* ({ input }) {
      const { question, type = 'custom', content } = input
      const agent = await AiModelFactory.WritingAgent(type)
      const result = await agent.stream([
        {
          role: 'user',
          content: question
        },
        {
          role: 'system',
          content: `This is the user's note content: ${content || ''}`
        }
      ]);
      for await (const chunk of result.fullStream) {
        yield chunk
      }
    }),
  autoTag: authProcedure
    .input(z.object({
      content: z.string()
    }))
    .mutation(async function ({ input }) {
      const config = await AiModelFactory.globalConfig();
      const { content } = input
      const tagAgent = await AiModelFactory.TagAgent(config.aiTagsPrompt || undefined);
      const tags = await getAllPathTags();
      const result = await tagAgent.generate(
        `Existing tags list: [${tags.join(', ')}]\nNote content: ${content}\nPlease suggest appropriate tags for this content. Include full hierarchical paths for tags like #Parent/Child instead of just #Child.`
      )
      return result?.text?.trim().split(',').map(tag => tag.trim()).filter(Boolean) ?? []
    }),
  autoEmoji: authProcedure
    .input(z.object({
      content: z.string()
    }))
    .mutation(async function ({ input }) {
      const { content } = input
      const agent = await AiModelFactory.EmojiAgent()
      const result = await agent.generate("Please select and suggest appropriate emojis for the above content" + content)
      console.log(result.text)
      return result?.text?.trim().split(',').map(tag => tag.trim()).filter(Boolean) ?? [];
    }),
  AIComment: authProcedure
    .input(z.object({
      content: z.string(),
      noteId: z.number()
    }))
    .mutation(async function ({ input }) {
      return await AiService.AIComment(input)
    }),

  rebuildEmbeddingStart: authProcedure
    .input(z.object({
      force: z.boolean().optional(),
      incremental: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      await RebuildEmbeddingJob.ForceRebuild(input.force ?? true, input.incremental ?? false);
      return { success: true };
    }),

  rebuildEmbeddingResume: authProcedure
    .mutation(async () => {
      await RebuildEmbeddingJob.ResumeRebuild();
      return { success: true };
    }),

  rebuildEmbeddingRetryFailed: authProcedure
    .mutation(async () => {
      await RebuildEmbeddingJob.RetryFailedNotes();
      return { success: true };
    }),

  rebuildEmbeddingStop: authProcedure
    .mutation(async () => {
      await RebuildEmbeddingJob.StopRebuild();
      return { success: true };
    }),

  rebuildEmbeddingProgress: authProcedure
    .query(async () => {
      const progress = await RebuildEmbeddingJob.GetProgress();
      return progress || {
        current: 0,
        total: 0,
        percentage: 0,
        isRunning: false,
        results: [],
        lastUpdate: new Date().toISOString()
      };
    }),

  testConnect: authProcedure
    .input(z.object({
      providerId: z.number(),
      modelKey: z.string(),
      capabilities: z.object({
        inference: z.boolean().optional(),
        tools: z.boolean().optional(),
        image: z.boolean().optional(),
        imageGeneration: z.boolean().optional(),
        video: z.boolean().optional(),
        audio: z.boolean().optional(),
        embedding: z.boolean().optional(),
        rerank: z.boolean().optional()
      })
    }))
    .mutation(async ({ input }) => {
      try {
        const { providerId, modelKey, capabilities } = input;

        // Get provider information
        const provider = await prisma.aiProviders.findUnique({
          where: { id: providerId }
        });

        if (!provider) {
          throw new Error('Provider not found');
        }

        // Create temporary model configuration for testing
        const tempModelConfig = {
          provider: provider.provider,
          baseURL: provider.baseURL,
          apiKey: provider.apiKey,
          config: provider.config,
          modelKey,
          capabilities
        };

        // Test based on model capabilities
        let testResults: any = {};

        // Test inference capability (chat)
        if (capabilities.inference) {
          try {
            const { LLMProvider } = await import('@server/aiServer/providers');
            const llmProvider = new LLMProvider();
            const languageModel = await llmProvider.getLanguageModel({
              provider: provider.provider,
              apiKey: provider.apiKey,
              baseURL: provider.baseURL,
              modelKey,
              apiVersion: (provider.config as any)?.apiVersion,
              auth: (provider.config as any)?.authConfig // Use enhanced auth config if available
            });

            // Test simple generation
            const { generateText } = await import('ai');
            const result = await generateText({
              model: languageModel,
              prompt: 'Say "Hello" to test connection'
            });
            testResults.inference = { success: true, response: result.text };
          } catch (error) {
            testResults.inference = { success: false, error: error.message };
          }
        }

        // Test embedding capability
        if (capabilities.embedding) {
          try {
            const { EmbeddingProvider } = await import('@server/aiServer/providers');
            const embeddingProvider = new EmbeddingProvider();
            const embeddingModel = await embeddingProvider.getEmbeddingModel({
              provider: provider.provider,
              apiKey: provider.apiKey,
              baseURL: provider.baseURL,
              modelKey,
              apiVersion: (provider.config as any)?.apiVersion,
              auth: (provider.config as any)?.authConfig // Use enhanced auth config if available
            });

            const { embed } = await import('ai');
            const result = await embed({
              model: embeddingModel as any,
              value: 'test embedding'
            });
            testResults.embedding = { success: true, dimensions: result.embedding?.length || 0 };
          } catch (error) {
            testResults.embedding = { success: false, error: error.message };
          }
        }

        // Test audio capability (speech recognition)
        if (capabilities.audio) {
          throw new Error("audio cannot test")
        }

        const overallSuccess = Object.values(testResults).some((result: any) => result.success);

        return {
          success: overallSuccess,
          capabilities: testResults,
          provider: provider.title,
          model: modelKey
        };
      } catch (error) {
        console.error("Connection test failed:", error);
        throw new Error(`Connection test failed: ${error?.message || "Unknown error"}`);
      }
    }),

  getAllProviders: authProcedure
    .query(async () => {
      return await AiModelFactory.getAllAiProviders();
    }),

  createProvider: authProcedure
    .input(z.object({
      title: z.string(),
      provider: z.string(),
      baseURL: z.string().optional(),
      apiKey: z.string().optional(),
      config: z.any().optional(),
      sortOrder: z.number().default(0)
    }))
    .mutation(async ({ input }) => {
      return await prisma.aiProviders.create({
        data: input,
        include: { models: true }
      });
    }),

  updateProvider: authProcedure
    .input(z.object({
      id: z.number(),
      title: z.string().optional(),
      provider: z.string().optional(),
      baseURL: z.string().optional(),
      apiKey: z.string().optional(),
      config: z.any().optional(),
      sortOrder: z.number().optional()
    }))
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      return await prisma.aiProviders.update({
        where: { id },
        data,
        include: { models: true }
      });
    }),

  deleteProvider: authProcedure
    .input(z.object({
      id: z.number()
    }))
    .mutation(async ({ input }) => {
      return await prisma.aiProviders.delete({
        where: { id: input.id }
      });
    }),

  getAllModels: authProcedure
    .query(async () => {
      return await prisma.aiModels.findMany({
        include: { provider: true },
        orderBy: [{ provider: { sortOrder: 'asc' } }, { sortOrder: 'asc' }]
      });
    }),

  getModelsByProvider: authProcedure
    .input(z.object({
      providerId: z.number()
    }))
    .query(async ({ input }) => {
      return await prisma.aiModels.findMany({
        where: { providerId: input.providerId },
        include: { provider: true },
        orderBy: { sortOrder: 'asc' }
      });
    }),

  getModelsByCapability: authProcedure
    .input(z.object({
      capability: z.string()
    }))
    .query(async ({ input }) => {
      return await AiModelFactory.getAiModelsByCapability(input.capability);
    }),

  createModel: authProcedure
    .input(z.object({
      providerId: z.number(),
      title: z.string(),
      modelKey: z.string(),
      capabilities: z.object({
        inference: z.boolean().default(true),
        tools: z.boolean().default(false),
        image: z.boolean().default(false),
        imageGeneration: z.boolean().default(false),
        video: z.boolean().default(false),
        audio: z.boolean().default(false),
        embedding: z.boolean().default(false),
        rerank: z.boolean().default(false)
      }),
      config: z.any().optional(),
      sortOrder: z.number().default(0)
    }))
    .mutation(async ({ input }) => {
      return await prisma.aiModels.create({
        data: input,
        include: { provider: true }
      });
    }),

  updateModel: authProcedure
    .input(z.object({
      id: z.number(),
      title: z.string().optional(),
      modelKey: z.string().optional(),
      capabilities: z.object({
        inference: z.boolean().optional(),
        tools: z.boolean().optional(),
        image: z.boolean().optional(),
        imageGeneration: z.boolean().optional(),
        video: z.boolean().optional(),
        audio: z.boolean().optional(),
        embedding: z.boolean().optional(),
        rerank: z.boolean().optional()
      }).optional(),
      config: z.any().optional(),
      sortOrder: z.number().optional()
    }))
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      return await prisma.aiModels.update({
        where: { id },
        data,
        include: { provider: true }
      });
    }),

  deleteModel: authProcedure
    .input(z.object({
      id: z.number()
    }))
    .mutation(async ({ input }) => {
      return await prisma.aiModels.delete({
        where: { id: input.id }
      });
    }),


  createModelsFromProvider: authProcedure
    .input(z.object({
      providerId: z.number(),
      models: z.array(z.object({
        id: z.string(),
        name: z.string(),
        capabilities: z.object({
          inference: z.boolean().default(true),
          tools: z.boolean().default(false),
          image: z.boolean().default(false),
          imageGeneration: z.boolean().default(false),
          video: z.boolean().default(false),
          audio: z.boolean().default(false),
          embedding: z.boolean().default(false),
          rerank: z.boolean().default(false)
        })
      }))
    }))
    .mutation(async ({ input }) => {
      const { providerId, models } = input;

      const createdModels: aiModels[] = [];
      for (const model of models) {
        const created = await prisma.aiModels.create({
          data: {
            providerId,
            title: model.name,
            modelKey: model.id,
            capabilities: model.capabilities,
            sortOrder: 0
          },
          include: { provider: true }
        });
        createdModels.push(created);
      }

      return createdModels;
    }),

  batchCreateModelsFromProvider: authProcedure
    .input(z.object({
      providerId: z.number(),
      selectedModels: z.array(z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        capabilities: z.object({
          inference: z.boolean().optional(),
          tools: z.boolean().optional(),
          image: z.boolean().optional(),
          imageGeneration: z.boolean().optional(),
          video: z.boolean().optional(),
          audio: z.boolean().optional(),
          embedding: z.boolean().optional(),
          rerank: z.boolean().optional()
        }).optional()
      }))
    }))
    .mutation(async ({ input }) => {
      const { providerId, selectedModels } = input;

      const createdModels: aiModels[] = [];
      for (const model of selectedModels) {
        const created = await prisma.aiModels.create({
          data: {
            providerId,
            title: model.name,
            modelKey: model.id,
            capabilities: model.capabilities || {
              inference: true,
              tools: false,
              image: false,
              imageGeneration: false,
              video: false,
              audio: false,
              embedding: false,
              rerank: false
            },
            sortOrder: 0
          },
          include: { provider: true }
        });
        createdModels.push(created);
      }

      return createdModels;
    }),
})
