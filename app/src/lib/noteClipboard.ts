import DOMPurify from 'isomorphic-dompurify';

type VditorStaticApi = {
  md2html: (markdown: string, options?: { markdown?: { gfmAutoLink?: boolean } }) => Promise<string>;
};

let vditorModulePromise: Promise<VditorStaticApi> | null = null;

async function getVditorStaticApi(): Promise<VditorStaticApi> {
  if (!vditorModulePromise) {
    vditorModulePromise = import('vditor').then((module) => module.default as VditorStaticApi);
  }
  return vditorModulePromise;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function wrapClipboardHtml(innerBodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${innerBodyHtml}</body></html>`;
}

export async function markdownToHtmlFragment(markdown: string, attachmentAbsoluteUrls: string[]): Promise<string> {
  const trimmed = markdown.trimEnd() || '';
  const vditor = await getVditorStaticApi();
  const parsed = await vditor.md2html(trimmed, {
    markdown: {
      gfmAutoLink: true,
    },
  });
  if (attachmentAbsoluteUrls.length === 0) {
    return sanitizeClipboardHtmlFragment(parsed);
  }
  const links = attachmentAbsoluteUrls
    .map((url) => `<a href="${escapeHtmlAttribute(url)}">${escapeHtmlAttribute(url)}</a>`)
    .join('<br/>');
  return sanitizeClipboardHtmlFragment(`${parsed}<hr/><p>${links}</p>`);
}

export function sanitizeClipboardHtmlFragment(htmlFragment: string): string {
  return DOMPurify.sanitize(htmlFragment);
}

export function buildFullPlainTextForNote(markdown: string, attachmentAbsoluteUrls: string[]): string {
  if (attachmentAbsoluteUrls.length === 0) {
    return markdown;
  }
  return `${markdown}\n${attachmentAbsoluteUrls.join('\n')}`;
}

export function buildAttachmentUrlsFromNote(
  attachments: { path: string }[] | null | undefined,
  origin: string = typeof window !== 'undefined' ? window.location.origin : ''
): string[] {
  return attachments?.map((a) => origin + a.path) ?? [];
}

export async function writeRichAndPlainToClipboard(plainText: string, htmlDocument: string): Promise<void> {
  if (typeof ClipboardItem === 'undefined') {
    await navigator.clipboard.writeText(plainText);
    return;
  }
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([htmlDocument], { type: 'text/html' }),
        'text/plain': new Blob([plainText], { type: 'text/plain' }),
      }),
    ]);
  } catch {
    await navigator.clipboard.writeText(plainText);
  }
}

export async function writePlainMarkdownToClipboard(plainText: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(plainText);
  } catch {
    const { default: copy } = await import('copy-to-clipboard');
    copy(plainText);
  }
}

export async function copyNoteRichToClipboard(
  markdown: string,
  attachmentAbsoluteUrls: string[]
): Promise<void> {
  const plain = buildFullPlainTextForNote(markdown, attachmentAbsoluteUrls);
  const fragment = await markdownToHtmlFragment(markdown, attachmentAbsoluteUrls);
  await writeRichAndPlainToClipboard(plain, wrapClipboardHtml(fragment));
}

export async function copyNoteMarkdownToClipboard(
  markdown: string,
  attachmentAbsoluteUrls: string[]
): Promise<void> {
  await writePlainMarkdownToClipboard(buildFullPlainTextForNote(markdown, attachmentAbsoluteUrls));
}
