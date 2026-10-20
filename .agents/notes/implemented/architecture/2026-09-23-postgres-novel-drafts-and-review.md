# Agent Note: PostgreSQL novel drafts require reviewed publication

Status: implemented

English | [中文](2026-09-23-postgres-novel-drafts-and-review.zh.md)

## Problem

AI-authored novel data must remain reviewable, tenant-scoped, versioned, and unable to change the database schema. Authentication and novel data share PostgreSQL, so migration ownership, runtime grants, row-level security, and publication transitions must agree with the application model.

## Decision

PostgreSQL migrations define fixed tables for novels, characters, skills, locations, factions, items, storylines, character-skill links, and generic entity relations. Workers receive no DDL permission and write only draft records and draft versions tied to one workspace, novel, user, agent, generation run, and idempotency key. Character-skill links retain a dedicated relational table and have their own version history.

Reviewers save proposal and version edits before approving. The publication service updates the reviewed draft version in place, advances the entity version under optimistic concurrency, and publishes the proposal in one transaction. Database triggers require the approved proposal, unchanged proposed content, matching generation run, and expected base version. Proposal and generation-run lifecycle changes append audit events without copying prompts, authentication tokens, or raw error summaries.

The `@deepseek-ai/dsh-user-auth` package exposes the framework-neutral `AuthHttpController` routes for registration, email verification, login, logout, refresh, password reset, and current-user lookup. Browser sessions use the `__Host-dsh_session` cookie; official clients use EdDSA access tokens and rotating refresh tokens. Redis rate limiting and mail delivery remain injected adapters. `WorkspaceAuthoringService` owns workspace lifecycle and membership operations, while `ProposalReviewService` and `ProposalPublicationService` enforce reviewer-controlled proposal transitions, publication, and rollback.

The deployment role owns database objects and migrations. Runtime pools reject deployment roles, and PostgreSQL checks the active role grants before connections proceed. Transaction-local identity GUCs are trusted backend input; RLS does not protect against a compromised runtime credential or arbitrary SQL executed with that credential.

## Alternatives considered

**Let AI create tables through DDL.** Rejected because schema mutation expands the worker's authority beyond a novel workspace and makes application upgrades, review, and rollback unsafe. AI creates records in fixed domain tables.

**Store all relations in one polymorphic table.** Rejected for character-skill links because that relationship needs efficient relational constraints and a stable query path. Other extensible entity relationships remain in `entity_relations`.

**Keep only proposal JSON until approval.** Rejected because users need a normal draft record they can inspect and edit; the proposal remains the review snapshot and publication authorization.

## Consequences

The schema and migration journal remain explicit and reviewable, and failed or retried generation requests are idempotent within a workspace. Draft edits and published versions use separate status transitions, and prior versions remain available to a rollback operation. PostgreSQL integration tests still require a disposable database with the deployed roles; static tests cannot prove runtime RLS behavior or migration execution.

Long-form continuation uses fixed outlines, chapters, chapter versions, summaries, story facts, timeline events, and generation-context rows. Chapter bodies use PostgreSQL text for content up to 1 MiB and require object-storage metadata for larger bodies. The `0005` hardening migration adds lifecycle fields and publication guards for these records. User and agent authoring services persist idempotent drafts and context selections through transaction-local RLS settings; persisted context selections can be replayed after a browser or service restart. Materialization also reuses completed results in-process and shares concurrent retries; failed attempts are not cached, and process-restart safety remains the responsibility of durable database idempotency constraints. The package currently provides deterministic ranking of supplied context candidates, but not an LLM adapter, object-storage client, automatic summarization/fact extraction, or Web review UI.
