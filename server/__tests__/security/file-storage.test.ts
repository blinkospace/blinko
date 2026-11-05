import { test, expect, mock, afterAll } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const directory = await mkdtemp(path.join(os.tmpdir(), 'blinko-storage-security-'));
let storage = 's3';
mock.module('../../routerTrpc/config', () => ({ getGlobalConfig: async () => ({ objectStorage: storage }) }));
mock.module('../../../shared/lib/pathConstant', () => ({ UPLOAD_FILE_PATH: directory, TEMP_PATH: path.join(directory, 'temp') }));
mock.module('../../prisma', () => ({ prisma: {} }));
const { FileService } = await import('../../lib/files');
const original = FileService.getS3Client;
let keys: string[] = [];
FileService.getS3Client = async () => ({ config: { s3Bucket: 'fixture' }, s3ClientInstance: { send: async (command: any) => {
  keys.push(command.input.Key);
  return { Body: [Buffer.from('S3 bytes')] };
} } } as any);
afterAll(async () => { FileService.getS3Client = original; await rm(directory, { recursive: true, force: true }); });
test('mixed legacy Local/S3 attachment paths retain their original storage after either configuration switch', async () => {
  await writeFile(path.join(directory, 'legacy.png'), 'local bytes');
  for (const selected of ['local', 's3']) {
    storage = selected; keys = [];
    expect((await FileService.getFileBuffer('/api/file/legacy.png')).toString()).toBe('local bytes');
    expect(keys).toEqual([]);
    expect((await FileService.getFileBuffer('/api/s3file/old/legacy.png')).toString()).toBe('S3 bytes');
    expect(keys).toEqual(['old/legacy.png']);
  }
});
