# 1.8.9 maintenance notes

Blinko 1.8.9 includes maintenance improvements, security hardening and compatibility fixes. We recommend updating the server and matching clients together.

## Upgrade preparation

- Back up the database and file volumes and retain the previous application image.
- Keep server, web and native clients on matching versions. Restart unfinished sign-in flows after updating.
- Review server-operator approval for existing stdio MCP configurations.
- Configure the public application URL and refresh cached attachment responses where applicable.

This release adds no application database migration. See [upgrade guidance](security-upgrade.md) for configuration and rollback steps.

## Validation

The release passed 184 scoped regression tests, targeted policy-module type checks and frontend/backend production builds. An isolated PostgreSQL 14.23 fixture was used for legacy-data compatibility checks, and the actual Linux amd64 release image passed startup, account access, sharing and export checks.

Desktop and Android packages were built and their signatures/version metadata checked. Android retains the previous release signing certificate. The release's 15 downloadable files were checked against their published SHA-256 digests.

These checks do not cover every external OAuth/object-storage deployment, target-device interaction or production workload. Full-project TypeScript validation remains incomplete; targeted checks passed.

Issue-specific triage, reproduction details and CVE coordination are handled in the private reporting channels while review is in progress.
