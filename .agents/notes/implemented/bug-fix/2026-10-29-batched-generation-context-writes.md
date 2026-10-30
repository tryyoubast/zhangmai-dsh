# Agent Note: Batched generation context writes

Status: implemented

English | [中文](2026-10-29-batched-generation-context-writes.zh.md)

## Problem

`recordContextItems()` performed a lookup and insert for every selected context source. Large context batches multiplied database round trips, and concurrent workers could still expose a unique-key error between those operations.

## Decision

`recordContextItems()` validates the complete input before opening a transaction, de-duplicates `(generationRunId, sourceType, sourceId)` in memory, and rejects a batch when the same key carries different durable content. The remaining rows are written with one multi-row `INSERT ... ON CONFLICT DO NOTHING RETURNING` using the existing source constraint.

When PostgreSQL returns no row for a requested key, the service builds one query for all missing keys and compares each persisted row with its workspace, novel, generation run, source identity, rank, excerpt hash, excerpt, source status, token count, and selection reason. A missing row or mismatch rejects the transaction, so rows inserted earlier in the batch are rolled back. Empty batches return without opening a transaction, and unrelated foreign-key, check, and business-unique errors remain database errors. The advisory lock in `selectAndRecordContext()` is unchanged. This extends the atomic retry semantics in [atomic AI idempotent draft writes](2026-10-29-atomic-ai-idempotent-draft-writes.md).

## Alternatives considered

**Per-row `INSERT ... ON CONFLICT` with per-row readback** retained the unique-key fix but preserved two round trips per context item, so it does not address the batch performance defect.

**Always reading the complete batch after the insert** simplified the query path but added a read on every successful write. Reading only keys absent from `RETURNING` keeps the normal path to one database round trip.

## Consequences

- A batch with N unique items uses one insert and, only when concurrent conflicts occur, one readback query.
- Duplicate keys with identical content are harmless; duplicate keys with different content fail before persistence.
- Conflict validation failure rolls back the entire transaction rather than leaving a partially recorded context set.
- The schema and migration history remain unchanged; PostgreSQL's existing unique constraint remains authoritative.

## Testing

`packages/storage/novel-authoring/tests/idempotency.spec.ts` verifies batch insertion, in-memory de-duplication, one-query conflict readback, the exact conflict target, pre-insert mismatch rejection, transaction rollback after a mismatched concurrent row, empty-batch behavior, and propagation of non-idempotent database errors.
