# Agent Note: Atomic AI idempotent draft writes

Status: implemented

English | [中文](2026-10-29-atomic-ai-idempotent-draft-writes.zh.md)

## Problem

AI generation writers selected an existing row before inserting a new one. Concurrent workers could both observe no row, then one insert would win and the other would receive a unique-constraint error instead of completing the retry idempotently.

## Decision

All AI idempotent writers use `INSERT ... ON CONFLICT DO NOTHING RETURNING id` with the existing database constraint as the conflict target. A returned ID completes the write without a read. When PostgreSQL reports a conflict, the service reads the row by the same unique key and compares workspace, novel, generation run, and the method's key content fields. Matching content returns the existing ID; reuse of an idempotency key with different content throws an explicit entity-specific idempotency conflict. JSON fields use deep comparison and optional values compare as database `NULL`.

Generation runs and proposals target `(workspaceId, idempotencyKey)`. Draft tables target `(workspaceId, sourceIdempotencyKey)`; partial source-idempotency indexes include their `sourceIdempotencyKey IS NOT NULL` predicate. Context items target the existing `(generationRunId, sourceType, sourceId)` unique constraint and validate the persisted snapshot fields. Existing rows are never updated, and unrelated business-unique violations remain database errors. The advisory-locked context selection and generation-result repository are unchanged. No migration is required.

## Consequences

- Concurrent retries converge on one durable row without exposing a unique-key exception.
- A reused key cannot silently bind a different novel, generation run, or payload.
- A conflict read is only performed after the atomic insert reports no returned row; the normal path is one insert round trip.
- Existing schema constraints, RLS, transaction boundaries, and non-idempotent uniqueness behavior remain authoritative.

## Testing

`packages/storage/novel-authoring/tests/idempotency.spec.ts` covers direct insert IDs, concurrent conflict readback, content mismatch rejection, and partial-index conflict predicates. The package test suite and TypeScript checks validate the remaining table writers and context-item path.
