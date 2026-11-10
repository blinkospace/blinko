import type {
  AbortLike, CallOptions, PluginFileUrlOptions, PluginFilesSdk,
  PluginHostContext, PluginHostContextSdk, PluginServiceErrorCode,
} from '../../../../shared/lib/pluginServices/v1';
import { fileUrl } from '../../lib/fileUrl';
import { createIdempotencyKey, PluginServiceCallError } from './services';

/** Private host inputs. Credentials never appear in the public context snapshot. */
export interface HostContextSource {
  accountId: number | null;
  token: string | null;
  serviceUrl: string | null;
  expiresAt: number | null;
  requiresTwoFactor?: boolean;
  /** A completed credential replacement can reset a previous authentication rejection. */
  credentialRevision?: number;
  credentialsMatchService?: boolean;
}

export interface HostContextEnvironment {
  read(): HostContextSource;
  subscribe?(listener: () => void): () => void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function failure(code: PluginServiceErrorCode, message: string): PluginServiceCallError {
  return new PluginServiceCallError({ code, message, requestId: createIdempotencyKey(), retryable: false });
}

let lifetime = 0;

/** One browser-host lifetime. No providers, database access, or identity network requests. */
export class PluginHostContextRuntime {
  private readonly lifetime = ++lifetime;
  private revision = 0;
  private source: HostContextSource | null = null;
  private snapshot!: PluginHostContext;
  private invalidAuthentication = false;
  private disposed = false;
  private timer: unknown;
  private readonly listeners = new Set<(value: PluginHostContext) => void>();
  private readonly subscriptionCleanups = new Set<() => void>();
  private readonly disconnect: () => void;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  readonly context: PluginHostContextSdk = {
    get: () => this.refresh(),
    subscribe: (listener, options) => this.subscribe(listener, options?.signal),
  };
  readonly files: PluginFilesSdk = { url: (path, options) => this.resolveFileUrl(path, options) };

  constructor(private readonly environment: HostContextEnvironment) {
    this.now = environment.now ?? Date.now;
    this.setTimer = environment.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = environment.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.refresh();
    this.disconnect = environment.subscribe?.(() => this.refresh()) ?? (() => {});
  }

  private normalize(value: HostContextSource): HostContextSource {
    let serviceUrl: string | null = null;
    try {
      const url = new URL(value.serviceUrl ?? '');
      if (/^https?:$/.test(url.protocol) && !url.username && !url.password) serviceUrl = `${url.origin}/`;
    } catch { /* No usable service address. */ }
    const id = Number(value.accountId);
    return {
      ...value,
      accountId: Number.isSafeInteger(id) && id > 0 ? id : null,
      token: typeof value.token === 'string' && value.token ? value.token : null,
      expiresAt: value.expiresAt !== null && Number.isFinite(new Date(value.expiresAt).getTime()) ? value.expiresAt : null,
      requiresTwoFactor: !!value.requiresTwoFactor,
      credentialRevision: value.credentialRevision ?? 0,
      credentialsMatchService: value.credentialsMatchService !== false,
      serviceUrl,
    };
  }

  private refresh(): PluginHostContext {
    if (this.disposed) return this.snapshot;
    let next: HostContextSource;
    try { next = this.normalize(this.environment.read()); }
    catch { next = { accountId: null, token: null, serviceUrl: null, expiresAt: null }; }
    const changed = !this.source || (Object.keys(next) as Array<keyof HostContextSource>)
      .some(key => next[key] !== this.source![key]);
    if (changed) this.invalidAuthentication = false;
    this.source = next;
    const authentication: PluginHostContext['authentication'] = !next.serviceUrl ? 'unavailable'
      : next.credentialsMatchService === false || next.requiresTwoFactor || !next.token || !next.accountId ? 'anonymous'
      : this.invalidAuthentication ? 'invalid'
      : next.expiresAt !== null && next.expiresAt <= this.now() ? 'expired' : 'authenticated';
    const expiresAt = next.expiresAt === null ? null : new Date(next.expiresAt).toISOString();
    const visibleChanged = changed || this.snapshot?.authentication !== authentication;
    if (visibleChanged) {
      this.revision++;
      this.snapshot = Object.freeze({
        identityKey: `host-context-${this.lifetime}-${this.revision}`,
        accountId: authentication === 'authenticated' ? next.accountId : null,
        serviceUrl: next.serviceUrl, authentication, expiresAt,
      });
    }
    this.scheduleExpiry();
    if (visibleChanged) this.notify();
    return this.snapshot;
  }

  private scheduleExpiry(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    if (this.snapshot.authentication !== 'authenticated' || this.source?.expiresAt == null) return;
    const delay = Math.min(2_147_483_647, Math.max(1, this.source.expiresAt - this.now()));
    this.timer = this.setTimer(() => { this.timer = undefined; this.refresh(); }, delay);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      try { listener(this.snapshot); } catch { /* One plugin must not break another listener. */ }
    }
  }

  private subscribe(listener: (value: PluginHostContext) => void, signal?: AbortLike): () => void {
    if (this.disposed || signal?.aborted) return () => {};
    const current = this.refresh();
    let active = true;
    const subscription = (value: PluginHostContext) => { if (active) listener(value); };
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      this.listeners.delete(subscription);
      this.subscriptionCleanups.delete(unsubscribe);
      signal?.removeEventListener('abort', unsubscribe);
    };
    this.listeners.add(subscription);
    this.subscriptionCleanups.add(unsubscribe);
    signal?.addEventListener('abort', unsubscribe);
    if (signal?.aborted) unsubscribe();
    if (active) {
      try { listener(current); } catch { /* Immediate emission has the same isolation as notifications. */ }
    }
    return unsubscribe;
  }

  private resolveFileUrl(path: string, options: PluginFileUrlOptions = {}): string {
    if (this.disposed) throw failure('ABORTED', 'The browser host context was disposed.');
    const current = this.refresh();
    if (typeof path !== 'string' || !path.trim()) throw failure('INVALID_INPUT', 'A file URL is required.');
    const raw = path.trim();
    if (/^blob:/i.test(raw) || /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(raw)) return raw;
    let url: URL;
    try { url = new URL(raw, current.serviceUrl ?? undefined); }
    catch { throw failure('INVALID_INPUT', 'The file URL is invalid.'); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
      throw failure('INVALID_INPUT', 'The file URL protocol is not supported.');
    }
    if (!current.serviceUrl) return url.href;
    return fileUrl(url.href, current.serviceUrl, {
      ...options, token: current.authentication === 'authenticated' ? this.source!.token : null,
    });
  }

  /** Guard all SDK I/O: abort on context replacement and discard even uncancellable late results. */
  async run<T>(invoke: (options: CallOptions) => Promise<T>, options?: CallOptions): Promise<T> {
    const before = this.refresh();
    if (this.disposed || options?.signal?.aborted) throw failure('ABORTED', 'The request was cancelled.');
    if (before.authentication !== 'authenticated') throw failure('UNAUTHENTICATED', 'Authentication required.');
    const controller = new AbortController();
    let rejectCancellation!: (error: unknown) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    let cancelledOnce = false;
    const cancel = () => {
      if (cancelledOnce) return;
      cancelledOnce = true;
      controller.abort();
      rejectCancellation(failure('ABORTED', 'The host identity or request lifetime changed.'));
    };
    const unsubscribe = this.context.subscribe(value => { if (value.identityKey !== before.identityKey) cancel(); });
    options?.signal?.addEventListener('abort', cancel);
    if (options?.signal?.aborted) cancel();
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (cancelledOnce) throw failure('ABORTED', 'The request was cancelled.');
          return invoke({ ...options, signal: controller.signal });
        }), cancelled,
      ]);
      if (this.refresh().identityKey !== before.identityKey) throw failure('ABORTED', 'The host identity changed.');
      return result;
    } catch (error) {
      if (this.refresh().identityKey !== before.identityKey) throw failure('ABORTED', 'The host identity changed.');
      if ((error as { code?: string })?.code === 'UNAUTHENTICATED') {
        this.invalidAuthentication = true;
        this.refresh();
      }
      throw error;
    } finally {
      unsubscribe();
      options?.signal?.removeEventListener('abort', cancel);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnect();
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.source = null;
    this.snapshot = Object.freeze({ ...this.snapshot, accountId: null,
      authentication: 'unavailable', identityKey: `host-context-${this.lifetime}-${++this.revision}` });
    this.notify();
    for (const cleanup of [...this.subscriptionCleanups]) cleanup();
  }
}
