import { reaction } from 'mobx';
import type { UserStore } from '../user';
import { getBlinkoEndpoint, getSavedEndpoint, subscribeBlinkoEndpointChange } from '../../lib/blinkoEndpoint';
import { PluginHostContextRuntime } from './hostContext';

/** Read the host's actual HTTP service root, rather than the desktop WebView origin. */
function serviceRoot(): string | null {
  if (typeof window === 'undefined' || !window.location?.origin) return null;
  try {
    if ((window as unknown as { __TAURI__?: unknown }).__TAURI__) {
      const configured = getSavedEndpoint().replace(/"/g, '').trim();
      if (!configured) return null;
      const parsed = new URL(configured);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return null;
    }
    const url = new URL(getBlinkoEndpoint('/'));
    return /^https?:$/.test(url.protocol) ? `${url.origin}/` : null;
  } catch { return null; }
}

/** JWT expiry is an additional local bound, not signature verification or server authorization. */
function tokenExpiry(token: string | null, declared: unknown): number | null {
  const times: number[] = [];
  if (typeof declared === 'string') {
    const time = Date.parse(declared);
    if (Number.isFinite(time)) times.push(time);
  }
  if (token) {
    try {
      const part = token.split('.')[1];
      if (part) {
        const encoded = part.replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
        if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) times.push(payload.exp * 1000);
      }
    } catch { /* Opaque/non-JWT credentials still use the host's declared expiry. */ }
  }
  return times.length ? Math.min(...times) : null;
}

/** Owns MobX, storage, endpoint and page lifecycle listeners for one manager instance. */
export function createBrowserPluginHostContext(
  user: Pick<UserStore, 'id' | 'token' | 'tokenData' | 'requiresTwoFactor'>,
): PluginHostContextRuntime {
  let credential = user.tokenData?.value;
  let credentialToken = user.token;
  let credentialAccount = user.id;
  let credentialRevision = 0;
  let credentialService = serviceRoot();
  let runtime!: PluginHostContextRuntime;
  runtime = new PluginHostContextRuntime({
    read: () => {
      const currentService = serviceRoot();
      const value = user.tokenData?.value;
      if (value !== credential || user.token !== credentialToken || user.id !== credentialAccount) {
        credential = value;
        credentialToken = user.token;
        credentialAccount = user.id;
        credentialRevision++;
        credentialService = currentService;
      }
      return {
        accountId: Number(user.id) || null,
        token: user.token,
        serviceUrl: currentService,
        expiresAt: tokenExpiry(user.token, value?.expires),
        requiresTwoFactor: user.requiresTwoFactor,
        credentialRevision,
        // Changing servers does not transfer the old server's login to the new one.
        credentialsMatchService: credentialService === currentService,
      };
    },
    subscribe: notify => {
      const stopUser = reaction(
        () => [user.tokenData?.value, user.id, user.token, user.requiresTwoFactor, user.tokenData?.value?.expires],
        notify,
      );
      const stopEndpoint = subscribeBlinkoEndpointChange(() => {
        // The canonical setter invalidates the old persisted server login.
        // Reflect that in the same window too (storage events only reach peers).
        if (credentialService !== serviceRoot() && window.localStorage.getItem('blinkoToken') === null) {
          user.tokenData?.load();
        }
        notify();
      });
      const onStorage = (event: StorageEvent) => {
        if (event.key === 'blinkoToken' || event.key === null) {
          user.tokenData?.load();
          notify();
        }
      };
      const onShow = () => notify();
      const onHide = (event: PageTransitionEvent) => { if (!event.persisted) runtime.dispose(); };
      window.addEventListener?.('storage', onStorage);
      window.addEventListener?.('pageshow', onShow);
      window.addEventListener?.('pagehide', onHide);
      return () => {
        stopUser();
        stopEndpoint();
        window.removeEventListener?.('storage', onStorage);
        window.removeEventListener?.('pageshow', onShow);
        window.removeEventListener?.('pagehide', onHide);
      };
    },
  });
  return runtime;
}
