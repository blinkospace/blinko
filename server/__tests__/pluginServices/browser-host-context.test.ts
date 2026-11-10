import { expect, test } from 'bun:test';
import { makeAutoObservable, runInAction } from 'mobx';
import { createBrowserPluginHostContext } from '../../../app/src/store/plugin/browserHostContext';
import { saveBlinkoEndpoint } from '../../../app/src/lib/blinkoEndpoint';
import { fetchWithTimeout } from '../../../app/src/lib/requestFetch';

class SyntheticWindow extends EventTarget {
  __TAURI__: unknown = {};
  location = { origin: 'http://tauri.localhost' };
  readonly data = new Map<string, string>([['blinkoEndpoint', '"https://server-a.invalid/"']]);
  localStorage = { getItem: (key: string) => this.data.get(key) ?? null, setItem: (key: string, value: string) => { this.data.set(key, value); }, removeItem: (key: string) => { this.data.delete(key); } };
  readonly listeners = new Map<string, Set<any>>();
  addEventListener(type: string, listener: any, options?: any) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener);
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type: string, listener: any, options?: any) { this.listeners.get(type)?.delete(listener); super.removeEventListener(type, listener, options); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, values) => sum + values.size, 0); }
}
class SyntheticUser {
  tokenData = { value: { user: { id: '7' }, token: 'synthetic-token-a', expires: '2099-01-01T00:00:00Z', requiresTwoFactor: false } as any,
    load: () => { this.tokenData.value = JSON.parse((globalThis as any).window.localStorage.getItem('blinkoToken') ?? 'null'); } };
  constructor() { makeAutoObservable(this); }
  get id() { return this.tokenData.value?.user?.id ?? ''; }
  get token() { return this.tokenData.value?.token ?? null; }
  get requiresTwoFactor() { return !!this.tokenData.value?.requiresTwoFactor; }
  login(id: string, token: string) { this.tokenData.value = { user: { id }, token, expires: '2099-01-01T00:00:00Z', requiresTwoFactor: false }; }
}
function fixture() {
  const previous = (globalThis as any).window, window = new SyntheticWindow(); (globalThis as any).window = window;
  const user = new SyntheticUser(), runtime = createBrowserPluginHostContext(user as never);
  return { window, user, runtime, clean() { runtime.dispose(); if (previous === undefined) delete (globalThis as any).window; else (globalThis as any).window = previous; } };
}

test('browser binding uses configured Tauri service and current authentication for file URLs (synthetic window)', () => {
  const f = fixture();
  try {
    expect(f.runtime.context.get().serviceUrl).toBe('https://server-a.invalid/');
    expect(f.runtime.context.get().accountId).toBe(7);
    const url = new URL(f.runtime.files.url('/api/file/synthetic.png'));
    expect(url.origin).toBe('https://server-a.invalid'); expect(url.searchParams.get('token')).toBe('synthetic-token-a');
    f.window.__TAURI__ = undefined; expect(f.runtime.context.get().serviceUrl).toBe('http://tauri.localhost/');
  } finally { f.clean(); }
});

test('canonical endpoint change notifies immediately and cannot transfer old credentials to the new server', () => {
  const f = fixture();
  try {
    const keys: string[] = []; f.runtime.context.subscribe(value => keys.push(value.identityKey));
    saveBlinkoEndpoint('https://server-b.invalid/');
    const after = f.runtime.context.get(); expect(after.serviceUrl).toBe('https://server-b.invalid/'); expect(after.authentication).toBe('anonymous');
    expect(keys).toHaveLength(2); expect(new URL(f.runtime.files.url('/api/file/a')).searchParams.has('token')).toBe(false);
    runInAction(() => f.user.login('8', 'synthetic-token-b'));
    expect(f.runtime.context.get().authentication).toBe('authenticated'); expect(f.runtime.context.get().accountId).toBe(8);
    expect(new URL(f.runtime.files.url('/api/file/a')).searchParams.get('token')).toBe('synthetic-token-b');
    expect(keys).toHaveLength(3);
  } finally { f.clean(); }
});

test('changing the configured service clears the persisted old login so remount and reload stay anonymous', () => {
  const f = fixture();
  try {
    f.window.data.set('blinkoToken', JSON.stringify(f.user.tokenData.value));
    const authentication: string[] = [];
    f.runtime.context.subscribe(value => authentication.push(value.authentication));
    saveBlinkoEndpoint('https://server-b.invalid/');
    // Assert the notification itself; polling get() must not be what repairs the state.
    expect(authentication).toEqual(['authenticated', 'anonymous']);
    expect(f.window.localStorage.getItem('blinkoToken')).toBeNull();
    f.runtime.dispose();
    f.user.tokenData.load();
    const remounted = createBrowserPluginHostContext(f.user as never);
    try {
      expect(remounted.context.get().authentication).toBe('anonymous');
      expect(new URL(remounted.files.url('/api/file/a')).searchParams.has('token')).toBe(false);
    } finally { remounted.dispose(); }
  } finally { f.clean(); }
});

test('rewriting the same canonical service does not discard its login', () => {
  const f = fixture();
  try {
    const serialized = JSON.stringify(f.user.tokenData.value);
    f.window.data.set('blinkoToken', serialized);
    saveBlinkoEndpoint('https://server-a.invalid');
    expect(f.window.localStorage.getItem('blinkoToken')).toBe(serialized);
    expect(f.runtime.context.get().authentication).toBe('authenticated');
  } finally { f.clean(); }
});

test('JWT expiry tightens declared expiry and a two-factor intermediate token stays anonymous', () => {
  const f = fixture();
  try {
    const exp = Math.floor(Date.now() / 1000) - 5;
    const payload = btoa(JSON.stringify({ exp }));
    runInAction(() => f.user.login('7', `synthetic.${payload}.signature`));
    expect(f.runtime.context.get().authentication).toBe('expired'); expect(f.runtime.context.get().expiresAt).toBe(new Date(exp * 1000).toISOString());
    runInAction(() => { f.user.login('7', 'synthetic-2fa'); f.user.tokenData.value.requiresTwoFactor = true; });
    expect(f.runtime.context.get().authentication).toBe('anonymous');
    expect(new URL(f.runtime.files.url('/api/file/a')).searchParams.has('token')).toBe(false);
  } finally { f.clean(); }
});

test('cross-window credential changes update the actual observable source and dispose removes every browser listener', () => {
  const f = fixture();
  try {
    let events = 0; f.runtime.context.subscribe(() => { events++; });
    f.window.data.set('blinkoToken', JSON.stringify({ user: { id: '9' }, token: 'synthetic-token-c', expires: '2099-01-01T00:00:00Z' }));
    f.window.dispatchEvent(Object.assign(new Event('storage'), { key: 'blinkoToken' }));
    expect(f.runtime.context.get().accountId).toBe(9); expect(events).toBe(2); expect(f.window.listenerCount()).toBeGreaterThan(0);
    f.runtime.dispose(); expect(f.window.listenerCount()).toBe(0);
    const count = events; runInAction(() => f.user.login('10', 'synthetic-token-d')); expect(events).toBe(count);
  } finally { f.clean(); }
});

test('back-forward page caching can restore the binding, while final page disposal invalidates it', () => {
  const f = fixture();
  try {
    f.window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    expect(f.runtime.context.get().authentication).toBe('authenticated');
    f.window.dispatchEvent(new Event('pageshow')); expect(f.runtime.context.get().accountId).toBe(7);
    f.window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
    expect(f.runtime.context.get().authentication).toBe('unavailable'); expect(f.window.listenerCount()).toBe(0);
  } finally { f.clean(); }
});

test('request fetch preserves the caller cancellation instead of replacing it with a timeout', async () => {
  const previous = globalThis.fetch; let sentSignal: AbortSignal | undefined;
  globalThis.fetch = (async (_input: any, options: any) => {
    sentSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
  }) as typeof fetch;
  try {
    const controller = new AbortController(), request = fetchWithTimeout('https://never-dispatched.invalid/', { signal: controller.signal }, 1000);
    void request.catch(() => {}); controller.abort(new DOMException('synthetic cancellation', 'AbortError'));
    await expect(request).rejects.toMatchObject({ name: 'AbortError' }); expect(sentSignal?.aborted).toBe(true);
  } finally { globalThis.fetch = previous; }
});

test('request fetch keeps caller cancellation alive after headers and still enforces the timeout', async () => {
  const previous = globalThis.fetch; const controller = new AbortController(); let observed: AbortSignal | undefined;
  globalThis.fetch = (async (_input: any, options: any) => { observed = options.signal; return new Response('synthetic'); }) as typeof fetch;
  try {
    await fetchWithTimeout('https://never-dispatched.invalid/', { signal: controller.signal }, 1000);
    controller.abort(); expect(observed?.aborted).toBe(true);
    globalThis.fetch = (async (_input: any, options: any) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))) as typeof fetch;
    // Native timeout signals do not keep the event loop alive. Real fetch has
    // live I/O; this entirely synthetic fetch needs an explicit loop lifetime.
    const keepAlive = setTimeout(() => {}, 100);
    try {
      await expect(fetchWithTimeout('https://never-dispatched.invalid/', {}, 5)).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally { clearTimeout(keepAlive); }
  } finally { globalThis.fetch = previous; }
});
