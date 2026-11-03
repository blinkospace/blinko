import { afterEach, expect, mock, test } from 'bun:test';
import { fileUrl, isBlinkoUrl } from '../../../app/src/lib/fileUrl';
import { getBlinkoFileUrl } from '../../../app/src/lib/blinkoEndpoint';

mock.module('../../lib/helper', () => ({
  getNextAuthSecret: async () => 'TEST_ONLY_FILE_URL_SIGNING_KEY',
}));
const { withAttachmentShareLinks, validAttachmentShareToken } = await import('../../lib/attachmentShare');
const endpoint = 'https://blinko.example/';
const originalWindow = globalThis.window;
afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as any).window;
  else (globalThis as any).window = originalWindow;
});

for (const storage of ['file', 's3file']) {
  test(`${storage}: a password-share grant survives preview, thumbnail, playback and download URL composition`, async () => {
    const note = {
      id: 15,
      isShare: true,
      sharePassword: 'protected',
      shareEncryptedUrl: 'share-path',
      content: `![image](/api/${storage}/image.png?width=800#image)`,
      attachments: [{ path: `/api/${storage}/image.png` }],
    };
    const shared = await withAttachmentShareLinks(note);
    const path = shared.attachments[0]!.path;
    const grant = new URL(path, endpoint).searchParams.get('shareToken');
    expect(await validAttachmentShareToken(grant, note)).toBe(true);
    for (const options of [{}, { thumbnail: true }, { download: true }]) {
      // These options are shared by PhotoView, image thumbnails, voice/music,
      // video, browser downloads and Tauri downloads.
      const url = new URL(fileUrl(path + '#position', endpoint, { ...options, token: 'signed-in-viewer' }));
      expect(url.searchParams.get('shareToken')).toBe(grant);
      expect(await validAttachmentShareToken(url.searchParams.get('shareToken'), note)).toBe(true);
      expect(url.searchParams.get('token')).toBe('signed-in-viewer');
      expect(url.hash).toBe('#position');
      if ('thumbnail' in options) expect(url.searchParams.get('thumbnail')).toBe('true');
      if ('download' in options) expect(url.searchParams.get('download')).toBe('true');
    }
    const markdownPath = /\]\(([^)]+)\)/.exec(shared.content)![1]!;
    const markdownUrl = new URL(fileUrl(markdownPath, endpoint, { thumbnail: true }));
    expect(markdownUrl.searchParams.get('width')).toBe('800');
    expect(markdownUrl.searchParams.get('shareToken')).toBe(grant);
    expect(markdownUrl.hash).toBe('#image');
  });
}

test('private media options replace existing parameters and encode bearer tokens once', () => {
  const url = new URL(fileUrl('/api/file/audio.mp3?foo=bar&token=old&thumbnail=false#t=5', endpoint, {
    token: 'token/+?&=value', thumbnail: true, download: true,
  }));
  expect(url.searchParams.get('foo')).toBe('bar');
  expect(url.searchParams.getAll('token')).toEqual(['token/+?&=value']);
  expect(url.searchParams.get('thumbnail')).toBe('true');
  expect(url.searchParams.get('download')).toBe('true');
  expect(url.hash).toBe('#t=5');
});

test('export grants are preserved together with the required owner authentication', () => {
  const url = new URL(fileUrl('/api/file/temp/export.zip?exportToken=signed-grant', endpoint, {
    token: 'owner-token', download: true,
  }));
  expect(url.searchParams.get('exportToken')).toBe('signed-grant');
  expect(url.searchParams.get('token')).toBe('owner-token');
  expect(url.searchParams.get('download')).toBe('true');
});

test('an expired share grant does not suppress an authenticated owner media request', () => {
  const url = new URL(fileUrl('/api/file/image.png?shareToken=expired-grant', endpoint, {
    token: 'owner-token',
  }));
  expect(url.searchParams.get('shareToken')).toBe('expired-grant');
  expect(url.searchParams.get('token')).toBe('owner-token');
});

test('anonymous media never acquires token=undefined or token=null', () => {
  for (const token of [undefined, null, '']) {
    expect(new URL(fileUrl('/api/file/image.png?shareToken=grant', endpoint, { token })).searchParams.has('token')).toBe(false);
    expect(new URL(fileUrl('/api/file/image.png', endpoint, { token })).searchParams.has('token')).toBe(false);
  }
});

test('external and presigned media/download URLs receive no login token or changed options', () => {
  for (const input of [
    'https://other.example/api/file/image.png?signature=abc%2Fdef#image',
    '//other.example/api/s3file/image.png?signature=abc',
    'https://storage.example/object?X-Amz-Signature=abc',
    'data:image/png;base64,abc',
    'blob:https://blinko.example/test',
    'https://blinko.example/unrelated-image.png',
  ]) {
    expect(fileUrl(input, endpoint, { token: 'private-login-token', thumbnail: true, download: true })).toBe(new URL(input, endpoint).href);
  }
  expect(isBlinkoUrl('https://blinko.example.evil.example/api/file/image.png', endpoint)).toBe(false);
  expect(isBlinkoUrl('https://other.example/api/file/image.png', endpoint)).toBe(false);
  expect(isBlinkoUrl('/api/file/image.png', endpoint)).toBe(true);
});

test('malformed Markdown sources and endpoints remain broken URLs without throwing or receiving credentials', () => {
  for (const input of ['http://%', 'https://[invalid', 'https://blinko.example:invalid/image.png']) {
    expect(() => fileUrl(input, endpoint, { token: 'private-login-token', thumbnail: true })).not.toThrow();
    expect(fileUrl(input, endpoint, { token: 'private-login-token', thumbnail: true })).toBe(input);
    expect(isBlinkoUrl(input, endpoint)).toBe(false);
  }
  expect(fileUrl('/api/file/image.png?shareToken=grant', 'http://%', { token: 'private-login-token' }))
    .toBe('/api/file/image.png?shareToken=grant');
  expect(isBlinkoUrl('/api/file/image.png', 'http://%')).toBe(false);
});

test('browser and Tauri consumers use the configured backend origin', () => {
  (globalThis as any).window = {
    location: { origin: endpoint },
    localStorage: { getItem: () => null },
  };
  expect(new URL(getBlinkoFileUrl('/api/file/a.png', { token: 'owner' })).origin).toBe('https://blinko.example');
  (globalThis as any).window = {
    __TAURI__: {},
    location: { origin: 'http://tauri.localhost' },
    localStorage: { getItem: () => '"https://desktop-blinko.example"' },
  };
  const url = new URL(getBlinkoFileUrl('/api/file/a.png?shareToken=grant', { download: true }));
  expect(url.origin).toBe('https://desktop-blinko.example');
  expect(url.searchParams.get('shareToken')).toBe('grant');
  expect(url.searchParams.get('download')).toBe('true');
});
