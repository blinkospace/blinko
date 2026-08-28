import { router, authProcedure } from '../middleware';
import { z } from 'zod';
import { prisma } from '../prisma';

export const messageRouter = router({
  create: authProcedure
    .input(z.object({
      conversationId: z.number(),
      content: z.string(),
      role: z.enum(['user', 'assistant', 'system']),
      metadata: z.any(),
    }))
    .mutation(async ({ input, ctx }) => {
      const conversation = await prisma.conversation.findFirst({
        where: {
          id: input.conversationId,
          accountId: Number(ctx.id),
        },
      });
      if (!conversation) {
        throw new Error('Conversation not found or access denied');
      }

      return await prisma.message.create({
        data: {
          content: input.content,
          role: input.role,
          conversationId: input.conversationId,
          metadata: input.metadata,
        }
      });
    }),

  list: authProcedure
    .input(z.object({
      conversationId: z.number(),
      page: z.number().default(1),
      size: z.number().default(20),
    }))
    .query(async ({ input, ctx }) => {
      const conversation = await prisma.conversation.findFirst({
        where: {
          id: input.conversationId,
          accountId: Number(ctx.id),
        },
      });
      if (!conversation) {
        throw new Error('Conversation not found or access denied');
      }

      const skip = (input.page - 1) * input.size;
      const [total, messages] = await Promise.all([
        prisma.message.count({
          where: {
            conversationId: input.conversationId,
          }
        }),
        prisma.message.findMany({
          where: {
            conversationId: input.conversationId,
          },
          skip,
          take: input.size,
          orderBy: { createdAt: 'asc' }
        })
      ]);
      return messages;
    }),

  update: authProcedure
    .input(z.object({
      id: z.number(),
      content: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const message = await prisma.message.findFirst({
        where: {
          id: input.id,
          conversation: {
            accountId: Number(ctx.id),
          },
        },
      });
      if (!message) {
        throw new Error('Message not found or access denied');
      }

      return await prisma.message.update({
        where: {
          id: input.id,
        },
        data: {
          content: input.content,
        }
      });
    }),

  delete: authProcedure
    .input(z.object({
      id: z.number()
    }))
    .mutation(async ({ input, ctx }) => {
      const message = await prisma.message.findFirst({
        where: {
          id: input.id,
          conversation: {
            accountId: Number(ctx.id),
          },
        },
        select: {
          id: true,
          conversationId: true,
          createdAt: true,
        },
      });

      if (!message) {
        throw new Error('Message not found or access denied');
      }

      return await prisma.$transaction(async (prisma) => {
        await prisma.message.delete({
          where: {
            id: input.id,
          },
        });

        await prisma.message.deleteMany({
          where: {
            conversationId: message.conversationId,
            createdAt: {
              gt: message.createdAt,
            },
          },
        });
      });
    }),

  clearAfter: authProcedure
    .input(z.object({
      id: z.number()
    }))
    .mutation(async ({ input, ctx }) => {
      const message = await prisma.message.findFirst({
        where: {
          id: input.id,
          conversation: {
            accountId: Number(ctx.id),
          },
        },
        select: {
          id: true,
          conversationId: true,
          createdAt: true,
        },
      });

      if (!message) {
        throw new Error('Message not found or access denied');
      }

      await prisma.message.deleteMany({
        where: {
          conversationId: message.conversationId,
          createdAt: {
            gt: message.createdAt,
          },
        },
      });

      return {
        success: true
      }
    }),
});
 