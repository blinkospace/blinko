import { afterAll, beforeEach, expect, mock, test } from "bun:test";

let existing: any;
const now = new Date();
const saved = mock(async ({ data }: any) => ({ ...existing, ...data }));
const transports: any[] = [];
mock.module("../../prisma", () => ({
  prisma: {
    mcpServers: {
      findUnique: async () => existing,
      create: saved,
      update: saved,
    },
  },
}));
mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(config: any) {
      transports.push(config);
    }
  },
}));
const { mcpClientManager } = await import(
  "../../aiServer/mcp/McpClientManager"
);
mcpClientManager.stopCleanup();
mock.module("../../aiServer/mcp", () => ({ mcpClientManager }));
const { mcpServersRouter } = await import("../../routerTrpc/mcpServers");
const admin = mcpServersRouter.createCaller({
  id: "1",
  sub: "1",
  name: "admin",
  role: "superadmin",
} as any);
const previousAllowlist = process.env.BLINKO_MCP_STDIO_ALLOWLIST;
beforeEach(() => {
  delete process.env.BLINKO_MCP_STDIO_ALLOWLIST;
  transports.length = 0;
  saved.mockClear();
  existing = {
    id: 1,
    name: "test",
    type: "stdio",
    command: "node",
    args: ["approved-server.js"],
    env: {},
    isEnabled: true,
    description: null,
    url: null,
    headers: null,
    createdAt: now,
    updatedAt: now,
  };
});
afterAll(() => {
  if (previousAllowlist === undefined)
    delete process.env.BLINKO_MCP_STDIO_ALLOWLIST;
  else process.env.BLINKO_MCP_STDIO_ALLOWLIST = previousAllowlist;
});
test("web administrators cannot create or enable a stdio command without operator approval", async () => {
  await expect(
    admin.create({
      name: "test",
      type: "stdio",
      command: "node",
      args: ["-e", "console.log(1)"],
    }),
  ).rejects.toThrow("approved");
  await expect(admin.update({ id: 1, isEnabled: true })).rejects.toThrow(
    "approved",
  );
  expect(saved).not.toHaveBeenCalled();
});
test("partial updates validate the merged command, arguments and environment", async () => {
  process.env.BLINKO_MCP_STDIO_ALLOWLIST = JSON.stringify([
    { command: "node", args: existing.args, env: {} },
  ]);
  await expect(
    admin.update({ id: 1, args: ["-e", "console.log(1)"] }),
  ).rejects.toThrow("approved");
  await expect(
    admin.update({ id: 1, env: { NODE_OPTIONS: "--require=other.js" } }),
  ).rejects.toThrow("approved");
  expect(saved).not.toHaveBeenCalled();
  expect(
    (await admin.update({ id: 1, description: "Allowed metadata change" }))
      .description,
  ).toBe("Allowed metadata change");
});
test("runtime blocks pre-existing unapproved database configurations before constructing a transport", async () => {
  await expect(mcpClientManager.connect(1)).rejects.toThrow("approved");
  expect(transports.length).toBe(0);
});
test("runtime uses the same operator-approved tuple and omits application secrets", () => {
  process.env.BLINKO_MCP_STDIO_ALLOWLIST = JSON.stringify([
    { command: "node", args: existing.args, env: {} },
  ]);
  // Exercise the production transport factory without starting a child process.
  (mcpClientManager as any).createStdioTransport(existing);
  expect(transports[0].args).toEqual(["approved-server.js"]);
  expect(transports[0].env).not.toHaveProperty("DATABASE_URL");
  expect(transports[0].env).not.toHaveProperty("NEXTAUTH_SECRET");
});
