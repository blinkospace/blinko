import { getPgBoss } from "../lib/pgBoss";
import { prisma } from "../prisma";
import { AiService } from "@server/aiServer";
import { RuntimeContext } from "@mastra/core/di";
import { AiModelFactory } from "@server/aiServer/aiModelFactory";

export const AI_SCHEDULED_TASK_QUEUE = "ai-scheduled-task";

interface AITaskPayload {
  taskId: number;
  accountId: number;
  prompt: string;
}

export class AIScheduledTaskJob {
  private static isWorkerRegistered = false;

  /**
   * Initialize the AI scheduled task worker
   */
  static async initialize(): Promise<void> {
    if (this.isWorkerRegistered) {
      return;
    }

    const boss = await getPgBoss();

    // Create the queue
    await boss.createQueue(AI_SCHEDULED_TASK_QUEUE);

    // Register the worker
    await boss.work(AI_SCHEDULED_TASK_QUEUE, { batchSize: 1 }, async (jobs: any[]) => {
      const job = jobs[0];
      if (!job || !job.data) return;
      const { taskId, accountId, prompt } = job.data as AITaskPayload;
      console.log(`[AI Scheduled Task] Executing task ${taskId}: ${prompt.slice(0, 50)}...`);

      try {
        // Get the task from database to ensure it's still enabled
        const task = await prisma.aiScheduledTask.findUnique({
          where: { id: taskId }
        });

        if (!task || !task.isEnabled) {
          console.log(`[AI Scheduled Task] Task ${taskId} is disabled or not found, skipping`);
          return { skipped: true, reason: 'Task disabled or not found' };
        }

        // Execute the AI prompt
        const result = await this.executeAIPrompt(prompt, accountId);

        // Update last run time and result
        await prisma.aiScheduledTask.update({
          where: { id: taskId },
          data: {
            lastRun: new Date(),
            lastResult: {
              success: true,
              result: result,
              executedAt: new Date().toISOString()
            }
          }
        });

        console.log(`[AI Scheduled Task] Task ${taskId} completed successfully`);
        return { success: true, result };

      } catch (error: any) {
        console.error(`[AI Scheduled Task] Task ${taskId} failed:`, error);

        // Update last run with error
        await prisma.aiScheduledTask.update({
          where: { id: taskId },
          data: {
            lastRun: new Date(),
            lastResult: {
              success: false,
              error: error?.message || 'Unknown error',
              executedAt: new Date().toISOString()
            }
          }
        });

        throw error;
      }
    });

    this.isWorkerRegistered = true;
    console.log(`[AI Scheduled Task] Worker registered`);

    // Schedule all enabled tasks
    await this.scheduleAllTasks();
  }

  /**
   * Execute an AI prompt and return the result
   */
  private static async executeAIPrompt(prompt: string, accountId: number): Promise<string> {
    const runtimeContext = new RuntimeContext();
    runtimeContext.set('accountId', accountId);
    
    const agent = await AiModelFactory.BaseChatAgent({ 
      withTools: true, 
      withOnlineSearch: true 
    });
    
    const conversations = [
      { role: 'user' as const, content: prompt }
    ];
    
    const result = await agent.stream(conversations, { runtimeContext });
    
    let output = '';
    for await (const chunk of result.fullStream) {
      if (chunk.type === 'text-delta' && chunk.textDelta) {
        output += chunk.textDelta;
      }
    }
    
    return output;
  }

  /**
   * Schedule all enabled AI tasks from database
   */
  static async scheduleAllTasks(): Promise<void> {
    // Check if aiScheduledTask is available (might not be if Prisma client not regenerated)
    if (!prisma.aiScheduledTask) {
      console.warn('[AI Scheduled Task] aiScheduledTask model not available, skipping scheduleAllTasks. Please restart server after running: bun x prisma generate');
      return;
    }

    const tasks = await prisma.aiScheduledTask.findMany({
      where: { isEnabled: true }
    });

    const boss = await getPgBoss();

    for (const task of tasks) {
      try {
        // Create a unique schedule name for this task
        const scheduleName = `${AI_SCHEDULED_TASK_QUEUE}-${task.id}`;
        
        // Create queue for this schedule
        await boss.createQueue(scheduleName);
        
        // Schedule sends jobs to queue with same name as schedule
        await boss.schedule(scheduleName, task.schedule, {
          taskId: task.id,
          accountId: task.accountId,
          prompt: task.prompt
        } as AITaskPayload, {
          tz: 'UTC'
        });

        // Worker to forward jobs from schedule queue to main queue
        await boss.work(scheduleName, { batchSize: 1 }, async (jobs: any[]) => {
          const job = jobs[0];
          if (job && job.data) {
            await boss.send(AI_SCHEDULED_TASK_QUEUE, job.data);
          }
        });

        console.log(`[AI Scheduled Task] Scheduled task ${task.id}: ${task.name}`);
      } catch (error) {
        console.error(`[AI Scheduled Task] Failed to schedule task ${task.id}:`, error);
      }
    }
  }

  /**
   * Create a new AI scheduled task
   */
  static async createTask(params: {
    name: string;
    prompt: string;
    schedule: string;
    accountId: number;
  }): Promise<{ id: number; name: string }> {
    const { name, prompt, schedule, accountId } = params;

    // Validate cron expression (basic validation)
    if (!this.isValidCron(schedule)) {
      throw new Error(`Invalid cron expression: ${schedule}`);
    }

    // Create the task in database
    const task = await prisma.aiScheduledTask.create({
      data: {
        name,
        prompt,
        schedule,
        accountId,
        isEnabled: true
      }
    });

    // Schedule it with pg-boss
    const boss = await getPgBoss();
    const scheduleName = `${AI_SCHEDULED_TASK_QUEUE}-${task.id}`;
    
    // Create queue for this schedule
    await boss.createQueue(scheduleName);
    
    // Schedule sends jobs to queue with same name as schedule
    await boss.schedule(scheduleName, schedule, {
      taskId: task.id,
      accountId: task.accountId,
      prompt: task.prompt
    } as AITaskPayload, {
      tz: 'UTC'
    });

    // Worker to forward jobs from schedule queue to main queue
    await boss.work(scheduleName, { batchSize: 1 }, async (jobs: any[]) => {
      const job = jobs[0];
      if (job && job.data) {
        await boss.send(AI_SCHEDULED_TASK_QUEUE, job.data);
      }
    });

    console.log(`[AI Scheduled Task] Created and scheduled task ${task.id}: ${name}`);

    return { id: task.id, name: task.name };
  }

  /**
   * Delete an AI scheduled task
   */
  static async deleteTask(taskId: number, accountId: number): Promise<boolean> {
    // Verify ownership
    const task = await prisma.aiScheduledTask.findFirst({
      where: { id: taskId, accountId }
    });

    if (!task) {
      throw new Error(`Task ${taskId} not found or access denied`);
    }

    // Unschedule from pg-boss
    const boss = await getPgBoss();
    const scheduleName = `${AI_SCHEDULED_TASK_QUEUE}-${taskId}`;

    try {
      await boss.unschedule(scheduleName);
    } catch (e) {
      // Ignore if schedule doesn't exist
    }

    // Delete from database
    await prisma.aiScheduledTask.delete({
      where: { id: taskId }
    });

    console.log(`[AI Scheduled Task] Deleted task ${taskId}`);
    return true;
  }

  /**
   * Toggle task enabled/disabled
   */
  static async toggleTask(taskId: number, accountId: number, enabled: boolean): Promise<boolean> {
    const task = await prisma.aiScheduledTask.findFirst({
      where: { id: taskId, accountId }
    });

    if (!task) {
      throw new Error(`Task ${taskId} not found or access denied`);
    }

    const boss = await getPgBoss();
    const scheduleName = `${AI_SCHEDULED_TASK_QUEUE}-${taskId}`;

    if (enabled) {
      // Create queue for this schedule
      await boss.createQueue(scheduleName);
      
      // Schedule sends jobs to queue with same name as schedule
      await boss.schedule(scheduleName, task.schedule, {
        taskId: task.id,
        accountId: task.accountId,
        prompt: task.prompt
      } as AITaskPayload, {
        tz: 'UTC'
      });

      // Worker to forward jobs from schedule queue to main queue
      await boss.work(scheduleName, { batchSize: 1 }, async (jobs: any[]) => {
        const job = jobs[0];
        if (job && job.data) {
          await boss.send(AI_SCHEDULED_TASK_QUEUE, job.data);
        }
      });
    } else {
      // Unschedule the task
      try {
        await boss.unschedule(scheduleName);
      } catch (e) {
        // Ignore
      }
    }

    await prisma.aiScheduledTask.update({
      where: { id: taskId },
      data: { isEnabled: enabled }
    });

    return true;
  }

  /**
   * Get all tasks for an account
   */
  static async getTasks(accountId: number) {
    return prisma.aiScheduledTask.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Run a task immediately
   */
  static async runNow(taskId: number, accountId: number): Promise<string | null> {
    const task = await prisma.aiScheduledTask.findFirst({
      where: { id: taskId, accountId }
    });

    if (!task) {
      throw new Error(`Task ${taskId} not found or access denied`);
    }

    const boss = await getPgBoss();
    const jobId = await boss.send(AI_SCHEDULED_TASK_QUEUE, {
      taskId: task.id,
      accountId: task.accountId,
      prompt: task.prompt
    } as AITaskPayload);

    return jobId;
  }

  /**
   * Basic cron expression validation
   */
  private static isValidCron(cron: string): boolean {
    // Basic validation: should have 5 parts
    const parts = cron.trim().split(/\s+/);
    return parts.length === 5;
  }
}

