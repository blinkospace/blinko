# Browser host context and file URLs

Browser hosts can add two local capabilities alongside the server SDK:
`services.context` and `services.files`. Their capability keys are `host.context`
and `files.url`. Both fields are optional so older hosts and transport-only SDK
consumers keep their existing shape. Test for their presence before using them;
use server capability discovery separately for note querying and prepared snapshots.

## Identity lifecycle

`context.get()` returns an immutable local snapshot:

- `identityKey`: opaque browser-host lifetime/revision key; compare for equality,
  never parse it or persist it as an account identifier.
- `accountId`: numeric account ID only while locally authenticated; otherwise null.
- `serviceUrl`: canonical HTTP(S) service root, including the configured Tauri
  server instead of its WebView origin; null when unavailable.
- `authentication`: `authenticated`, `anonymous`, `expired`, `invalid` or `unavailable`.
- `expiresAt`: ISO timestamp or null. The earlier of the declared and decoded JWT
  expiries is a local bound; decoding a JWT does not verify its signature.

No credential is included. The snapshot is client-observed state. Every server
procedure still performs authoritative authentication, permission and ownership
checks. A pending second factor is anonymous. A server `UNAUTHENTICATED` failure
invalidates the observed login; a plain permission refusal does not invalidate
unrelated capabilities. New credentials can recover the local state.

```ts
const context = services.context;
if (!context || !services.files) {
  // Explain that this browser host does not provide the required capabilities.
  return;
}
let identityKey = context.get().identityKey;
const stop = context.subscribe(current => {
  if (current.identityKey !== identityKey) {
    identityKey = current.identityKey;
    clearDisplayedPrivateContent();
    discardCachedBodiesAndGeneratedImages();
  }
});
// In the plugin's destroy():
stop();
```

Subscription immediately emits the current value, then changes from observable
login state, peer-window storage, configured service changes, local expiry and
host disposal. A listener exception is isolated. The returned unsubscribe
function is idempotent; passing `{signal}` also permits abort-based cleanup.
A plugin must unsubscribe on destruction and clear private views even while idle.

The mounted SDK aborts in-flight service work on identity replacement, caller
cancellation or host disposal, and rejects late responses even when a transport
ignores cancellation. A plugin must still check the captured identity and its own
operation version after awaits, before UI/cache/share commits and between several
SDK calls. Legacy `window.Blinko.api` calls do not acquire these SDK guards; the
public API field does track the current tRPC client after reinitialization.

Changing a Tauri server through the canonical address setting clears its old
persisted login before publishing the new address. The same window, peer windows,
remounts and reloads therefore require a login for the replacement server. Rewriting
the same canonical origin retains its login. Transport URLs are rebound before
local identity listeners are notified. Expiry timers, browser listeners and caller
subscriptions are cleaned up when their owning host runtime is disposed.

The request helper retains the existing `AbortSignal.timeout` browser baseline.
It detects native `AbortSignal.any` before using it; otherwise an AbortController
forwards the first caller/timeout cancellation and removes both source listeners.
Network failures and bodyless responses remove fallback listeners immediately.
For a successful response with a body, fallback listeners remain bounded by the
original timeout (five minutes by default) or caller cancellation. This preserves
the native Response and streaming behavior without cloning, buffering or wrapping
the body merely to observe completion. Headers alone never trigger that cleanup.

## Files

```ts
const src = services.files.url('/api/file/example.png', { thumbnail: true });
const download = services.files.url('/api/s3file/example.pdf', { download: true });
```

The resolver uses the canonical service root and the current local authentication.
It adds credentials only to that server's `/api/file/` and `/api/s3file/` routes,
preserving share grants and file options. External URLs and other paths receive
no added login credential. HTTP(S), blob URLs and base64 PNG/JPEG/GIF/WebP data
images are accepted; executable schemes, HTML data URLs and credential-bearing
HTTP authorities are rejected. Invalid input produces the public `INVALID_INPUT`
error. Resolution performs no network request or provider call.

A resolved authenticated media URL necessarily carries its access credential for
browser image/navigation requests. Treat it as sensitive: keep it ephemeral,
never log it or put it into a public share image/link, and discard it when identity
changes. This local helper is not a plugin sandbox or a separate authorization
boundary. Callers cannot inject a token through its public options.

## Independent example and verification scope

The existing [similar-content example](./examples/similar-content/plugin.ts) adds
`checkPreparedNote(noteId)`: capability discovery, weighted snapshot creation,
existing-note comparison, same-version first-match inspection and cleanup. It
preserves the prepared-subset range and partial/unknown retrieval states, clears
an idle report on identity changes, and resolves attachments through `files.url`.
It imports no random-walk package or private host store. Its original text
comparison remains a separate, potentially charged embedding action.

The declaration checks compile that actual example against the locally packed
`blinko` archive. Unit tests use the actual SDK with synthetic transport. Browser
binding probes use real Chromium pages/storage notifications and streaming
loopback HTTP with synthetic accounts/service data. Those checks do not establish
full Blinko plugin installation, real backend/permission integration, Tauri native
execution, physical mobile devices or provider behavior; those need their own
integration evidence.
