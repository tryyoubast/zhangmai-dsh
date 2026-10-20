# Agent Note: Replayable generation context snapshots

English | [中文](2026-10-20-generation-context-snapshots.zh.md)

Status: implemented

## Problem

Long-form retries could retrieve different or incomplete model context after a worker restart or source edit because persisted selections only identified source records.

## Decision

`ai.generation_context_items` stores each selected excerpt and its source lifecycle state with the existing rank, hash, token count, source identity, and selection reason. `LongformAuthoringService.selectAndRecordContext` writes the complete snapshot under the generation-run transaction lock, and `LongformGenerationService` passes the writer's saved result to the adapter or reconstructs retries and continuations from ordered snapshot rows. Archived and deleted candidates are excluded; published candidates rank first, while draft state is retained. Snapshot columns remain nullable for upgrade compatibility with pre-existing rows, but replay fails explicitly when a row has no snapshot. AI-created domain records remain drafts and publication stays in the independent review flow.

## Alternatives considered

**Persist source identifiers and hashes only.** This lost because source rows can be edited or deleted before a retry, so a hash cannot supply the exact model input.

**Rehydrate source records on retry.** This lost because it makes replay dependent on mutable source availability and state.

## Consequences

Migration `0012_generation_context_snapshots.sql` adds nullable `excerpt` and `source_status` columns with lifecycle and paired-null constraints; it does not alter workspace isolation, RLS, worker grants, or idempotency. Existing context rows remain readable but cannot be replayed unless their snapshot is present; new generation selections persist complete snapshots. Excerpts follow the generation-run retention policy, with no independent cleanup mechanism.
