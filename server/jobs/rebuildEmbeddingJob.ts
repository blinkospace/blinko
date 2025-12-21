import { BaseScheduleJob } from "./baseScheduleJob";
import { prisma } from "../prisma";
import { NotificationType } from "@shared/lib/prismaZodType";
import { CreateNotification } from "../routerTrpc/notification";
import { AiModelFactory } from "@server/aiServer/aiModelFactory";
import { AiService } from "@server/aiServer";

export const REBUILD_EMBEDDING_TASK_NAME = "rebuildEmbedding";
const PROGRESS_CACHE_KEY = "rebuild-embedding-progress";

// JSON-serializable result record
export interface ResultRecord {
  type: 'success' | 'skip' | 'error';
  content: string;
  error?: string;
  timestamp: string;
}

// JSON-serializable progress object
export interface RebuildProgress {
  current: number;
  total: number;
  percentage: number;
  isRunning: boolean;
  results: ResultRecord[];
  lastUpdate: string;
  processedNoteIds: number[];
  failedNoteIds: number[];
  skippedNoteIds: number[];
  lastProcessedId?: number;
  retryCount: number;
  startTime: string;
  isIncremental: boolean;
}

export class RebuildEmbeddingJob extends BaseScheduleJob {
  protected static taskName = REBUILD_EMBEDDING_TASK_NAME;
  protected static cronSchedule = '0 0 * * *';
  private static forceStopFlag = false;

  /**
   * Get progress from cache table
   */
  private static async getProgressFromCache(): Promise<RebuildProgress | null> {
    const cached = await prisma.cache.findUnique({
      where: { key: PROGRESS_CACHE_KEY }
    });
    return cached?.value as unknown as RebuildProgress | null;
  }

  /**
   * Save progress to cache table
   */
  private static async saveProgressToCache(progress: RebuildProgress): Promise<void> {
    await prisma.cache.upsert({
      where: { key: PROGRESS_CACHE_KEY },
      update: { value: progress as any },
      create: { key: PROGRESS_CACHE_KEY, value: progress as any }
    });
  }

  /**
   * Force restart the rebuild embedding task
   */
  static async ForceRebuild(force: boolean = true, incremental: boolean = false): Promise<boolean> {
    try {
      this.forceStopFlag = false;

      const existingProgress = await this.getProgressFromCache();

      if (existingProgress?.isRunning && force) {
        console.log(`Task ${this.taskName} is already running, force stopping before restart`);
        await this.StopRebuild();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      let initialProgress: RebuildProgress;

      if (incremental && existingProgress) {
        initialProgress = {
          current: existingProgress.current || 0,
          total: existingProgress.total || 0,
          percentage: existingProgress.percentage || 0,
          isRunning: true,
          results: existingProgress.results || [],
          lastUpdate: new Date().toISOString(),
          processedNoteIds: existingProgress.processedNoteIds || [],
          failedNoteIds: existingProgress.failedNoteIds || [],
          skippedNoteIds: existingProgress.skippedNoteIds || [],
          lastProcessedId: existingProgress.lastProcessedId,
          retryCount: (existingProgress.retryCount || 0) + 1,
          startTime: existingProgress.startTime || new Date().toISOString(),
          isIncremental: true
        };
      } else {
        initialProgress = {
          current: 0,
          total: 0,
          percentage: 0,
          isRunning: true,
          results: [],
          lastUpdate: new Date().toISOString(),
          processedNoteIds: [],
          failedNoteIds: [],
          skippedNoteIds: [],
          retryCount: 0,
          startTime: new Date().toISOString(),
          isIncremental: false
        };
      }

      await this.saveProgressToCache(initialProgress);

      // Use base class method to trigger job
      await super.TriggerNow();
      return true;
    } catch (error) {
      console.error("Failed to force rebuild embedding:", error);
      return false;
    }
  }

  /**
   * Stop the current rebuild task if it's running
   */
  static async StopRebuild(): Promise<boolean> {
    try {
      this.forceStopFlag = true;
      
      const progress = await this.getProgressFromCache();
      if (progress) {
        progress.isRunning = false;
        await this.saveProgressToCache(progress);
      }

      return true;
    } catch (error) {
      console.error("Failed to stop rebuild embedding:", error);
      return false;
    }
  }

  /**
   * Get current progress of the rebuild embedding task
   */
  static async GetProgress(): Promise<RebuildProgress | null> {
    return this.getProgressFromCache();
  }

  protected static async RunTask(): Promise<any> {
    let currentProgress = await this.getProgressFromCache();

    if (!currentProgress) {
      currentProgress = {
        current: 0,
        total: 0,
        percentage: 0,
        isRunning: true,
        results: [],
        lastUpdate: new Date().toISOString(),
        processedNoteIds: [],
        failedNoteIds: [],
        skippedNoteIds: [],
        retryCount: 0,
        startTime: new Date().toISOString(),
        isIncremental: false
      };
      await this.saveProgressToCache(currentProgress);
    }

    if (!currentProgress.isRunning) {
      return currentProgress;
    }

    try {
      this.forceStopFlag = false;

      const { VectorStore } = await AiModelFactory.GetProvider();
      const processedIds = new Set<number>(currentProgress.processedNoteIds || []);
      const failedIds = new Set<number>(currentProgress.failedNoteIds || []);
      const results: ResultRecord[] = [...(currentProgress.results || [])];

      if (!currentProgress.isIncremental) {
        await AiModelFactory.rebuildVectorIndex({
          vectorStore: VectorStore,
          isDelete: true
        });
      }

      const whereClause: any = { isRecycle: false };
      if (currentProgress.isIncremental && processedIds.size > 0) {
        whereClause.id = { notIn: Array.from(processedIds) };
      }

      const notes = await prisma.notes.findMany({
        include: { attachments: true },
        where: whereClause,
        orderBy: { id: 'asc' }
      });

      const total = currentProgress.isIncremental
        ? (currentProgress.total || notes.length + processedIds.size)
        : notes.length;
      let current = currentProgress.current || processedIds.size;

      const BATCH_SIZE = 5;
      console.log(`[${new Date().toISOString()}] start rebuild embedding, ${notes.length} notes`);

      for (let i = 0; i < notes.length; i += BATCH_SIZE) {
        if (this.forceStopFlag) {
          return await this.saveStoppedProgress(current, total, results, processedIds, failedIds, currentProgress);
        }

        const latestProgress = await this.getProgressFromCache();
        if (latestProgress && !latestProgress.isRunning) {
          return latestProgress;
        }

        const noteBatch = notes.slice(i, i + BATCH_SIZE);

        for (const note of noteBatch) {
          if (this.forceStopFlag) {
            return await this.saveStoppedProgress(current, total, results, processedIds, failedIds, currentProgress);
          }

          if (processedIds.has(note.id)) continue;

          console.log(`[${new Date().toISOString()}] processing note ${note.id}, progress: ${current}/${total}`);

          try {
            let noteProcessed = false;

            if (note?.content && note.content.trim() !== '') {
              const result = await this.processNoteWithRetry(note, 3);
              if (result.success) {
                results.push({ type: 'success', content: note?.content.slice(0, 30) ?? '', timestamp: new Date().toISOString() });
                noteProcessed = true;
              } else {
                results.push({ type: 'error', content: note?.content.slice(0, 30) ?? '', error: result.error, timestamp: new Date().toISOString() });
                failedIds.add(note.id);
              }
            }

            if (note?.attachments) {
              for (const attachment of note.attachments) {
                const isImage = (filePath: string): boolean => {
                  if (!filePath) return false;
                  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
                  return imageExtensions.some(ext => filePath.toLowerCase().endsWith(ext));
                };

                if (isImage(attachment?.path)) {
                  results.push({ type: 'skip', content: attachment?.path, error: 'image is not supported', timestamp: new Date().toISOString() });
                  continue;
                }

                const attachmentResult = await this.processAttachmentWithRetry(note, attachment, 3);
                if (attachmentResult.success) {
                  results.push({ type: 'success', content: decodeURIComponent(attachment?.path), timestamp: new Date().toISOString() });
                  noteProcessed = true;
                } else {
                  results.push({ type: 'error', content: decodeURIComponent(attachment?.path), error: attachmentResult.error, timestamp: new Date().toISOString() });
                }
              }
            }

            if (noteProcessed) {
              processedIds.add(note.id);
              current++;
            }

            const percentage = Math.floor((current / total) * 100);
            const updatedProgress: RebuildProgress = {
              current, total, percentage,
              isRunning: true,
              results: results.slice(-50),
              lastUpdate: new Date().toISOString(),
              processedNoteIds: Array.from(processedIds),
              failedNoteIds: Array.from(failedIds),
              skippedNoteIds: currentProgress.skippedNoteIds || [],
              lastProcessedId: note.id,
              retryCount: currentProgress.retryCount || 0,
              startTime: currentProgress.startTime || new Date().toISOString(),
              isIncremental: currentProgress.isIncremental || false
            };

            await this.saveProgressToCache(updatedProgress);

          } catch (error: any) {
            console.error(`[${new Date().toISOString()}] error processing note ${note.id}:`, error);
            results.push({ type: 'error', content: note.content.slice(0, 30), error: error?.toString(), timestamp: new Date().toISOString() });
          }
        }
      }

      const finalProgress: RebuildProgress = {
        current, total, percentage: 100,
        isRunning: false,
        results: results.slice(-50),
        lastUpdate: new Date().toISOString(),
        processedNoteIds: Array.from(processedIds),
        failedNoteIds: Array.from(failedIds),
        skippedNoteIds: currentProgress.skippedNoteIds || [],
        lastProcessedId: notes[notes.length - 1]?.id,
        retryCount: currentProgress.retryCount || 0,
        startTime: currentProgress.startTime || new Date().toISOString(),
        isIncremental: currentProgress.isIncremental || false
      };

      await this.saveProgressToCache(finalProgress);

      await CreateNotification({
        title: 'embedding-rebuild-complete',
        content: 'embedding-rebuild-complete',
        type: NotificationType.SYSTEM,
        useAdmin: true,
      });

      return finalProgress;
    } catch (error) {
      console.error("Error rebuilding embedding index:", error);

      const errorProgress: RebuildProgress = {
        ...currentProgress,
        isRunning: false,
        results: [
          ...(currentProgress.results || []).slice(-49),
          { type: 'error', content: 'Task failed with error', error: error?.toString(), timestamp: new Date().toISOString() }
        ],
        lastUpdate: new Date().toISOString()
      };

      await this.saveProgressToCache(errorProgress);
      throw error;
    }
  }

  private static async saveStoppedProgress(current: number, total: number, results: ResultRecord[], processedIds: Set<number>, failedIds: Set<number>, currentProgress: RebuildProgress): Promise<RebuildProgress> {
    const stoppedProgress: RebuildProgress = {
      current, total,
      percentage: total > 0 ? Math.floor((current / total) * 100) : 0,
      isRunning: false,
      results: results.slice(-50),
      lastUpdate: new Date().toISOString(),
      processedNoteIds: Array.from(processedIds),
      failedNoteIds: Array.from(failedIds),
      skippedNoteIds: currentProgress.skippedNoteIds || [],
      retryCount: currentProgress.retryCount || 0,
      startTime: currentProgress.startTime || new Date().toISOString(),
      isIncremental: true
    };

    await this.saveProgressToCache(stoppedProgress);
    return stoppedProgress;
  }

  private static async processNoteWithRetry(note: any, maxRetries: number): Promise<{ success: boolean; error?: string }> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const { ok, error } = await AiService.embeddingUpsert({
          createTime: note.createdAt,
          updatedAt: note.updatedAt,
          id: note.id,
          content: note.content,
          type: 'update' as const
        });

        if (ok) return { success: true };
        if (attempt === maxRetries) return { success: false, error: error?.toString() || 'Unknown error' };
        console.warn(`Attempt ${attempt} failed for note ${note.id}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      } catch (error: any) {
        if (attempt === maxRetries) return { success: false, error: error?.toString() || 'Unknown error' };
        console.warn(`Attempt ${attempt} failed for note ${note.id}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
    return { success: false, error: 'Max retries exceeded' };
  }

  private static async processAttachmentWithRetry(note: any, attachment: any, maxRetries: number): Promise<{ success: boolean; error?: string }> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const { ok, error } = await AiService.embeddingInsertAttachments({
          id: note.id,
          updatedAt: note.updatedAt,
          filePath: attachment?.path
        });

        if (ok) return { success: true };
        if (attempt === maxRetries) return { success: false, error: error?.toString() || 'Unknown error' };
        console.warn(`Attempt ${attempt} failed for attachment ${attachment.path}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      } catch (error: any) {
        if (attempt === maxRetries) return { success: false, error: error?.toString() || 'Unknown error' };
        console.warn(`Attempt ${attempt} failed for attachment ${attachment.path}, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
    return { success: false, error: 'Max retries exceeded' };
  }

  static async ResumeRebuild(): Promise<boolean> {
    return this.ForceRebuild(true, true);
  }

  static async GetFailedNotes(): Promise<number[]> {
    const progress = await this.getProgressFromCache();
    return progress?.failedNoteIds || [];
  }

  static async RetryFailedNotes(): Promise<boolean> {
    try {
      const progress = await this.getProgressFromCache();
      if (!progress) return false;

      const updatedProgress: RebuildProgress = {
        ...progress,
        processedNoteIds: (progress.processedNoteIds || []).filter((id: number) => !(progress.failedNoteIds || []).includes(id)),
        failedNoteIds: [],
        isRunning: true,
        isIncremental: true
      };

      await this.saveProgressToCache(updatedProgress);
      await super.TriggerNow();
      return true;
    } catch (error) {
      console.error("Failed to retry failed notes:", error);
      return false;
    }
  }
}
