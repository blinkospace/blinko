export type FileUrlOptions = {
  token?: string | null;
  thumbnail?: boolean;
  download?: boolean;
};

export function isBlinkoUrl(input: string, endpoint: string): boolean {
  try {
    const base = new URL(endpoint);
    const url = new URL(input, base);
    return /^https?:$/.test(url.protocol) && url.origin === base.origin;
  } catch {
    return false;
  }
}

// Media and navigation requests cannot set an Authorization header. Preserve
// share/export grants when adding their file options, and never send a login
// token to an external image, signed storage URL, or blob/data URL.
export function fileUrl(input: string, endpoint: string, options: FileUrlOptions = {}): string {
  let url: URL;
  try {
    url = new URL(input, endpoint);
  } catch {
    // A malformed Markdown source should produce a broken image rather than
    // throw during React rendering. Without a valid URL, add no credentials.
    return input;
  }
  if (!isBlinkoUrl(url.href, endpoint) || !/^\/api\/(?:s3)?file\//.test(url.pathname)) {
    return url.href;
  }
  if (options.token) {
    url.searchParams.set('token', options.token);
  }
  if (options.thumbnail !== undefined) url.searchParams.set('thumbnail', String(options.thumbnail));
  if (options.download !== undefined) url.searchParams.set('download', String(options.download));
  return url.href;
}
