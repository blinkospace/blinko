import { describe, test, expect, mock, beforeEach } from 'bun:test';

/**
 * Regression test for issue #1192.
 *
 * The `deleteMany` attachments endpoint used to call `prisma.attachments.deleteMany()`
 * directly, which removed the DB records but left the underlying files orphaned on
 * disk / S3. The fix routes every deletion through `FileService.deleteFile()` (which
 * removes both the file AND the DB record), mirroring the single `delete` endpoint.
 *
 * The heavy modules (`../middleware`, `../prisma`, `@prisma/client`, `../lib/files`)
 * are mocked so we can exercise the real resolver in `routerTrpc/attachment.ts`
 * without standing up tRPC, Prisma or any storage backend.
 */

// --- mock the storage layer: this is what the fix must invoke -------------------
const deleteFile = mock((_path: string) => Promise.resolve());
mock.module('../../../lib/files', () => ({
  FileService: { deleteFile },
}));

// --- mock prisma: findMany returns the owned attachments, deleteMany must NOT be used
const findMany = mock((_args: any) => Promise.resolve([] as any[]));
const deleteMany = mock((_args: any) => Promise.resolve({ count: 0 }));
mock.module('../../../prisma', () => ({
  prisma: { attachments: { findMany, deleteMany } },
}));

// `@prisma/client` is imported at module scope only for the `Prisma` namespace.
mock.module('@prisma/client', () => ({ Prisma: {} }));

// --- mock the tRPC middleware so we can grab each procedure's raw resolver -------
function createProcedureBuilder(): any {
  const builder: any = {};
  const self = () => builder;
  builder.input = self;
  builder.output = self;
  builder.use = self;
  builder.meta = self;
  builder.mutation = (resolver: any) => ({ _resolver: resolver });
  builder.query = (resolver: any) => ({ _resolver: resolver });
  return builder;
}
mock.module('../../../middleware', () => ({
  router: (procedures: any) => procedures,
  authProcedure: createProcedureBuilder(),
  publicProcedure: createProcedureBuilder(),
}));

const { attachmentsRouter } = await import('../../../routerTrpc/attachment');
const deleteManyResolver = (input: any, ctx: any) =>
  (attachmentsRouter as any).deleteMany._resolver({ input, ctx });

describe('attachments deleteMany — issue #1192', () => {
  beforeEach(() => {
    deleteFile.mockClear();
    findMany.mockClear();
    deleteMany.mockClear();
  });

  test('deletes the actual file for every attachment (not just DB records)', async () => {
    const attachments = [
      { id: 1, path: '/api/file/a/one.jpg' },
      { id: 2, path: '/api/file/b/two.png' },
      { id: 3, path: '/api/s3file/c/three.pdf' },
    ];
    findMany.mockImplementationOnce(() => Promise.resolve(attachments));

    const result = await deleteManyResolver({ ids: [1, 2, 3] }, { id: 42 });

    // Every file must be removed from storage via FileService.deleteFile
    expect(deleteFile).toHaveBeenCalledTimes(3);
    const deletedPaths = deleteFile.mock.calls.map((c) => c[0]);
    expect(deletedPaths).toEqual([
      '/api/file/a/one.jpg',
      '/api/file/b/two.png',
      '/api/s3file/c/three.pdf',
    ]);

    // The old, buggy DB-only deletion path must NOT be used.
    expect(deleteMany).not.toHaveBeenCalled();

    expect(result).toEqual({ success: true, message: 'Files deleted successfully' });
  });

  test('only fetches attachments owned by the requesting account', async () => {
    findMany.mockImplementationOnce(() => Promise.resolve([]));

    await deleteManyResolver({ ids: [7, 8] }, { id: 99 });

    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ in: [7, 8] });
    // Ownership scoping is preserved: either the note's account or the attachment's account.
    expect(where.OR).toEqual([
      { note: { accountId: 99 } },
      { accountId: 99 },
    ]);
  });

  test('continues deleting remaining files if one deletion fails', async () => {
    findMany.mockImplementationOnce(() =>
      Promise.resolve([
        { id: 1, path: '/api/file/a/one.jpg' },
        { id: 2, path: '/api/file/b/two.png' },
      ]),
    );
    deleteFile.mockImplementationOnce(() => Promise.reject(new Error('disk error')));

    const result = await deleteManyResolver({ ids: [1, 2] }, { id: 1 });

    // Both files are attempted even though the first throws.
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ success: true, message: 'Files deleted successfully' });
  });
});
