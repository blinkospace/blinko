import { PgBossManager } from './pgBossManager';
import { prisma } from '../prisma';
import { ARCHIVE_BLINKO_TASK_NAME, DBBAK_TASK_NAME, RECOMMAND_TASK_NAME } from '@shared/lib/sharedConstant';
import { REBUILD_EMBEDDING_TASK_NAME } from './rebuildEmbeddingJobPgBoss';

export interface TaskInfo {
  name: string;
  schedule: string;
  isRunning: boolean;
  isSuccess: boolean;
  lastRun: Date;
  output?: any;
}

export async function getAllTasksInfo(): Promise<TaskInfo[]> {
  if (!PgBossManager.isAvailable()) {
    return [];
  }

  try {
    const boss = PgBossManager.getInstance();
    const [schedules, queues] = await Promise.all([
      boss.getSchedules(),
      boss.getQueues()
    ]);

    const taskNames = [
      ARCHIVE_BLINKO_TASK_NAME,
      DBBAK_TASK_NAME,
      RECOMMAND_TASK_NAME,
      REBUILD_EMBEDDING_TASK_NAME,
    ];

    const tasks: TaskInfo[] = [];

    for (const taskName of taskNames) {
      const schedule = schedules.find(s => s.name === taskName);
      const queue = queues.find(q => q.name === taskName);

      let output: any = null;
      let lastRun = new Date();
      let isSuccess = true;

      if (taskName === REBUILD_EMBEDDING_TASK_NAME) {
        try {
          const cache = await prisma.cache.findFirst({
            where: { key: 'rebuild_embedding_progress' }
          });
          if (cache) {
            output = cache.value;
          }
        } catch (error) {
          console.error('Failed to get rebuild progress:', error);
        }
      }

      if (schedule) {
        lastRun = schedule.updated || new Date();
      }

      tasks.push({
        name: taskName,
        schedule: schedule?.cron || '0 0 * * *',
        isRunning: !!schedule && (queue?.count || 0) > 0,
        isSuccess,
        lastRun,
        output,
      });
    }

    return tasks;
  } catch (error) {
    console.error('[PgBossAdapter] Failed to get tasks info:', error);
    return [];
  }
}

export async function getTaskInfo(taskName: string): Promise<TaskInfo | null> {
  if (!PgBossManager.isAvailable()) {
    return null;
  }

  try {
    const boss = PgBossManager.getInstance();
    const [schedules, queues] = await Promise.all([
      boss.getSchedules(),
      boss.getQueues()
    ]);

    const schedule = schedules.find(s => s.name === taskName);
    const queue = queues.find(q => q.name === taskName);

    let output: any = null;
    
    if (taskName === REBUILD_EMBEDDING_TASK_NAME) {
      const cache = await prisma.cache.findFirst({
        where: { key: 'rebuild_embedding_progress' }
      });
      if (cache) {
        output = cache.value;
      }
    }

    return {
      name: taskName,
      schedule: schedule?.cron || '0 0 * * *',
      isRunning: !!schedule && (queue?.count || 0) > 0,
      isSuccess: true,
      lastRun: schedule?.updated || new Date(),
      output,
    };
  } catch (error) {
    console.error(`[PgBossAdapter] Failed to get task info for ${taskName}:`, error);
    return null;
  }
}

