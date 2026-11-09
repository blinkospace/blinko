import { beforeEach, describe, expect, mock, test } from 'bun:test';

type NoteOrderDirection = 'asc' | 'desc';
type TestNote = {
  id: number;
  isTop: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

const notes: TestNote[] = [
  {
    id: 10,
    isTop: true,
    sortOrder: 100,
    createdAt: new Date('2022-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
  },
  {
    id: 11,
    isTop: true,
    sortOrder: 0,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2023-01-01T00:00:00.000Z'),
  },
  {
    id: 20,
    isTop: false,
    sortOrder: 50,
    createdAt: new Date('2025-02-01T00:00:00.000Z'),
    updatedAt: new Date('2022-02-01T00:00:00.000Z'),
  },
  {
    id: 21,
    isTop: false,
    sortOrder: 0,
    createdAt: new Date('2022-02-01T00:00:00.000Z'),
    updatedAt: new Date('2025-02-01T00:00:00.000Z'),
  },
  {
    id: 22,
    isTop: false,
    sortOrder: 7,
    createdAt: new Date('2024-06-01T00:00:00.000Z'),
    updatedAt: new Date('2024-06-01T00:00:00.000Z'),
  },
  {
    id: 23,
    isTop: false,
    sortOrder: 1,
    createdAt: new Date('2024-06-01T00:00:00.000Z'),
    updatedAt: new Date('2024-06-01T00:00:00.000Z'),
  },
  {
    id: 24,
    isTop: false,
    sortOrder: 1,
    createdAt: new Date('2024-06-01T00:00:00.000Z'),
    updatedAt: new Date('2024-06-01T00:00:00.000Z'),
  },
];

const compareValues = (left: unknown, right: unknown): number => {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right);
  }
  if (left === right) {
    return 0;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  const leftString = String(left);
  const rightString = String(right);
  return leftString < rightString ? -1 : 1;
};

const notesFindMany = mock((args: any) => {
  const orderedNotes = [...notes].sort((left, right) => {
    for (const criterion of args.orderBy) {
      const [field, direction] = Object.entries(criterion)[0] as [keyof TestNote, NoteOrderDirection];
      const result = compareValues(left[field], right[field]);
      if (result !== 0) {
        return direction === 'asc' ? result : -result;
      }
    }
    return 0;
  });

  return Promise.resolve(
    orderedNotes.slice(args.skip, args.skip + args.take).map((note) => ({
      ...note,
      internalShares: [],
    })),
  );
});

const getGlobalConfig = mock(() => Promise.resolve({ isOrderByCreateTime: true }));

mock.module('../../../prisma', () => ({
  prisma: {
    notes: { findMany: notesFindMany },
    tagsToNote: { findMany: mock(() => Promise.resolve([])) },
  },
}));
mock.module('@prisma/client', () => ({ Prisma: {} }));
mock.module('../../../routerTrpc/config', () => ({ getGlobalConfig }));
mock.module('../../../lib/files', () => ({ FileService: {} }));
mock.module('@server/aiServer', () => ({ AiService: {} }));
mock.module('@server/aiServer/aiModelFactory', () => ({ AiModelFactory: {} }));
mock.module('@server/lib/helper', () => ({ SendWebhook: mock(() => Promise.resolve()) }));
mock.module('@shared/lib/cache', () => ({
  cache: { wrap: async (_key: string, callback: () => Promise<unknown>) => callback() },
}));

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

const middleware = {
  router: (procedures: any) => procedures,
  authProcedure: createProcedureBuilder(),
  publicProcedure: createProcedureBuilder(),
  demoAuthMiddleware: {},
};
mock.module('@server/middleware', () => middleware);
mock.module('../../../middleware', () => middleware);

const { buildNoteOrderBy, noteRouter } = await import('../../../routerTrpc/note');
const listResolver = (input: any) =>
  (noteRouter as any).list._resolver({ input, ctx: { id: '42' } });

const listNotes = (options: {
  page?: number;
  size?: number;
  orderBy?: NoteOrderDirection;
} = {}) => listResolver({
  tagId: null,
  page: options.page ?? 1,
  size: options.size ?? notes.length,
  orderBy: options.orderBy ?? 'desc',
  type: -1,
  isArchived: false,
  isRecycle: false,
  searchText: '',
  withoutTag: false,
  withFile: false,
  withLink: false,
  isUseAiQuery: false,
  startDate: null,
  endDate: null,
  isShare: null,
  hasTodo: false,
});

const ids = (result: Array<{ id: number }>) => result.map((note) => note.id);

describe('notes.list ordering — issue #1000', () => {
  beforeEach(() => {
    notesFindMany.mockClear();
    getGlobalConfig.mockResolvedValue({ isOrderByCreateTime: true });
  });

  test('orders by createdAt before legacy sortOrder and keeps page boundaries deterministic', async () => {
    const firstPage = await listNotes({ page: 1, size: 3, orderBy: 'desc' });
    const secondPage = await listNotes({ page: 2, size: 3, orderBy: 'desc' });

    expect(ids(firstPage)).toEqual([11, 10, 20]);
    expect(ids(secondPage)).toEqual([23, 24, 22]);
    expect(notesFindMany.mock.calls[0][0].orderBy).toEqual([
      { isTop: 'desc' },
      { createdAt: 'desc' },
      { sortOrder: 'asc' },
      { id: 'asc' },
    ]);
    expect(notesFindMany.mock.calls[1][0].skip).toBe(3);
    expect(notesFindMany.mock.calls[1][0].take).toBe(3);
  });

  test('orders by updatedAt in ascending mode and uses sortOrder and id only for ties', async () => {
    getGlobalConfig.mockResolvedValue({ isOrderByCreateTime: false });

    const result = await listNotes({ orderBy: 'asc' });

    expect(ids(result)).toEqual([11, 10, 20, 23, 24, 22, 21]);
    expect(notesFindMany.mock.calls[0][0].orderBy).toEqual([
      { isTop: 'desc' },
      { updatedAt: 'asc' },
      { sortOrder: 'asc' },
      { id: 'asc' },
    ]);
  });

  test('supports the opposite direction for both configured timestamp fields', async () => {
    getGlobalConfig.mockResolvedValue({ isOrderByCreateTime: false });
    expect(ids(await listNotes({ orderBy: 'desc' }))).toEqual([10, 11, 21, 23, 24, 22, 20]);

    getGlobalConfig.mockResolvedValue({ isOrderByCreateTime: true });
    expect(ids(await listNotes({ orderBy: 'asc' }))).toEqual([10, 11, 21, 23, 24, 22, 20]);
  });

  test('builds the pinned-first order independently of the selected direction', () => {
    expect(buildNoteOrderBy({ isOrderByCreateTime: true, orderBy: 'asc' })).toEqual([
      { isTop: 'desc' },
      { createdAt: 'asc' },
      { sortOrder: 'asc' },
      { id: 'asc' },
    ]);
    expect(buildNoteOrderBy({ isOrderByCreateTime: false, orderBy: 'desc' })).toEqual([
      { isTop: 'desc' },
      { updatedAt: 'desc' },
      { sortOrder: 'asc' },
      { id: 'asc' },
    ]);
  });
});
