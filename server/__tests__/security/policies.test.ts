import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, symlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canReadFile, uploadedFileHeaders } from "../../lib/fileAccessPolicy";
import { visibleProvider, visibleModel } from "../../lib/providerVisibility";
import { pluginDirectory, containedPluginPath } from "../../lib/pluginPaths";
import { approvedStdioConfig } from "../../lib/mcpStdioPolicy";
import { resolvePublicUrl, isPublicAddress } from "../../lib/publicHttp";
import { TwoFactorLogin, TwoFactorRateLimit } from "../../lib/twoFactorLogin";

describe("private attachments and active uploads", () => {
  const file = { accountId: 1, note: { id: 10, accountId: 1, isShare: false } };
  test("only the owner/admin can read a private file, and unknown files fail closed", () => {
    expect(canReadFile(file, { id: 1 })).toBe(true);
    expect(canReadFile(file, { id: 2 })).toBe(false);
    expect(canReadFile(file, null)).toBe(false);
    expect(canReadFile(null, { id: 1, role: "superadmin" })).toBe(false);
    expect(canReadFile(file, { id: 2, role: "superadmin" })).toBe(true);
    expect(canReadFile({ accountId: 1 }, { id: 2 })).toBe(false);
  });
  test("password-protected shares require a grant; expiry and revocation still apply", () => {
    const shared = {
      ...file,
      note: { ...file.note, isShare: true, sharePassword: "protected" },
    };
    expect(canReadFile(shared, null)).toBe(false);
    expect(canReadFile(shared, { id: 2 })).toBe(false);
    expect(canReadFile(shared, null, true)).toBe(true);
    expect(
      canReadFile(
        { ...shared, note: { ...shared.note, isShare: false } },
        null,
        true,
      ),
    ).toBe(false);
    expect(
      canReadFile(
        { ...shared, note: { ...shared.note, shareExpiryDate: new Date(1) } },
        null,
        true,
      ),
    ).toBe(false);
    expect(
      canReadFile(
        { ...shared, note: { ...shared.note, isRecycle: true } },
        null,
        true,
      ),
    ).toBe(false);
    expect(
      canReadFile({ ...file, note: { ...file.note, isShare: true } }, null),
    ).toBe(true);
  });
  test.each([
    "text/html",
    "image/svg+xml",
    "application/xhtml+xml",
    "application/xml",
    "text/javascript",
  ])(
    "%s is forced to inert download with sandbox and private caching",
    (type) => {
      const headers = uploadedFileHeaders("payload.html", type);
      expect(headers["Content-Type"]).toBe("application/octet-stream");
      expect(headers["Content-Disposition"]).toStartWith("attachment;");
      expect(headers["Content-Security-Policy"]).toContain("sandbox");
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Cache-Control"]).toBe("private, no-store");
    },
  );
  test("ordinary image/media preview remains inline; downloads remain downloads", () => {
    expect(
      uploadedFileHeaders("image.png", "image/png")["Content-Disposition"],
    ).toStartWith("inline;");
    expect(
      uploadedFileHeaders("image.png", "image/png", true)[
        "Content-Disposition"
      ],
    ).toStartWith("attachment;");
  });
});

test("model selection never exposes provider/model configs or nested secrets to ordinary users", () => {
  const provider = {
    id: 1,
    title: "Provider",
    apiKey: "TEST_PROVIDER_SECRET",
    baseURL: "https://example.com",
    config: { token: "TEST_CONFIG_SECRET" },
    models: [{ id: 2, config: { apiKey: "TEST_MODEL_SECRET" } }],
  };
  const serialized = JSON.stringify(visibleProvider(provider, false));
  expect(serialized).not.toContain("SECRET");
  expect(
    visibleModel(
      { id: 2, title: "Model", config: { key: "TEST_SECRET" }, provider },
      false,
    ).provider.apiKey,
  ).toBeNull();
  expect(visibleProvider(provider, true)).toBe(provider);
  expect(provider.apiKey).toBe("TEST_PROVIDER_SECRET");
});

describe("plugin path boundaries", () => {
  test.each([
    "../escape",
    "../../../tmp/VICTIM",
    "/tmp/VICTIM",
    "..",
    ".",
    "a/b",
    "a\\b",
    "a\0b",
  ])("rejects unsafe name %s before filesystem cleanup", (name) =>
    expect(() => pluginDirectory(name)).toThrow(),
  );
  test("rejects both extraction traversal and existing symlinks without touching the outside file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blinko-plugin-policy-"));
    try {
      const base = path.join(root, "plugins");
      const outside = path.join(root, "outside");
      await mkdir(base);
      await mkdir(outside);
      await writeFile(path.join(outside, "keep.txt"), "keep");
      await symlink(outside, path.join(base, "linked"));
      await expect(
        containedPluginPath(base, "../outside/keep.txt"),
      ).rejects.toThrow();
      await expect(
        containedPluginPath(base, "linked/keep.txt"),
      ).rejects.toThrow();
      expect(await containedPluginPath(base, "safe/index.js")).toBe(
        path.join(base, "safe/index.js"),
      );
      expect(await Bun.file(path.join(outside, "keep.txt")).text()).toBe(
        "keep",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MCP stdio requires operator approval of the entire execution tuple", () => {
  const original = process.env.BLINKO_MCP_STDIO_ALLOWLIST;
  afterEach(() => {
    if (original === undefined) delete process.env.BLINKO_MCP_STDIO_ALLOWLIST;
    else process.env.BLINKO_MCP_STDIO_ALLOWLIST = original;
  });
  test("denies by default, including interpreter inline code and old stored configurations", () => {
    delete process.env.BLINKO_MCP_STDIO_ALLOWLIST;
    expect(() =>
      approvedStdioConfig({ command: "node", args: ["-e", "process.exit()"] }),
    ).toThrow();
  });
  test("approved package cannot be replaced with eval or a hostile environment", () => {
    process.env.BLINKO_MCP_STDIO_ALLOWLIST = JSON.stringify([
      { command: "npx", args: ["--yes", "approved-mcp@1.0.0"], env: {} },
    ]);
    const good = { command: "npx", args: ["--yes", "approved-mcp@1.0.0"] };
    expect(approvedStdioConfig(good).command).toBe("npx");
    expect(() =>
      approvedStdioConfig({ ...good, args: ["--yes", "other-package"] }),
    ).toThrow();
    expect(() =>
      approvedStdioConfig({
        ...good,
        env: { NODE_OPTIONS: "--require=evil.js" },
      }),
    ).toThrow();
    expect(approvedStdioConfig(good).env).not.toHaveProperty("DATABASE_URL");
  });
});

describe("SSRF destination validation", () => {
  test.each([
    "http://127.0.0.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://127.1",
    "http://10.1.1.1",
    "http://169.254.169.254/latest",
    "http://100.100.100.200",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[fc00::1]",
    "http://[fe80::1]",
    "http://[2002:7f00:1::]",
    "file:///etc/passwd",
    "http://user:pass@example.com",
  ])(
    "blocks %s",
    async (url) => await expect(resolvePublicUrl(url)).rejects.toThrow(),
  );
  test("rejects mixed DNS answers and accepts public IPv4/IPv6", async () => {
    const resolver: any = async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    await expect(
      resolvePublicUrl("https://mixed.example", resolver),
    ).rejects.toThrow();
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("2001:db8::1")).toBe(false);
  });
});

function sessionStore() {
  const rows = new Map<string, any>();
  let calls = 0;
  const matches = (row: any, where: any) =>
    (!where.id ||
      (typeof where.id === "string"
        ? row.id === where.id
        : row.id.startsWith(where.id.startsWith))) &&
    (!where.data || row.data === where.data) &&
    (!where.expiresAt?.gt || row.expiresAt > where.expiresAt.gt) &&
    (!where.expiresAt?.lte || row.expiresAt <= where.expiresAt.lte);
  const store = {
    async create({ data }: any) {
      calls++;
      rows.set(data.id, { ...data });
      return data;
    },
    async findUnique({ where }: any) {
      calls++;
      return rows.has(where.id) ? { ...rows.get(where.id) } : null;
    },
    async updateMany({ where, data }: any) {
      calls++;
      const row = rows.get(where.id);
      if (!row || !matches(row, where)) return { count: 0 };
      rows.set(where.id, { ...row, ...data });
      return { count: 1 };
    },
    async deleteMany({ where }: any) {
      calls++;
      let count = 0;
      for (const [id, row] of rows)
        if (matches(row, where)) {
          rows.delete(id);
          count++;
        }
      return { count };
    },
  };
  return { store, rows, calls: () => calls };
}

describe("2FA first-factor challenges", () => {
  test("construction and invalid requests perform zero database queries", async () => {
    const db = sessionStore();
    const challenges = new TwoFactorLogin(db.store);
    await Bun.sleep(5);
    expect(await challenges.begin(undefined, 1)).toBeNull();
    expect(await challenges.begin("invalid", 1)).toBeNull();
    expect(db.calls()).toBe(0);
  });
  test("binds user, expires, limits guesses and consumes once across independent workers", async () => {
    const db = sessionStore();
    const first = new TwoFactorLogin(db.store);
    const second = new TwoFactorLogin(db.store);
    const token = await first.issue(1);
    expect(await second.begin(token, 2)).toBeNull();
    const attempt = await second.begin(token, 1);
    expect(attempt).not.toBeNull();
    expect(await first.consume(attempt!)).toBe(true);
    expect(await second.consume(attempt!)).toBe(false);
    expect(await first.begin(token, 1)).toBeNull();
    const stale = await first.issue(1, Date.now() - 6 * 60 * 1000);
    expect(await first.begin(stale, 1)).toBeNull();
    const limited = await first.issue(1);
    for (let i = 0; i < 5; i++)
      expect(await first.begin(limited, 1)).not.toBeNull();
    expect(await second.begin(limited, 1)).toBeNull();
  });
  test("concurrent attempts cannot exceed the persisted attempt budget", async () => {
    const db = sessionStore();
    const service = new TwoFactorLogin(db.store);
    const token = await service.issue(1);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.begin(token, 1)),
    );
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(5);
  });
  test("IP throttling expires on requests, with no periodic job", () => {
    const limit = new TwoFactorRateLimit();
    for (let i = 0; i < 60; i++) expect(limit.allow("ip", 100)).toBe(true);
    expect(limit.allow("ip", 101)).toBe(false);
    expect(limit.allow("other", 101)).toBe(true);
    expect(limit.allow("ip", 6 * 60 * 1000)).toBe(true);
  });
});

// The deployed Bun 1.2.8 runtime must reject these without relying on BlockList.
test.each([
  '10.255.255.255', '100.64.0.1', '100.127.255.255', '172.31.255.255',
  '192.168.255.255', '198.19.255.255', '224.0.0.1', '255.255.255.255',
  '2001:1ff:ffff::1', '2001:db8::1', '2002:7f00:1::', '3fff:fff::1',
])('reserved destination remains blocked on the deployed runtime: %s', (address) => {
  expect(isPublicAddress(address)).toBe(false);
});
test.each(['1.1.1.1', '8.8.8.8', '100.128.0.1', '172.32.0.1', '2001:4860:4860::8888', '2606:4700:4700::1111'])(
  'public destinations remain available: %s', (address) => expect(isPublicAddress(address)).toBe(true),
);
