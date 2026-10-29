---
description: "Workspace-scoped PostgreSQL services for AI novel drafts and long-form context."
kind: "package-reference"
---

# @deepseek-ai/dsh-novel-authoring

English | [中文](README.zh.md)

## Summary

This host-only package provides workspace and novel lifecycle services, fixed-entity draft writers, proposal review/publication boundaries, chapter/version persistence, and generation-context recording. Every write uses the authenticated principal and transaction-local PostgreSQL RLS context.

`NovelAuthoringService` creates queued generation runs for authenticated editors. A separately composed worker principal creates proposals and idempotent draft records for outlines, characters, skills, locations, factions, items, storylines, character-skill links, generic entity relations, chapter summaries, story facts, and timeline events. These are records in versioned, pre-existing tables; the model never creates PostgreSQL tables.

`WorkspaceAuthoringService` manages workspace and novel creation, membership invitations and revocation, role changes, ownership transfer, and archive/restore operations. `ProposalReviewService` binds generated proposals to draft targets and supports approve, reject, and reopen transitions. `ProposalPublicationService` calls the database-owned publication and rollback transactions after reviewer authorization.

`LongformAuthoringService` persists chapter drafts, chapter versions, summaries, and the exact context items selected for a generation run, including each model-visible excerpt and the source lifecycle state at selection time. It validates SHA-256 and byte counts, stores small bodies as PostgreSQL text, and requires object-storage metadata for bodies over 1 MiB. Persisted chapter, summary, fact, timeline, and context records allow continuation after a browser or process restart.

`LongformGenerationService` provides the provider-neutral generation boundary. It retrieves workspace-scoped candidates, ranks and records the exact context used by a run, validates structured draft-only adapter output, and deduplicates retries by an idempotency key. If context was persisted before a process interruption, a retry reuses that context instead of silently selecting a different one. `DeepSeekNovelGenerationAdapter` supplies a fetch-based structured JSON adapter, `GenerationMaterializationService` maps validated records to fixed draft tables and review proposals, and `NovelGenerationWorkflowService` coordinates run lifecycle, optional post-generation extraction, materialization, and safe failure codes. Hosts can inject the enrichment adapter to turn chapter output into reviewable summary, fact, and timeline draft records without granting the model SQL access.

`GenerationMaterializationService` also reuses a completed result in the current process and shares in-flight work for concurrent retries with the same workspace, novel, generation run, and idempotency key. A failed attempt is never cached as completed. After a process restart, the durable writer and database idempotency constraints remain the source of truth.

A generation request with `limit: 0` deliberately runs without context retrieval or context rows; callers should use a positive limit when continuation needs a persisted context selection.

`PostgresNovelContextRepository` is the production retrieval adapter. It reads outlines, chapters, summaries, facts, timeline events, and fixed novel entities inside `withRequestContext`, applies each source's GIN expression index before ranking with PostgreSQL full-text search, keeps excerpts bounded, and verifies the stored hash before a new snapshot is written. Retries and continuations replay the database snapshot in rank order without reading the source entities again. The host still supplies the actual LLM adapter and a durable result repository; production result repositories must implement `withIdempotencyLock` or an equivalent database-backed claim.

## Security contract

User services may enqueue a generation run and review drafts. Only a separately authenticated agent principal may advance a run or materialize proposals and `draft` records; it cannot review, approve, publish, or roll back content. Idempotency keys make retries safe within a workspace. Publication is a separate reviewer-controlled transaction with workspace permission checks, proposal/target locks, optimistic-version checks, and immutable audit events.

The service accepts only validated structured input. It never executes model-supplied SQL or DDL, and every database operation runs through the authenticated transaction context. Cross-workspace inputs are rejected before persistence and enforced again by PostgreSQL constraints and RLS.

## Model Experience

The package is host-side infrastructure. Model-generated content reaches it only as validated structured input; model code never receives SQL or PostgreSQL credentials. User-facing adapters can present draft, review, published, conflict, and rollback states without exposing SQL, JSON, roles, or migration details.

## Known Limitations and Deferred Work

- The package does not include an actual object-storage client, a concrete summarization/fact-extraction provider, or a Web review UI. The workflow exposes an injected enrichment seam for those extraction models. The DeepSeek adapter requires a host-supplied API key and network policy; callers must persist object-storage content before submitting its metadata. The generation service provides deterministic bounded ranking and exact-context replay, but the caller still owns candidate retrieval, deployment routing, and publication UI.
