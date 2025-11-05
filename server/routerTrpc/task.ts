import { router, authProcedure, demoAuthMiddleware, superAdminAuthMiddleware } from '@server/middleware';
import { z } from 'zod';
import { prisma } from '@server/prisma';
import { ArchiveJobPgBoss } from '@server/jobs/archiveJobPgBoss';
import { DBJobPgBoss } from '@server/jobs/dbJobPgBoss';
import { getAllTasksInfo } from '@server/jobs/pgBossAdapter';
import { UPLOAD_FILE_PATH } from '@shared/lib/pathConstant';
import { ARCHIVE_BLINKO_TASK_NAME, DBBAK_TASK_NAME } from '@shared/lib/sharedConstant';
import { scheduledTaskSchema } from '@shared/lib/prismaZodType';
import { unlink } from 'fs/promises';
import { FileService } from '../lib/files';
import path from 'path';
import fs from 'fs';
import { DBUtils } from '../lib/dbUtils';


export const taskRouter = router({
  list: authProcedure.use(superAdminAuthMiddleware)
    .meta({ openapi: { method: 'GET', path: '/v1/tasks/list', summary: 'Query user task list', protect: true, tags: ['Task'] } })
    .input(z.void())
    .output(z.array(scheduledTaskSchema))
    .query(async () => {
      return await getAllTasksInfo()
    }),
  upsertTask: authProcedure.use(superAdminAuthMiddleware)
    .meta({ openapi: { method: 'GET', path: '/v1/tasks/upsert', summary: 'Upsert Task', protect: true, tags: ['Task'] } })
    .input(z.object({
      time: z.string().optional(),
      type: z.enum(['start', 'stop', 'update']),
      task: z.enum([ARCHIVE_BLINKO_TASK_NAME, DBBAK_TASK_NAME]),
    }))
    .output(z.any())
    .mutation(async ({ input }) => {
      const { time, type, task } = input
      if (type == 'start') {
        const cronTime = time ?? '0 0 * * *'
        return task == DBBAK_TASK_NAME ? await DBJobPgBoss.Start(cronTime, true) : await ArchiveJobPgBoss.Start(cronTime, true)
      }
      if (type == 'stop') {
        return task == DBBAK_TASK_NAME ? await DBJobPgBoss.Stop() : await ArchiveJobPgBoss.Stop()
      }
      if (type == 'update' && time) {
        return task == DBBAK_TASK_NAME ? await DBJobPgBoss.SetCronTime(time) : await ArchiveJobPgBoss.SetCronTime(time)
      }
    }),
  importFromBlinko: authProcedure.use(demoAuthMiddleware).use(superAdminAuthMiddleware)
    .input(z.object({
      filePath: z.string()
    }))
    .mutation(async function* ({ input, ctx }) {
      const { filePath } = input
      try {
        const fileResult = await FileService.getFile(filePath)
        const res = DBUtils.RestoreDB(fileResult.path, ctx)
        for await (const result of res) {
          yield result;
        }
        try {
          if (fileResult.isTemporary && fileResult.cleanup) {
            await fileResult.cleanup()
          } else {
            await unlink(fileResult.path)
          }
          await FileService.deleteFile(filePath)
        } catch (error) {
        }
      } catch (error) {
        throw new Error(error)
      }
    }),

  importFromMemos: authProcedure.use(demoAuthMiddleware).use(superAdminAuthMiddleware)
    .input(z.object({
      filePath: z.string() //xxxx.db
    }))
    .mutation(async function* ({ input, ctx }) {
      try {
        const memos = new Memos();
        const dbPath = await memos.initDB(input.filePath);
        for await (const result of memos.importMemosDB(ctx)) {
          yield result;
        }
        for await (const result of memos.importFiles(ctx)) {
          yield result;
        }
        await memos.closeDB();
        try {
          await FileService.deleteFile(input.filePath)
        } catch (error) {
        }
      } catch (error) {
        throw new Error(error)
      }
    }),

  importFromMarkdown: authProcedure.use(demoAuthMiddleware)
    .input(z.object({
      filePath: z.string() // Path to .md file or .zip containing md files
    }))
    .mutation(async function* ({ input, ctx }) {
      try {
        const fileResult = await FileService.getFile(input.filePath);
        const markdownImporter = new MarkdownImporter();

        for await (const result of markdownImporter.importMarkdown(fileResult.path, ctx)) {
          yield result;
        }

        // Clean up the file after import
        try {
          if (fileResult.isTemporary && fileResult.cleanup) {
            await fileResult.cleanup()
          } else {
            await unlink(fileResult.path)
          }
          await FileService.deleteFile(input.filePath);
        } catch (error) {
          console.error("Failed to clean up files after markdown import:", error);
        }
      } catch (error) {
        console.error("Error in importFromMarkdown:", error);
        throw new Error(error);
      }
    }),

  exportMarkdown: authProcedure
    .input(z.object({
      format: z.enum(['markdown', 'csv', 'json']),
      baseURL: z.string(),
      startDate: z.date().optional(),
      endDate: z.date().optional(),
    })).output(z.object({
      success: z.boolean(),
      downloadUrl: z.string().optional(),
      fileCount: z.number().optional(),
      error: z.string().optional()
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await DBUtils.ExporMDFiles({ ...input, ctx });
      setTimeout(async () => {
        try {
          const zipPath = path.join(UPLOAD_FILE_PATH, result.path);
          if (fs.existsSync(zipPath)) {
            await unlink(zipPath);
          }
        } catch (error) {
          console.warn('Failed to cleanup export zip file:', error);
        }
      }, 5 * 60 * 1000);
      return {
        success: true,
        downloadUrl: `/api/file${result.path}`,
        fileCount: result.fileCount
      };
    }),
})
