# Refresh Token Replay Revocation Design

**Status:** Approved implementation and acceptance specification

English | [中文](2026-11-06-refresh-token-replay-design.zh.md)

## Problem

The pre-P0 service reads a refresh-token record before entering the persistence mutation. Two requests can both observe an unused token. The winner consumes it and inserts a replacement; the loser then receives a conditional-update error. That error bypasses reuse handling, can become an HTTP 500, and leaves the winning replacement usable.

## Goals and boundaries

- Make refresh rotation, replay detection, family revocation, and replay audit one atomic store operation.
- Ensure a replayed token cannot leave any replacement in its family usable after both concurrent requests finish.
- Return the same 401 invalid_refresh_token response for unknown, expired, revoked, and reused credentials.
- Revoke only the affected refresh-token family. Keep access-token lifetime and unrelated sessions unchanged.
- Do not add or change database tables, indexes, or migrations.
- Never persist or log raw refresh tokens, token hashes, access tokens, email addresses, or authorization headers in the replay audit.

## Persistence protocol

RefreshTokenStore.rotate(tokenHash, replacement, now) owns the full operation. The service creates replacement token material before calling the store, but does not read persisted token state or make a separate revoke decision.

PostgreSQL performs the operation in a READ COMMITTED transaction:

1. Look up the token's user and family identifiers by its unique hash. Return invalid when no row exists; the lookup does not establish credential validity.
2. Lock the user row FOR KEY SHARE, then acquire a transaction-scoped advisory lock derived from the family identifier. The family key uses hashtextextended with the dsh:auth:refresh-family: namespace and seed 0.
3. Re-read the token in a new SQL statement and lock its row with FOR UPDATE. The fresh READ COMMITTED statement sees changes committed while waiting for the family lock.
4. Return invalid without writes for expired or revoked tokens.
5. For an already-used token, revoke every still-active row in the family, append exactly one reuse audit event, and return reused. The revocation and audit commit together.
6. For an unused token, insert its replacement first, then set used_at and replaced_by on the consumed row. Return rotated with persisted identity fields.

Initial issuance and explicit family revocation use the same user KEY SHARE and family advisory locks. Password reset locks the user FOR UPDATE before enumerating and locking existing families in sorted order. The exclusive user lock prevents concurrent issuance or rotation from changing the family set during enumeration. All paths preserve user-to-family-to-token lock order; different families can otherwise rotate concurrently.

The result is a discriminated union of rotated, invalid, and reused. Database failures reject and roll back the transaction; normal credential rejection does not use exceptions.

## HTTP and audit behavior

The refresh service maps both invalid and reused to null, so callers cannot distinguish token state. The HTTP controller returns 401 {"error":"invalid_refresh_token"}. Infrastructure or audit-write failures remain service failures and are handled by the existing generic availability response.

The reuse audit has workspaceId null, actorType system, actorId auth.refresh_token_service, action auth.refresh_token_reuse_detected, targetType refresh_token_family, and targetId equal to the family ID. Metadata is limited to userId, sessionId, and tokenId. createdAt uses the time passed to rotate; the event is written in the same transaction as family revocation.

## Repository CI and PR policy

The P0 acceptance requires a dedicated PostgreSQL 18 Actions job. A temporary superuser applies only baseline 0001 and ownership bootstrap; a separate non-superuser inheriting only dsh_migrator applies 0002–0014. Tests use another non-superuser inheriting only dsh_auth_runtime. The job participates in all checks passed without a conditional skip or continue-on-error.

Three commits separate portable CI prerequisites, the independent PR metadata policy, and the P0 fix. CI uses hosted Linux and Windows runners by default, with explicit enterprise/failover configuration. Package constraints and exact database publication payloads are repaired without dependency upgrades or migration edits. The [CI decision](../../../.agents/notes/implemented/process/2026-11-09-portable-ci-prerequisites.md) owns runner and package details.

The required Issue policy check validates current-repository PR labels and review state with a read-only token. It does not parse the PR body, query Issues or Projects, or require an Issue reference. Issue/Project automation and Cloudflare deployment are opt-in; Cloudflare still builds when deployment is disabled. The [PR policy decision](../../../.agents/notes/implemented/process/2026-11-09-portable-pr-metadata-and-optional-project.md) owns permissions and activation conditions.

## Alternatives

- Locking only the presented token row does not serialize a stale-token replay against a different descendant row being rotated or inserted. A family-level lock is required to cover the aggregate.
- Catching the conditional-update exception cannot reliably identify the transaction state and does not make family revocation atomic with the winning replacement.
- A complex single-statement CTE obscures the required fresh post-lock read and the insert-before-self-reference ordering. A short explicit transaction makes both invariants reviewable.
- Serializable isolation would add retry behavior without replacing the need for a consistent family-wide mutation protocol.

## Verification

- Unit tests cover service result mapping and HTTP 401 behavior.
- Real PostgreSQL integration tests require explicit runtime and migration URLs pointing to the same isolated database whose name contains test. Missing or mismatched values fail; no production .env is loaded.
- Two independent runtime connections, a control transaction, test-only triggers, and observed database lock waits arrange both race orders without a fixed delay.
- Tests assert no promise rejection for a normal replay, no second active replacement, revocation of every family row, one append-only audit event, and rollback of revocation when audit insertion fails.
- Tests cover stale-ancestor replay, explicit family revocation, and password reset racing with rotation in both orders. Other families and users remain unaffected by replay revocation.
- Red tests run against the pre-fix implementation, and an ancestor/descendant negative control temporarily removes the family lock and must fail. All temporary mutations are restored before acceptance checks.
- Fixture cleanup releases control transactions, removes test triggers/functions, and closes connections in finally. Append-only audits remain until the disposable database is destroyed.
- Required checks include the user-auth unit suite, real PostgreSQL suite, the dedicated PostgreSQL 18 Actions job, typecheck, lint, and documentation gates.

P0 is resolved only after real concurrency tests and every required CI check pass. The [implemented decision](../../../.agents/notes/implemented/bug-fix/2026-11-09-refresh-family-transaction-locks.md) records the persistence rationale; the [authentication subsystem](../../subsystems/identity-auth.md) owns source-equivalent types. Verification results belong in the delivery report, not this specification.
