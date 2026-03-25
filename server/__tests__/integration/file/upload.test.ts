import { describe, test, expect, beforeAll, afterAll, mock, beforeEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';

// Mock prisma before importing FileService
mock.module('../../../prisma', () => ({
  prisma: {
    attachments: {
      create: mock(() => Promise.resolve({ id: 1 })),
      findFirst: mock(() => Promise.resolve(null)),
      delete: mock(() => Promise.resolve()),
    }
  }
}));

// Mock getGlobalConfig to return local storage config
const TEMP_UPLOAD_DIR = path.join(import.meta.dir, '../../__fixtures__/uploads');
mock.module('../../../routerTrpc/config', () => ({
  getGlobalConfig: mock(() => Promise.resolve({
    objectStorage: 'local',
    localCustomPath: '/',
    s3Endpoint: '',
    s3Region: '',
    s3Bucket: '',
    s3AccessKeyId: '',
    s3AccessKeySecret: '',
    s3CustomPath: '',
  }))
}));

// Mock UPLOAD_FILE_PATH
mock.module('@shared/lib/pathConstant', () => ({
  UPLOAD_FILE_PATH: TEMP_UPLOAD_DIR,
  TEMP_PATH: path.join(TEMP_UPLOAD_DIR, 'temp'),
}));

// Mock cache
mock.module('@shared/lib/cache', () => ({
  cache: {
    wrap: mock(async (_key: string, fn: () => Promise<any>) => fn()),
  }
}));

import { FileService, sanitizeUploadFileName } from '../../../lib/files';

function createReadableStream(content: string | Buffer): ReadableStream {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  const readable = new Readable({
    read() {
      this.push(buf);
      this.push(null);
    }
  });
  return Readable.toWeb(readable) as unknown as ReadableStream;
}

describe('File Upload — Full Flow', () => {
  beforeAll(async () => {
    await fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(TEMP_UPLOAD_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clean upload dir between tests
    const files = await fs.readdir(TEMP_UPLOAD_DIR).catch(() => []);
    for (const file of files) {
      await fs.rm(path.join(TEMP_UPLOAD_DIR, file), { recursive: true, force: true }).catch(() => {});
    }
  });

  test('uploads file with simple ASCII name', async () => {
    const stream = createReadableStream('hello world');
    const result = await FileService.uploadFileStream({
      stream,
      originalName: 'test-document.txt',
      fileSize: 11,
      type: 'text/plain',
      accountId: 1,
    });

    expect(result.filePath).toContain('/api/file/');
    expect(result.filePath).toContain('test-document');
    expect(result.filePath).toContain('.txt');
    expect(result.fileName).toContain('.txt');

    // Verify file actually written to disk
    const relativePath = result.filePath.replace('/api/file/', '');
    const fullPath = path.join(TEMP_UPLOAD_DIR, relativePath);
    const content = await fs.readFile(fullPath, 'utf-8');
    expect(content).toBe('hello world');
  });

  test('uploads file with Chinese characters in name', async () => {
    const stream = createReadableStream('中文内容');
    const result = await FileService.uploadFileStream({
      stream,
      originalName: '挽救计划.epub',
      fileSize: 12,
      type: 'application/epub+zip',
      accountId: 1,
    });

    expect(result.filePath).toContain('/api/file/');
    expect(result.filePath).toContain('.epub');

    // Verify file written
    const relativePath = result.filePath.replace('/api/file/', '');
    const fullPath = path.join(TEMP_UPLOAD_DIR, relativePath);
    const stat = await fs.stat(fullPath);
    expect(stat.isFile()).toBe(true);
  });

  test('uploads file with the exact bug #1138 filename — should NOT throw', async () => {
    const bugFilename = '挽救计划(《火星救援》作者安迪·威尔全新力作,出版后连续16周雄踞亚马逊科幻畅销榜第一名科技宅男+跨星系好友联袂上演太空大救援,硬核工程风+... (z-library.sk, 1lib.sk, z-lib.sk).epub';
    const stream = createReadableStream('epub content');

    const result = await FileService.uploadFileStream({
      stream,
      originalName: bugFilename,
      fileSize: 12,
      type: 'application/epub+zip',
      accountId: 1,
    });

    // Must succeed — this is the exact scenario that caused 500
    expect(result.filePath).toBeTruthy();
    expect(result.filePath).toContain('/api/file/');
    expect(result.filePath).toContain('.epub');

    // Verify file actually exists on disk
    const relativePath = result.filePath.replace('/api/file/', '');
    const fullPath = path.join(TEMP_UPLOAD_DIR, relativePath);
    const stat = await fs.stat(fullPath);
    expect(stat.isFile()).toBe(true);
  });

  test('uploads file with reserved filesystem characters in name', async () => {
    const stream = createReadableStream('data');
    const result = await FileService.uploadFileStream({
      stream,
      originalName: 'report<2024>final|v2.pdf',
      fileSize: 4,
      type: 'application/pdf',
      accountId: 1,
    });

    expect(result.filePath).toContain('/api/file/');
    expect(result.filePath).toContain('.pdf');
    // Reserved chars should be sanitized, not cause a crash
    expect(result.filePath).not.toContain('<');
    expect(result.filePath).not.toContain('>');
    expect(result.filePath).not.toContain('|');

    const relativePath = result.filePath.replace('/api/file/', '');
    const fullPath = path.join(TEMP_UPLOAD_DIR, relativePath);
    const stat = await fs.stat(fullPath);
    expect(stat.isFile()).toBe(true);
  });

  test('uploads file with extremely long name (250+ chars)', async () => {
    const longName = 'a'.repeat(250) + '.txt';
    const stream = createReadableStream('long name test');

    const result = await FileService.uploadFileStream({
      stream,
      originalName: longName,
      fileSize: 14,
      type: 'text/plain',
      accountId: 1,
    });

    expect(result.filePath).toContain('/api/file/');
    expect(result.filePath).toContain('.txt');

    // Filename should be truncated but still valid
    const relativePath = result.filePath.replace('/api/file/', '');
    const fullPath = path.join(TEMP_UPLOAD_DIR, relativePath);
    const stat = await fs.stat(fullPath);
    expect(stat.isFile()).toBe(true);

    // Total filename (base + timestamp + ext) should not exceed filesystem limits
    const fileName = path.basename(relativePath);
    expect(fileName.length).toBeLessThan(255);
  });

  test('uploads file with control characters in name', async () => {
    const stream = createReadableStream('ctrl chars');
    const result = await FileService.uploadFileStream({
      stream,
      originalName: 'file\x00with\x1fcontrol\x7fchars.txt',
      fileSize: 10,
      type: 'text/plain',
      accountId: 1,
    });

    expect(result.filePath).toContain('/api/file/');
    // Control chars should be stripped
    expect(result.filePath).not.toMatch(/[\x00-\x1f\x7f]/);

    const relativePath = result.filePath.replace('/api/file/', '');
    const fullPath = path.join(TEMP_UPLOAD_DIR, relativePath);
    const stat = await fs.stat(fullPath);
    expect(stat.isFile()).toBe(true);
  });

  test('uploads file with spaces in name (converted to underscores)', async () => {
    const stream = createReadableStream('space test');
    const result = await FileService.uploadFileStream({
      stream,
      originalName: 'my document file.pdf',
      fileSize: 10,
      type: 'application/pdf',
      accountId: 1,
    });

    expect(result.filePath).toContain('/api/file/');
    expect(result.filePath).toContain('.pdf');

    const relativePath = result.filePath.replace('/api/file/', '');
    const fullPath = path.join(TEMP_UPLOAD_DIR, relativePath);
    const stat = await fs.stat(fullPath);
    expect(stat.isFile()).toBe(true);
  });

  test('returned filePath can be used to read the file back', async () => {
    const originalContent = 'round-trip test content 你好世界';
    const stream = createReadableStream(originalContent);
    const result = await FileService.uploadFileStream({
      stream,
      originalName: '往返测试.txt',
      fileSize: Buffer.byteLength(originalContent),
      type: 'text/plain',
      accountId: 1,
    });

    // Simulate what the file serving route does
    const relativePath = result.filePath.replace('/api/file/', '');
    const fullPath = path.join(TEMP_UPLOAD_DIR, relativePath);
    const readBack = await fs.readFile(fullPath, 'utf-8');
    expect(readBack).toBe(originalContent);
  });
});

describe('Filename Decode Chain — busboy to FileService', () => {
  // Simulates the full chain: busboy binary decode → space replace → sanitize → path
  test('binary-decoded Chinese filename survives the full chain', () => {
    // Simulate busboy giving raw UTF-8 bytes as latin1 string
    const chineseUtf8 = Buffer.from('挽救计划', 'utf-8');
    const binaryString = chineseUtf8.toString('binary');

    // Step 1: upload.ts decodes it back
    const decoded = Buffer.from(binaryString, 'binary').toString('utf-8');
    expect(decoded).toBe('挽救计划');

    // Step 2: upload.ts replaces spaces
    const noSpaces = decoded.replace(/\s+/g, '_');
    expect(noSpaces).toBe('挽救计划');

    // Step 3: files.ts sanitizes
    const sanitized = sanitizeUploadFileName(noSpaces);
    expect(sanitized).toBe('挽救计划');
  });

  test('binary-decoded long filename with special chars survives the full chain', () => {
    const original = '挽救计划(《火星救援》作者安迪·威尔全新力作,出版后连续16周雄踞亚马逊科幻畅销榜第一名科技宅男+跨星系好友联袂上演太空大救援,硬核工程风+... (z-library.sk, 1lib.sk, z-lib.sk)';
    const utf8Bytes = Buffer.from(original, 'utf-8');
    const binaryString = utf8Bytes.toString('binary');

    // Decode chain
    const decoded = Buffer.from(binaryString, 'binary').toString('utf-8');
    const noSpaces = decoded.replace(/\s+/g, '_');
    const sanitized = sanitizeUploadFileName(noSpaces);

    // Must produce a valid, non-empty filename
    expect(sanitized.length).toBeGreaterThan(0);
    expect(sanitized.length).toBeLessThanOrEqual(200);
    // Must not contain filesystem-unsafe characters
    expect(sanitized).not.toMatch(/[<>:"/\\|?*\x00-\x1f\x7f]/);
    // Must preserve Chinese content
    expect(sanitized).toContain('挽救计划');
  });
});
