import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { isImage, AiService } from '../../../aiServer/index';

describe('isImage file extension detection', () => {
  test('recognizes standard image formats', () => {
    expect(isImage('photo.jpg')).toBe(true);
    expect(isImage('image.JPEG')).toBe(true);
    expect(isImage('graphic.png')).toBe(true);
    expect(isImage('banner.webp')).toBe(true);
    expect(isImage('icon.svg')).toBe(true);
  });

  test('recognizes modern camera and web formats (.heic, .heif, .avif, .ico)', () => {
    expect(isImage('IMG_1234.HEIC')).toBe(true);
    expect(isImage('photo.heic')).toBe(true);
    expect(isImage('picture.heif')).toBe(true);
    expect(isImage('modern.avif')).toBe(true);
    expect(isImage('favicon.ico')).toBe(true);
    expect(isImage('scan.tiff')).toBe(true);
  });

  test('returns false for non-image files and falsy inputs', () => {
    expect(isImage('document.pdf')).toBe(false);
    expect(isImage('notes.txt')).toBe(false);
    expect(isImage('data.csv')).toBe(false);
    expect(isImage('archive.zip')).toBe(false);
    expect(isImage('')).toBe(false);
    expect(isImage(null as any)).toBe(false);
  });
});

describe('AiService.loadFileContent Unstructured opt-in (#1287)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.UNSTRUCTURED_API_URL;
    delete process.env.UNSTRUCTURED_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('returns empty string and skips external request when UNSTRUCTURED_API_URL is unset', async () => {
    const result = await AiService.loadFileContent('unsupported_attachment.xyz');
    expect(result).toBe('');
  });
});
