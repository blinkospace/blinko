# Security patch upgrade and rollback

This patch is based on public 1.8.8 (`b2586d03`). It must be reviewed and released as a coordinated server/frontend update. Passing the checks below is scoped evidence, not a guarantee for every deployment.

## Database and rollback evidence

- No Prisma schema, migration or seed source changes; the lockfile and runtime dependency declarations are unchanged.
- An isolated PostgreSQL 14.23 database received the original 30 migrations and synthetic old-format data: 7 accounts and 10,007 notes.
- The same database was used by old code, patched code, then old code again in independent processes. The patch migration deploy reported no pending migrations.
- All three phases passed actual `koray` password login, authenticated profile, private-note lookup and private-attachment download. The existing legacy session remained present.
- Nine application-table digests were identical across phases: notes, attachments, messages, conversations, internal shares, providers, models, plugins and MCP configurations.
- The patched phase created a pending 2FA challenge in the existing session table. The legacy phase could still read its normal session and application data with that row present.
- This test does not assert zero database writes: login writes account authentication state, pending challenges use session rows, and the unchanged startup seed may update legacy metadata and fonts.

## Coordinated upgrade requirements

1. Ship the frontend and backend together. Existing authenticated sessions remain valid, but old pending 2FA logins must restart. Clients implementing 2FA must send the new first-factor challenge; older native or custom clients need the corresponding update before their users can complete a new 2FA login.
2. Inventory enabled stdio MCP configurations before rollout. The operator must explicitly approve required command/arguments/environment tuples using `BLINKO_MCP_STDIO_ALLOWLIST`. Without approval those configurations are intentionally denied, including existing saved configurations. HTTP MCP transports retain their existing behavior. Keep operator approval separate from ordinary web administration.
3. Configure the public application origin for RSS/Atom, and expire old publicly cached attachment responses. Newly served attachments are private/no-store; changing headers does not purge old CDN entries.
4. Preserve database and file volumes, signing secrets, and storage credentials. Retain an immutable previous application image and the matching client build. Do not run reset, seed-repair SQL, volume deletion or inverse migrations as an automatic rollback step.

## Release acceptance gates

- Local regression: 165 security tests across 15 isolated suites pass. Frontend and backend production bundles passed in the prior acceptance round.
- Scoped browser acceptance already passed: actual ordinary-user login and session refresh, old note rendering, owner-only export download and anonymous protected-share inline/fullscreen media.
- Server-wide TypeScript validation remains incomplete: a fresh 6GB check was stopped after a 180-second timeout without a result. A build is not a full type check.
- Real external OAuth, live object-storage deployment, native packages, full job startup and deployment-specific load acceptance are not established by these checks.
- Do not mark the change release-ready until the coordinated client/MCP requirements are accepted and the required deployment gates are satisfied.

## Rollback procedure

Stop new traffic/background work using the deployment's normal controls, retain persistent volumes, and redeploy the previous matching application/frontend image. No database down migration is required by this patch. Restart incomplete 2FA flows and verify actual login, private/public/internal/protected attachment access and owner export downloads before restoring traffic.

Reverting to the vulnerable version also restores its security weaknesses. Prefer a forward correction; if rollback is necessary, restrict affected exposed functionality while preparing the corrected release. Database/file restoration is reserved for demonstrated data damage and a separately assessed recovery point, not a routine consequence of this patch.
