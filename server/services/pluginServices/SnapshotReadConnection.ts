import type { Client } from '@libsql/client';

// Connection-local, optional SQLite optimization. This maps pages on demand;
// it neither reads vectors ahead of the query nor changes the pager cache size.
const MAX_MAPPED_BYTES = 512 * 1024 * 1024;
export async function configureSnapshotReadConnection(client: Pick<Client, 'execute'>): Promise<number> {
  try {
    await client.execute(`PRAGMA mmap_size=${MAX_MAPPED_BYTES}`);
    const result = await client.execute('PRAGMA mmap_size');
    const effective = Number(result.rows[0]?.mmap_size ?? 0);
    if (Number.isSafeInteger(effective) && effective >= 0 && effective <= MAX_MAPPED_BYTES) return effective;
  } catch {
    // Some SQLite builds/VFS implementations omit mmap support. Keep the
    // existing ordinary read path available; normal query errors still surface.
  }
  try { await client.execute('PRAGMA mmap_size=0'); } catch { /* Unsupported pragma. */ }
  return 0;
}
