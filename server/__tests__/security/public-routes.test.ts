import { beforeEach, test, expect, mock } from "bun:test";

const configReads = mock(async () => [
  { key: "mainModelId", userId: null, config: { value: 1 } },
]);
const modelRead = mock(async () => ({
  title: "Model",
  modelKey: "model",
  capabilities: {},
  provider: {
    id: 1,
    title: "Provider",
    provider: "openai",
    apiKey: "TEST_KEY",
    baseURL: null,
  },
}));
const proxy = mock(async () => ({ status: 200, data: "" }));
const preview = mock(async (_url: string, _options: any) => ({
  title: "Public preview",
  description: "Description",
}));
mock.module("../../prisma", () => ({
  prisma: {
    config: { findMany: configReads },
    aiModels: { findUnique: modelRead },
  },
}));
mock.module("../../routerExpress/auth/config", () => ({
  reinitializeOAuthStrategies: async () => {},
}));
mock.module("../../lib/spotify", () => ({ SpotifyClient: class {} }));
mock.module("../../lib/files", () => ({ FileService: {} }));
mock.module("../../lib/proxy", () => ({ getWithProxy: proxy }));
mock.module("unfurl.js", () => ({ unfurl: preview }));
mock.module("../../../shared/lib/cache", () => ({
  cache: { wrap: (_key: string, fn: any) => fn() },
}));
const { configRouter } = await import("../../routerTrpc/config");
const { publicRouter } = await import("../../routerTrpc/public");
const ctx = (role = "user") =>
  ({ id: "1", sub: "1", name: "user", role }) as any;
beforeEach(() => {
  configReads.mockClear();
  modelRead.mockClear();
  proxy.mockClear();
  preview.mockClear();
});

test("AI configuration secrets require an administrator before any database access", async () => {
  await expect(
    configRouter.createCaller({} as any).ai({ type: "mainModel" }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    configRouter.createCaller(ctx()).ai({ type: "mainModel" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(configReads).not.toHaveBeenCalled();
  expect(modelRead).not.toHaveBeenCalled();
  expect(
    (
      await configRouter
        .createCaller(ctx("superadmin"))
        .ai({ type: "mainModel" })
    )?.provider.apiKey,
  ).toBe("TEST_KEY");
});
test("link previews reject anonymous callers before any parsing or network activity", async () => {
  await expect(
    publicRouter
      .createCaller({} as any)
      .linkPreview({ url: "https://1.1.1.1" }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(preview).not.toHaveBeenCalled();
});
test.each([
  "http://127.0.0.1",
  "http://169.254.169.254/latest/meta-data/",
  "file:///etc/passwd",
])("authenticated previews cannot use %s", async (url) => {
  const result = await publicRouter.createCaller(ctx()).linkPreview({ url });
  expect(result?.title).toBe("");
  expect(preview).not.toHaveBeenCalled();
});
test("public preview uses the guarded transport and disables secondary oEmbed fetching", async () => {
  const result = await publicRouter
    .createCaller(ctx())
    .linkPreview({ url: "https://1.1.1.1" });
  expect(result?.title).toBe("Public preview");
  const options = preview.mock.calls[0][1];
  expect(options.oembed).toBe(false);
  expect(typeof options.fetch).toBe("function");
  await expect(options.fetch("http://127.0.0.1")).rejects.toThrow(
    "Private or reserved",
  );
});
test("proxy diagnostics require admin and reject arbitrary targets before using the proxy", async () => {
  await expect(
    publicRouter.createCaller(ctx()).testHttpProxy({}),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const admin = publicRouter.createCaller(ctx("superadmin"));
  expect(
    (await admin.testHttpProxy({ url: "http://169.254.169.254" })).success,
  ).toBe(false);
  expect(proxy).not.toHaveBeenCalled();
  expect(
    (await admin.testHttpProxy({ url: "https://www.google.com" })).success,
  ).toBe(true);
  expect(proxy.mock.calls[0][1].config.maxRedirects).toBe(0);
});

test('the preview deadline includes the limiter queue and expired queued work never starts', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  preview.mockImplementation(async () => {
    await blocked;
    return { title: 'late', description: 'late' };
  });
  const start = Date.now();
  const jobs = Array.from({ length: 6 }, (_, index) =>
    publicRouter.createCaller(ctx()).linkPreview({ url: `https://1.1.1.1/queued-${index}` }),
  );
  const results = await Promise.all(jobs);
  expect(results.every((value) => value?.title === '')).toBe(true);
  expect(Date.now() - start).toBeLessThan(6000);
  expect(preview).toHaveBeenCalledTimes(5);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(preview).toHaveBeenCalledTimes(5);
}, 10000);
