# Agent Note: Proposal-bound candidates and atomic reviewed publication

Status: implemented

English | [中文](2026-11-12-proposal-bound-publication.zh.md)

## Problem

Generation proposals and draft entity versions need one durable identity before approval can authorize publication. A global entity/version uniqueness constraint makes independent proposals compete for an unpublished slot, while matching only a generation run and JSON content cannot distinguish two proposals. Publication also spans heterogeneous long-form tables, and its service role needs row visibility before it can update them.

## Decision

[Migration 0020](../../../../packages/database/database-postgres/migrations/0020_independent_proposal_publication.sql) reuses the eight entity version tables for proposal-bound candidates. `source_type = 'generation_proposal'` and `source_id = proposal.id` identify one candidate per proposal. The invoker synchronization trigger creates or synchronizes the candidate in the proposal transaction and validates its tenant, target, source run, author, expected version, and content. Only non-draft history reserves an entity/version number. Rejected and expired proposals retain their draft candidates; reopening a rejected proposal reuses the same row.

Publication uses target → proposal → candidate lock order, validates the exact approved proposal, publishes the existing candidate, projects its complete payload, advances the entity, and transitions the proposal in one transaction. Target locks use `FOR NO KEY UPDATE` so candidate inserts can acquire foreign-key key-share locks without reversing that order. The service does not lock workspace or novel parent rows it cannot access. Character-skill key endpoints remain immutable. The six long-form targets retain create-only publication with their actual columns and workspace-scoped service read policies.

Rollback appends a new published snapshot and restores the full supported entity payload. Pending candidates remain unchanged and become stale. Publication audit comes only from the proposal transition trigger; rollback appends its own event. An audit failure aborts the complete operation. The service's ordinary version-insert prohibition remains in force outside the controlled rollback context.

The forward migration preserves existing unbound versions and published history, backfills bound unpublished proposals from explicit generation-run ownership, and rejects provenance collisions. Its DDL has bounded lock and statement waits. [Local startup](../../../../deploy/local-test/manage.mjs) builds before stopping API and worker, migrates while both are stopped, then starts the new profiles; migration failure retains data and leaves consumers stopped.

[ProposalOperationError](../../../../packages/storage/novel-authoring/src/proposal-error.ts) classifies only dedicated SQLSTATE values P2001–P2004 through driver causes. The HTTP adapter maps missing, forbidden, conflicting, and invalid operations to 404/403/409/400; unclassified database failures remain redacted 500 responses.

The [context repository](../../../../packages/storage/novel-authoring/src/context-repository.ts) decodes raw PostgreSQL timestamp strings before calculating recency. Raw SQL bypasses Drizzle's column decoder; treating its result as a `Date` prevents continuation once stored entities match the instruction. Non-finite timestamps fail explicitly instead of entering context ranking.

Migration [0022](../../../../packages/database/database-postgres/migrations/0022_guard_proposal_publication_state.sql) checks the authenticated reviewer, published target projection and, for versioned entities, the exact published candidate before allowing the proposal status transition. A long-form target accepts only one published create proposal. The check runs with the existing service privileges.

## Alternatives considered

**One unpublished version per entity.** A rejected or stale candidate occupies the next slot and prevents another proposal or rollback from progressing. Independent candidates preserve choice without reserving publication history.

**Insert the published version from the service.** This bypasses the existing requirement to publish an exact draft and widens the service's write authority. Candidate synchronization remains under the original caller's privileges.

**Match approval by run and content.** Identical output from one run can belong to different proposals. The proposal UUID is the authorization identity, even when all payload bytes match.

**Turn every permission or serialization error into a conflict.** Those codes also identify broken grants, RLS configuration, and infrastructure failures. Dedicated business codes preserve observable service faults without exposing database text.

## Consequences

Multiple candidates coexist without occupying formal history. Exactly one candidate based on the current version can win publication; other approved candidates require regeneration against the new base. Candidate records remain durable after rejection or expiry. The migration replaces eight uniqueness constraints and adds synchronization and read policies; it requires an offline application upgrade and a recoverable backup. Long-form update/rollback and whole-generation atomic materialization remain outside this decision.

## Testing

[Restricted PostgreSQL regressions](../../../../packages/storage/novel-authoring/tests-postgres/publication.spec.ts) exercise candidate identity, publication, rollback, audits, permissions, and concurrent operations. The [upgrade regression](../../../../packages/storage/novel-authoring/tests-postgres/publication-upgrade.spec.ts) verifies 0019 history preservation, exact backfill, and rejection of reserved-key collisions. [Service errors](../../../../packages/storage/novel-authoring/tests/publication-errors.spec.ts) and [HTTP errors](../../../../packages/api/novel-authoring-http/tests/publication-errors.spec.ts) verify safe classification, unexpected failures, and normalized routes. [HTTPS acceptance](../../../../deploy/local-test/acceptance.ts) requires successful fourteen-target publication and exact 409 responses for competing and stale candidates before and after rollback.
