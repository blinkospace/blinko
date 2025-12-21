// src/server/plugins/BaseScheduleJob.ts
import { getPgBoss } from "../lib/pgBoss";

export abstract class BaseScheduleJob {
  protected static taskName: string;
  protected static cronSchedule: string = '0 0 * * *'; // Default: daily at midnight
  protected static isWorkerRegistered: boolean = false;

  /**
   * The main task logic - must be implemented by subclasses
   */
  protected static async RunTask(): Promise<any> {
    throw new Error('RunTask must be implemented');
  }

  /**
   * Register the worker for this job type
   * This should be called once during initialization
   */
  protected static async registerWorker(): Promise<void> {
    if (this.isWorkerRegistered) {
      return;
    }

    const boss = await getPgBoss();
    const taskName = this.taskName;
    const RunTask = this.RunTask.bind(this);

    // Create the queue first (required in pg-boss v10+)
    await boss.createQueue(taskName);

    await boss.work(taskName, async (job) => {
      console.log(`[${taskName}] Starting job execution...`);
      try {
        const res = await RunTask();
        console.log(`[${taskName}] Job completed successfully`);
        return res;
      } catch (error: any) {
        console.error(`[${taskName}] Job failed:`, error);
        throw error;
      }
    });

    this.isWorkerRegistered = true;
    console.log(`[${taskName}] Worker registered`);
  }

  /**
   * Start the scheduled job with optional cron time
   * @param cronTime - Cron expression (e.g., '0 0 * * *' for daily at midnight)
   * @param immediate - Whether to run the task immediately
   */
  static async Start(cronTime?: string, immediate: boolean = true): Promise<void> {
    const boss = await getPgBoss();
    const schedule = cronTime || this.cronSchedule;

    // Register the worker first
    await this.registerWorker();

    // Schedule the job with pg-boss
    await boss.schedule(this.taskName, schedule, {}, {
      tz: 'UTC'
    });

    console.log(`[${this.taskName}] Scheduled with cron: ${schedule}`);

    // Run immediately if requested
    if (immediate) {
      try {
        await this.RunTask();
      } catch (error: any) {
        console.error(`[${this.taskName}] Immediate run failed:`, error);
      }
    }
  }

  /**
   * Stop the scheduled job
   */
  static async Stop(): Promise<void> {
    const boss = await getPgBoss();
    await boss.unschedule(this.taskName);
    console.log(`[${this.taskName}] Unscheduled`);
  }

  /**
   * Update the cron schedule for the job
   * @param cronTime - New cron expression
   */
  static async SetCronTime(cronTime: string): Promise<void> {
    const boss = await getPgBoss();

    // Unschedule current and reschedule with new time
    await boss.unschedule(this.taskName);
    await boss.schedule(this.taskName, cronTime, {}, {
      tz: 'UTC'
    });

    console.log(`[${this.taskName}] Rescheduled with cron: ${cronTime}`);

    // Run immediately after rescheduling
    try {
      await this.RunTask();
    } catch (error: any) {
      console.error(`[${this.taskName}] Run after reschedule failed:`, error);
    }
  }

  /**
   * Trigger the job to run immediately (outside of schedule)
   */
  static async TriggerNow(): Promise<string | null> {
    const boss = await getPgBoss();
    
    // Ensure worker is registered
    await this.registerWorker();
    
    // Send a job to be processed immediately
    const jobId = await boss.send(this.taskName, {});
    console.log(`[${this.taskName}] Triggered immediately, jobId: ${jobId}`);
    
    return jobId;
  }

  /**
   * Initialize the job - should be called once at startup
   * This replaces the old static {} block initialization
   */
  static async initialize(defaultSchedule?: string): Promise<void> {
    const schedule = defaultSchedule || this.cronSchedule;
    
    try {
      // Register worker
      await this.registerWorker();
      console.log(`[${this.taskName}] Initialized with default schedule: ${schedule}`);
    } catch (error) {
      console.error(`[${this.taskName}] Failed to initialize:`, error);
    }
  }

  /**
   * Get the current schedule from pg-boss
   */
  static async getSchedule(): Promise<{ name: string; cron: string; data: any } | null> {
    const boss = await getPgBoss();
    const schedules = await boss.getSchedules();
    return schedules.find(s => s.name === this.taskName) || null;
  }

  /**
   * Check if the job is currently scheduled
   */
  static async isScheduled(): Promise<boolean> {
    const schedule = await this.getSchedule();
    return schedule !== null;
  }
}
