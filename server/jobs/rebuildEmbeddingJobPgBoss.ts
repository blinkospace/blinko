import { BasePgBossJob } from './basePgBossJob';
import { prisma } from '../prisma';
import { NotificationType } from '@shared/lib/prismaZodType';
import { CreateNotification } from '../routerTrpc/notification';
import { AiModelFactory } from '@server/aiServer/aiModelFactory';
import { AiService } from '@server/aiServer';
import PgBoss from 'pg-boss';

export const REBUILD_EMBEDDING_TASK_NAME = 'rebuildEmbedding';

export interface ResultRecord {
  type: 'success' | 'skip' | 'error';
  content: string;
  error?: string;
  timestamp: string;
}

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
  [key: string]: any;
}

export class RebuildEmbeddingJobPgBoss extends BasePgBossJob {
  protected static taskName = REBUILD_EMBEDDING_TASK_NAME;
  protected static defaultSchedule = '0 0 * * *';
  private static forceStopFlag = false;
  private static readonly PROGRESS_CACHE_KEY = 'rebuild_embedding_progress';

  // Removed automatic initialization - will be called manually from server startup

  static async ForceRebuild(force: boolean = true, incremental: boolean = false): Promise<boolean> {
    try {
      this.forceStopFlag = false;

      const existingProgress = await this.GetProgress();
      
      if (existingProgress?.isRunning && force) {
        console.log(`[${this.taskName}] Force stopping`);
        await this.StopRebuild();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      let initialProgress: RebuildProgress;
      if (incremental && existingProgress) {
        initialProgress = {
          ...existingProgress,
          isRunning: true,
          retryCount: (existingProgress.retryCount || 0) + 1,
          lastUpdate: new Date().toISOString(),
          isIncremental: true,
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
          isIncremental: false,
        };
      }

      await this.saveProgress(initialProgress);
      await this.sendJob({ force, incremental });
      
      return true;
    } catch (error) {
      console.error(`[${this.taskName}] Force rebuild failed:`, error);
      return false;
    }
  }

  static async StopRebuild(): Promise<boolean> {
    try {
      this.forceStopFlag = true;
      
      const progress = await this.GetProgress();
      if (progress) {
        await this.saveProgress({
          ...progress,
          isRunning: false,
        });
      }
      
      return true;
    } catch (error) {
      console.error(`[${this.taskName}] Stop failed:`, error);
      return false;
    }
  }

  static async GetProgress(): Promise<RebuildProgress | null> {
    try {
      const cache = await prisma.cache.findFirst({
        where: { key: this.PROGRESS_CACHE_KEY }
      });
      
      if (!cache) return null;
      return cache.value as unknown as RebuildProgress;
    } catch (error) {
      console.error(`[${this.taskName}] Get progress failed:`, error);
      return null;
    }
  }

  static async ResumeRebuild(): Promise<boolean> {
    return this.ForceRebuild(true, true);
  }

  static async RetryFailedNotes(): Promise<boolean> {
    try {
      const progress = await this.GetProgress();
      if (!progress) return false;

      const updatedProgress = {
        ...progress,
        processedNoteIds: progress.processedNoteIds.filter(
          id => !progress.failedNoteIds.includes(id)
        ),
        failedNoteIds: [],
        isRunning: true,
        isIncremental: true,
      };

      await this.saveProgress(updatedProgress);
      await this.sendJob({ retry: true });
      
      return true;
    } catch (error) {
      console.error(`[${this.taskName}] Retry failed:`, error);
      return false;
    }
  }

  static async GetFailedNotes(): Promise<number[]> {
    try {
      const progress = await this.GetProgress();
      return progress?.failedNoteIds || [];
    } catch (error) {
      console.error(`[${this.taskName}] Get failed notes error:`, error);
      return [];
    }
  }

  protected static async RunTask(job?: PgBoss.Job): Promise<any> {
    const currentProgress = await this.GetProgress() || {
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
      isIncremental: false,
    };

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
      console.log(`[${this.taskName}] Processing ${notes.length} notes`);

      for (let i = 0; i < notes.length; i += BATCH_SIZE) {
        if (this.forceStopFlag) {
          await this.saveProgress({
            ...currentProgress,
            current,
            total,
            percentage: Math.floor((current / total) * 100),
            isRunning: false,
            results: results.slice(-50),
            lastUpdate: new Date().toISOString(),
          });
          return { stopped: true, current, total };
        }

        const noteBatch = notes.slice(i, i + BATCH_SIZE);

        for (const note of noteBatch) {
          if (this.forceStopFlag) break;
          if (processedIds.has(note.id)) continue;

          console.log(`[${this.taskName}] Processing note ${note.id}, ${current}/${total}`);

          try {
            let noteProcessed = false;

            if (process.env.NODE_ENV === 'development') {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }

            if (note?.content && note.content.trim() !== '') {
              const result = await this.processNoteWithRetry(note, 3);
              if (result.success) {
                results.push({
                  type: 'success',
                  content: note?.content.slice(0, 30) ?? '',
                  timestamp: new Date().toISOString()
                });
                noteProcessed = true;
              } else {
                results.push({
                  type: 'error',
                  content: note?.content.slice(0, 30) ?? '',
                  error: result.error,
                  timestamp: new Date().toISOString()
                });
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
                  results.push({
                    type: 'skip',
                    content: attachment?.path,
                    error: 'image not supported',
                    timestamp: new Date().toISOString()
                  });
                  continue;
                }

                const attachmentResult = await this.processAttachmentWithRetry(note, attachment, 3);
                if (attachmentResult.success) {
                  results.push({
                    type: 'success',
                    content: decodeURIComponent(attachment?.path),
                    timestamp: new Date().toISOString()
                  });
                  noteProcessed = true;
                } else {
                  results.push({
                    type: 'error',
                    content: decodeURIComponent(attachment?.path),
                    error: attachmentResult.error,
                    timestamp: new Date().toISOString()
                  });
                }
              }
            }

            if (noteProcessed) {
              processedIds.add(note.id);
              current++;
            }

            const updatedProgress: RebuildProgress = {
              ...currentProgress,
              current,
              total,
              percentage: Math.floor((current / total) * 100),
              isRunning: true,
              results: results.slice(-50),
              lastUpdate: new Date().toISOString(),
              processedNoteIds: Array.from(processedIds),
              failedNoteIds: Array.from(failedIds),
              lastProcessedId: note.id,
            };

            await this.saveProgress(updatedProgress);
          } catch (error: any) {
            console.error(`[${this.taskName}] Error processing note ${note.id}:`, error);
            results.push({
              type: 'error',
              content: note.content.slice(0, 30),
              error: error?.toString(),
              timestamp: new Date().toISOString()
            });
          }
        }
      }

      const finalProgress: RebuildProgress = {
        ...currentProgress,
        current,
        total,
        percentage: 100,
        isRunning: false,
        results: results.slice(-50),
        lastUpdate: new Date().toISOString(),
        processedNoteIds: Array.from(processedIds),
        failedNoteIds: Array.from(failedIds),
      };

      await this.saveProgress(finalProgress);

      await CreateNotification({
        title: 'embedding-rebuild-complete',
        content: 'embedding-rebuild-complete',
        type: NotificationType.SYSTEM,
        useAdmin: true,
      });

      return finalProgress;
    } catch (error) {
      console.error(`[${this.taskName}] Error:`, error);
      
      const errorProgress = {
        ...currentProgress,
        isRunning: false,
        results: [
          ...(currentProgress.results || []).slice(-49),
          {
            type: 'error' as const,
            content: 'Task failed',
            error: error?.toString(),
            timestamp: new Date().toISOString()
          }
        ],
        lastUpdate: new Date().toISOString()
      };

      await this.saveProgress(errorProgress);
      throw error;
    }
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
        if (attempt === maxRetries) {
          return { success: false, error: error?.toString() || 'Unknown error' };
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      } catch (error: any) {
        if (attempt === maxRetries) {
          return { success: false, error: error?.toString() || 'Unknown error' };
        }
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
        if (attempt === maxRetries) {
          return { success: false, error: error?.toString() || 'Unknown error' };
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      } catch (error: any) {
        if (attempt === maxRetries) {
          return { success: false, error: error?.toString() || 'Unknown error' };
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
    return { success: false, error: 'Max retries exceeded' };
  }

  private static async saveProgress(progress: RebuildProgress): Promise<void> {
    try {
      const existing = await prisma.cache.findFirst({
        where: { key: this.PROGRESS_CACHE_KEY }
      });

      if (existing) {
        await prisma.cache.update({
          where: { id: existing.id },
          // @ts-ignore
          data: { value: progress }
        });
      } else {
        // @ts-ignore
        await prisma.cache.create({
          data: {
            key: this.PROGRESS_CACHE_KEY,
            // @ts-ignore
            value: progress
          }
        });
      }
    } catch (error) {
      console.error(`[${this.taskName}] Failed to save progress:`, error);
    }
  }
}

