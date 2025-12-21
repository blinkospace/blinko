import { PgBoss } from 'pg-boss';

let boss: PgBoss | null = null;

/**
 * Get or create the pg-boss instance
 * Uses singleton pattern to ensure only one instance exists
 */
export async function getPgBoss(): Promise<PgBoss> {
  if (!boss) {
    const connectionString = process.env.DATABASE_URL;
    
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    boss = new PgBoss({
      connectionString,
      schema: 'pgboss',
      // Retry configuration
      retryLimit: 3,
      retryDelay: 60, // seconds
      retryBackoff: true,
      // Archive completed jobs after 1 day
      archiveCompletedAfterSeconds: 60 * 60 * 24,
      // Delete archived jobs after 7 days
      deleteAfterSeconds: 60 * 60 * 24 * 7,
      // Monitor state every 30 seconds
      monitorStateIntervalSeconds: 30,
    });

    boss.on('error', (error) => {
      console.error('[pg-boss] Error:', error);
    });

    boss.on('monitor-states', (states) => {
      if (states.all.active > 0) {
        console.log(`[pg-boss] Active jobs: ${states.all.active}`);
      }
    });

    await boss.start();
    console.log('[pg-boss] Started successfully');
  }
  
  return boss;
}

/**
 * Stop the pg-boss instance gracefully
 */
export async function stopPgBoss(): Promise<void> {
  if (boss) {
    console.log('[pg-boss] Stopping...');
    await boss.stop({ graceful: true, timeout: 30000 });
    boss = null;
    console.log('[pg-boss] Stopped successfully');
  }
}

/**
 * Check if pg-boss is running
 */
export function isPgBossRunning(): boolean {
  return boss !== null;
}

