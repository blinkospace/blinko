import { BasePgBossJob } from './basePgBossJob';
import { prisma } from '../prisma';
import { RECOMMAND_TASK_NAME } from '@shared/lib/sharedConstant';
import { attachmentsSchema, tagSchema, tagsToNoteSchema, notesSchema } from '@shared/lib/prismaZodType';
import { z } from 'zod';
import axios from 'axios';

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
      z.object({ tag: tagSchema })).optional()
    ).nullable().optional(),
    _count: z.object({ comments: z.number() }).optional(),
    originURL: z.string().optional()
  }))
);

export type RecommandListType = z.infer<typeof recommandListSchema>;

export class RecommandJobPgBoss extends BasePgBossJob {
  protected static taskName = RECOMMAND_TASK_NAME;
  protected static defaultSchedule = '0 */6 * * *';
  private static maxConcurrency = 5;

  // Removed automatic initialization - will be called manually from server startup

  static async initializeTask() {
    const followCount = await prisma.follows.count({
      where: { followType: 'following' }
    });

    if (followCount > 0) {
      await this.initialize();
      this.RunTask().catch(err => {
        console.error(`[${this.taskName}] Initial run failed:`, err);
      });
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
      results.push(...await Promise.all(batch.map(processFn)));
      if (i + batchSize < items.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return results;
  }

  protected static async RunTask() {
    let cachedList: { [key: string]: RecommandListType } = {};

    try {
      const follows = await prisma.follows.findMany({
        where: { followType: 'following' },
        select: { accountId: true, siteUrl: true }
      });

      if (follows.length === 0) {
        try {
          await prisma.cache.delete({ where: { key: 'recommand_list' } });
        } catch {}
        return { message: 'No follows', followCount: 0 };
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

          const accountId = follow.accountId || '0';
          if (!cachedList[accountId]) cachedList[accountId] = [];
          cachedList[accountId] = cachedList[accountId].concat(processedData);
        } catch (error: any) {
          console.error(`[${this.taskName}] Error fetching ${follow.siteUrl}:`, error.message);
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
          data: { key: 'recommand_list', value: cachedList }
        });
      }

      const totalItems = Object.values(cachedList).reduce((sum, list) => sum + list.length, 0);
      return { followCount: follows.length, totalItems };
    } finally {
      cachedList = {};
      if (global.gc) {
        try { global.gc(); } catch {}
      }
    }
  }
}

