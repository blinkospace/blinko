import { router, authProcedure } from '@server/middleware';
import { z } from 'zod';
import { AIScheduledTaskJob } from '@server/jobs/aiScheduledTaskJob';

// Schema for AI scheduled task
const aiScheduledTaskSchema = z.object({
  id: z.number(),
  name: z.string(),
  prompt: z.string(),
  schedule: z.string(),
  isEnabled: z.boolean(),
  lastRun: z.date().nullable(),
  lastResult: z.any().nullable(),
  accountId: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const aiScheduledTaskRouter = router({
  // List all AI scheduled tasks for current user
  list: authProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/ai-tasks/list', summary: 'List AI scheduled tasks', protect: true, tags: ['AI Task'] } })
    .input(z.void())
    .output(z.array(aiScheduledTaskSchema))
    .query(async ({ ctx }) => {
      const tasks = await AIScheduledTaskJob.getTasks(Number(ctx.id));
      return tasks;
    }),

  // Create a new AI scheduled task
  create: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/ai-tasks/create', summary: 'Create AI scheduled task', protect: true, tags: ['AI Task'] } })
    .input(z.object({
      name: z.string().min(1).max(255),
      prompt: z.string().min(1),
      schedule: z.string().min(1),
    }))
    .output(z.object({
      id: z.number(),
      name: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await AIScheduledTaskJob.createTask({
        name: input.name,
        prompt: input.prompt,
        schedule: input.schedule,
        accountId: Number(ctx.id),
      });
      return result;
    }),

  // Delete an AI scheduled task
  delete: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/ai-tasks/delete', summary: 'Delete AI scheduled task', protect: true, tags: ['AI Task'] } })
    .input(z.object({
      id: z.number(),
    }))
    .output(z.object({
      success: z.boolean(),
    }))
    .mutation(async ({ input, ctx }) => {
      const success = await AIScheduledTaskJob.deleteTask(input.id, Number(ctx.id));
      return { success };
    }),

  // Toggle task enabled/disabled
  toggle: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/ai-tasks/toggle', summary: 'Toggle AI scheduled task', protect: true, tags: ['AI Task'] } })
    .input(z.object({
      id: z.number(),
      enabled: z.boolean(),
    }))
    .output(z.object({
      success: z.boolean(),
    }))
    .mutation(async ({ input, ctx }) => {
      const success = await AIScheduledTaskJob.toggleTask(input.id, Number(ctx.id), input.enabled);
      return { success };
    }),

  // Run a task immediately
  runNow: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/ai-tasks/run-now', summary: 'Run AI task immediately', protect: true, tags: ['AI Task'] } })
    .input(z.object({
      id: z.number(),
    }))
    .output(z.object({
      jobId: z.string().nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      const jobId = await AIScheduledTaskJob.runNow(input.id, Number(ctx.id));
      return { jobId };
    }),
});

