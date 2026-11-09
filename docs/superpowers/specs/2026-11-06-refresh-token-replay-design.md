# Refresh Token Replay Revocation Design

**Status:** Approved design, pending document review

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

1. Look up the token's family identifier by its unique hash. Return invalid when no row exists.
2. Acquire a transaction-scoped advisory lock derived from that family identifier.
3. Re-read the token in a new statement and lock its row with FOR UPDATE. The fresh statement is required so a request that waited for the family lock sees the committed state.
4. Return invalid without writes for expired or revoked tokens.
5. For an already-used token, revoke every still-active row in the family, append exactly one reuse audit event, and return reused. The revocation and audit commit together.
6. For an unused token, insert its replacement first, then set used_at and replaced_by on the consumed row. Return rotated with persisted identity fields.

Every operation that can revoke or create descendants in a family must follow the same family-lock protocol. Operations spanning multiple families acquire locks in a deterministic sorted order. This includes explicit family revocation and password-reset-driven refresh-token revocation.

The result is a discriminated union of rotated, invalid, and reused. Database failures reject and roll back the transaction; normal credential rejection does not use exceptions.

## HTTP and audit behavior

The refresh service maps both invalid and reused to null, so callers cannot distinguish token state. The HTTP controller returns 401 {"error":"invalid_refresh_token"}. Infrastructure or audit-write failures remain service failures and are handled by the existing generic availability response.

Reuse audit action is auth.refresh_token_reuse_detected, with target type refresh_token_family. Metadata is limited to userId, sessionId, and tokenId; the event is written in the same transaction as family revocation.

## CI boundary

The P0 reimplementation includes a dedicated PostgreSQL 18 Actions job that provisions an isolated test database, applies the repository migrations with the migration role, and runs the real-store concurrency suite with the restricted runtime role. The job participates in the stable required-check verdict so a missing database environment cannot silently skip the P0 regression test.

Only CI wiring needed to provision PostgreSQL and run this regression suite is in scope. Repository-independent PR policy, Issue/Project workflow changes, and package-constraint edits from the previous CI work are not part of this design.

## Alternatives

- Locking only the presented token row does not serialize a stale-token replay against a different descendant row being rotated or inserted. A family-level lock is required to cover the aggregate.
- Catching the conditional-update exception cannot reliably identify the transaction state and does not make family revocation atomic with the winning replacement.
- A complex single-statement CTE obscures the required fresh post-lock read and the insert-before-self-reference ordering. A short explicit transaction makes both invariants reviewable.
- Serializable isolation would add retry behavior without replacing the need for a consistent family-wide mutation protocol.

## Verification

- Unit tests cover service result mapping and HTTP 401 behavior.
- Real PostgreSQL integration tests use two independent connections to force same-token contention and stale-ancestor versus descendant contention.
- Tests assert no promise rejection for a normal replay, no second active replacement, revocation of every family row, one append-only audit event, and rollback of revocation when audit insertion fails.
- Tests cover family revocation and password reset racing with rotation, proving these mutation paths share the family lock order.
- Required checks include the user-auth unit suite, real PostgreSQL suite, the dedicated PostgreSQL 18 Actions job, typecheck, lint, and documentation gates.
