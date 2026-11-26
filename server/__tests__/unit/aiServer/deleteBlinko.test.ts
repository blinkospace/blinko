import { describe, test, expect, mock, beforeEach, spyOn } from 'bun:test';

/**
 * Regression test for issue #1179 (first bug).
 *
 * The MCP router passes each tool's return value straight through as
 * `structuredContent`, which the MCP SDK validates as a record. `deleteBlinko`
 * used to return a bare `true` on success and a plain string on failure, so every
 * call failed validation even though the notes had been moved to the recycle bin.
 *
 * The tRPC caller and token helper are mocked so the real tool can run without a
 * database.
 */

const trashMany = mock((_input: { ids: number[] }) => Promise.resolve({ count: 0 }));
mock.module('@server/routerTrpc/_app', () => ({
  userCaller: () => ({ notes: { trashMany } }),
}));
mock.module('@server/lib/helper', () => ({
  verifyToken: async () => ({ sub: '1' }),
}));

const { deleteBlinkoTool } = await import('../../../aiServer/tools/deleteBlinko');

const runtimeContext = { get: (key: string) => (key === 'accountId' ? '1' : undefined) };
const run = (ids: number[]) =>
  (deleteBlinkoTool as any).execute({ context: { ids }, runtimeContext });

const isRecord = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

describe('deleteBlinko MCP tool — issue #1179', () => {
  beforeEach(() => {
    trashMany.mockReset();
  });

  test('returns an object on success so it can be used as structuredContent', async () => {
    trashMany.mockImplementation(() => Promise.resolve({ count: 2 }));

    const result = await run([153, 154]);

    expect(isRecord(result)).toBe(true);
    expect(result).toEqual({ success: true, deletedCount: 2 });
    expect(trashMany).toHaveBeenCalledWith({ ids: [153, 154] });
  });

  test('returns an object on failure instead of a bare error string', async () => {
    trashMany.mockImplementation(() => Promise.reject(new Error('note not found')));
    const log = spyOn(console, 'log').mockImplementation(() => {});

    const result = await run([999]);
    log.mockRestore();

    expect(isRecord(result)).toBe(true);
    expect(result).toEqual({ success: false, error: 'note not found' });
  });
});
