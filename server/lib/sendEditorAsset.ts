import type { Response } from 'express';
import path from 'path';

/** Send a fixed, server-selected editor asset; never derive fullPath from a request. */
export function sendEditorAsset(res: Response, fullPath: string): void {
  // Keep hidden installation ancestors out of sendFile's relative path check.
  // Default dotfile protection still applies to the server-selected basename.
  res.sendFile(path.basename(fullPath), { root: path.dirname(fullPath) });
}
