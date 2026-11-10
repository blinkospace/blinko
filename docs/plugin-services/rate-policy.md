# Account frequency policy and single-note reads

All deployments default to the original combined account limit, including a missing policy row and an existing row without the new field. `maxRequestsPerMinute` remains p (default 20, administrator range 1–240). The new nullable administrator field `readNoteRequestsPerMinute` is disabled by default; an explicit integer r in 1–20 enables a separate read lane. This configuration is unrelated to plugin identity or device identity.

## Explicit administrator configuration

The authenticated superadministrator tRPC procedures remain `pluginServices.admin.getPolicy` and `pluginServices.admin.setPolicy`. There is no new settings screen or public error field. To request p=20, r=20, total=40, send `maxRequestsPerMinute: 20` and `readNoteRequestsPerMinute: 20`. Send `readNoteRequestsPerMinute: null` to disable splitting. These are operator actions, not automatic plugin behaviour.

Omitting the new field on an update preserves its current value, so older clients cannot accidentally enable or disable splitting. On first creation, omission stores NULL. The existing fields keep their prior replacement semantics: omitted old fields are still resolved as before. An operator preserving those values must carry forward the accepted fields from `getPolicy` (`limits`, `features`, `modelAllowlist`, `dailyTokenBudget`, `maxRequestsPerMinute`); do not spread internal `ok`/`problem` response fields into the strict input object. An unreadable or invalid policy fails closed.

## Admission and durable counters

- Combined mode: every admitted `create`, `sample`, `readNote`, note/text query or generation consumes one of the original p account requests.
- Split mode: only `vector.snapshots.readNote` uses r. Snapshot creation, sampling, both note query algorithms, text queries and generation share p. Paid work does not receive another p quota. Total admission is bounded by p+r.
- p=20/r=20 therefore admits at most 40 requests in a fixed database minute. The current consumer's initial flow uses three shared operations plus one read; each new step uses one shared query and one read. An ideal additional 17 steps uses 20 shared calls and 18 reads, total 38. Other account clients, details, restart and retries may consume more; this is not a promise of 17 steps or unlimited use.
- `capabilities`, index `status` and model discovery retain their existing behaviour. Snapshot `release` bypasses frequency admission, but authentication, input checks, database failures and timeouts can still prevent release. Expiration invalidates handles; later reserve/prune work performs physical cleanup.

Each account/window has one row in `plugin_service_rate`: `used` retains total admission, `readNoteUsed` and `sharedUsed` retain classifications. Both classifications are recorded even in combined mode. A single UPSERT serializes total and lane admission; rejected calls do not increment it. Mode changes, lower limits, restarts and administrator updates do not clear the row.

Disabling splitting restores the original combined p check against `used`. If split calls have already exceeded p, further calls are refused for the rest of the window. Re-enabling does not reset either lane. A lower r also lowers the total p+r bound; a shared call may be refused by that total even when its own lane has capacity.

The additive migration leaves old `used` unchanged. Unclassified usage is `used-readNoteUsed-sharedUsed`; it is conservatively charged against either lane, so deployment or an older writer cannot manufacture a fresh bucket. This can under-admit during the remainder of a migrated window. No operation uses a forged account id, per-plugin row or in-memory-only counter. Disabling splitting is the supported behavioural rollback; a schema downgrade must not discard the original `used` values.

## Paid operations and waits

The paid reservation, daily token budget, concurrency and idempotency gates are unchanged. New paid reservations enter the shared lane using the same PostgreSQL transaction connection; admission failure rolls back registration, budget and frequency together. Replays do not consume another slot. There is no second paid lane and no change to provider dispatch or unknown-outcome recovery.

Frequency windows use database statement time, not the beginning of a potentially long paid transaction. A frequency refusal returns the existing `RATE_LIMITED` and `retryAfterMs`, calculated from the remaining database minute rather than always 60000ms. The hint is positive and at most 60000ms; if the window rolls over between refusal and its read-only recheck, it is 1ms. The request is not silently retried. A concurrent account client may use capacity after the hint, so expiry only means the user can try again.

Concurrency refusal has no reliable completion time: it retains `RATE_LIMITED`/`retryable` but omits the optional `retryAfterMs`. Budget refusal remains `BUDGET_EXCEEDED`; it is not a frequency countdown. HTTP/error DTO formats are unchanged, with no HTTP 429 migration, new error fields, automatic retry or plugin exception.

The single-note 4MiB UTF-8 bound, computation/time limits, snapshot quotas and permission/content checks continue to apply. Separate frequency accounting is not a claim that all bodies are cheap. Evidence includes real-PG combined p=1/20/240, split concurrent admission, multiple processes, existing-row migration, toggles/rollback/restart, actual admin calls, shared paid quotas with a one-connection pool, and four simultaneous exact-4MiB Unicode reads with oversized and foreign-read rejection. The large-body fixture seeds an immutable snapshot directly: it tests the read path, not indexing or full-corpus creation at that size.
