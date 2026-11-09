---
description: "Workspace-scoped PostgreSQL services for AI novel drafts and long-form context."
kind: "package-library"
---

# @deepseek-ai/dsh-novel-authoring

English | [中文](README.zh.md)

## Summary

Callers can persist workspaces and novels, queue AI generation, save character and location drafts, and publish after separate review. Generation retries replay recorded context, while PostgreSQL retains chapters and versions. The host supplies authenticated principals, a database, and model and external-storage adapters; models return structured drafts for fixed entity types.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The host composes authoring services through the [public exports](src/index.ts) and injects the database, authenticated principal, and generation adapters; this library has no plugin mount.

### Security contract

User services may enqueue a generation run and review drafts. Only a separately authenticated agent principal may advance a run or materialize proposals and `draft` records; it cannot review, approve, publish, or roll back content. Idempotency keys make retries safe within a workspace. Publication is a separate reviewer-controlled transaction with workspace permission checks, proposal/target locks, optimistic-version checks, and immutable audit events.

The service accepts only validated structured input. It never executes model-supplied SQL or DDL, and every database operation runs through the authenticated transaction context. Cross-workspace inputs are rejected before persistence and enforced again by PostgreSQL constraints and RLS.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This host-only package provides workspace and novel lifecycle services, fixed-entity draft writers, proposal review/publication boundaries, chapter/version persistence, and generation-context recording. Every write uses the authenticated principal and transaction-local PostgreSQL RLS context.

`NovelAuthoringService` creates queued generation runs for authenticated editors. A separately composed worker principal creates proposals and idempotent draft records for outlines, characters, skills, locations, factions, items, storylines, character-skill links, generic entity relations, chapter summaries, story facts, and timeline events. These are records in versioned, pre-existing tables; the model never creates PostgreSQL tables.

`WorkspaceAuthoringService` manages workspace and novel creation, membership invitations and revocation, role changes, ownership transfer, and archive/restore operations. `ProposalReviewService` binds generated proposals to draft targets and supports approve, reject, and reopen transitions. `ProposalPublicationService` calls the database-owned publication and rollback transactions after reviewer authorization.

`LongformAuthoringService` persists chapter drafts, chapter versions, summaries, and the exact context items selected for a generation run, including each model-visible excerpt and the source lifecycle state at selection time. It validates SHA-256 and byte counts, stores small bodies as PostgreSQL text, and requires object-storage metadata for bodies over 1 MiB. Persisted chapter, summary, fact, timeline, and context records allow continuation after a browser or process restart.

`LongformGenerationService` provides the provider-neutral generation boundary. It retrieves workspace-scoped candidates, ranks and records the exact context used by a run, validates structured draft-only adapter output, and deduplicates retries by an idempotency key. If context was persisted before a process interruption, a retry reuses that context instead of silently selecting a different one. `DeepSeekNovelGenerationAdapter` supplies a fetch-based structured JSON adapter, `GenerationMaterializationService` maps validated records to fixed draft tables and review proposals, and `NovelGenerationWorkflowService` coordinates run lifecycle, optional post-generation extraction, materialization, and safe failure codes. Hosts can inject the enrichment adapter to turn chapter output into reviewable summary, fact, and timeline draft records without granting the model SQL access.

`GenerationMaterializationService` also reuses a completed result in the current process and shares in-flight work for concurrent retries with the same workspace, novel, generation run, and idempotency key. A failed attempt is never cached as completed. After a process restart, the durable writer and database idempotency constraints remain the source of truth.

`validateNovelGenerationAdapterResult()` returns both `records` and `proposals` arrays after validation; an omitted array becomes empty. Materialization dispatches only the target types accepted by the shared guard. The result repository validates workspace and agent identity before entering either its ordinary request transaction or an existing idempotency transaction.

`isNovelDraftTargetType()` recognizes the existing fixed draft target types for HTTP and materialization callers. Provider arrays reject invalid elements rather than dropping them; materialization validates raw target and operation fields before invoking a writer. Optional durable-lock methods run on their repository object and may depend on its instance state. The PostgreSQL result repository acquires connections through their owning pool and releases each checked-out connection after its lock transaction settles.

Every AI-generated durable write uses `INSERT ... ON CONFLICT DO NOTHING RETURNING id` against its workspace-scoped idempotency constraint. A concurrent conflict is read back by the same unique key and compared against the workspace, novel, generation run, and request content; a matching row returns its existing ID, while key reuse with different content fails explicitly. Partial source-idempotency indexes use their `IS NOT NULL` conflict predicate. Context items are de-duplicated in memory, written with one multi-row insert against their existing `(generationRunId, sourceType, sourceId)` constraint, and only missing conflict keys are read back in one query; an inconsistent conflict rolls back the whole batch. No update is performed on an existing row, and unrelated business-unique violations still surface as database errors.

A generation request with `limit: 0` deliberately runs without context retrieval or context rows; callers should use a positive limit when continuation needs a persisted context selection.

`PostgresNovelContextRepository` is the production retrieval adapter. It reads outlines, chapters, summaries, facts, timeline events, and fixed novel entities inside `withRequestContext`, applies each source's GIN expression index before ranking with PostgreSQL full-text search, keeps excerpts bounded, and verifies the stored hash before a new snapshot is written. Retries and continuations replay the database snapshot in rank order without reading the source entities again. The host still supplies the actual LLM adapter and a durable result repository; production result repositories must implement `withIdempotencyLock` or an equivalent database-backed claim.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [PostgreSQL library](../../database/database-postgres/README.md): fixed entity tables and publication constraints.
- [HTTP adapter](../../api/novel-authoring-http/README.md): browser and worker access.

-----

<a id="model-experience"></a>
## Model Experience

### DeepSeek structured generation

#### What the model sees

`DeepSeekNovelGenerationAdapter` sends the fixed system instruction below and user JSON containing the writing instruction, workspace/novel/run IDs, idempotency key, and selected context. Each context item includes source identity, status, hash, token count, and an excerpt bounded by the configured character limit. The API key belongs only in the HTTP Authorization header, outside messages.

##### Fixed system instruction

```markdown
Return only a JSON object with records and/or proposals. Use fixed target types, draft status only, and never return SQL, DDL, queries, migrations, credentials, or publication commands.
```

#### Token effect

Each actual provider call includes the fixed instruction and serialized dynamic input. Input tokens grow with the instruction, context item count, and excerpt lengths; item tokenCount values do not measure the complete request, and a character limit is not a model token limit. Retries replay persisted excerpts to avoid retrieval drift.

#### KV Cache effect

The system message stays stable; user JSON changes with instructions, identities, runs, idempotency keys, or context. Replaying a snapshot preserves excerpt content but does not guarantee the same prefix across runs or a cache hit. Providers own KV caching; this package does not manage a cache or promise hit rates.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The package does not include an actual object-storage client, a concrete summarization/fact-extraction provider, or a Web review UI. The workflow exposes an injected enrichment seam for those extraction models. The DeepSeek adapter requires a host-supplied API key and network policy; callers must persist object-storage content before submitting its metadata. The generation service provides deterministic bounded ranking and exact-context replay, but the caller still owns candidate retrieval, deployment routing, and publication UI.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
