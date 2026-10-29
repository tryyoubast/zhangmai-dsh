# Agent Note: Atomic email verification consumption and activation

Status: implemented

English | [中文](2026-10-29-atomic-email-verification-consumption-activation.zh.md)

## Problem

Email verification consumed a valid one-time token in one store call and activated the associated user in another. If activation failed after token consumption, the token could not be retried and the account remained pending.

## Decision

`AuthLifecycleStore` requires `consumeAndActivateEmailVerification(tokenHash, now): Promise<boolean>`; `UserAuthService.verifyEmail()` delegates to that single operation. `PostgresAuthStore` runs the token-consumption and user-activation `UPDATE … RETURNING` statements through one `db.transaction()` handle. A missing, expired, or already consumed token returns `false`. After consuming a token, an activation update that does not return exactly one user row throws, so the transaction rolls back the token update. The existing activation fields and user-id condition remain unchanged; the required interface has no legacy fallback.

Each implementation receives one timestamp for both updates. The PostgreSQL adapter preserves the prior result semantics while making token consumption and activation indivisible for callers. No schema migration is required.

## Alternatives considered

### Keep token consumption and activation as separate store calls

This is the behavior that caused the failure: the service cannot make two independent persistence operations atomic, so an activation error can strand a pending user with a consumed token.

### Retain a fallback to the two legacy methods

A fallback would allow stores that do not provide the atomic guarantee to continue passing capability checks and reintroduce the same partial-commit state. The lifecycle interface therefore requires the combined operation.

## Consequences

- A valid token and its account activation commit together; a missing token returns `false`, and a failed activation rolls back token consumption.
- Every `AuthLifecycleStore` implementation must implement the combined operation, including test doubles and downstream adapters.
- Token expiry, consumed-token handling, activation fields, and the existing user-id match are unchanged. Deployments need no database migration.

## Testing

The user-auth lifecycle tests cover successful verification, one-time use, expired and unknown tokens, and activation failure. PostgreSQL store tests verify that both updates use the transaction object and that a user-update miss rejects the transaction callback, preventing token consumption from committing.
