---
description: "PostgreSQL and Drizzle foundation for multi-tenant authentication, workspaces, and AI novel authoring."
kind: "package-reference"
---

# @deepseek-ai/dsh-database-postgres

English | [中文](README.zh.md)

## Summary

This host-only package owns the PostgreSQL connection pool, Drizzle schema, and reviewed SQL foundation for the multi-user novel authoring platform. PostgreSQL is the production source of truth; the existing SQLite storage packages remain separate KV/session infrastructure.

## Configuration

Application startup requires `DATABASE_URL` for a non-superuser login that inherits exactly one selected `dsh_*_runtime` role. The package never falls back to SQLite, an in-memory database, or a local file.

```powershell
$env:DATABASE_URL = "postgresql://user:password@host:5432/dsh"
```

Optional pool settings are `DATABASE_POOL_MAX`, `DATABASE_IDLE_TIMEOUT_MS`, `DATABASE_CONNECTION_TIMEOUT_MS`, `DATABASE_APPLICATION_NAME`, and `DATABASE_RUNTIME_ROLE`. Values are validated before a pool is created. Do not commit the URL or credentials.

```ts
import { createDatabase } from '@deepseek-ai/dsh-database-postgres'

const database = createDatabase()
try {
  // Pass database.db to application services.
} finally {
  await database.close()
}
```

## Database layout

The migration journal contains twelve immutable entries. `0001_auth_workspace_novel_ai.sql` creates authentication, workspace, novel, AI-run, proposal, and audit tables; `0002_workspace_drafts_and_hardening.sql` adds workspace-consistent references, draft-only worker policies, lifecycle guards, and least-privilege grants; `0003_remove_redundant_prefix_indexes.sql` removes redundant prefix indexes; `0004_novel_longform_context.sql` adds outlines, chapters, chapter versions, summaries, facts, timeline events, and generation-context selections; `0005_longform_publication_hardening.sql` adds long-form lifecycle fields and publication guards; `0006_publication_and_rollback.sql` adds database-owned publication and rollback transactions; `0007_secure_rollback.sql` makes rollback an invoker-only service operation that appends a new version inside a tightly scoped transaction context; `0008_generation_results.sql` stores structured generation output under an idempotency key with worker-only draft writes; `0009_generation_queue_payload.sql` retains queued generation instructions and context limits for worker replay; `0010_generation_queue_claim.sql` lets a bound worker atomically claim a browser-created queued run; `0011_generation_claim_rls_hardening.sql` keeps that claim exception separate from the bound-worker write predicate for already-migrated databases; and `0012_generation_context_snapshots.sql` stores the exact context excerpts and source statuses used for generation replay.

AI creates records in these fixed tables and never receives PostgreSQL DDL permission. A new stable entity type requires a reviewed, versioned migration rather than model-generated SQL.

An administrator applies `0001` once, then runs [`scripts/bootstrap-migrator-ownership.sql`](scripts/bootstrap-migrator-ownership.sql) as a superuser. The bootstrap transfers the application schemas and migration journal to `dsh_migrator` and removes its role-creation capability. Create a deployment login that inherits only `dsh_migrator`; do not use `postgres` for routine deployments.

```sql
CREATE ROLE dsh_migration_login LOGIN PASSWORD 'managed-outside-source-control';
GRANT dsh_migrator TO dsh_migration_login;
```

```powershell
$env:DATABASE_MIGRATION_URL = "postgresql://dsh_migration_login:password@host:5432/dsh"
pnpm --filter @deepseek-ai/dsh-database-postgres db:migrate
```

Build the package before running its published migration entry point. `db:migrate` uses the packaged SQL journal and checksums through the controlled runner; production deployments must not use `drizzle-kit migrate`, `push`, or `DATABASE_URL` for DDL. `db:check` reads `DATABASE_MIGRATION_URL` for Drizzle's static journal check.

Runtime roles have no schema `CREATE`, `CREATEDB`, `CREATEROLE`, `SUPERUSER`, or `BYPASSRLS` capability. The service transaction sets `app.user_id`, `app.workspace_id`, `app.actor_type`, and `app.agent_principal_id` with transaction-local settings after authentication. This trusted service transaction context uses PostgreSQL GUCs; it does not defend against stolen runtime credentials or arbitrary SQL execution. Credentials and SQL access must not be exposed to model-generated SQL.

Workers can write draft records and draft versions in their bound workspace. Reviewers save proposal and draft-version edits first, then approve in a separate update. The publication service updates the same draft-version row, updates the entity's current version, then marks the proposal published in one transaction. Database triggers require exact proposal/version content and append audit events for reviews and generation-run lifecycle changes without copying prompt or raw error text. Ownership transfer is available only through `app.transfer_workspace_owner(workspace_id, new_owner_user_id)`.

`ai.publish_generation_proposal(workspace_id, proposal_id)` is executable only by `dsh_service_runtime` and a trusted user transaction context. It locks the proposal and target, checks the approved review, target status, and optimistic base version, publishes the target, and appends an audit event. `ai.rollback_entity_version(workspace_id, target_type, target_id, version_no)` restores a supported historical entity version and appends a rollback audit event; both functions revoke `PUBLIC` execution.

The framework-neutral authentication routes live in [`@deepseek-ai/dsh-user-auth`](../../identity/user-auth/README.md). This package supplies the PostgreSQL stores and tables used by those routes; it does not own HTTP routing, cookies, JWT issuance, Redis limits, or mail delivery.

## Model Experience

Nothing in this package is model-visible. It exposes host-side storage to application services; prompts, tools, and agent-loop behavior remain unchanged.

## Known Limitations and Deferred Work

- This package provides database infrastructure and enforcement, not the registration, password hashing, HTTP authentication, Redis rate-limit, email, Web review, or novel-authoring orchestration services. The caller must validate AI JSON against a versioned schema and set the authenticated transaction context. Migration `0002` stops with a diagnostic if legacy generation runs cannot be assigned unambiguously to a novel or a non-draft create proposal has no target; repair those rows before retrying. Long-form records and publication hardening are supplied by migrations `0004` and `0005`; publication is supplied by `0006`, secure monotonic rollback by `0007`, durable generation-result idempotency by `0008`, queued instruction replay by `0009`, atomic worker claiming by `0010`, the follow-up RLS repair by `0011`, and replayable context snapshots by `0012`. Apply all entries with the controlled migration runner after confirming a recoverable backup.
