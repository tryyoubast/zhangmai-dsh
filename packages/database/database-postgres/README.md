---
description: "PostgreSQL and Drizzle foundation for multi-tenant authentication, workspaces, and AI novel authoring."
kind: "package-library"
---

# @deepseek-ai/dsh-database-postgres

English | [中文](README.zh.md)

## Summary

This host-only package owns the PostgreSQL connection pool, Drizzle schema, and reviewed SQL foundation for the multi-user novel authoring platform. PostgreSQL is the production source of truth; the existing SQLite storage packages remain separate KV/session infrastructure.

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

Import this library as a service dependency; the caller owns the pool and its shutdown.

### Configuration

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

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The migration journal records immutable entries. `0001_auth_workspace_novel_ai.sql` creates authentication, workspace, novel, AI-run, proposal, and audit tables; `0002_workspace_drafts_and_hardening.sql` adds workspace-consistent references, draft-only worker policies, lifecycle guards, and least-privilege grants; `0003_remove_redundant_prefix_indexes.sql` removes redundant prefix indexes; `0004_novel_longform_context.sql` adds outlines, chapters, chapter versions, summaries, facts, timeline events, and generation-context selections; `0005_longform_publication_hardening.sql` adds long-form lifecycle fields and publication guards; `0006_publication_and_rollback.sql` adds database-owned publication and rollback transactions; `0007_secure_rollback.sql` makes rollback an invoker-only service operation that appends a new version inside a tightly scoped transaction context; `0008_generation_results.sql` stores structured generation output under an idempotency key with worker-only draft writes; `0009_generation_queue_payload.sql` retains queued generation instructions and context limits for worker replay; `0010_generation_queue_claim.sql` lets a bound worker atomically claim a browser-created queued run; `0011_generation_claim_rls_hardening.sql` keeps that claim exception separate from the bound-worker write predicate for already-migrated databases; `0012_generation_context_snapshots.sql` stores the exact context excerpts and source statuses used for generation replay; `0013_legacy_context_rerun_marker.sql` marks incomplete legacy snapshots for rerun; and `0014_novel_context_fulltext_indexes.sql` adds the GIN expression indexes used by bounded full-text context retrieval.

`0015_current_user_workspace_memberships.sql` exposes a no-argument, app-only function that reads the current user GUC and returns membership history and workspace status. `0016_generation_claim_policy_repair.sql` adds the bounded worker claim SELECT policy and repairs its queued UPDATE postcondition without widening the claim predicate. These additive migrations retain existing rows, tables, and indexes.

`0017_generation_worker_identity.sql` adds `ai.resolve_generation_run_worker_identity(workspace_id, run_id)`, a stable SECURITY DEFINER function owned by `dsh_migrator` with a fixed search path and execution granted only to the worker runtime. The function requires the actual worker database role, agent actor, nonempty configured agent principal, and matching workspace context. It resolves only an assigned run or a queued `user-request` run, with a matching live, unrevoked session, active verified undeleted user, active owner/admin/editor membership, and active undeleted workspace. It returns only user/session/workspace/novel IDs, membership role, and run status. It grants no authentication-table reads and returns no credential fields; a queue locator alone cannot establish identity.

Migrations `0018` and `0019` grant app/worker and app/service execution of narrowly scoped boolean guard functions, respectively; those functions continue to reject callers that lack the required service or worker database role. Migration `0020` creates proposal-owned draft candidates and adds service read policies for long-form content. Migration `0021` lets the worker settle a queued or running run as failed only after rechecking its persisted identity under the run lock; if identity is still valid, the queue delivery remains retryable. The existing lifecycle trigger writes the failure audit in the same transaction. Migration `0022` rejects a proposal transition to published unless the authenticated reviewer, published target projection, and exact published candidate (where versioned storage applies) agree. These migrations do not widen runtime table access.

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

Build the package before running its published migration entry point. `db:migrate` uses the packaged SQL journal and checksums through the controlled runner; production deployments must not use `drizzle-kit migrate`, `push`, or `DATABASE_URL` for DDL. The published package includes `migrations/*.sql`, `migrations/meta/_journal.json`, `scripts/migrate.js`, and `scripts/bootstrap-migrator-ownership.sql` beside built artifacts; Drizzle configuration, schema source, and migration snapshots remain development inputs. `db:check` reads `DATABASE_MIGRATION_URL` for Drizzle's static journal check in a source checkout.

Runtime roles have no schema `CREATE`, `CREATEDB`, `CREATEROLE`, `SUPERUSER`, or `BYPASSRLS` capability. The service transaction sets `app.user_id`, `app.workspace_id`, `app.actor_type`, and `app.agent_principal_id` with transaction-local settings after authentication. This trusted service transaction context uses PostgreSQL GUCs; it does not defend against stolen runtime credentials or arbitrary SQL execution. Credentials and SQL access must not be exposed to model-generated SQL.

The pool awaits each connection's asynchronous role validation and `SET ROLE` initialization before lending it to callers. Initialization failure rejects checkout and closes that connection. Drizzle extra-config callbacks use array entries; versioned SQL migrations remain the database schema authority.

Workers can write draft records and proposals in their bound workspace. For the eight versioned entity types, an invoker trigger synchronizes one candidate per proposal within that transaction. Candidate provenance and payload must match its exact proposal; approved content cannot be changed. Draft candidates can share an expected version number, while a partial unique index reserves each non-draft history number. Review transitions append audit events without copying prompt or raw error text. Ownership transfer is available only through `app.transfer_workspace_owner(workspace_id, new_owner_user_id)`.

`ai.publish_generation_proposal(workspace_id, proposal_id)` requires `dsh_service_runtime` and the authenticated reviewer. It locks the target with `FOR NO KEY UPDATE`, then the proposal and its exact candidate, publishes that candidate, projects approved content, and advances the entity before the proposal audit commits. Six long-form types support initial creation publication using their own columns. `ai.rollback_entity_version(workspace_id, target_type, target_id, version_no)` appends a new published version for the eight entity types and restores its complete payload; pending candidates remain stored and stale. Both functions revoke `PUBLIC` execution. Missing, denied, conflicting, and invalid operations use dedicated business SQLSTATE values; unexpected database errors remain faults.

Migration `0020` replaces only the eight version-number uniqueness constraints, adds proposal candidate synchronization, backfills bound unpublished proposals from their explicit generation runs, and supplies the six missing workspace-scoped service read policies. Existing unbound versions and published history remain unchanged. Conflicting candidate provenance aborts the migration rather than guessing ownership. Migration lock waits are limited to five seconds and statements to sixty seconds. The [publication decision](../../../.agents/notes/implemented/bug-fix/2026-11-12-proposal-bound-publication.md) records the concurrency and compatibility choices.

Draft-publication triggers evaluate shared predicates under the caller's role. Migration `0018` grants app and worker execution of `novel.rollback_context_active()`, which returns true only for the service role with a trusted user transaction and active rollback context. Migration `0019` grants app and service execution of `app.agent_run_allowed(uuid,uuid,uuid)`; its actual-worker-role check still returns false for those callers, including forged agent context. These grants change no table privileges or RLS policies. The [privilege decision](../../../.agents/notes/implemented/bug-fix/2026-11-11-draft-guard-context-privileges.md) explains both repairs.

The framework-neutral authentication routes live in [`@deepseek-ai/dsh-user-auth`](../../identity/user-auth/README.md). This package supplies the PostgreSQL stores and tables used by those routes; it does not own HTTP routing, cookies, JWT issuance, Redis limits, or mail delivery.

No invariant companion is published because schema constraints, migration checksums, and connection-role checks enforce database consistency at their owning operations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Database subsystem](../../../docs/subsystems/database.md): pool, RLS, and migration ownership.

-----

<a id="model-experience"></a>
## Model Experience

None, as database connections and persistence serve application services without constructing model requests.

#### KV Cache effect

This package does not construct or mutate model input prefixes; callers and providers own model caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This package provides database infrastructure and enforcement, not the registration, password hashing, HTTP authentication, Redis rate-limit, email, Web review, or novel-authoring orchestration services. The caller must validate AI JSON against a versioned schema and set the authenticated transaction context. Migration `0002` stops with a diagnostic if legacy generation runs cannot be assigned unambiguously to a novel or a non-draft create proposal has no target; repair those rows before retrying. Long-form records and publication hardening are supplied by migrations `0004` and `0005`; publication is supplied by `0006`, secure monotonic rollback by `0007`, durable generation-result idempotency by `0008`, queued instruction replay by `0009`, atomic worker claiming by `0010`, the follow-up RLS repair by `0011`, and replayable context snapshots by `0012`. Apply all entries with the controlled migration runner after confirming a recoverable backup.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
