import { afterAll, beforeAll, expect, test, mock } from 'bun:test';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
// The factory never queries persistence; replace its unused Prisma import.
mock.module('../../prisma', () => ({ prisma: {} }));
const { mcpClientManager } = await import('../../aiServer/mcp/McpClientManager');

// Use the real production factory and SDK transport, with a harmless local
// fixture process. No database access, external package or remote service.
mcpClientManager.stopCleanup();
const directory = await mkdtemp(path.join(os.tmpdir(), 'blinko-mcp-process-'));
const script = path.join(directory, 'approved.cjs');
const marker = path.join(directory, 'unexpected-execution');
const node = Bun.which('node')!;
const saved = Object.fromEntries(['BLINKO_MCP_STDIO_ALLOWLIST', 'DATABASE_URL', 'NEXTAUTH_SECRET'].map(key => [key, process.env[key]]));
const config = { command: node, args: [script], env: { BLINKO_FIXTURE: 'approved' } };
const factory = (value: typeof config) => (mcpClientManager as any).createStdioTransport(value);
beforeAll(async () => {
  process.env.DATABASE_URL = 'TEST_ONLY_PARENT_SECRET';
  process.env.NEXTAUTH_SECRET = 'TEST_ONLY_PARENT_SECRET';
  await writeFile(script, `process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/fixture-ready',params:{approved:process.env.BLINKO_FIXTURE==='approved',databaseSecretPresent:!!process.env.DATABASE_URL,signingSecretPresent:!!process.env.NEXTAUTH_SECRET}})+'\\n');process.stdin.resume();`);
});
afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});
test('real stdio child starts only with the exact operator approval and receives no database/signing secrets', async () => {
  process.env.BLINKO_MCP_STDIO_ALLOWLIST = JSON.stringify([config]);
  const transport = factory(config);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<any>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Fixture process did not start')), 3000);
    transport.onmessage = resolve;
    transport.onerror = reject;
  });
  try {
    await transport.start();
    const message = await ready;
    expect(message.method).toBe('notifications/fixture-ready');
    expect(message.params).toEqual({ approved: true, databaseSecretPresent: false, signingSecretPresent: false });
  } finally {
    clearTimeout(timer);
    await transport.close();
  }
});
test('inline-execution and environment-injection changes are rejected before a real child can start', async () => {
  process.env.BLINKO_MCP_STDIO_ALLOWLIST = JSON.stringify([config]);
  const payload = `require('fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`;
  expect(() => factory({ ...config, args: ['-e', payload] })).toThrow('approved');
  expect(() => factory({ ...config, env: { ...config.env, NODE_OPTIONS: '--inspect' } } as any)).toThrow('approved');
  delete process.env.BLINKO_MCP_STDIO_ALLOWLIST;
  expect(() => factory(config)).toThrow('approved');
  await expect(access(marker)).rejects.toThrow();
});
