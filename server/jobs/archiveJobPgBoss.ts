import { BasePgBossJob } from './basePgBossJob';
import { ARCHIVE_BLINKO_TASK_NAME } from '@shared/lib/sharedConstant';
import { prisma } from '../prisma';
import { adminCaller } from '../routerTrpc/_app';
import { NoteType } from '../../shared/lib/types';

export class ArchiveJobPgBoss extends BasePgBossJob {
  protected static taskName = ARCHIVE_BLINKO_TASK_NAME;
  protected static defaultSchedule = '0 0 * * *';

  // Removed automatic initialization - will be called manually from server startup

  protected static async RunTask() {
    try {
      const config = await adminCaller.config.list();
      const autoArchivedDays = config.autoArchivedDays ?? 30;
      
      const cutoffDate = new Date(Date.now() - autoArchivedDays * 24 * 60 * 60 * 1000);

      const notes = await prisma.notes.findMany({
        where: {
          type: NoteType.BLINKO,
          createdAt: { lt: cutoffDate },
          isArchived: false,
        },
      });

      if (notes.length === 0) {
        return { archivedCount: 0, message: 'No notes to archive' };
      }

      const result = await prisma.notes.updateMany({
        where: { id: { in: notes.map(n => n.id) } },
        data: { isArchived: true }
      });

      return {
        archivedCount: result.count,
        autoArchivedDays,
        cutoffDate: cutoffDate.toISOString(),
      };
    } catch (error: any) {
      throw new Error(error?.message ?? 'Archive failed');
    }
  }
}

