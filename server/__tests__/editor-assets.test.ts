import { afterAll, expect, test } from 'bun:test';
import express from 'express';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { sendEditorAsset } from '../lib/sendEditorAsset';

// Keep the tiny synthetic files under the checkout, including a hidden ancestor.
const fixture = mkdtempSync(path.join(import.meta.dir, 'editor-assets-'));
const assets = path.join(fixture, '.hidden-install', 'assets');
mkdirSync(assets, { recursive: true });
const css = 'body{color:#123456}';
const js = 'globalThis.syntheticEditorAsset = true;';
writeFileSync(path.join(assets, 'theme.css'), css);
writeFileSync(path.join(assets, 'editor.js'), js);
writeFileSync(path.join(assets, '.private'), 'synthetic secret');
writeFileSync(path.join(fixture, 'sibling.txt'), 'synthetic sibling');

const app = express();
app.use('/theme.css', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=604800, immutable');
  sendEditorAsset(res, path.join(assets, 'theme.css'));
});
app.use('/editor.js', (_req, res) => sendEditorAsset(res, path.join(assets, 'editor.js')));
app.use('/private', (_req, res) => sendEditorAsset(res, path.join(assets, '.private')));
app.use('/missing', (_req, res) => sendEditorAsset(res, path.join(assets, 'missing.css')));
// Use the existing host's error policy so the old hidden-ancestor regression is 500.
const handleError: express.ErrorRequestHandler = (error, _req, res, _next) => {
  res.status(500).json({ error: { message: 'Internal Server Error', sourceStatus: error.status } });
};
app.use(handleError);
const server = createServer(app);
server.listen(0, '127.0.0.1');
const ready = new Promise<void>((resolve, reject) => {
  if (server.listening) resolve();
  else { server.once('listening', resolve); server.once('error', reject); }
});
async function request(route: string, options?: RequestInit) {
  await ready;
  return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`, options);
}
afterAll(async () => {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  const resolved = realpathSync(fixture);
  if (resolved !== fixture || path.dirname(resolved) !== realpathSync(import.meta.dir) || !path.basename(resolved).startsWith('editor-assets-')) {
    throw new Error('Refusing to remove an unexpected fixture path');
  }
  rmSync(resolved, { recursive: true });
});

test('CSS under a hidden installation ancestor returns exact bytes and preserves cache headers', async () => {
  const response = await request('/theme.css', { headers: { 'Accept-Encoding': 'gzip' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toStartWith('text/css');
  expect(response.headers.get('cache-control')).toBe('public, max-age=604800, immutable');
  expect(response.headers.get('content-encoding')).toBeNull();
  expect(await response.text()).toBe(css);
});

test('uncompressed JS under a hidden installation ancestor returns exact bytes', async () => {
  const response = await request('/editor.js', { headers: { 'Accept-Encoding': 'identity' } });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(js);
});

test('HEAD and byte range behavior are preserved', async () => {
  const head = await request('/theme.css', { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(css)));
  expect(await head.text()).toBe('');
  const range = await request('/theme.css', { headers: { Range: 'bytes=0-3' } });
  expect(range.status).toBe(206);
  expect(await range.text()).toBe(css.slice(0, 4));
});

test('request suffixes and encoded traversal cannot choose a sibling asset', async () => {
  const response = await request('/theme.css/%2e%2e%2fsibling.txt?file=sibling.txt');
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(css);
});

test('hidden file names remain denied and missing assets are not disclosed', async () => {
  const hidden = await request('/private');
  expect(hidden.status).toBe(500);
  expect((await hidden.json()).error.sourceStatus).toBe(404);
  const missing = await request('/missing');
  expect(missing.status).toBe(500);
  expect((await missing.json()).error.sourceStatus).toBe(404);
  expect(readFileSync(path.join(assets, '.private'), 'utf8')).toBe('synthetic secret');
});
