import { beforeEach, expect, mock, test } from 'bun:test';

let notes: any[];
let files: any[];
let history: any[];
let writes: number;
let beforeTransaction: (() => void) | undefined;
const shares = [{ noteId: 30, accountId: 1, canEdit: true }];
const enrich = (file: any) => ({ ...file, note: notes.find(note => note.id === file.noteId) ?? null });
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'OR') return value.some((item: any) => matches(row, item));
    if (key === 'note') return !!row.note && matches(row.note, value);
    if (key === 'internalShares') return shares.some(share => share.noteId === row.id && matches(share, value.some));
    if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key]);
    return row[key] === value;
  });
}
const db: any = {
  notes: {
    findFirst: async ({ where }: any) => notes.find(note => matches(note, where)) ?? null,
    findUnique: async ({ where }: any) => notes.find(note => matches(note, where)) ?? null,
    create: async ({ data }: any) => {
      writes++;
      const note = { ...data, id: 100 + notes.length, createdAt: new Date(), updatedAt: new Date() };
      notes.push(note);
      return note;
    },
    update: async ({ where, data }: any) => {
      const note = notes.find(note => matches(note, where));
      if (!note) throw new Error('Note permission changed');
      writes++;
      Object.assign(note, data);
      return note;
    },
  },
  attachments: {
    findMany: async ({ where }: any) => files.map(enrich).filter(file => matches(file, where)),
    findFirst: async ({ where }: any) => files.map(enrich).find(file => matches(file, where)) ?? null,
    updateMany: async ({ where, data }: any) => {
      const selected = files.filter(file => matches(enrich(file), where));
      for (const file of selected) { writes++; Object.assign(file, data); }
      return { count: selected.length };
    },
  },
  noteHistory: {
    findFirst: async () => history.at(-1) ?? null,
    create: async ({ data }: any) => { writes++; history.push(data); return data; },
  },
  tagsToNote: { findMany: async () => [] },
  tag: { deleteMany: async () => ({ count: 0 }) },
  noteReference: { findMany: async () => [] },
  $transaction: async (fn: any) => {
    beforeTransaction?.();
    beforeTransaction = undefined;
    const before = structuredClone({ notes, files, history });
    try { return await fn(db); }
    catch (error) { ({ notes, files, history } = before); throw error; }
  },
};
mock.module('../../prisma', () => ({ prisma: db }));
mock.module('../../routerTrpc/config', () => ({ getGlobalConfig: async () => ({}) }));
mock.module('../../lib/files', () => ({ FileService: {} }));
mock.module('../../lib/helper', () => ({ SendWebhook: () => {} }));
mock.module('../../aiServer', () => ({ AiService: {} }));
mock.module('../../aiServer/aiModelFactory', () => ({ AiModelFactory: {} }));
const { noteRouter } = await import('../../routerTrpc/note');
const caller = () => noteRouter.createCaller({ id: '1', sub: '1', name: 'owner', role: 'user' } as any);
const inputFile = (path: string) => ({ path, name: 'image.png', size: 1, type: 'image/png' });
const state = () => JSON.stringify({ notes, files, history });

beforeEach(() => {
  notes = [
    { id: 10, accountId: 1, content: 'own note' },
    { id: 20, accountId: 2, content: 'victim note' },
    { id: 30, accountId: 3, content: 'shared target' },
  ];
  files = [
    { id: 1, accountId: 1, noteId: null, path: '/api/file/upload.png', name: 'upload.png', size: 1, type: 'image/png' },
    { id: 2, accountId: 2, noteId: 20, path: '/api/file/victim.png', name: 'victim.png', size: 1, type: 'image/png' },
    { id: 3, accountId: null, noteId: 10, path: '/api/file/legacy.png', name: 'legacy.png', size: 1, type: 'image/png' },
    { id: 4, accountId: 3, noteId: 30, path: '/api/s3file/shared.png', name: 'shared.png', size: 1, type: 'image/png' },
    { id: 5, accountId: null, noteId: null, path: '/api/file/orphan.png', name: 'orphan.png', size: 1, type: 'image/png' },
  ];
  history = [];
  writes = 0;
  beforeTransaction = undefined;
});

test.each([undefined, 10])('foreign explicit attachment is rejected before any writes (target %s)', async id => {
  const before = state();
  await expect(caller().upsert({ id, content: 'changed #tag', type: 0, attachments: [inputFile('/api/file/victim.png')] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(state()).toBe(before);
  expect(writes).toBe(0);
});

test.each([undefined, 10])('foreign Markdown attachment is rejected before any writes (target %s)', async id => {
  const before = state();
  await expect(caller().upsert({ id, type: 0, content: '![victim](/api/file/victim.png) #tag' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(state()).toBe(before);
  expect(writes).toBe(0);
});

test.each(['/api/file/missing.png', '/api/file/orphan.png'])('missing/unowned old upload %s cannot be claimed', async path => {
  const before = state();
  await expect(caller().upsert({ content: 'new note', type: 0, attachments: [inputFile(path)] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(state()).toBe(before);
  expect(writes).toBe(0);
});

test('owner can create with own upload and update with a legacy null-account attachment', async () => {
  const created = await caller().upsert({ content: 'new note', type: 0, attachments: [inputFile('/api/file/upload.png')] });
  expect(files[0].noteId).toBe(created.id);
  await caller().upsert({ id: 10, content: 'legacy retained', attachments: [inputFile('/api/file/legacy.png')] });
  expect(files[2].noteId).toBe(10);
  expect(files[2].accountId).toBeNull();
  expect(history).toHaveLength(1);
});

test('owner can bind a legacy null-account attachment through its original note ownership', async () => {
  const created = await caller().upsert({ content: 'move my legacy attachment', type: 0, attachments: [inputFile('/api/file/legacy.png')] });
  expect(files[2].noteId).toBe(created.id);
  expect(files[2].accountId).toBeNull();
});

test('Markdown discovery canonicalizes render parameters and preserves stale URL text', async () => {
  await caller().upsert({ id: 10, content: '![own](/api/file/legacy.png?thumbnail=true#x) ![stale](/api/file/deleted.png)' });
  expect(files[2].noteId).toBe(10);
  expect(notes[0].content).toContain('/api/file/deleted.png');
  expect(history).toHaveLength(1);
});

test('Markdown render parameters cannot hide a foreign registered attachment', async () => {
  const before = state();
  await expect(caller().upsert({ content: '![victim](/api/file/victim.png?thumbnail=true#x)', type: 0 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(state()).toBe(before);
  expect(writes).toBe(0);
});

test('shared editor can retain target files and attach own upload, but cannot move target files elsewhere', async () => {
  await caller().upsert({ id: 30, content: '![shared](/api/s3file/shared.png)', attachments: [inputFile('/api/file/upload.png')] });
  expect(files[0].noteId).toBe(30);
  expect(files[3].noteId).toBe(30);
  const before = state();
  await expect(caller().upsert({ id: 10, content: 'steal shared', attachments: [inputFile('/api/s3file/shared.png')] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(state()).toBe(before);
});

test.each([undefined, 10])('concurrent attachment ownership/binding change rolls back note and history (target %s)', async id => {
  beforeTransaction = () => { files[0].accountId = 2; files[0].noteId = 20; };
  const originalNotes = JSON.stringify(notes);
  await expect(caller().upsert({ id, content: 'changed', type: 0, attachments: [inputFile('/api/file/upload.png')] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(JSON.stringify(notes)).toBe(originalNotes);
  expect(history).toHaveLength(0);
  expect(files[0].noteId).toBe(20);
  expect(files[0].accountId).toBe(2);
});

test('concurrent movement of a still-owned upload fails the original binding check', async () => {
  beforeTransaction = () => { files[0].noteId = 10; };
  const originalNotes = JSON.stringify(notes);
  await expect(caller().upsert({ content: 'new note', type: 0, attachments: [inputFile('/api/file/upload.png')] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(JSON.stringify(notes)).toBe(originalNotes);
  expect(files[0].noteId).toBe(10);
  expect(files[0].accountId).toBe(1);
});
