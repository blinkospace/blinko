import { afterAll, beforeAll, expect, test } from "bun:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { createQueryNoteSource } from "../../services/pluginServices/VectorQueryHost";

if (process.env.PLUGIN_SERVICES_TEST_DB !== "1" || !process.env.DATABASE_URL)
  throw new Error("An isolated PostgreSQL database is required");
const database = new URL(process.env.DATABASE_URL);
if (database.hostname !== "127.0.0.1" || database.username !== "blinko_test")
  throw new Error("Wrong synthetic database");
const prisma = new PrismaClient();
const source = createQueryNoteSource(prisma);
const date = new Date("2026-01-01T00:00:00.000Z");
let owner = 0, foreign = 0, noteId = 0, foreignNoteId = 0, tagId = 0;
const stamp = () => source.stamp(owner);

beforeAll(async () => {
  owner = (await prisma.accounts.create({ data: { name: "synthetic-corpus-fence-owner" } })).id;
  foreign = (await prisma.accounts.create({ data: { name: "synthetic-corpus-fence-foreign" } })).id;
  noteId = (await prisma.notes.create({ data: { accountId: owner, content: "Alpha synthetic body", createdAt: date, updatedAt: date } })).id;
  foreignNoteId = (await prisma.notes.create({ data: { accountId: foreign, content: "Foreign synthetic body", createdAt: date, updatedAt: date } })).id;
  tagId = (await prisma.tag.create({ data: { accountId: owner, name: "synthetic-fence-tag" } })).id;
});
afterAll(async () => {
  await prisma.tagsToNote.deleteMany({ where: { noteId: { in: [noteId, foreignNoteId] } } });
  await prisma.tag.deleteMany({ where: { id: tagId } });
  await prisma.notes.deleteMany({ where: { id: { in: [noteId, foreignNoteId] } } });
  await prisma.accounts.deleteMany({ where: { id: { in: [owner, foreign] } } });
  await prisma.$disconnect();
});

test("tuple fence stays stable without writes and is scoped to the owner", async () => {
  const before = await stamp();
  expect(await stamp()).toBe(before);
  await prisma.$executeRaw`UPDATE notes SET content='Changed foreign body' WHERE id=${foreignNoteId}::int`;
  expect(await stamp()).toBe(before);
  expect(await source.stamp(foreign)).not.toBe(before);
});

test("a body edit with an unchanged updatedAt still invalidates the corpus fence", async () => {
  const before = await stamp();
  await prisma.$executeRaw`UPDATE notes SET content='Edited body with fixed timestamp' WHERE id=${noteId}::int`;
  expect((await prisma.notes.findUniqueOrThrow({ where: { id: noteId } })).updatedAt).toEqual(date);
  expect(await stamp()).not.toBe(before);
});

test("ctid catches repeated updates in the same transaction even with identical content and timestamps", async () => {
  await prisma.$transaction(async (tx) => {
    const within = createQueryNoteSource(tx as unknown as PrismaClient);
    const token = async () => (await tx.$queryRaw<Array<{ xmin: string; ctid: string }>>`SELECT xmin::text,ctid::text FROM notes WHERE id=${noteId}::int`)[0];
    await tx.$executeRaw`UPDATE notes SET content='Same transaction content' WHERE id=${noteId}::int`;
    const first = await token(), firstStamp = await within.stamp(owner);
    await tx.$executeRaw`UPDATE notes SET content='Same transaction content' WHERE id=${noteId}::int`;
    const second = await token(), secondStamp = await within.stamp(owner);
    expect(second.xmin).toBe(first.xmin);
    expect(second.ctid).not.toBe(first.ctid);
    expect(secondStamp).not.toBe(firstStamp);
    expect((await tx.notes.findUniqueOrThrow({ where: { id: noteId } })).updatedAt).toEqual(date);
  });
});

test("archive, recycle, type and ownership changes remain fenced without timestamp updates", async () => {
  for (const sql of [
    () => prisma.$executeRaw`UPDATE notes SET "isArchived"=NOT "isArchived" WHERE id=${noteId}::int`,
    () => prisma.$executeRaw`UPDATE notes SET "isRecycle"=NOT "isRecycle" WHERE id=${noteId}::int`,
    () => prisma.$executeRaw`UPDATE notes SET type=1 WHERE id=${noteId}::int`,
    () => prisma.$executeRaw`UPDATE notes SET "accountId"=${foreign}::int WHERE id=${noteId}::int`,
  ]) {
    const before = await stamp(); await sql(); expect(await stamp()).not.toBe(before);
  }
  await prisma.$executeRaw`UPDATE notes SET "accountId"=${owner}::int,"isRecycle"=false,"isArchived"=false,type=0 WHERE id=${noteId}::int`;
  expect((await prisma.notes.findUniqueOrThrow({ where: { id: noteId } })).updatedAt).toEqual(date);
});

test("tag attach, detach and same-ID replacement are fenced independently of note timestamps", async () => {
  const before = await stamp();
  await prisma.tagsToNote.create({ data: { noteId, tagId } });
  const attached = await stamp(); expect(attached).not.toBe(before);
  await prisma.$transaction(async (tx) => {
    const within = createQueryNoteSource(tx as unknown as PrismaClient);
    const first = await within.stamp(owner);
    await tx.tagsToNote.delete({ where: { noteId_tagId: { noteId, tagId } } });
    await tx.tagsToNote.create({ data: { noteId, tagId } });
    expect(await within.stamp(owner)).not.toBe(first);
  });
  const replaced = await stamp();
  await prisma.tagsToNote.delete({ where: { noteId_tagId: { noteId, tagId } } });
  expect(await stamp()).not.toBe(replaced);
  expect((await prisma.notes.findUniqueOrThrow({ where: { id: noteId } })).updatedAt).toEqual(date);
});

test("deletion and same-ID reinsertion with identical business fields change the fence", async () => {
  const note = await prisma.notes.findUniqueOrThrow({ where: { id: noteId } });
  const before = await stamp();
  await prisma.notes.delete({ where: { id: noteId } }); expect(await stamp()).not.toBe(before);
  await prisma.notes.create({ data: { ...note, metadata: note.metadata === null ? Prisma.DbNull : note.metadata } });
  expect(await stamp()).not.toBe(before);
  expect(await stamp()).toBe(await stamp());
});
