import { describe, test, expect } from 'bun:test';
import { sanitizeUploadFileName } from '../lib/files';

describe('sanitizeUploadFileName', () => {
  test('passes through simple ASCII filenames unchanged', () => {
    expect(sanitizeUploadFileName('my_document')).toBe('my_document');
    expect(sanitizeUploadFileName('report-2024')).toBe('report-2024');
  });

  test('preserves Chinese characters', () => {
    expect(sanitizeUploadFileName('挽救计划')).toBe('挽救计划');
  });

  test('replaces reserved filesystem characters with underscores', () => {
    expect(sanitizeUploadFileName('file<name>test')).toBe('file_name_test');
    expect(sanitizeUploadFileName('file:name')).toBe('file_name');
    expect(sanitizeUploadFileName('file"name')).toBe('file_name');
    expect(sanitizeUploadFileName('file|name')).toBe('file_name');
    expect(sanitizeUploadFileName('file?name')).toBe('file_name');
    expect(sanitizeUploadFileName('file*name')).toBe('file_name');
  });

  test('replaces whitespace with underscores', () => {
    expect(sanitizeUploadFileName('hello world')).toBe('hello_world');
    expect(sanitizeUploadFileName('multiple   spaces')).toBe('multiple_spaces');
    // tab is whitespace, replaced with underscore
    expect(sanitizeUploadFileName('tab\there')).toBe('tab_here');
  });

  test('removes control characters', () => {
    expect(sanitizeUploadFileName('file\x00name')).toBe('filename');
    expect(sanitizeUploadFileName('file\x1fname')).toBe('filename');
    expect(sanitizeUploadFileName('file\x7fname')).toBe('filename');
    expect(sanitizeUploadFileName('file\x80name')).toBe('filename');
    expect(sanitizeUploadFileName('file\x9fname')).toBe('filename');
  });

  test('removes leading/trailing dots and spaces', () => {
    expect(sanitizeUploadFileName('.hidden')).toBe('hidden');
    expect(sanitizeUploadFileName('...dots')).toBe('dots');
    expect(sanitizeUploadFileName('trailing.')).toBe('trailing');
  });

  test('truncates filenames longer than 200 characters', () => {
    const longName = 'a'.repeat(250);
    const result = sanitizeUploadFileName(longName);
    expect(result.length).toBe(200);
  });

  test('returns fallback for empty or whitespace-only names', () => {
    expect(sanitizeUploadFileName('')).toBe('unnamed_file');
    expect(sanitizeUploadFileName('   ')).toBe('unnamed_file');
    expect(sanitizeUploadFileName('...')).toBe('unnamed_file');
  });

  test('handles the exact bug report filename (issue #1138)', () => {
    // This is the filename from the bug report that caused 500 error
    const bugFilename = '挽救计划(《火星救援》作者安迪·威尔全新力作,出版后连续16周雄踞亚马逊科幻畅销榜第一名科技宅男+跨星系好友联袂上演太空大救援,硬核工程风+..._(z-library.sk,_1lib.sk,_z-lib.sk)';
    const result = sanitizeUploadFileName(bugFilename);

    // Should not throw
    expect(result).toBeTruthy();
    // Should preserve Chinese characters and parentheses
    expect(result).toContain('挽救计划');
    expect(result).toContain('(');
    // Should not contain reserved chars
    expect(result).not.toMatch(/[<>:"/\\|?*]/);
    // Should be within length limit
    expect(result.length).toBeLessThanOrEqual(200);
  });

  test('handles filenames with only reserved characters', () => {
    expect(sanitizeUploadFileName('<>:"/\\|?*')).toBe('unnamed_file');
  });

  test('handles mixed unicode and special characters', () => {
    const result = sanitizeUploadFileName('日本語テスト<file>');
    expect(result).toBe('日本語テスト_file');
  });
});
