import PgBoss from 'pg-boss';
import { PgBossManager } from './pgBossManager';

/**
 * Base class for all pg-boss jobs
 * Follows official pattern: start() -> createQueue() -> work()
 */
export abstract class BasePgBossJob {
  protected static taskName: string;
  protected static defaultSchedule: string = '0 0 * * *';
  
  protected static async RunTask(job?: PgBoss.Job): Promise<any> {
    throw new Error('RunTask must be implemented');
  }

  /**
   * Step 4: Register worker (called after queue is created)
   * Official pattern: boss.work(name, handler)
   */
  protected static async initialize() {
    try {
      if (!PgBossManager.isAvailable()) {
        console.warn(`[${this.taskName}] PgBoss not available`);
        return;
      }

      const boss = PgBossManager.getInstance();

      // Register worker - queue MUST already exist at this point
      await boss.work(
        this.taskName,
        { batchSize: 1 },
        async (jobs: PgBoss.Job[]) => {
          // Handler always receives array
          const job = jobs[0];
          console.log(`[${this.taskName}] Job started: ${job.id}`);
          
          try {
            const result = await this.RunTask(job);
            console.log(`[${this.taskName}] Job completed`);
            return result;
          } catch (error) {
            console.error(`[${this.taskName}] Job failed:`, error);
            throw error;
          }
        }
      );

      console.log(`[${this.taskName}] ✅ Worker registered`);
    } catch (error) {
      console.error(`[${this.taskName}] ❌ Worker registration failed:`, error);
      throw error;
    }
  }

  static async Start(cronTime: string, immediate: boolean = true): Promise<boolean> {
    if (!PgBossManager.isAvailable()) {
      throw new Error('PgBoss not available');
    }

    try {
      const boss = PgBossManager.getInstance();
      
      await boss.schedule(this.taskName, cronTime, {}, { tz: 'UTC' });
      console.log(`[${this.taskName}] Scheduled: ${cronTime}`);

      if (immediate) {
        await this.sendJob();
      }

      return true;
    } catch (error) {
      console.error(`[${this.taskName}] Start failed:`, error);
      throw error;
    }
  }

  static async Stop(): Promise<boolean> {
    if (!PgBossManager.isAvailable()) {
      throw new Error('PgBoss not available');
    }

    try {
      const boss = PgBossManager.getInstance();
      // Unschedule stops future automatic job creation
      await boss.unschedule(this.taskName);
      console.log(`[${this.taskName}] Stopped`);
      return true;
    } catch (error) {
      console.error(`[${this.taskName}] Stop failed:`, error);
      throw error;
    }
  }

  static async SetCronTime(cronTime: string): Promise<boolean> {
    return await this.Start(cronTime, false);
  }

  static async sendJob(data?: any, options?: PgBoss.SendOptions): Promise<string | null> {
    if (!PgBossManager.isAvailable()) {
      throw new Error('PgBoss not available');
    }

    const boss = PgBossManager.getInstance();
    return await boss.send(this.taskName, data, {
      singletonKey: this.taskName,
      ...options,
    });
  }

  static async getStatus() {
    if (!PgBossManager.isAvailable()) {
      return null;
    }

    const boss = PgBossManager.getInstance();
    const [schedules, queues] = await Promise.all([
      boss.getSchedules(),
      boss.getQueues()
    ]);

    const schedule = schedules.find(s => s.name === this.taskName);
    const queue = queues.find(q => q.name === this.taskName);

    return {
      name: this.taskName,
      schedule: schedule?.cron || null,
      isRunning: !!schedule,
      activeJobs: queue?.activeCount || 0,
      scheduleData: schedule,
      queueData: queue,
    };
  }
}

