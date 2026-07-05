import heicConvert from 'heic-convert/browser';

const HEIC_MIME = new Set(['image/heic', 'image/heif']);
const HEIC_EXT = /\.(heic|heif)$/i;

export function isHeicFile(file: File): boolean {
  return HEIC_MIME.has(file.type) || HEIC_EXT.test(file.name);
}

/**
 * Convert a HEIC/HEIF file to a JPEG File in the browser.
 * Returns the original file if it is not HEIC.
 */
export async function convertHeicToJpeg(file: File, quality = 0.85): Promise<File> {
  if (!isHeicFile(file)) return file;

  const buffer = await file.arrayBuffer();
  const jpeg = await heicConvert({
    buffer: new Uint8Array(buffer),
    format: 'JPEG',
    quality,
  });

  const baseName = file.name.replace(HEIC_EXT, '');
  return new File(
    [new Blob([jpeg as ArrayBufferView], { type: 'image/jpeg' })],
    `${baseName}.jpg`,
    { type: 'image/jpeg' },
  );
}
