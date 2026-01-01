/**
 * This file contains the root router of your tRPC-backend
 */
import { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { router, t } from '../middleware';
import { Context } from '../context';
import { lazy } from '@trpc/server';
import { noteRouter } from './note';
import { configRouter } from './config';
import { followsRouter } from './follows';
import { notificationRouter } from './notification';
import { aiRouter } from './ai';
import { tagRouter } from './tag';
import { userRouter } from './user';
import { commentRouter } from './comment';
import { pluginRouter } from './plugin';
import { conversationRouter } from './conversation';
import { attachmentsRouter } from './attachment';
import { publicRouter } from './public';
import { analyticsRouter } from './analytics';
import { messageRouter } from './message';
import { taskRouter } from './task';
import { aiScheduledTaskRouter } from './aiScheduledTask';
import { mcpServersRouter } from './mcpServers';
import { fontRouter } from './font';
export const appRouter = router({
  ai: aiRouter,
  notes: noteRouter,
  tags: tagRouter,
  users: userRouter,
  attachments: attachmentsRouter,
  config: configRouter,
  public: publicRouter,
  task: taskRouter,
  aiTask: aiScheduledTaskRouter,
  analytics: analyticsRouter,
  comments: commentRouter,
  follows: followsRouter,
  notifications: notificationRouter,
  plugin: pluginRouter,
  conversation: conversationRouter,
  message: messageRouter,
  mcpServers: mcpServersRouter,
  fonts: fontRouter,
});

export const createCaller = t.createCallerFactory(appRouter);

//not recommend to use this
export const adminCaller = createCaller({ id: '1', name: 'admin', sub: '1', role: 'superadmin', exp: 0, iat: 0 });

export const userCaller = (ctx: Context) => {
  return createCaller(ctx);
};

export type AppRouter = typeof appRouter;
export type RouterOutput = inferRouterOutputs<AppRouter>;
export type RouterInput = inferRouterInputs<AppRouter>;
