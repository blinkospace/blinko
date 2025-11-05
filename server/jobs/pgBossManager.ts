import PgBoss from 'pg-boss';

/**
 * PgBoss Manager - Singleton
 * Official pg-boss pattern: new PgBoss() -> start() -> createQueue() -> work()
 */
class PgBossManager {
  private static instance: PgBoss | null = null;
  private static isInitialized: boolean = false;
  private static initPromise: Promise<void> | null = null;

  /**
   * Initialize and start pg-boss
   */
  static async initialize(): Promise<void> {
    if (this.isInitialized && this.instance) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        const databaseUrl = process.env.DATABASE_URL;
        
        if (!databaseUrl) {
          throw new Error('DATABASE_URL not set');
        }

        if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
          console.warn('[PgBoss] Requires PostgreSQL. Disabled.');
          return;
        }

        console.log('[PgBoss] Initializing...');
        
        // Step 1: Create instance
        this.instance = new PgBoss({
          connectionString: databaseUrl,
          schema: 'pgboss',
          monitorIntervalSeconds: 60,
          deleteAfterDays: 7,
          maintenanceIntervalSeconds: 300,
        });

        // Error handling
        this.instance.on('error', (error) => {
          console.error('[PgBoss] Error:', error);
        });

        // Step 2: Start (connects to DB, runs migrations)
        await this.instance.start();
        
        this.isInitialized = true;
        console.log('[PgBoss] ✅ Started');
      } catch (error) {
        console.error('[PgBoss] Failed to start:', error);
        this.instance = null;
        this.isInitialized = false;
        throw error;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  /**
   * Step 3: Create queue explicitly (official best practice)
   */
  static async createQueue(name: string, options?: PgBoss.Queue): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error('PgBoss not initialized');
    }

    try {
      await this.instance!.createQueue(name, options);
      console.log(`[PgBoss] ✓ Queue created: ${name}`);
    } catch (error: any) {
      console.error(`[PgBoss] Failed to create queue ${name}:`, error.message);
      throw error;
    }
  }

  static getInstance(): PgBoss {
    if (!this.instance || !this.isInitialized) {
      throw new Error('PgBoss not initialized');
    }
    return this.instance;
  }

  static isAvailable(): boolean {
    return this.isInitialized && this.instance !== null;
  }

  static async stop(): Promise<void> {
    if (this.instance) {
      try {
        await this.instance.stop({ graceful: true, timeout: 30000 });
        console.log('[PgBoss] Stopped');
      } catch (error) {
        console.error('[PgBoss] Stop error:', error);
      } finally {
        this.instance = null;
        this.isInitialized = false;
      }
    }
  }

  /**
   * Get all tasks info for adapter
   */
  static async getQueueInfo(queueName?: string) {
    if (!this.isAvailable()) {
      return null;
    }

    const boss = this.getInstance();
    
    if (queueName) {
      const [queues, schedules] = await Promise.all([
        boss.getQueues(),
        boss.getSchedules()
      ]);
      
      const schedule = schedules.find((s: any) => s.name === queueName);
      const queue = queues.find((q: any) => q.name === queueName);
      
      return {
        name: queueName,
        cron: schedule?.cron || null,
        isScheduled: !!schedule,
        queueData: queue,
        scheduleData: schedule,
      };
    }

    const [queues, schedules] = await Promise.all([
      boss.getQueues(),
      boss.getSchedules()
    ]);

    return { queues, schedules };
  }

  static async getJob(jobId: string) {
    if (!this.isAvailable()) {
      return null;
    }
    return await this.getInstance().getJobById(jobId);
  }
}

export { PgBossManager };

