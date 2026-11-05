import { TRPCError } from '@trpc/server';
import type { Prisma } from '@prisma/client';

type AttachmentClient = Pick<Prisma.TransactionClient, 'attachments'>;
const bindingSelect = {
  id: true, path: true, name: true, size: true, type: true,
  accountId: true, noteId: true, note: { select: { accountId: true } },
} as const;
export type PreparedAttachment = Prisma.attachmentsGetPayload<{ select: typeof bindingSelect }>;

const forbiddenAttachment = () => new TRPCError({
  code: 'FORBIDDEN',
  message: 'Attachment not found or you do not have permission to attach it',
});

// A shared editor can retain the target note's files and add their own uploads.
// Access to a different shared/public note never permits moving its attachments.
export async function prepareAttachmentBindings(
  db: AttachmentClient,
  paths: string[],
  accountId: number,
  targetNoteId?: number,
  markdownPaths: string[] = [],
): Promise<PreparedAttachment[]> {
  // Query/fragment parameters change rendering or access, never file ownership.
  const discoveredPaths = markdownPaths.map(path => path.split(/[?#]/, 1)[0]);
  const uniquePaths = [...new Set([...paths, ...discoveredPaths])];
  if (!uniquePaths.length) return [];
  const files = await db.attachments.findMany({
    where: { path: { in: uniquePaths } },
    select: bindingSelect,
  });
  const foundPaths = new Set(files.map(file => file.path));
  // Stale Markdown URLs remain valid note text; explicit attachments must exist.
  if (paths.some(path => !foundPaths.has(path)) || files.some(file => !(
    file.accountId === accountId ||
    (file.accountId === null && file.note?.accountId === accountId) ||
    (targetNoteId !== undefined && file.noteId === targetNoteId)
  ))) throw forbiddenAttachment();
  return files;
}

// Run with the note write in the same transaction. Match the original binding
// as well as live ownership so a stale preflight cannot steal a moved file.
export async function bindPreparedAttachments(
  db: AttachmentClient,
  files: PreparedAttachment[],
  accountId: number,
  noteId: number,
  targetNoteId?: number,
) {
  for (const file of files) {
    const where: Prisma.attachmentsWhereInput = {
      id: file.id,
      path: file.path,
      accountId: file.accountId,
      noteId: file.noteId,
      OR: [
        { accountId },
        { accountId: null, note: { accountId } },
        ...(targetNoteId === undefined ? [] : [{ noteId: targetNoteId }]),
      ],
    };
    if (file.noteId === noteId) {
      // Retaining an attachment should not rewrite legacy data or timestamps.
      if (!await db.attachments.findFirst({ where, select: { id: true } })) throw forbiddenAttachment();
      continue;
    }
    const result = await db.attachments.updateMany({ where, data: { noteId } });
    if (result.count !== 1) throw forbiddenAttachment();
  }
}
