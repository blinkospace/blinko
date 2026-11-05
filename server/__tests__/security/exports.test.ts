import { test, expect, mock, afterAll } from 'bun:test';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
const directory = await mkdtemp(path.join(os.tmpdir(), 'blinko-export-security-'));
mock.module('../../../shared/lib/pathConstant', () => ({ UPLOAD_FILE_PATH: directory, TEMP_PATH: path.join(directory, 'temp'), DBBAKUP_PATH: directory, ROOT_PATH: directory }));
let selectedAccount: number | undefined;
mock.module('../../prisma', () => ({ prisma: { notes: { findMany: async ({where}: any) => {
  selectedAccount = where.accountId;
  return [{ id: where.accountId, content: 'Private account ' + where.accountId, createdAt: new Date(0), attachments: [
    { id: where.accountId, name: '../../photo.png', path: '/api/file/own.png' },
  ] }];
} } } }));
mock.module('../../lib/files', () => ({ FileService: { getFileBuffer: async (file: string) => {
  expect(file).toBe('/api/file/own.png');
  await new Promise(resolve => setTimeout(resolve, 5));
  return Buffer.from('private attachment');
} } }));
mock.module('../../routerTrpc/_app', () => ({ createCaller: () => ({}) }));
mock.module('../../routerTrpc/notification', () => ({ CreateNotification: async () => {} }));
mock.module('../../routerTrpc/config', () => ({ getGlobalConfig: async () => ({}) }));
mock.module('../../lib/helper', () => ({ resetSequences: async () => {} }));
mock.module('../../jobs/baseScheduleJob', () => ({ BaseScheduleJob: class {} }));
const { DBJob } = await import('../../jobs/dbjob');
afterAll(() => rm(directory, { recursive: true, force: true }));
test('concurrent accounts export isolated archives and the requested formats without remote credential forwarding', async () => {
  const exports = await Promise.all(['markdown', 'csv', 'json'].map((format, i) => DBJob.ExporMDFiles({
    baseURL: 'https://attacker.invalid', format: format as any, ctx: { id: String(i + 1), token: 'never-send-this' } as any,
  })));
  expect(selectedAccount).toBe(3);
  expect(new Set(exports.map(file => file.path)).size).toBe(3);
  for (const [i, file] of exports.entries()) {
    expect(file.fileCount).toBe(1);
    const zip = new AdmZip(path.join(directory, file.path));
    const names = zip.getEntries().map(entry => entry.entryName);
    const document = zip.readAsText(names.find(name => /\.(md|csv|json)$/.test(name))!);
    expect(document).toContain('Private account ' + (i + 1));
    expect(document).not.toContain('Private account ' + (i === 0 ? 2 : 1));
    expect(names.every(name => !name.includes('..'))).toBe(true);
    if (i === 0) {
      expect(zip.readAsText('files/1-photo.png')).toBe('private attachment');
      expect(document).toContain('./files/1-photo.png');
    }
  }
  expect((await readdir(path.join(directory, 'temp'))).every(name => name.endsWith('.zip'))).toBe(true);
});
