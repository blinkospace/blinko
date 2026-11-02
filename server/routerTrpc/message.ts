import { router, authProcedure } from '../middleware';
import { z } from 'zod';
import { prisma } from '../prisma';
import { requireOwnedConversation, requireOwnedMessage } from '../lib/conversationAccess';

export const messageRouter = router({
  create: authProcedure
    .input(z.object({
      conversationId: z.number(),
      content: z.string(),
      role: z.enum(['user', 'assistant', 'system']),
      metadata: z.any(),
    }))
    .mutation(async ({ input, ctx }) => {
      await requireOwnedConversation(input.conversationId, Number(ctx.id));
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
      await requireOwnedConversation(input.conversationId, Number(ctx.id));
      const skip = (input.page - 1) * input.size;
      const [total, messages] = await Promise.all([
        prisma.message.count({
          where: {
            conversationId: input.conversationId,
            conversation: { accountId: Number(ctx.id) },
          }
        }),
        prisma.message.findMany({
          where: {
            conversationId: input.conversationId,
            conversation: { accountId: Number(ctx.id) },
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
      await requireOwnedMessage(input.id, Number(ctx.id));
      return await prisma.message.update({
        where: {
          id: input.id,
          conversation: { accountId: Number(ctx.id) },
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
      const message = await requireOwnedMessage(input.id, Number(ctx.id));

      return await prisma.$transaction(async (prisma) => {
        await prisma.message.delete({
          where: {
            id: input.id,
            conversation: { accountId: Number(ctx.id) },
          },
        });

        await prisma.message.deleteMany({
          where: {
            conversationId: message.conversationId,
            conversation: { accountId: Number(ctx.id) },
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
      const message = await requireOwnedMessage(input.id, Number(ctx.id));

      await prisma.message.deleteMany({
        where: {
          conversationId: message.conversationId,
          conversation: { accountId: Number(ctx.id) },
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
