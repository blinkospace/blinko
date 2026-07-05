import { SendWebhook } from '@server/lib/helper';

export type CommentWebhookEvent = 'comment.created' | 'comment.updated' | 'comment.deleted';
type CommentWebhookAction = 'create' | 'update' | 'delete';

const commentWebhookActionMap: Record<CommentWebhookEvent, CommentWebhookAction> = {
  'comment.created': 'create',
  'comment.updated': 'update',
  'comment.deleted': 'delete'
};

export const commentAccountSelect = {
  id: true,
  name: true,
  nickname: true,
  image: true
} as const;

export const commentWebhookInclude = {
  account: {
    select: commentAccountSelect
  },
  note: {
    select: {
      accountId: true,
      account: {
        select: {
          id: true
        }
      }
    }
  }
} as const;

export const getCommentAuthor = (comment: any) => {
  return comment.account?.nickname || comment.account?.name || comment.guestName || null;
}

export const getCommentWebhookConfigUserId = (comment: any, ctx: any) => {
  return comment.note?.accountId ?? comment.accountId ?? (ctx.id ? Number(ctx.id) : null);
}

export const buildCommentWebhookPayload = (event: CommentWebhookEvent, comment: any, extra: Record<string, any> = {}) => {
  return {
    event,
    noteId: comment.noteId,
    comment: {
      id: comment.id,
      content: comment.content,
      noteId: comment.noteId,
      parentId: comment.parentId,
      accountId: comment.accountId,
      guestName: comment.guestName,
      author: getCommentAuthor(comment),
      account: comment.account ? {
        id: comment.account.id,
        name: comment.account.name,
        nickname: comment.account.nickname,
        image: comment.account.image
      } : null,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt
    },
    ...extra
  };
}

export const sendCommentWebhook = (event: CommentWebhookEvent, comment: any, ctx: any, extra: Record<string, any> = {}) => {
  const webhookType = commentWebhookActionMap[event];
  SendWebhook(buildCommentWebhookPayload(event, comment, extra), webhookType, ctx, {
    activityType: `blinko.comment.${webhookType}`,
    configUserId: getCommentWebhookConfigUserId(comment, ctx)
  });
}
