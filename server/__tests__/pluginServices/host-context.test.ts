import { expect, test } from 'bun:test';
import { PluginHostContextRuntime, type HostContextSource } from '../../../app/src/store/plugin/hostContext';
import { createPluginServices, type ServicesTransport } from '../../../app/src/store/plugin/services';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function fixture(initial: Partial<HostContextSource> = {}) {
  let state: HostContextSource = { accountId: 7, token: 'synthetic-token-a', serviceUrl: 'https://server-a.invalid/', expiresAt: null, ...initial };
  let notify = () => {};
  let sourceDisconnected = 0;
  const runtime = new PluginHostContextRuntime({ read: () => state, subscribe: callback => { notify = callback; return () => { sourceDisconnected++; }; } });
  return { runtime, patch(value: Partial<HostContextSource>) { state = { ...state, ...value }; notify(); }, disconnected: () => sourceDisconnected };
}
function transport(overrides: Partial<ServicesTransport> = {}): ServicesTransport {
  return {
    capabilities: async () => ({ apiVersion: '1.0', hostVersion: 'synthetic', features: {}, limits: { maxResults: 50, maxExcludeIds: 5000, maxInputBytes: 1000, maxOutputTokens: 10, maxConcurrentGeneration: 1 } }),
    vectorStatus: async () => ({ available: false, reason: 'not-configured' } as never),
    vectorQuery: async () => ({ items: [] } as never), listModels: async () => [],
    generateText: async () => ({ text: 'synthetic' } as never),
    ...overrides,
  };
}

test('public identity is immutable and token-free; each credential/account/service boundary changes its key', () => {
  const f = fixture();
  try {
    const events: string[] = [];
    const unsubscribe = f.runtime.context.subscribe(value => events.push(value.identityKey));
    const original = f.runtime.context.get();
    expect(Object.isFrozen(original)).toBe(true);
    expect(original.accountId).toBe(7);
    expect(JSON.stringify(original)).not.toContain('synthetic-token');
    expect(f.runtime.context.get().identityKey).toBe(original.identityKey);
    f.patch({ accountId: 8 }); f.patch({ serviceUrl: 'https://server-b.invalid/path' }); f.patch({ token: 'synthetic-token-b' });
    expect(new Set(events).size).toBe(4);
    expect(f.runtime.context.get().serviceUrl).toBe('https://server-b.invalid/');
    unsubscribe(); unsubscribe(); f.patch({ accountId: 9 });
    expect(events).toHaveLength(4);
  } finally { f.runtime.dispose(); }
});

test('2FA credentials, expired credentials and endpoint mismatches never advertise an authenticated account', () => {
  for (const initial of [{ requiresTwoFactor: true }, { expiresAt: Date.now() - 1 }, { credentialsMatchService: false }, { token: null }]) {
    const f = fixture(initial);
    try { expect(f.runtime.context.get().authentication).not.toBe('authenticated'); expect(f.runtime.context.get().accountId).toBeNull(); }
    finally { f.runtime.dispose(); }
  }
});

test('expiry notifies without another request and stops the timer after expiring', () => {
  let now = 100, callback: (() => void) | undefined, timers = 0;
  const runtime = new PluginHostContextRuntime({ read: () => ({ accountId: 7, token: 'synthetic', serviceUrl: 'https://server.invalid/', expiresAt: 200 }), now: () => now,
    setTimer: fn => { callback = fn; timers++; return timers; }, clearTimer: () => {} });
  try {
    const states: string[] = []; runtime.context.subscribe(value => states.push(value.authentication));
    now = 200; callback!();
    expect(states).toEqual(['authenticated', 'expired']);
    const before = timers; runtime.context.get(); expect(timers).toBe(before);
  } finally { runtime.dispose(); }
});

test('subscriptions isolate listener errors, honor abort, and detach source and caller listeners on disposal', () => {
  const f = fixture(); const signal = new AbortController(); let observed = 0;
  f.runtime.context.subscribe(() => { throw new Error('synthetic listener failure'); });
  f.runtime.context.subscribe(() => { observed++; }, { signal: signal.signal });
  expect(observed).toBe(1); f.patch({ accountId: 8 }); expect(observed).toBe(2);
  signal.abort(); f.patch({ accountId: 9 }); expect(observed).toBe(2);
  f.runtime.dispose(); f.runtime.dispose(); expect(f.disconnected()).toBe(1);
  expect(f.runtime.context.get().authentication).toBe('unavailable');
  f.runtime.context.subscribe(() => { observed++; }); expect(observed).toBe(2);
});

test('file resolution preserves grants/options and never sends a token to external or nonfile URLs', () => {
  const f = fixture();
  try {
    const local = new URL(f.runtime.files.url('/api/file/image.png?shareToken=synthetic-grant', { thumbnail: true }));
    expect(local.origin).toBe('https://server-a.invalid'); expect(local.searchParams.get('token')).toBe('synthetic-token-a');
    expect(local.searchParams.get('shareToken')).toBe('synthetic-grant'); expect(local.searchParams.get('thumbnail')).toBe('true');
    expect(new URL(f.runtime.files.url('/api/s3file/a')).searchParams.get('token')).toBe('synthetic-token-a');
    for (const value of ['https://external.invalid/api/file/a', '//external.invalid/api/file/a', '/api/other/a', '/api/files/a', 'https://server-a.invalid.evil.invalid/api/file/a']) {
      expect(new URL(f.runtime.files.url(value)).searchParams.has('token')).toBe(false);
    }
    for (const value of ['', 'javascript:alert(1)', 'data:text/html,synthetic', 'https://user:pass@server-a.invalid/api/file/a']) expect(() => f.runtime.files.url(value)).toThrow();
    expect(f.runtime.files.url('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    f.patch({ token: null }); expect(new URL(f.runtime.files.url('/api/file/a')).searchParams.has('token')).toBe(false);
  } finally { f.runtime.dispose(); }
});

test('SDK context replacement aborts transport and never delivers a late response even if transport ignores abort', async () => {
  const f = fixture(); const gate = deferred<any>(); let actualSignal: AbortSignal | undefined, delivered = 0;
  const sdk = createPluginServices(transport({ vectorStatus: async options => { actualSignal = options?.signal as AbortSignal; return gate.promise; } }), f.runtime);
  try {
    const request = sdk.vector.status(); void request.then(() => { delivered++; }, () => {});
    await tick(); f.patch({ accountId: 8 });
    await expect(request).rejects.toMatchObject({ code: 'ABORTED' }); expect(actualSignal?.aborted).toBe(true);
    gate.resolve({ available: true, syntheticPrivateBody: 'old-account-result' }); await tick(); expect(delivered).toBe(0);
  } finally { f.runtime.dispose(); }
});

test('caller abort and runtime disposal settle hanging requests and prevent new dispatch', async () => {
  const f = fixture(); const signal = new AbortController(); let calls = 0;
  const sdk = createPluginServices(transport({ vectorStatus: async () => { calls++; return new Promise(() => {}); } }), f.runtime);
  const a = sdk.vector.status({ signal: signal.signal }); void a.catch(() => {}); await tick(); signal.abort();
  await expect(a).rejects.toMatchObject({ code: 'ABORTED' });
  const b = sdk.vector.status(); void b.catch(() => {}); await tick(); f.runtime.dispose();
  await expect(b).rejects.toMatchObject({ code: 'ABORTED' });
  await expect(sdk.vector.status()).rejects.toMatchObject({ code: 'ABORTED' }); expect(calls).toBe(2);
  expect(() => sdk.files!.url('/api/file/a')).toThrow();
});

test('server authentication rejection invalidates the observed session; credential replacement can recover', async () => {
  const f = fixture(); let calls = 0;
  const sdk = createPluginServices(transport({ vectorStatus: async () => { calls++; throw { code: 'UNAUTHENTICATED' }; } }), f.runtime);
  try {
    await expect(sdk.vector.status()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(sdk.context!.get().authentication).toBe('invalid');
    await expect(sdk.vector.status()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(calls).toBe(1);
    f.patch({ token: 'synthetic-new-token' }); expect(sdk.context!.get().authentication).toBe('authenticated');
  } finally { f.runtime.dispose(); }
});

test('a permission refusal does not invalidate the entire login, and a previous account error cannot invalidate a new login', async () => {
  const f = fixture(); const gate = deferred<any>();
  try {
    const sdk = createPluginServices(transport({ vectorStatus: () => gate.promise }), f.runtime);
    const request = sdk.vector.status(); void request.catch(() => {}); await tick(); f.patch({ token: 'synthetic-new-login' });
    gate.reject({ code: 'UNAUTHENTICATED' }); await expect(request).rejects.toMatchObject({ code: 'ABORTED' });
    expect(sdk.context!.get().authentication).toBe('authenticated');
    const permission = createPluginServices(transport({ vectorStatus: async () => { throw { code: 'FORBIDDEN' }; } }), f.runtime);
    await expect(permission.vector.status()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(permission.context!.get().authentication).toBe('authenticated');
  } finally { f.runtime.dispose(); }
});

test('browser capabilities are additive and a non-browser SDK remains usable with the old transport', async () => {
  const legacy = createPluginServices(transport()); expect(legacy.context).toBeUndefined(); expect(legacy.files).toBeUndefined();
  await expect(legacy.ai.listModels()).resolves.toEqual([]);
  const f = fixture();
  try {
    const sdk = createPluginServices(transport(), f.runtime), capabilities = await sdk.capabilities();
    expect(capabilities.features['host.context']).toEqual({ available: true }); expect(capabilities.features['files.url']).toEqual({ available: true });
  } finally { f.runtime.dispose(); }
});
