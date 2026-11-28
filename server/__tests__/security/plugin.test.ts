import { beforeEach, afterAll, test, expect, mock } from "bun:test";
import { mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

const name = `security-test-${process.pid}`;
const directory = path.resolve(".blinko/plugins", name);
let existing: any = null;
let archiveEntries: any[] = [];
let downloadFails = false;
const download = mock(async () => {
  if (downloadFails) throw new Error("Controlled download failure");
  return { data: Buffer.from("mock archive") };
});
const save = mock(async ({ data }: any) => ({ id: 1, ...data }));
const prisma: any = {
  plugin: {
    findFirst: async () => existing,
    findUnique: async () => existing,
    create: save,
    update: save,
    delete: save,
  },
  $transaction: async (fn: any) => fn(prisma),
};
mock.module("../../prisma", () => ({ prisma }));
mock.module("axios", () => ({ default: { get: download } }));
mock.module("yauzl-promise", () => ({
  default: {
    open: async () => ({
      async *[Symbol.asyncIterator]() {
        yield* archiveEntries;
      },
      close: async () => {},
    }),
  },
}));
mock.module("../../lib/proxy", () => ({
  getHttpCacheKey: async () => "",
  getWithProxy: async () => {
    throw new Error("Unexpected network");
  },
}));
mock.module("../../../shared/lib/cache", () => ({
  cache: { wrap: (_key: string, fn: any) => fn() },
}));
const { pluginRouter } = await import("../../routerTrpc/plugin");
const admin = pluginRouter.createCaller({
  id: "1",
  sub: "1",
  name: "admin",
  role: "superadmin",
} as any);
const user = pluginRouter.createCaller({
  id: "2",
  sub: "2",
  name: "user",
  role: "user",
} as any);
const input = () => ({
  name,
  version: "1.0.0",
  url: "https://github.com/example/plugin",
});
beforeEach(async () => {
  await rm(directory, { recursive: true, force: true });
  existing = null;
  archiveEntries = [];
  downloadFails = false;
  download.mockClear();
  save.mockClear();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("ordinary users cannot install or uninstall global executable plugins", async () => {
  await expect(user.installPlugin(input())).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(user.uninstallPlugin({ id: 1 })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(download).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
test.each(["../outside", "..", "/tmp/outside", "nested/plugin", "dev"])(
  "invalid or reserved plugin name %s is rejected before writes",
  async (invalidName) => {
    await expect(
      admin.installPlugin({ ...input(), name: invalidName }),
    ).rejects.toThrow();
    expect(download).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  },
);
test("invalid repository URL and already-installed version never delete existing files", async () => {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "keep.txt"), "existing plugin");
  existing = { id: 1, metadata: { name, version: "1.0.0" } };
  await expect(
    admin.installPlugin({ ...input(), url: "http://127.0.0.1/private" }),
  ).rejects.toThrow();
  expect(await readFile(path.join(directory, "keep.txt"), "utf8")).toBe(
    "existing plugin",
  );
  await expect(admin.installPlugin(input())).rejects.toThrow(
    "already installed",
  );
  expect(await readFile(path.join(directory, "keep.txt"), "utf8")).toBe(
    "existing plugin",
  );
  expect(download).not.toHaveBeenCalled();
});
test("failed download cleans only the validated plugin directory", async () => {
  downloadFails = true;
  await expect(admin.installPlugin(input())).rejects.toThrow(
    "Controlled download failure",
  );
  await expect(access(directory)).rejects.toThrow();
  expect(save).not.toHaveBeenCalled();
});
test.each([
  { filename: "../escape.js", externalFileAttributes: 0 },
  { filename: "link", externalFileAttributes: 0o120777 << 16 },
])(
  "archive escape or symlink entries are rejected before database writes",
  async (entry) => {
    archiveEntries = [entry];
    await expect(admin.installPlugin(input())).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    await expect(access(directory)).rejects.toThrow();
  },
);
test("administrator can install a contained regular-file release", async () => {
  archiveEntries = [
    {
      filename: "index.js",
      externalFileAttributes: 0,
      openReadStream: async () => Readable.from(["export default {}"]),
    },
  ];
  const result = await admin.installPlugin(input());
  expect(result.path).toBe(`/plugins/${name}/index.js`);
  expect(await readFile(path.join(directory, "index.js"), "utf8")).toBe(
    "export default {}",
  );
  expect(download.mock.calls[0][0]).toBe(
    "https://github.com/example/plugin/releases/download/v1.0.0/release.zip",
  );
});
