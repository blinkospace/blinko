import { prisma } from "../prisma";

import { RECOMMAND_TASK_NAME } from "@shared/lib/sharedConstant";
import { BaseScheduleJob } from "./baseScheduleJob";
import { attachmentsSchema, tagSchema, tagsToNoteSchema, notesSchema } from "@shared/lib/prismaZodType";
import { z } from "zod";
import axios from "axios";

export const recommandListSchema = z.array(notesSchema.merge(
  z.object({
    attachments: z.array(attachmentsSchema).optional(),
    account: z.object({
      image: z.string().optional(),
      nickname: z.string().optional(),
      name: z.string().optional(),
      id: z.number().optional(),
    }).nullable().optional(),
    tags: z.array(tagsToNoteSchema.merge(
      z.object({
        tag: tagSchema
      })).optional()
    ).nullable().optional(),
    _count: z.object({
      comments: z.number()
    }).optional(),
    originURL: z.string().optional()
  }))
)

export type RecommandListType = z.infer<typeof recommandListSchema>

export class RecommandJob extends BaseScheduleJob {
  protected static taskName = RECOMMAND_TASK_NAME;
  protected static cronSchedule = '0 */6 * * *'; // Every 6 hours
  private static maxConcurrency = 5;

  /**
   * Initialize the job - only starts if there are followings
   */
  static async initialize(): Promise<void> {
    try {
      const followCount = await prisma.follows.count({
        where: {
          followType: 'following'
        }
      });

      if (followCount > 0) {
        console.log(`[${this.taskName}] Found ${followCount} followings, scheduling job`);
        
        // Register worker
        await this.registerWorker();
        
        // Check if task is already scheduled via pg-boss
        const isAlreadyScheduled = await this.isScheduled();

        if (!isAlreadyScheduled) {
          // Start with default schedule
          await this.Start(this.cronSchedule, false);
        }

        // Run task immediately on startup
        this.RunTask().catch(err => {
          console.error(`[${this.taskName}] Initial execution failed:`, err);
        });
      } else {
        console.log(`[${this.taskName}] No followings found, skipping initialization`);
      }
    } catch (error) {
      console.error(`[${this.taskName}] Failed to initialize:`, error);
    }
  }

  private static async batchProcess<T, R>(
    items: T[],
    processFn: (item: T) => Promise<R>,
    batchSize: number = 5
  ): Promise<R[]> {
    const results: R[] = [];

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(processFn));
      results.push(...batchResults);

      if (i + batchSize < items.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return results;
  }

  protected static async RunTask() {
    let cachedList: { [key: string]: RecommandListType } = {};

    try {
      console.log(`[${this.taskName}] Running at`, new Date().toISOString());
      const follows = await prisma.follows.findMany({
        where: {
          followType: 'following'
        },
        select: {
          accountId: true,
          siteUrl: true
        }
      });

      if (follows.length === 0) {
        console.log(`[${this.taskName}] No follows found, skipping task`);
        await prisma.cache.delete({
          where: { key: 'recommand_list' },
        }).catch(() => {}); // Ignore if doesn't exist
        return { message: 'No follows found' };
      }

      await this.batchProcess(follows, async (follow: any) => {
        try {
          const url = new URL(follow.siteUrl);
          const response = await axios.post<RecommandListType>(
            `${url.origin}/api/v1/note/public-list`,
            { page: 1, size: 30 },
            { timeout: 10000 }
          );

          const processedData = response.data.map(item => {
            const newItem = { ...item, originURL: url.origin };

            if (newItem.attachments) {
              newItem.attachments = newItem.attachments.map(a => ({
                ...a,
                path: `${url.origin}${a.path}`
              }));
            }

            return newItem;
          });

          if (!cachedList[follow.accountId]) {
            cachedList[follow.accountId] = [];
          }

          const accountId = follow.accountId || '0';
          if (cachedList[accountId]) {
            cachedList[accountId] = cachedList[accountId].concat(processedData);
          } else {
            cachedList[accountId] = processedData;
          }

        } catch (error: any) {
          console.error(`[${this.taskName}] Error fetching data for ${follow.siteUrl}:`, error.message);
          return [];
        }
      }, this.maxConcurrency);

      const hasCache = await prisma.cache.findFirst({
        where: { key: 'recommand_list' },
        select: { id: true }
      });

      if (hasCache) {
        await prisma.cache.update({
          where: { id: hasCache.id },
          // @ts-ignore
          data: { value: cachedList }
        });
      } else {
        // @ts-ignore
        await prisma.cache.create({
          data: {
            key: 'recommand_list',
            // @ts-ignore
            value: cachedList
          }
        });
      }

      console.log(`[${this.taskName}] Successfully updated recommand_list cache`);
      return { success: true, followsProcessed: follows.length };

    } catch (error) {
      console.error(`[${this.taskName}] Failed:`, error);
      throw error;
    } finally {
      cachedList = {};

      if (global.gc) {
        try {
          global.gc();
          console.log(`[${this.taskName}] Garbage collection triggered`);
        } catch (e) {
          console.error(`[${this.taskName}] Failed to trigger garbage collection:`, e);
        }
      }
    }
  }
}
