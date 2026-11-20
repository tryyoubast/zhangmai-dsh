# Agent Note: Persisted generation worker identity

Status: implemented

English | [中文](2026-11-11-generation-worker-identity.zh.md)

## Problem

A queue delivery identifies a workspace and run, but cannot authenticate its initiating user or source session. The restricted worker role cannot read authentication tables. Supplying user or session IDs from the message would let queue data establish authority and omit current revocation checks.

## Decision

Migration [0017](../../../../packages/database/database-postgres/migrations/0017_generation_worker_identity.sql) supplies a worker-only lookup with migrator ownership, a fixed search path, and no PUBLIC execution. PostgreSQL checks the actual worker role and configured agent context before joining the run to its matching valid session, active verified user, current write membership, and active workspace. The function returns six identity and state fields without authentication secrets or table grants.

[PostgresGenerationWorkerIdentity](../../../../packages/storage/novel-authoring/src/worker-identity.ts) opens a transaction with an initially unknown user and the host-configured agent. It returns a database-backed principal, novel, and state, or null. Its fixed official-client type describes worker execution; it does not assert the original session transport. Host parsing validates UUID locators and nonempty agent configuration. Each delivery resolves authority again before the existing atomic claim.

Migration [0021](../../../../packages/database/database-postgres/migrations/0021_settle_unavailable_generation_runs.sql) locks a matching pending run and rechecks the lookup before marking it failed. Failure uses a fixed error and the existing lifecycle audit in the same transaction. A usable identity retains the delivery. Missing, unrelated, and terminal runs may be acknowledged without exposing how they differ.

## Alternatives considered

**Read authentication tables as the worker.** Broad table access exposes authentication data beyond the six fields needed to execute one persisted run.

**Trust user and session fields in queue messages.** Queue locators locate records but do not prove current session validity, membership, or assignment.

## Consequences

Resolution reads a current database snapshot and does not claim the run, extend session validity, or reserve authority for subsequent operations. Atomic claims still decide which duplicate delivery executes. Credential theft and arbitrary SQL through a runtime login remain outside the trusted transaction-context model. Restricted PostgreSQL tests verify function ownership and grants, successful resolution, unchanged run state, authentication-table denial, and rejection after session, account, membership, workspace, or actor authority becomes unavailable. Fixtures retain audit history and use separate worker and migrator logins.
