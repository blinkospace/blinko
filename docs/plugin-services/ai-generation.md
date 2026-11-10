# AI model catalog and non-streaming generation

Plugins reach these through the mounted SDK; the procedures themselves are
`pluginServices.ai.listModels` (query) and `pluginServices.ai.generateText`
(mutation), and both require an authenticated account.

```ts
import type { PluginServicesSdk } from 'blinko';

const services: PluginServicesSdk = window.Blinko.services;
const models = await services.ai.listModels();
const reply = await services.ai.generateText({
  messages: [{ role: 'user', content: 'Summarize these notes.' }],
  contextNoteIds: [12, 34],
  idempotencyKey: crypto.randomUUID(),
});
```

## Capability discovery and the endpoint agree

The `ai.listModels` and `ai.generateText` feature entries returned by
`capabilities()` use the same administrator policy row and model allowlist as
the endpoints. A capability entry is not a pre-authorization. Both endpoints
check their policy when called, and generation checks durable quota, concurrency
and rate before admitting a new request. Reading a capability does not reserve
capacity for a later call. Listing models does not reserve a generation budget
or occupy a generation slot.

Disabling a feature in administrator policy takes effect on the endpoint itself.
A disabled `ai.listModels` is refused before the catalog is read, and a disabled
`ai.generateText` is refused before model credentials are read.

## Model catalog

`ai.listModels` returns only permitted text models, reduced to a fixed public
shape: numeric host id, display name, provider display label, default flag and
three capability fields. `text` is a boolean, `streaming` is `false` for this
release, and `structuredOutput` is `null` because the host has not confirmed it.
The catalog carries no keys, endpoints, request headers, raw model identifiers
or provider configuration. This release does not offer structured output.

## Order of checks in `generateText`

Every step below happens before anything is sent to a provider:

1. Administrator policy gate for `ai.generateText`.
2. Credential-free catalog lookup of the requested or default text model, then
   the model allowlist check.
3. Context authorization, one note at a time: only the calling account's
   non-recycled notes are used. If any requested note is missing or inaccessible,
   the whole request is refused with `NOT_FOUND_OR_FORBIDDEN`.
4. Final message composition, then the input byte limit, fingerprint and
   reservation amount.
5. Durable idempotency, account budget, concurrency and rate admission.
6. Credentials and provider client construction, followed by the durable
   dispatch marker immediately before invoking generation.

Step 4 includes the explanation text, per-note `<note id="...">` tags and
separators added by the context block. Counting raw note bodies would omit that
content. Each context note is limited to 32 KiB of UTF-8 text; the administrator's
`maxInputBytes` also checks the final system and message bodies after composition.

## Reservation, settlement and the daily budget

The reservation formula is:

```text
UTF-8 bytes(final system + final message bodies)
  + 8 * (final message count + 1)
  + effective maxOutputTokens
```

The final message count includes the context block when present. The output
allowance uses the same effective limit passed to the generator. The fixed
8-byte per-message allowance estimates protocol framing; this calculation does
not implement a provider-specific tokenizer or establish a universal billing
upper bound.

For known usage, settlement replaces the reservation with the reported input
plus output tokens. An over-reservation can reduce admission capacity until
settlement releases the difference. If the provider reports unknown usage,
settlement retains the reservation amount as usage; an unknown dispatched
outcome keeps its reservation.

A new reservation is admitted only while reserved plus settled tokens fit the
daily account budget: default 200,000 tokens per UTC reservation day,
configurable up to 5,000,000. This gate is separate from generation concurrency
(default 2, `maxConcurrentGeneration`) and account request rate (default 20 new
requests per database minute, configurable up to 240). Rate windows are stored
in `plugin_service_rate` across processes and are shared with both note-based
and text-based vector queries. A request can pass one gate and be refused by
another. The ledger counts tokens, not a monetary charge.

An administrator may explicitly split bounded single-note reads from this shared
frequency bucket; paid work still shares the original p quota with heavy local
operations. Defaults and existing counters are preserved. See
[account frequency policy](rate-policy.md) for configuration, migration and
same-window rollback. Concurrency refusal omits a wait hint when completion time
is unknown; frequency refusal reports the actual remaining database minute.

For ledger-managed generation and text queries, rate admission uses the same
transaction connection as the reservation, after concurrency and budget checks.
Only admitted requests consume that per-minute quota; an earlier admission
failure rolls back the counter together with the reservation.

## Idempotency

`idempotencyKey` is required for each generation managed by the durable call
ledger. The service stores the request fingerprint and outcome, not the
generated text.

- Same key, same fingerprint, already completed: `RESULT_NOT_RETAINED` and
  **no second provider call**. Results are not cached; a plugin that wants the
  text must keep it.
- Same key, different fingerprint: `IDEMPOTENCY_CONFLICT`.
- Same key, still running: `REQUEST_IN_PROGRESS`, retryable with `retryAfterMs`.

Recovery distinguishes a reservation that never dispatched from one that did.
An expired `reserved` row becomes failed with `TIMEOUT` and releases its budget
reservation. An expired `dispatched` row becomes `outcome_unknown`: later replay
returns `OUTCOME_UNKNOWN`, keeps the budget reservation and releases the
concurrency slot. Recovery does not automatically send the request again.

A dispatch marker can commit before its acknowledgement reaches the caller.
If that acknowledgement arrives after the deadline, the generator is never
invoked: the late marker handler settles the row as failed with `TIMEOUT` and
releases its reservation. The caller receives the timeout without waiting for
that database acknowledgement. If the write never returns, durable recovery
handles the remaining row conservatively; an already dispatched row can retain
its reservation as `outcome_unknown`. An in-flight database write is not forcibly
cancelled.

## Failure semantics

- Before dispatch, an unexpected fault becomes `INTERNAL_ERROR`. An explicit
  service error keeps its specific code, such as `CAPABILITY_UNSUPPORTED`,
  `MODEL_UNAVAILABLE`, `NOT_FOUND_OR_FORBIDDEN`, `INVALID_INPUT`, `RATE_LIMITED`
  or `BUDGET_EXCEEDED`.
- After dispatch, an unexpected fault becomes `PROVIDER_ERROR`. The failed call
  keeps its reservation as an unknown outcome; a provider failure is not
  converted to a successful generation with empty text.
- A `PaidCallError` raised by the caller or shared call machinery keeps its
  original code. Later replay of an unknown outcome returns `OUTCOME_UNKNOWN`.

`ai.generateText` is non-streaming only. Streaming, cancellation-driven partial
output and structured output are out of scope for this release.

## What this does not cover

The account budget, concurrency and rate controls apply to the new plugin
services. Pre-existing AI entry points such as the built-in chat and writing
flows keep their own behaviour and are **not** charged against this ledger, so
an operator should not read this as a site-wide spend cap. The SDK currently does
not upload `clientTag`, and this release does not persist per-plugin cost
attribution. A caller-supplied label or `pluginId` grants no permissions or extra
budget and does not isolate one plugin from another.

Coverage: `ai-generation.test.ts` (check ordering before credentials, context
authorization, final-message reservation, catalog shape, kill switch on the
endpoint), `governance.test.ts` (failure-closed policy, limit clamping, allowlist
semantics, reservation and settlement, replay decisions, failure-code
preservation), `contract.test.ts` and `sdk-examples.test.ts` (SDK surface and the
three example consumers). `db-sdk-host.test.ts` and `db-vector-query.test.ts`
exercise the same paths over the real root router and an isolated PostgreSQL
database through the mounted SDK. Their HTTP transport runs in memory; this is
not browser or production deployment coverage.
