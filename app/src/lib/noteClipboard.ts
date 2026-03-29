let markedOptionsApplied = false;

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

async function markdownToHtmlFragment(markdown: string, attachmentAbsoluteUrls: string[]): Promise<string> {
  const { marked } = await import('marked');
  if (!markedOptionsApplied) {
    marked.setOptions({ gfm: true });
    markedOptionsApplied = true;
  }
  const trimmed = markdown.trimEnd() || '';
  const parsed = marked.parse(trimmed, { async: false }) as string;
  if (attachmentAbsoluteUrls.length === 0) {
    return parsed;
  }
  const links = attachmentAbsoluteUrls
    .map((url) => `<a href="${escapeHtmlAttribute(url)}">${escapeHtmlAttribute(url)}</a>`)
    .join('<br/>');
  return `${parsed}<hr/><p>${links}</p>`;
}

function buildFullPlainTextForNote(markdown: string, attachmentAbsoluteUrls: string[]): string {
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

/** Zengin (HTML + düz metin) not kopyası; `marked` ilk kullanımda dinamik yüklenir. */
export async function copyNoteRichToClipboard(
  markdown: string,
  attachmentAbsoluteUrls: string[]
): Promise<void> {
  const plain = buildFullPlainTextForNote(markdown, attachmentAbsoluteUrls);
  const fragment = await markdownToHtmlFragment(markdown, attachmentAbsoluteUrls);
  await writeRichAndPlainToClipboard(plain, wrapClipboardHtml(fragment));
}

/** Yalnızca ham markdown (+ ek URL satırları). */
export async function copyNoteMarkdownToClipboard(
  markdown: string,
  attachmentAbsoluteUrls: string[]
): Promise<void> {
  await writePlainMarkdownToClipboard(buildFullPlainTextForNote(markdown, attachmentAbsoluteUrls));
}
