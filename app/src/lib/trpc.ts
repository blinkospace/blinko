import { createTRPCClient, httpBatchLink, httpLink, splitLink, httpBatchStreamLink } from '@trpc/client';
import type { AppRouter } from '../../../server/routerTrpc/_app';
import type { TRPCClient } from '@trpc/client';

// Preserve the complete legacy API while keeping declarations portable. Inferred
// client types otherwise expand provider internals (including nested SDK copies).
export type BlinkoApi = TRPCClient<AppRouter>;
import superjson from 'superjson';
import { getBlinkoEndpoint, subscribeBlinkoEndpointChange } from './blinkoEndpoint';
import { fetchWithTimeout } from './requestFetch';
import { RootStore } from '@/store';
import { UserStore } from '@/store/user';
const headers = () => {
  const userStore = RootStore.Get(UserStore);
  const token = userStore.token;
  const baseHeaders: Record<string, string> = {};

  if (token) {
    baseHeaders['Authorization'] = `Bearer ${token}`;
  }

  return baseHeaders;
};


const getLinks = (useStream = false) => {
  try {
    if (useStream) {
      return httpBatchStreamLink({
        url: getBlinkoEndpoint('/api/trpc'),
        transformer: superjson,
        headers,
        // Increase timeout for large file uploads (5 minutes)
        fetch(url, options) {
          return fetchWithTimeout(url, options);
        }
      });
    }

    return splitLink({
      condition(op) {
        return op.context.skipBatch === true;
      },
      true: httpLink({
        url: getBlinkoEndpoint('/api/trpc'),
        transformer: superjson,
        headers,
        // Increase timeout for large file uploads (5 minutes)
        fetch(url, options) {
          return fetchWithTimeout(url, options);
        }
      }),
      // when condition is false, use batching
      false: httpBatchLink({
        url: getBlinkoEndpoint('/api/trpc'),
        transformer: superjson,
        headers,
        // Increase timeout for large file uploads (5 minutes)
        fetch(url, options) {
          return fetchWithTimeout(url, options);
        }
      }),
    });
  } catch (error) {
    console.error(error, 'trpc get links error');
    return splitLink({
      condition(op) {
        return op.context.skipBatch === true;
      },
      true: httpLink({
        url: ('/api/trpc'),
        transformer: superjson,
        headers,
        // Increase timeout for large file uploads (5 minutes)
        fetch(url, options) {
          return fetchWithTimeout(url, options);
        }
      }),
      // when condition is false, use batching
      false: httpBatchLink({
        url: ('/api/trpc'),
        transformer: superjson,
        headers,
        // Increase timeout for large file uploads (5 minutes)
        fetch(url, options) {
          return fetchWithTimeout(url, options);
        }
      }),
    });;
  }
};

//@ts-ignore
export let api: BlinkoApi = createTRPCClient<AppRouter>({
  links: [getLinks(false)],
});

//@ts-ignore
export let streamApi: BlinkoApi = createTRPCClient<AppRouter>({
  links: [getLinks(true)],
});

/**
 * refresh api
 * when need refresh auth status (login/logout)
 */
export const reinitializeTrpcApi = (): { api: BlinkoApi; streamApi: BlinkoApi } => {
  //@ts-ignore
  api = createTRPCClient<AppRouter>({
    links: [getLinks(false)],
  });

  //@ts-ignore
  streamApi = createTRPCClient<AppRouter>({
    links: [getLinks(true)],
  });

  // Existing plugins read this public field for note details and other legacy
  // routes. Keep it on the same server as the newly created services transport.
  if (typeof window !== 'undefined' && window.Blinko) window.Blinko.api = api;
  return { api, streamApi };
};

// Endpoint changes update transport bindings before plugins observe the new identity.
const stopEndpointUpdates = subscribeBlinkoEndpointChange(() => { reinitializeTrpcApi(); });
const hot = (import.meta as { hot?: { dispose(callback: () => void): void } }).hot;
hot?.dispose(stopEndpointUpdates);

