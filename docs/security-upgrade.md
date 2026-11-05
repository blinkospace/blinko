# 1.8.9 upgrade guidance

Update the server and matching clients together. Back up persistent data and retain the previous application image before making deployment changes.

## Compatibility and configuration

- Existing authenticated sessions remain usable. Restart any unfinished sign-in flow after updating. Custom clients using two-step authentication must use the current client/server protocol.
- Existing stdio MCP configurations require server-operator approval through `BLINKO_MCP_STDIO_ALLOWLIST`. Supply a JSON array of exact command, argument and environment tuples. For example: `[{"command":"node","args":["/opt/blinko-mcp/server.js"],"env":{}}]`. Approve only operator-controlled programs. HTTP MCP transports retain their existing configuration behavior.
- Set `NEXT_PUBLIC_BASE_URL` or `NEXTAUTH_URL` to the public application origin.
- Refresh previously cached attachment responses at the CDN/proxy when applicable. New response headers do not expire previously cached objects automatically.
- Preserve database/file volumes, signing secrets and storage credentials throughout the upgrade.

## Database compatibility

This release introduces no Prisma schema, migration or seed-source changes. Isolated PostgreSQL 14.23 tests exercised old code, the updated code and old code again against synthetic legacy data. Account access and application data remained compatible in that test.

Normal runtime operations can still write authentication state and legacy metadata. No schema migration does not imply zero runtime writes. Do not reset databases or delete volumes as an upgrade or rollback step.

## Rollout checks

Verify actual account access, private/public/internal/protected sharing and owner export downloads in the target deployment. Apply the deployment's usual checks for external authentication, object storage and workload capacity.

The actual Linux amd64 release image passed isolated startup and API account/file/export checks. Complete browser/device and deployment-specific acceptance in the target environment before rollout.

## Rollback

Use the deployment's normal traffic controls and restore the previous matching application/client image while retaining persistent volumes. This patch requires no application database down migration.

Restart unfinished sign-in flows and verify account access, sharing and exports before restoring traffic. Prefer a forward correction where possible: a rollback also changes the protections supplied by the current release. Restore a database/file backup only for demonstrated data damage and a separately assessed recovery point.
