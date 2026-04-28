import { beforeEach, describe, expect, mock, test } from 'bun:test';

const md2HtmlMock = mock(async (markdown: string) => `<p>${markdown}</p>`);
const clipboardWriteTextMock = mock(async (_text: string) => {});
const clipboardWriteMock = mock(async (_items: unknown[]) => {});
const copyToClipboardMock = mock((_text: string) => true);
const sanitizeHtmlMock = mock((html: string) => html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ''));

mock.module('vditor', () => ({
  default: {
    md2html: md2HtmlMock,
  },
}));

mock.module('copy-to-clipboard', () => ({
  default: copyToClipboardMock,
}));

mock.module('isomorphic-dompurify', () => ({
  default: {
    sanitize: sanitizeHtmlMock,
  },
}));

const noteClipboardModule = await import('./noteClipboard');
const {
  buildAttachmentUrlsFromNote,
  buildFullPlainTextForNote,
  copyNoteMarkdownToClipboard,
  copyNoteRichToClipboard,
  markdownToHtmlFragment,
  sanitizeClipboardHtmlFragment,
} = noteClipboardModule;

describe('noteClipboard helpers', () => {
  beforeEach(() => {
    md2HtmlMock.mockClear();
    clipboardWriteTextMock.mockClear();
    clipboardWriteMock.mockClear();
    copyToClipboardMock.mockClear();
    sanitizeHtmlMock.mockClear();

    Object.assign(globalThis, {
      navigator: {
        clipboard: {
          writeText: clipboardWriteTextMock,
          write: clipboardWriteMock,
        },
      },
      ClipboardItem: class ClipboardItemMock {
        constructor(_data: Record<string, Blob>) {}
      },
    });
  });

  test('buildFullPlainTextForNote returns markdown when attachment does not exist', () => {
    expect(buildFullPlainTextForNote('## Baslik', [])).toBe('## Baslik');
  });

  test('buildFullPlainTextForNote appends attachment urls line by line', () => {
    const result = buildFullPlainTextForNote('Not icerigi', ['https://site/a.png', 'https://site/b.pdf']);
    expect(result).toBe('Not icerigi\nhttps://site/a.png\nhttps://site/b.pdf');
  });

  test('buildAttachmentUrlsFromNote returns empty array for nullish attachments', () => {
    expect(buildAttachmentUrlsFromNote(undefined, 'https://origin.test')).toEqual([]);
    expect(buildAttachmentUrlsFromNote(null, 'https://origin.test')).toEqual([]);
  });

  test('buildAttachmentUrlsFromNote builds absolute urls with provided origin', () => {
    const urls = buildAttachmentUrlsFromNote(
      [{ path: '/upload/a.png' }, { path: '/upload/b.pdf' }],
      'https://origin.test'
    );
    expect(urls).toEqual(['https://origin.test/upload/a.png', 'https://origin.test/upload/b.pdf']);
  });

  test('markdownToHtmlFragment converts markdown and appends escaped attachment links', async () => {
    md2HtmlMock.mockResolvedValueOnce('<p>icerik</p>');
    const html = await markdownToHtmlFragment('icerik', ['https://a.com/file?a="1"&b=<x>']);
    expect(html).toContain('<p>icerik</p>');
    expect(html).toContain('&quot;1&quot;');
    expect(html).toContain('&lt;x&gt;');
    expect(sanitizeHtmlMock).toHaveBeenCalledTimes(1);
  });

  test('sanitizeClipboardHtmlFragment removes unsafe script tags', () => {
    const sanitized = sanitizeClipboardHtmlFragment('<p>safe</p><script>alert(1)</script>');
    expect(sanitized).toBe('<p>safe</p>');
  });
});

describe('noteClipboard integration validations', () => {
  beforeEach(() => {
    md2HtmlMock.mockClear();
    clipboardWriteTextMock.mockClear();
    clipboardWriteMock.mockClear();
    copyToClipboardMock.mockClear();
    sanitizeHtmlMock.mockClear();

    Object.assign(globalThis, {
      navigator: {
        clipboard: {
          writeText: clipboardWriteTextMock,
          write: clipboardWriteMock,
        },
      },
      ClipboardItem: class ClipboardItemMock {
        constructor(_data: Record<string, Blob>) {}
      },
    });
  });

  test('does not throw on empty note in rich and markdown copy flows', async () => {
    md2HtmlMock.mockResolvedValueOnce('');
    await expect(copyNoteRichToClipboard('', [])).resolves.toBeUndefined();
    await expect(copyNoteMarkdownToClipboard('', [])).resolves.toBeUndefined();
  });

  test('does not throw when note has no attachments', async () => {
    md2HtmlMock.mockResolvedValueOnce('<p>icerik</p>');
    await expect(copyNoteRichToClipboard('icerik', [])).resolves.toBeUndefined();
  });

  test('does not throw on very large note content', async () => {
    const veryLargeNote = `# Baslik\n${'satir '.repeat(30_000)}`;
    md2HtmlMock.mockResolvedValueOnce('<p>buyuk</p>');
    await expect(copyNoteRichToClipboard(veryLargeNote, [])).resolves.toBeUndefined();
    await expect(copyNoteMarkdownToClipboard(veryLargeNote, [])).resolves.toBeUndefined();
  });
});
