import { expect, test } from 'bun:test';
import { build } from 'esbuild';
import path from 'node:path';
import vm from 'node:vm';

// Real tRPC client, batching, headers, canonical endpoint setter and rebind
// subscription. UI stores and HTTP responses are synthetic; no real backend.
test('public legacy API and SDK client stay on the canonical server, including peer token-before-endpoint events', async () => {
  const file = path.resolve(import.meta.dir, '../../../app/src/lib/trpc.ts');
  const endpoint = path.resolve(import.meta.dir, '../../../app/src/lib/blinkoEndpoint.ts');
  const bundled = await build({
    stdin: { contents: `import {api} from ${JSON.stringify(file)}; export {saveBlinkoEndpoint} from ${JSON.stringify(endpoint)}; export const currentApi = () => api;`, resolveDir: path.dirname(file), loader: 'ts' },
    bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022',
    define: { 'import.meta.hot': 'globalThis.__fixtureHot' },
    plugins: [{ name: 'isolated-ui-stores', setup(builder) {
      builder.onResolve({ filter: /^@\/store(?:\/user)?$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path.endsWith('/user')
        ? 'export class UserStore {};' : 'export const RootStore = {Get: () => globalThis.__fixtureUser};' }));
    } }],
  });
  class SyntheticWindow extends EventTarget {
    __TAURI__ = {};
    location = { origin: 'http://tauri.localhost' };
    data = new Map<string, string>([['blinkoEndpoint', 'https://server-a.invalid/'], ['blinkoToken', JSON.stringify({ token: 'synthetic-token-a' })]]);
    localStorage = { getItem: (key: string) => this.data.get(key) ?? null, setItem: (key: string, value: string) => { this.data.set(key, value); }, removeItem: (key: string) => { this.data.delete(key); } };
  }
  const window = new SyntheticWindow();
  const requests: Array<{ url: string; authorization: string | null }> = [];
  let hotCleanup!: () => void;
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, window, URL, Headers, Request, Response, Event, AbortSignal, AbortController, DOMException, setTimeout, clearTimeout, console,
    __fixtureUser: { get token() { return JSON.parse(window.data.get('blinkoToken') ?? 'null')?.token ?? null; } },
    __fixtureHot: { dispose: (callback: () => void) => { hotCleanup = callback; } },
    fetch: async (url: string, options: RequestInit) => {
      requests.push({ url: String(url), authorization: new Headers(options.headers).get('Authorization') });
      return new Response(JSON.stringify([{ result: { data: { json: 'synthetic-version' } } }]), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  vm.runInContext(bundled.outputFiles[0]!.text, context);
  const compiled = module.exports as { currentApi(): any; saveBlinkoEndpoint(endpoint: string): void };
  (window as any).Blinko = { api: compiled.currentApi() };
  const query = () => (window as any).Blinko.api.public.serverVersion.query();
  expect(await query()).toBe('synthetic-version');
  expect(requests[0]?.url).toStartWith('https://server-a.invalid/api/trpc/');
  expect(requests[0]?.authorization).toBe('Bearer synthetic-token-a');

  const previous = (window as any).Blinko.api;
  compiled.saveBlinkoEndpoint('https://server-b.invalid/');
  expect((window as any).Blinko.api).not.toBe(previous);
  expect((window as any).Blinko.api).toBe(compiled.currentApi());
  expect(await query()).toBe('synthetic-version');
  expect(requests[1]?.url).toStartWith('https://server-b.invalid/api/trpc/'); expect(requests[1]?.authorization).toBeNull();
  window.data.set('blinkoToken', JSON.stringify({ token: 'synthetic-token-b' }));
  await query(); expect(requests[2]?.authorization).toBe('Bearer synthetic-token-b');

  // The peer has completed address and login writes before this tab handles the
  // first queued storage event. Its token observer must never use server B's URL.
  window.data.set('blinkoEndpoint', 'https://server-c.invalid/');
  window.data.set('blinkoToken', JSON.stringify({ token: 'synthetic-token-c' }));
  window.dispatchEvent(Object.assign(new Event('storage'), { key: 'blinkoToken' }));
  await query(); expect(requests[3]?.url).toStartWith('https://server-c.invalid/api/trpc/');
  expect(requests[3]?.authorization).toBe('Bearer synthetic-token-c');
  const current = compiled.currentApi();
  window.dispatchEvent(Object.assign(new Event('storage'), { key: 'blinkoEndpoint' }));
  expect(compiled.currentApi()).toBe(current);
  hotCleanup();
  compiled.saveBlinkoEndpoint('https://server-d.invalid/');
  expect(compiled.currentApi()).toBe(current);
});
