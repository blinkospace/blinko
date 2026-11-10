import { expect, test } from 'bun:test';
import { fetchWithTimeout } from '../../../app/src/lib/requestFetch';

function trackedSignal(controller: AbortController) {
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  const listeners = new Set<EventListenerOrEventListenerObject>();
  signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: any) => { if (type === 'abort') listeners.add(listener); add(type, listener, options); }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: any) => { if (type === 'abort') listeners.delete(listener); remove(type, listener, options); }) as typeof signal.removeEventListener;
  return { signal, count: () => listeners.size };
}
async function withoutNativeAny(run: (timeout: AbortController) => Promise<void>) {
  const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
  const originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')!;
  const timeout = new AbortController();
  Object.defineProperty(AbortSignal, 'any', { ...any, value: undefined });
  Object.defineProperty(AbortSignal, 'timeout', { ...originalTimeout, value: () => timeout.signal });
  const previousFetch = globalThis.fetch;
  try { await run(timeout); }
  finally { globalThis.fetch = previousFetch; Object.defineProperty(AbortSignal, 'any', any); Object.defineProperty(AbortSignal, 'timeout', originalTimeout); }
}

test('without AbortSignal.any, caller cancellation remains live after response headers and listeners detach', async () => {
  await withoutNativeAny(async timeout => {
    const caller = new AbortController(), a = trackedSignal(caller), b = trackedSignal(timeout);
    let sent!: AbortSignal;
    globalThis.fetch = (async (_url: any, options: RequestInit) => { sent = options.signal!; return new Response('synthetic body'); }) as typeof fetch;
    const response = await fetchWithTimeout('https://not-dispatched.invalid/', { signal: a.signal });
    expect(await response.text()).toBe('synthetic body');
    // A success with a body retains its cancellation bound until the original
    // timeout expires; there is no attempt to clone or eagerly consume a body.
    expect(a.count()).toBe(1); expect(b.count()).toBe(1);
    caller.abort(new DOMException('synthetic caller', 'AbortError'));
    expect(sent.aborted).toBe(true); expect(sent.reason.name).toBe('AbortError');
    expect(a.count()).toBe(0); expect(b.count()).toBe(0);
  });
});

test('fallback preserves timeout reason after headers and releases both source listeners', async () => {
  await withoutNativeAny(async timeout => {
    const caller = new AbortController(), a = trackedSignal(caller), b = trackedSignal(timeout);
    let sent!: AbortSignal;
    globalThis.fetch = (async (_url: any, options: RequestInit) => { sent = options.signal!; return new Response('synthetic'); }) as typeof fetch;
    await fetchWithTimeout('https://not-dispatched.invalid/', { signal: a.signal });
    timeout.abort(new DOMException('synthetic timeout', 'TimeoutError'));
    expect(sent.aborted).toBe(true); expect(sent.reason.name).toBe('TimeoutError');
    expect(a.count()).toBe(0); expect(b.count()).toBe(0);
    caller.abort(); expect(sent.reason.name).toBe('TimeoutError');
  });
});

test('fallback passes an already-aborted caller through without retaining listeners', async () => {
  await withoutNativeAny(async timeout => {
    const caller = new AbortController(), a = trackedSignal(caller), b = trackedSignal(timeout);
    caller.abort(new DOMException('already cancelled', 'AbortError'));
    globalThis.fetch = (async (_url: any, options: RequestInit) => { throw options.signal!.reason; }) as typeof fetch;
    await expect(fetchWithTimeout('https://not-dispatched.invalid/', { signal: a.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(a.count()).toBe(0); expect(b.count()).toBe(0);
  });
});

test('network rejection and synchronous fetch failure both clean up fallback subscriptions', async () => {
  await withoutNativeAny(async timeout => {
    const caller = new AbortController(), a = trackedSignal(caller), b = trackedSignal(timeout);
    globalThis.fetch = (async () => { throw new TypeError('synthetic network failure'); }) as typeof fetch;
    await expect(fetchWithTimeout('https://not-dispatched.invalid/', { signal: a.signal })).rejects.toThrow('synthetic network failure');
    expect(a.count()).toBe(0); expect(b.count()).toBe(0);
    globalThis.fetch = (() => { throw new TypeError('synthetic synchronous failure'); }) as typeof fetch;
    expect(() => fetchWithTimeout('https://not-dispatched.invalid/', { signal: a.signal })).toThrow('synthetic synchronous failure');
    expect(a.count()).toBe(0); expect(b.count()).toBe(0);
  });
});

test('bodyless fallback success cleans up immediately without altering the Response', async () => {
  await withoutNativeAny(async timeout => {
    const caller = new AbortController(), a = trackedSignal(caller), b = trackedSignal(timeout);
    const response = new Response(null, { status: 204 });
    globalThis.fetch = (async () => response) as typeof fetch;
    expect(await fetchWithTimeout('https://not-dispatched.invalid/', { signal: a.signal })).toBe(response);
    expect(a.count()).toBe(0); expect(b.count()).toBe(0);
  });
});

test('absence of native any does not change the timeout-only request path', async () => {
  await withoutNativeAny(async timeout => {
    let sent!: AbortSignal;
    globalThis.fetch = (async (_url: any, options: RequestInit) => { sent = options.signal!; return new Response('synthetic'); }) as typeof fetch;
    await fetchWithTimeout('https://not-dispatched.invalid/');
    expect(sent).toBe(timeout.signal);
  });
});
