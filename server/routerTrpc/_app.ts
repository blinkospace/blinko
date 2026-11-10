/**
 * This file contains the root router of your tRPC-backend
 */
import { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { TRPCBuiltRouter, TRPCDecorateCreateRouterOptions, TRPCRouterCaller } from '@trpc/server';
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
import { pluginServicesRouter } from './pluginServices';
// Name the router record instead of expanding every provider's inferred types
// into the public declaration. Procedure inputs and outputs remain unchanged.
type AppRouterRecord = {
  pluginServices: typeof pluginServicesRouter;
  ai: typeof aiRouter;
  notes: typeof noteRouter;
  tags: typeof tagRouter;
  users: typeof userRouter;
  attachments: typeof attachmentsRouter;
  config: typeof configRouter;
  public: typeof publicRouter;
  task: typeof taskRouter;
  aiTask: typeof aiScheduledTaskRouter;
  analytics: typeof analyticsRouter;
  comments: typeof commentRouter;
  follows: typeof followsRouter;
  notifications: typeof notificationRouter;
  plugin: typeof pluginRouter;
  conversation: typeof conversationRouter;
  message: typeof messageRouter;
  mcpServers: typeof mcpServersRouter;
  fonts: typeof fontRouter;
};

export const appRouter: TRPCBuiltRouter<typeof t._config.$types, TRPCDecorateCreateRouterOptions<AppRouterRecord>> = router({
  pluginServices: pluginServicesRouter,
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
} satisfies AppRouterRecord);

export const createCaller: TRPCRouterCaller<typeof t._config.$types, AppRouter['_def']['record']> = t.createCallerFactory(appRouter);

//not recommend to use this
export const adminCaller: ReturnType<typeof createCaller> = createCaller({ id: '1', name: 'admin', sub: '1', role: 'superadmin', exp: 0, iat: 0 });

export const userCaller = (ctx: Context): ReturnType<typeof createCaller> => {
  return createCaller(ctx);
};

export type AppRouter = typeof appRouter;
export type RouterOutput = inferRouterOutputs<AppRouter>;
export type RouterInput = inferRouterInputs<AppRouter>;
