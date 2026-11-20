# Agent Note: Atomic AI idempotent draft writes

Status: implemented

English | [中文](2026-10-29-atomic-ai-idempotent-draft-writes.zh.md)

## Problem

AI generation writers selected an existing row before inserting a new one. Concurrent workers could both observe no row, then one insert would win and the other would receive a unique-constraint error instead of completing the retry idempotently.

Claiming a human generation request changes its worker assignment from `user-request` to the executing agent. Treating that mutable assignment as immutable request content rejects otherwise identical human retries after claim or completion.

## Decision

All AI idempotent writers use `INSERT ... ON CONFLICT DO NOTHING RETURNING id` with the existing database constraint as the conflict target. A returned ID completes the write without a read. When PostgreSQL reports a conflict, the service reads the row by the same unique key and compares workspace, novel, generation run, and the method's key content fields. Matching content returns the existing ID; reuse of an idempotency key with different content throws an explicit entity-specific idempotency conflict. JSON fields use deep comparison and optional values compare as database `NULL`.

Generation runs and proposals target `(workspaceId, idempotencyKey)`. Draft tables target `(workspaceId, sourceIdempotencyKey)`; partial source-idempotency indexes include their `sourceIdempotencyKey IS NOT NULL` predicate. Context items target the existing `(generationRunId, sourceType, sourceId)` unique constraint and validate the persisted snapshot fields. Existing rows are never updated, and unrelated business-unique violations remain database errors. The advisory-locked context selection and generation-result repository are unchanged. No migration is required.

Generation-run retries compare the novel, initiating user, source session, model, prompt version, normalized instruction, and context limit within the workspace's idempotency key. Human retries do not compare the assigned worker, so queued, running, or terminal runs retain the same ID. Agent retries also compare `agentPrincipalId` to their own identity. Ignoring assignment for human retries does not bypass user, session, immutable-input, or RLS checks and never resets the run's state.

## Alternatives considered

**Read before inserting.** The race described above remains possible because an absent row cannot reserve its unique key for another worker.

**Update the conflicting row.** `ON CONFLICT DO UPDATE` would modify an existing draft on retry, contrary to the writer's immutable retry behavior and explicit content-mismatch rejection.

**Compare worker assignment for every caller.** Claiming changes that field without changing the human request. Comparing it for agent callers preserves their binding while allowing the initiating user's identical retry.

## Consequences

- Concurrent retries converge on one durable row without exposing a unique-key exception.
- A reused key cannot silently bind a different novel, generation run, or payload.
- Human retries remain idempotent after worker assignment; agent retries remain bound to the assigned identity.
- A conflict read is only performed after the atomic insert reports no returned row; the normal path is one insert round trip.
- Existing schema constraints, RLS, transaction boundaries, and non-idempotent uniqueness behavior remain authoritative.

## Testing

[Idempotent-write tests](../../../../packages/storage/novel-authoring/tests/idempotency.spec.ts) cover direct insert IDs, concurrent conflict readback, content mismatch rejection, and partial-index conflict predicates. [Generation-retry tests](../../../../packages/storage/novel-authoring/tests/generation-run-retry.spec.ts) cover human retries across worker assignment and lifecycle states, immutable-input and initiating-user conflicts, and agent identity mismatches. [Restricted app PostgreSQL tests](../../../../packages/storage/novel-authoring/tests-postgres/workspace-identity.spec.ts) retry persisted assigned runs and verify that their ID, status, and worker remain intact. The package test suite and TypeScript checks validate the remaining table writers and context-item path.
