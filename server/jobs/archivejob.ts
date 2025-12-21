import { ARCHIVE_BLINKO_TASK_NAME } from "@shared/lib/sharedConstant";
import { prisma } from "../prisma";
import { adminCaller } from "../routerTrpc/_app";
import { NoteType } from "../../shared/lib/types";
import { BaseScheduleJob } from "./baseScheduleJob";

export class ArchiveJob extends BaseScheduleJob {
  protected static taskName = ARCHIVE_BLINKO_TASK_NAME;
  protected static cronSchedule = '0 0 * * *'; // Daily at midnight

  protected static async RunTask() {
    try {
      const config = await adminCaller.config.list()
      let autoArchivedDays = config.autoArchivedDays ?? 30
      const notes = await prisma.notes.findMany({
        where: {
          type: NoteType.BLINKO,
          createdAt: {
            lt: new Date(new Date().getTime() - autoArchivedDays * 24 * 60 * 60 * 1000)
          }
        },
      })
      return await prisma.notes.updateMany({ where: { id: { in: notes.map(e => e.id) } }, data: { isArchived: true } })
    } catch (error: any) {
      throw new Error(error)
    }
  }
}
