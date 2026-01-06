import path from 'path';
import fs from 'fs';
import { writeFile } from 'fs/promises';
import Package from '../../package.json';
import AdmZip from 'adm-zip';
import { DBBAKUP_PATH, ROOT_PATH, TEMP_PATH, UPLOAD_FILE_PATH } from "@shared/lib/pathConstant";
import { DBBAK_TASK_NAME } from "@shared/lib/sharedConstant";
import { prisma } from "../prisma";
import { unlink } from "fs/promises";
import { createCaller } from "../routerTrpc/_app";
import { Context } from "../context";
import { BaseScheduleJob } from "./baseScheduleJob";
import { CreateNotification } from "../routerTrpc/notification";
import { NotificationType } from "@shared/lib/prismaZodType";
import archiver from 'archiver';
import { createWriteStream } from 'fs';
import yauzl from 'yauzl-promise';
import { FileService } from "../lib/files";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getGlobalConfig } from "../routerTrpc/config";
import { resetSequences } from '@server/lib/helper';
import { RestoreResult } from '@shared/lib/types';

export type ExportTimeRange = 'day' | 'week' | 'month' | 'quarter';

const BACKUP_PROGRESS_CACHE_KEY = "backup-database-progress";

export class DBJob extends BaseScheduleJob {
  protected static taskName = DBBAK_TASK_NAME;
  protected static cronSchedule = '0 0 * * *'; // Daily at midnight

  /**
   * Save backup progress to cache
   */
  private static async saveProgressToCache(progress: any): Promise<void> {
    await prisma.cache.upsert({
      where: { key: BACKUP_PROGRESS_CACHE_KEY },
      update: { value: progress },
      create: { key: BACKUP_PROGRESS_CACHE_KEY, value: progress }
    });
  }

  protected static async RunTask() {
    try {
      const config = await getGlobalConfig({ useAdmin: true });
      const notes = await prisma.notes.findMany({
        select: {
          id: true,
          account: true,
          content: true,
          isArchived: true,
          isShare: true,
          isTop: true,
          createdAt: true,
          updatedAt: true,
          type: true,
          attachments: true,
          tags: true,
          references: true,
          referencedBy: true
        }
      });
      const exportData = {
        notes,
        exportTime: new Date(),
        version: Package.version
      };

      fs.writeFileSync(
        `${DBBAKUP_PATH}/bak.json`,
        JSON.stringify(exportData, null, 2)
      );

      const targetFile = UPLOAD_FILE_PATH + `/blinko_export.bko`;
      
      // Try to remove existing file with retry for Windows file locking issues
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await unlink(targetFile);
          break;
        } catch (error: any) {
          if (error.code === 'ENOENT') {
            break; // File doesn't exist, that's fine
          }
          if (attempt < 2) {
            console.log(`[${this.taskName}] File locked, retrying in 1s... (attempt ${attempt + 1})`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }

      const output = createWriteStream(targetFile);
      const archive = archiver('zip', {
        zlib: { level: 9 }
      });

      archive.on('error', (err) => {
        throw err;
      });

      const archiveComplete = new Promise((resolve, reject) => {
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
      });

      archive.pipe(output);

      const addFilesRecursively = async (dirPath: string, basePath: string = '') => {
        const files = fs.readdirSync(dirPath);

        for (const file of files) {
          const fullPath = path.join(dirPath, file);
          const stat = fs.statSync(fullPath);

          if (stat.isDirectory()) {
            await addFilesRecursively(fullPath, path.join(basePath, file));
          } else {
            archive.file(fullPath, {
              name: path.join(basePath, file)
            });
          }
        }
      };

      await addFilesRecursively(ROOT_PATH, '');

      let lastUpdateTime = 0;
      const updateInterval = 1000;
      let finalProgress: any = null;

      archive.on('progress', async (progress) => {
        finalProgress = {
          processed: progress.entries.processed,
          total: progress.entries.total,
          processedBytes: progress.fs.processedBytes,
          percent: Math.floor((progress.entries.processed / progress.entries.total) * 100)
        };

        const now = Date.now();
        if (now - lastUpdateTime >= updateInterval) {
          lastUpdateTime = now;
          await this.saveProgressToCache({ progress: finalProgress });
        }
      });

      archive.finalize();
      await archiveComplete;

      await CreateNotification({
        type: NotificationType.SYSTEM,
        title: 'system-notification',
        content: 'backup-success',
        useAdmin: true,
      });

      let result;
      if (config.objectStorage === 's3') {
        const { s3ClientInstance } = await FileService.getS3Client();
        const fileStream = fs.createReadStream(targetFile);
        await s3ClientInstance.send(new PutObjectCommand({
          Bucket: config.s3Bucket,
          Key: `/BLINKO_BACKUP/blinko_export.bko`,
          Body: fileStream
        }));
        result = {
          filePath: `/api/s3file/BLINKO_BACKUP/blinko_export.bko`,
          progress: finalProgress
        };
      } else {
        result = {
          filePath: `/api/file/blinko_export.bko`,
          progress: finalProgress
        };
      }

      // Save final result to cache for frontend display
      await this.saveProgressToCache(result);
      return result;
    } catch (error) {
      throw error;
    }
  }

  static async *RestoreDB(filePath: string, ctx: Context): AsyncGenerator<RestoreResult & { progress: { current: number; total: number } }, void, unknown> {
    try {
      const zipFile = await yauzl.open(filePath);
      let processedBytes = 0;
      let entryCount = 0;
      const totalEntries = await (async () => {
        let count = 0;
        for await (const _ of zipFile) {
          count++;
        }
        await zipFile.close();
        return count;
      })();

      const zipFileForExtract = await yauzl.open(filePath);
      for await (const entry of zipFileForExtract) {
        if (entry.filename.endsWith('/')) {
          await fs.promises.mkdir(path.join(ROOT_PATH, entry.filename), { recursive: true });
          continue;
        }
        const targetPath = path.join(ROOT_PATH, entry.filename);
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        
        try {
          const readStream = await entry.openReadStream();
          const writeStream = fs.createWriteStream(targetPath);
          
          readStream.on('error', (err) => {
            writeStream.destroy(err);
          });
          
          writeStream.on('error', (err) => {
            readStream.destroy();
          });
          
          await new Promise((resolve, reject) => {
            readStream
              .pipe(writeStream)
              .on('finish', () => {
                writeStream.end();
                resolve(null);
              })
              .on('error', (err) => {
                writeStream.destroy();
                readStream.destroy();
                reject(err);
              });
          });
          
          processedBytes += entry.uncompressedSize;
          entryCount++;

          yield {
            type: 'success',
            content: `extract: ${entry.filename}`,
            progress: { current: entryCount, total: totalEntries }
          };
        } catch (error) {
          yield {
            type: 'error',
            content: `Failed to extract: ${entry.filename}`,
            error,
            progress: { current: entryCount, total: totalEntries }
          };
        }
      }

      await zipFileForExtract.close();

      const backupData = JSON.parse(
        fs.readFileSync(`${DBBAKUP_PATH}/bak.json`, 'utf-8')
      );

      const attachmentsCount = backupData.notes.reduce((acc: number, note: any) =>
        acc + (note.attachments?.length || 0), 0);
      const total = backupData.notes.length + attachmentsCount;
      let current = 0;

      const accountMap = new Map();
      for (const note of backupData.notes) {
        if (!note.account?.name) {
          yield {
            type: 'error',
            content: 'Note missing account information',
            error: new Error('Missing account information'),
            progress: { current: 0, total }
          };
          continue;
        }

        if (!accountMap.has(note.account.name)) {
          const account = await prisma.accounts.findFirst({
            where: { name: note.account.name }
          });

          if (!account) {
            const newAccount = await prisma.accounts.create({
              data: {
                name: note.account.name,
                password: note.account.password,
                role: note.account.role
              }
            });
            accountMap.set(note.account.name, newAccount);
          } else {
            accountMap.set(note.account.name, account);
          }
        }
      }

      for (const note of backupData.notes) {
        current++;
        if (!note.account?.name) {
          yield {
            type: 'error',
            content: 'Note missing account information',
            error: new Error('Missing account information'),
            progress: { current, total }
          };
          continue;
        }

        const accountInfo = accountMap.get(note.account.name);
        if (!accountInfo) {
          yield {
            type: 'error',
            content: `Account not found: ${note.account.name}`,
            error: new Error('Account not found'),
            progress: { current, total }
          };
          continue;
        }

        try {
          await prisma.$transaction(async (tx) => {
            let ctx = {
              name: accountInfo.name,
              sub: accountInfo.id,
              role: accountInfo.role,
              id: accountInfo.id,
              exp: 0,
              iat: 0,
            }
            const userCaller = createCaller(ctx);
            const createdNote = await userCaller.notes.upsert({
              content: note.content,
              isArchived: note.isArchived,
              type: note.type,
              isTop: note.isTop,
              isShare: note.isShare,
            });

            if (createdNote.id) {
              const account = accountMap.get(note.account.name);
              await tx.notes.update({
                where: { id: createdNote.id },
                data: {
                  accountId: account.id,
                  createdAt: note.createdAt,
                  updatedAt: note.updatedAt,
                }
              });
              if (note.attachments?.length) {
                const attachmentData = note.attachments.map((attachment: any) => ({
                  ...attachment,
                  noteId: createdNote.id
                }));
                await tx.attachments.createMany({
                  data: attachmentData,
                  skipDuplicates: true
                });
                current += note.attachments.length;
              }
            }
          });

          yield {
            type: 'success',
            content: note.account.name + ' - ' + note.content.slice(0, 30),
            progress: { current, total }
          };

        } catch (error) {
          yield {
            type: 'error',
            content: note.content.slice(0, 30),
            error,
            progress: { current, total }
          };
          continue;
        }
      }
    } catch (error: any) {
      yield {
        type: 'error',
        error,
        content: `extract failed: ${error.message}`,
        progress: { current: 0, total: 0 }
      };
    }

    // Reset sequences after restore
    try {
      await resetSequences();
      yield {
        type: 'success',
        content: 'Sequences reset successfully',
        progress: { current: 0, total: 0 }
      };
    } catch (error: any) {
      yield {
        type: 'error',
        error,
        content: `Failed to reset sequences: ${error.message}`,
        progress: { current: 0, total: 0 }
      };
    }
  }

  static async ExporMDFiles(params: {
    baseURL: string;
    startDate?: Date;
    endDate?: Date;
    ctx: Context;
    format: 'markdown' | 'csv' | 'json';
  }) {
    const { baseURL, startDate, endDate, ctx, format } = params;
    const notes = await prisma.notes.findMany({
      where: {
        createdAt: {
          ...(startDate && { gte: startDate }),
          ...(endDate && { lte: endDate })
        },
        accountId: Number(ctx.id)
      },
      select: {
        id: true,
        content: true,
        attachments: true,
        createdAt: true,
      }
    });
    if (notes.length === 0) {
      throw new Error('No notes found');
    }
    const exportDir = path.join(TEMP_PATH, 'exports');
    const attachmentsDir = path.join(exportDir, 'files');
    const zipFilePath = TEMP_PATH + `/notes_export_${Date.now()}.zip`;

    try {
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }
      if (!fs.existsSync(attachmentsDir)) {
        fs.mkdirSync(attachmentsDir, { recursive: true });
      }

      if (format === 'csv') {
        const csvContent = ['ID,Content,Created At'].concat(
          notes.map(note => `${note.id},"${note.content.replace(/"/g, '""')}",${note.createdAt.toISOString()}`)
        ).join('\n');
        await writeFile(path.join(exportDir, 'notes.csv'), csvContent);
      } else if (format === 'json') {
        await writeFile(
          path.join(exportDir, 'notes.json'),
          JSON.stringify(notes, null, 2)
        );
      } else {
        await Promise.all(notes.map(async (note) => {
          let mdContent = note.content;

          if (note.attachments?.length) {
            await Promise.all(note.attachments.map(async (attachment) => {
              try {
                // Fix: Add authentication token to allow downloading private note attachments
                const tokenParam = ctx.token ? `?token=${ctx.token}` : '';
                const response = await fetch(`${baseURL}${attachment.path}${tokenParam}`);
                const buffer = await response.arrayBuffer();
                const attachmentPath = path.join(attachmentsDir, attachment.name);
                //@ts-ignore
                await writeFile(attachmentPath, Buffer.from(buffer));

                const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(attachment.name);

                if (isImage) {
                  mdContent += `\n![${attachment.name}](./files/${attachment.name})`;
                } else {
                  mdContent += `\n[${attachment.name}](./files/${attachment.name})`;
                }
              } catch (error) {
                console.error(`Failed to download attachment: ${attachment.name}`, error);
              }
            }));
          }

          const fileName = `note-${note.id}-${note.createdAt.getTime()}.md`;
          await writeFile(path.join(exportDir, fileName), mdContent);
        }));
      }

      const zip = new AdmZip();
      zip.addLocalFolder(exportDir);
      zip.writeZip(zipFilePath);

      fs.rmSync(exportDir, { recursive: true, force: true });
      return {
        success: true,
        path: zipFilePath.replace(UPLOAD_FILE_PATH, ''),
        fileCount: notes.length
      };
    } catch (error) {
      try {
        if (fs.existsSync(exportDir)) {
          fs.rmSync(exportDir, { recursive: true, force: true });
        }
        if (fs.existsSync(zipFilePath)) {
          fs.unlinkSync(zipFilePath);
        }
      } catch { }
      throw error;
    }
  }
}
