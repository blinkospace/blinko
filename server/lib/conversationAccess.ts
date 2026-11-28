import { TRPCError } from "@trpc/server";
import { prisma } from "../prisma";

export async function requireOwnedConversation(id: number, accountId: number) {
  const conversation = await prisma.conversation.findFirst({
    where: { id, accountId },
    select: { id: true },
  });
  if (!conversation)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Conversation not found",
    });
}

export async function requireOwnedMessage(id: number, accountId: number) {
  const message = await prisma.message.findFirst({
    where: { id, conversation: { accountId } },
    select: { id: true, conversationId: true, createdAt: true },
  });
  if (!message)
    throw new TRPCError({ code: "NOT_FOUND", message: "Message not found" });
  return message;
}
