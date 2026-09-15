import { describe, test, expect, mock, beforeEach } from 'bun:test';

/**
 * Regression test for issue #1217 (GHSA-3g4r-r4g4-x9vp).
 *
 * `noteReferenceList` queried `noteReference` by the caller-supplied note id
 * without checking who owns that note, so any authenticated user could read the
 * full content of anyone else's private notes by passing their note ids.
 *
 * The fix authorises the note being asked about, and scopes the referenced
 * notes to the same visibility rule the list and detail queries already use:
 * the caller owns the note, or it was shared with them internally.
 *
 * The heavy modules are mocked so the real resolver in `routerTrpc/note.ts` can
 * be exercised without tRPC, Prisma or the AI stack.
 */

const notesFindFirst = mock((_args: any) => Promise.resolve(null as any));
const noteReferenceFindMany = mock((_args: any) => Promise.resolve([] as any[]));
mock.module('../../../prisma', () => ({
  prisma: {
    notes: { findFirst: notesFindFirst },
    noteReference: { findMany: noteReferenceFindMany },
  },
}));

// note.ts pulls in modules that import PrismaClient at module scope.
mock.module('@prisma/client', () => ({ Prisma: {}, PrismaClient: class {} }));

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
  t: { router: (procedures: any) => procedures, middleware: () => () => {} },
  router: (procedures: any) => procedures,
  mergeRouters: (...routers: any[]) => Object.assign({}, ...routers),
  authProcedure: createProcedureBuilder(),
  publicProcedure: createProcedureBuilder(),
  demoAuthMiddleware: () => {},
  superAdminAuthMiddleware: () => {},
}));

// note.ts reaches _app.ts through these, which would be a circular import here.
mock.module('../../../routerTrpc/config', () => ({ getGlobalConfig: () => Promise.resolve({}) }));
mock.module('../../../aiServer', () => ({ AiService: {} }));
mock.module('../../../aiServer/aiModelFactory', () => ({ AiModelFactory: {} }));
mock.module('../../../lib/files', () => ({ FileService: {} }));
mock.module('../../../lib/helper', () => ({ SendWebhook: () => Promise.resolve() }));

const { noteRouter } = await import('../../../routerTrpc/note');
const referenceListResolver = (input: any, ctx: any) =>
  (noteRouter as any).noteReferenceList._resolver({ input, ctx });

const visibleTo = (accountId: number) => ({
  OR: [{ accountId }, { internalShares: { some: { accountId } } }],
});

describe('note noteReferenceList — issue #1217', () => {
  beforeEach(() => {
    notesFindFirst.mockClear();
    noteReferenceFindMany.mockClear();
  });

  test('refuses a note the caller cannot see, without querying references', async () => {
    notesFindFirst.mockImplementationOnce(() => Promise.resolve(null));

    await expect(referenceListResolver({ noteId: 1234, type: 'references' }, { id: 99 })).rejects.toThrow(
      'Note not found or you do not have access',
    );

    // The leak was reading references before establishing access.
    expect(noteReferenceFindMany).not.toHaveBeenCalled();
  });

  test('authorises the requested note against owner-or-shared visibility', async () => {
    notesFindFirst.mockImplementationOnce(() => Promise.resolve({ id: 7 }));

    await referenceListResolver({ noteId: 7, type: 'references' }, { id: 42 });

    expect(notesFindFirst).toHaveBeenCalledTimes(1);
    expect(notesFindFirst.mock.calls[0][0].where).toEqual({ id: 7, ...visibleTo(42) });
  });

  test('scopes referenced notes so a shared note cannot expose private ones', async () => {
    notesFindFirst.mockImplementationOnce(() => Promise.resolve({ id: 7 }));

    await referenceListResolver({ noteId: 7, type: 'references' }, { id: 42 });

    expect(noteReferenceFindMany.mock.calls[0][0].where).toEqual({
      fromNoteId: 7,
      toNote: visibleTo(42),
    });
  });

  test('scopes referencing notes for the referencedBy direction too', async () => {
    notesFindFirst.mockImplementationOnce(() => Promise.resolve({ id: 7 }));

    await referenceListResolver({ noteId: 7, type: 'referencedBy' }, { id: 42 });

    expect(noteReferenceFindMany.mock.calls[0][0].where).toEqual({
      toNoteId: 7,
      fromNote: visibleTo(42),
    });
  });
});
