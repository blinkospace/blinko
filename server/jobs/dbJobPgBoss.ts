import path from 'path';
import fs from 'fs';
import Package from '../../package.json';
import { DBBAKUP_PATH, ROOT_PATH, UPLOAD_FILE_PATH } from '@shared/lib/pathConstant';
import { DBBAK_TASK_NAME } from '@shared/lib/sharedConstant';
import { unlink } from 'fs/promises';
import { BasePgBossJob } from './basePgBossJob';
import { CreateNotification } from '../routerTrpc/notification';
import { NotificationType } from '@shared/lib/prismaZodType';
import archiver from 'archiver';
import { createWriteStream } from 'fs';
import { FileService } from '../lib/files';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getGlobalConfig } from '../routerTrpc/config';
import { prisma } from '../prisma';
import PgBoss from 'pg-boss';

export class DBJobPgBoss extends BasePgBossJob {
  protected static taskName = DBBAK_TASK_NAME;
  protected static defaultSchedule = '0 0 * * *';

  // Removed automatic initialization - will be called manually from server startup

  protected static async RunTask(job?: PgBoss.Job) {
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
      try {
        await unlink(targetFile);
      } catch (error) { }

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

      let finalProgress: any = null;

      archive.on('progress', (progress) => {
        finalProgress = {
          processed: progress.entries.processed,
          total: progress.entries.total,
          processedBytes: progress.fs.processedBytes,
          percent: Math.floor((progress.entries.processed / progress.entries.total) * 100)
        };
        
        if (job) {
          console.log(`[${this.taskName}] Progress: ${finalProgress.percent}%`);
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

      let filePath: string;
      if (config.objectStorage === 's3') {
        const { s3ClientInstance } = await FileService.getS3Client();
        const fileStream = fs.createReadStream(targetFile);
        await s3ClientInstance.send(new PutObjectCommand({
          Bucket: config.s3Bucket,
          Key: `/BLINKO_BACKUP/blinko_export.bko`,
          Body: fileStream
        }));
        filePath = `/api/s3file/BLINKO_BACKUP/blinko_export.bko`;
      } else {
        filePath = `/api/file/blinko_export.bko`;
      }

      return {
        filePath,
        progress: finalProgress,
        notesCount: notes.length,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error(`[${this.taskName}] Backup failed:`, error);
      throw error;
    }
  }
}

