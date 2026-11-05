# Agent Note: Atomic refresh-token replay revocation

Status: implemented

English | [中文](2026-11-04-atomic-refresh-token-replay-revocation.zh.md)

## Problem

Refresh-token rotation previously read token state in `RefreshTokenService` and then performed a conditional update in `PostgresAuthStore`. Two requests could both observe `used_at IS NULL`. The first request rotated successfully, while the second updated no row and threw. That exception did not execute the service's token-family revocation branch, so the winning replacement remained usable and the replay request could surface as HTTP 500.

Locking only the presented token also permits a cross-generation race: while T1 inserts T2 and waits to consume T1, replay of used T0 starts a family update whose snapshot excludes uncommitted T2. Waiting on T1 does not make that update discover T2, leaving a valid descendant after revocation.

## Decision

`RefreshTokenStore.rotate(tokenHash, replacement, now)` owns validation, rotation, replay handling, and result classification as one atomic persistence operation. `PostgresAuthStore` owns a top-level transaction with explicit `READ COMMITTED` isolation. A preliminary hash lookup discovers only the family identifier; it never authorizes rotation. The Store acquires `pg_advisory_xact_lock(hashtextextended('auth.refresh_token_family:' || familyId::uuid::text, 0))`, then re-reads the token in a separate `SELECT ... FOR UPDATE`. The UUID cast gives uppercase and lowercase inputs the same lock key. Each statement after waiting sees committed descendants.

`revokeFamily()` uses the same transaction lock. Every participating writer acquires the family lock before token row locks and writes, preventing different-generation deadlocks between rotations and revocations. Commit and rollback release the advisory lock. A hash collision can serialize unrelated families but cannot weaken revocation. `create()` issues the initial token in a fresh family; only `rotate()` creates descendants.

`resetPassword()` selects the user's token families in sorted UUID order, acquires each family lock, then updates the password, sessions, and refresh tokens. Its final token update runs as a separate `READ COMMITTED` statement after all locks are held, so it includes descendants committed while reset waited for a rotation.

Missing, expired, or revoked tokens return `invalid` without inserting a replacement or audit event. A valid unused token inserts its replacement first, then marks the old token used and records `replaced_by`; this order satisfies the existing immediate self-reference foreign key. A used token causes every unrevoked token in that family to receive `revoked_at`, then appends `auth.refresh_token_reuse_detected` to `security.audit_events` in the same transaction. The audit metadata contains only user, session, and token identifiers; it excludes raw tokens, token hashes, email, access tokens, and request headers.

`RefreshTokenService` generates replacement material before calling the Store. It returns the new raw token only for `rotated`; both `invalid` and `reused` become `null`. `AuthHttpController` consequently keeps the existing `401 {"error":"invalid_refresh_token"}` protocol without exposing token state. Unexpected database failures still propagate as service failures.

No schema migration is required. The change revokes only the replayed token's family, not the user's other sessions, and does not change access-token lifetime.

## Alternatives considered

### Keep service-level read then write

The service cannot preserve a database row lock across separate Store calls. A pre-write `used_at` check therefore remains stale under concurrency and cannot guarantee family revocation.

### Catch the conditional-update exception

Treating a zero-row update as an exception and catching it later still separates replay detection from family revocation. A crash or a second failure between those operations can leave a live replacement, and ordinary replay continues to look like an infrastructure error.

### Add only a conditional-update fallback

A conditional update can choose one winner, but it does not reveal a stable family identity to the losing request unless detection and revocation remain in the same transaction. Adding a follow-up lookup outside that transaction recreates the original race boundary.

### Lock only individual token rows

Tokens in different generations lock different rows. A family update can miss an uncommitted descendant, and replay transactions holding different token rows can deadlock while updating the family. The family advisory lock coordinates those rows without a schema change. The separate post-lock statements and explicit `READ COMMITTED` isolation avoid retaining a snapshot from before the lock wait.

### Encode the workflow as one large CTE

A data-modifying CTE could combine parts of the workflow, but row-lock sequencing, branching audit behavior, immediate foreign-key ordering, and result classification become harder to review and test. The explicit transaction keeps each invariant visible while providing the same atomicity.

## Consequences

- Concurrent use of one refresh token yields one `rotated` result and one `reused` result; after both complete, every token in that family is revoked.
- Normal replay returns 401 instead of 500 and writes one append-only security event.
- `RefreshTokenStore` implementations and test doubles must implement the atomic result contract; the public `findByHash()` seam is removed.
- The security event is part of the revocation transaction, so an audit insert failure rolls back family revocation and surfaces as a database failure.
- Callers provide the root database client rather than a nested transaction. Deployments drain old refresh requests and instances before enabling this implementation; every rotation and family-revocation implementation must participate in the family-lock protocol, so mixed versions do not provide its guarantee.
- Audit events remain append-only, including in test cleanup. Disposable test databases retain those events until the database is destroyed; mutable fixtures and temporary triggers are cleaned independently.

## Testing

Unit and Store-contract tests cover successful rotation, invalid tokens without writes, replay family revocation, exact secret-free audit metadata, audit-failure rollback, service mapping of `reused` to `null`, and HTTP mapping to 401. The PostgreSQL 18 suite uses independent restricted runtime pools and fixture-scoped trigger barriers in a separate two-integer advisory-lock namespace. It observes blocking relationships rather than relying on sleeps. The cross-generation regression fails on the row-lock-only implementation because T2 survives and passes with family serialization. The suite also checks same-token competition, both cross-generation orders, reset-versus-rotation ordering, two-generation replay without deadlock, active revocation, unrelated-family progress, audit rollback and lock release, and HTTP 200/401 behavior. PR CI provisions PostgreSQL 18, applies migrations through a restricted migrator login, and includes the suite in the required aggregate verdict. Production traffic and rolling deployments remain outside this test's coverage.
