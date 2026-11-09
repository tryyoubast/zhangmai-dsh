# Agent Note: Transaction locks for refresh-token families

Status: implemented

English | [中文](2026-11-09-refresh-family-transaction-locks.zh.md)

## Problem

Reading an unused refresh token before the rotation transaction allows two requests to consume the same credential. A losing conditional update reports a persistence error without revoking the winner's replacement. Locking only that token row also leaves a stale ancestor's family revocation racing with a descendant's insertion.

## Decision

The [authentication store](../../../../packages/identity/user-auth/src/postgres.ts) owns rotation, replay classification, family revocation, and append-only audit insertion in one READ COMMITTED transaction. It locks the user row in KEY SHARE mode, takes a transaction-scoped advisory lock namespaced by family ID, and reads the token again in a new statement with FOR UPDATE. Every descendant insertion and explicit family revocation uses that protocol. Replacement insertion precedes the old token's self-referencing replaced_by update.

Password reset takes the user row FOR UPDATE before enumerating and locking families in sorted order. This conflicts with ordinary refresh operations' KEY SHARE locks, keeping the enumeration stable and retaining a single user-to-family-to-token lock order. Different families of the same user can otherwise rotate concurrently.

The store returns rotated, invalid, or reused. The service hides invalid/reused distinctions, and HTTP returns the same 401 for normal credential rejection. Audit failures roll back revocation and remain availability failures. The audit identifies only the family, user, session, and presented token record; credentials and hashes are excluded.

## Alternatives considered

**Conditional-update exception handling** cannot make a separate revoke decision atomic with descendant creation and couples credential rejection to transaction errors.

**Token row locks alone** serialize duplicate use of one row but do not serialize operations on separate ancestor and descendant rows in a family.

**Serializable transactions** require retry handling and still need consistent family mutation ownership. **A single CTE** obscures the fresh statement after lock acquisition and immediate foreign-key ordering.

## Consequences

Refresh mutations in one family serialize across processes. Password reset waits for in-flight refresh transactions, and refresh transactions wait for an in-flight reset. Transaction end releases advisory locks on commit or rollback; no session-level lock or persistent schema change is required. Every writer of refresh families must preserve this lock order.

The [PostgreSQL suite](../../../../packages/identity/user-auth/tests-postgres) uses independent restricted connections and observed database lock waits to exercise both race orders. Its required CI lane rejects missing test configuration. Access-token lifetime and unrelated sessions retain their existing semantics.
