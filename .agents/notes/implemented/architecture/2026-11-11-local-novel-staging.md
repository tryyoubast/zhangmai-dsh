# Agent Note: Isolated novel-authoring staging profiles

Status: implemented

English | [中文](2026-11-11-local-novel-staging.zh.md)

## Problem

Authentication, authoring, generation, and publication services need an assembled HTTP application before their combined behavior can be verified. Unit tests alone do not exercise secure browser cookies, mail delivery, restricted runtime database roles, durable queue recovery, or saved context after a process restart.

## Decision

The [novel application bundle](../../../../packages/bundle/novel-app/README.md) supplies one host row for standalone startup-only `novel-api` and `novel-worker` profiles. Both start through the existing `dsh` launcher. The [host](../../../../packages/host/novel-host/README.md) composes existing domain services instead of introducing another authentication or generation implementation. API pools separately assume auth, app, and service roles; the worker uses only the worker role. The [local deployment](../../../../deploy/local-test/README.md) owns independent Compose infrastructure, immutable image selection, local credentials, and a CA trusted explicitly by its HTTPS client.

When Node exposes no optional Loader internals, the vendored fallback imports from its own directory and loses the profile's dependency location. The app-boot Include adapter uses `import-meta-resolve` and public ESM import from the configuration or explicit host base URL. Profile dependencies retain priority, including import-only exports; no global package links or vendor edits are required. The fallback selects `node`/`import` export conditions, so custom conditions remain a documented limitation.

PostgreSQL stores the complete generation request and result; Redis carries only workspace/run UUIDs. Persistence precedes notification. Notification failure returns 503, and the original request/key retries notification without another run. This retains the current schema while making the cross-system failure explicit.

A database-wide session advisory lock permits one active worker. Its serial consumer recovers pending messages before new messages, rechecks persisted authority for every delivery, and uses the existing atomic run claim. Terminal deliveries are acknowledged; interrupted running work is marked failed rather than calling the provider again. Losing the ownership connection stops intake and aborts the provider request. Disposal joins owned requests and deliveries before closing external resources.

The fixed model runs without a provider secret. Every ordinary Compose operation explicitly selects the internal endpoint; real acceptance alone overrides it within a separate, exclusively created two-task budget and restores the fixed endpoint after completion or failure. Held-model probes restart the worker even when submission or observation fails. Append-only audit and durable test volumes are retained; ordinary shutdown does not destroy them.

## Alternatives considered

**Start a separate service executable.** Another entrypoint bypasses profile composition and lifecycle ownership. The host remains a Cordis plugin mounted by the existing launcher.

**Store instructions or identities in Redis messages.** Duplicate data can diverge from saved requests and lets queue fields impersonate authority. Locator-only messages leave persistence and current identity checks in PostgreSQL.

**Automatically retry interrupted model calls.** A disconnected worker cannot prove that the provider did not bill or complete the first request. Marking the run failed makes the next paid generation an explicit user action with a new key.

**Add a transactional outbox.** It would require an additional durable schema and dispatcher beyond the approved local integration. The API instead reports notification failure and preserves idempotent client recovery; unattended recovery remains a limitation.

## Consequences

One worker executes at a time per database; horizontal scheduling and exactly-once provider billing are not promised. Runtime profiles lack migration and administrator credentials. Readiness checks required catalog capabilities rather than granting runtime access to the private migration journal. Deployment retains full checksum validation through the controlled migrator.

The acceptance script asserts business effects through HTTPS and supplements them with read-only database inspection and restricted worker denial probes. It separately runs the existing refresh-family concurrency suite and the new worker/workspace PostgreSQL suites. Results and image identities belong to ignored environment evidence; source-controlled CI requires the keyless Compose flow and does not claim real provider coverage.

Provisioning independently detects migration 0001 and its ownership journal so an interruption between their committed steps can resume. Existing logins receive their precise runtime-role grant again. A separate disposable PostgreSQL container verifies both interrupted states without replacing the retained acceptance databases.
