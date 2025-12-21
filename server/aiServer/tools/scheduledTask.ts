import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';
import { verifyToken } from '@server/lib/helper';
import { AIScheduledTaskJob } from '@server/jobs/aiScheduledTaskJob';
import { prisma } from '@server/prisma';

/**
 * Tool for AI to create scheduled tasks
 */
export const createScheduledTaskTool = createTool({
  id: 'create-scheduled-task-tool',
  description: `Create a scheduled task that will run automatically at specified times.
  
Examples of schedule (cron format):
- "0 10 * * *" - Every day at 10:00 AM
- "0 9 * * 1" - Every Monday at 9:00 AM  
- "0 */6 * * *" - Every 6 hours
- "30 8 * * 1-5" - Weekdays at 8:30 AM
- "0 0 1 * *" - First day of every month at midnight

The prompt is what the AI will execute when the task runs. For example:
- "Search for the latest technology news and create a note summarizing the top 5 stories"
- "Check my notes from last week and create a summary"
- "Search for weather forecast and create a reminder note"`,
  //@ts-ignore
  inputSchema: z.object({
    name: z.string().describe("A short, descriptive name for the task (e.g., 'Daily News Summary', 'Weekly Review')"),
    prompt: z.string().describe("The instruction for the AI to execute when the task runs. Be specific about what actions to take."),
    schedule: z.string().describe("Cron expression for when to run the task. Format: 'minute hour day month weekday'. Use * for 'every'."),
    token: z.string().optional().describe("internal use, do not pass!")
  }),
  execute: async ({ context, runtimeContext }) => {
    const accountId = runtimeContext?.get('accountId');
    let userId: number;

    if (accountId) {
      userId = Number(accountId);
    } else if (context?.token) {
      const user = await verifyToken(context.token);
      if (!user) {
        return { success: false, error: 'Authentication failed' };
      }
      userId = Number(user.id);
    } else {
      return { success: false, error: 'No authentication provided' };
    }

    try {
      const result = await AIScheduledTaskJob.createTask({
        name: context.name,
        prompt: context.prompt,
        schedule: context.schedule,
        accountId: userId
      });

      return {
        success: true,
        message: `Scheduled task "${result.name}" created successfully with ID ${result.id}`,
        taskId: result.id,
        taskName: result.name,
        schedule: context.schedule
      };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message || 'Failed to create scheduled task'
      };
    }
  }
});

/**
 * Tool for AI to delete scheduled tasks
 */
export const deleteScheduledTaskTool = createTool({
  id: 'delete-scheduled-task-tool',
  description: 'Delete an existing scheduled task by its ID or name. Use this when user wants to remove/cancel a scheduled task.',
  //@ts-ignore
  inputSchema: z.object({
    taskId: z.number().optional().describe("The ID of the task to delete"),
    taskName: z.string().optional().describe("The name of the task to delete (if ID is not provided)"),
    token: z.string().optional().describe("internal use, do not pass!")
  }),
  execute: async ({ context, runtimeContext }) => {
    const accountId = runtimeContext?.get('accountId');
    let userId: number;

    if (accountId) {
      userId = Number(accountId);
    } else if (context?.token) {
      const user = await verifyToken(context.token);
      if (!user) {
        return { success: false, error: 'Authentication failed' };
      }
      userId = Number(user.id);
    } else {
      return { success: false, error: 'No authentication provided' };
    }

    try {
      let taskId = context.taskId;

      // If taskName is provided but not taskId, find the task by name
      if (!taskId && context.taskName) {
        const task = await prisma.aiScheduledTask.findFirst({
          where: {
            name: { contains: context.taskName, mode: 'insensitive' },
            accountId: userId
          }
        });
        if (!task) {
          return { success: false, error: `Task with name "${context.taskName}" not found` };
        }
        taskId = task.id;
      }

      if (!taskId) {
        return { success: false, error: 'Please provide either taskId or taskName' };
      }

      await AIScheduledTaskJob.deleteTask(taskId, userId);

      return {
        success: true,
        message: `Scheduled task ${taskId} deleted successfully`
      };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message || 'Failed to delete scheduled task'
      };
    }
  }
});

/**
 * Tool for AI to list scheduled tasks
 */
export const listScheduledTasksTool = createTool({
  id: 'list-scheduled-tasks-tool',
  description: 'List all scheduled tasks for the current user. Use this to see what tasks are scheduled.',
  //@ts-ignore
  inputSchema: z.object({
    token: z.string().optional().describe("internal use, do not pass!")
  }),
  execute: async ({ context, runtimeContext }) => {
    const accountId = runtimeContext?.get('accountId');
    let userId: number;

    if (accountId) {
      userId = Number(accountId);
    } else if (context?.token) {
      const user = await verifyToken(context.token);
      if (!user) {
        return { success: false, error: 'Authentication failed' };
      }
      userId = Number(user.id);
    } else {
      return { success: false, error: 'No authentication provided' };
    }

    try {
      const tasks = await AIScheduledTaskJob.getTasks(userId);

      if (tasks.length === 0) {
        return {
          success: true,
          message: 'No scheduled tasks found',
          tasks: []
        };
      }

      return {
        success: true,
        message: `Found ${tasks.length} scheduled task(s)`,
        tasks: tasks.map(t => ({
          id: t.id,
          name: t.name,
          prompt: t.prompt.slice(0, 100) + (t.prompt.length > 100 ? '...' : ''),
          schedule: t.schedule,
          isEnabled: t.isEnabled,
          lastRun: t.lastRun?.toISOString() || 'Never',
          lastResult: t.lastResult
        }))
      };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message || 'Failed to list scheduled tasks'
      };
    }
  }
});

