# Agent Note: Draft publication guard predicate privileges

Status: implemented

English | [中文](2026-11-11-draft-guard-context-privileges.zh.md)

## Problem

Draft and version publication triggers run with the caller's privileges. Shared guard expressions require execution of `novel.rollback_context_active()` for app and worker writes and `app.agent_run_allowed(uuid,uuid,uuid)` for app and service writes. Missing helper grants block valid operations with PostgreSQL error `42501`, even when a role condition makes the predicate's result false. A generation result can persist while its first materialized draft fails.

## Decision

Migration [0018](../../../../packages/database/database-postgres/migrations/0018_draft_guard_context_privileges.sql) grants only rollback-context helper execution to `dsh_app_runtime` and `dsh_worker_runtime`. The helper remains an invoker function without data writes. It returns true only when the actual role is `dsh_service_runtime`, the actor is a user with a nonempty identity, and the transaction's rollback context is active. Forging context settings under an app or worker role cannot activate rollback.

Migration [0019](../../../../packages/database/database-postgres/migrations/0019_agent_run_predicate_privileges.sql) grants only agent-run helper execution to `dsh_app_runtime` and `dsh_service_runtime`. This read-only SECURITY DEFINER predicate retains its fixed search path and actual-worker-role requirement. `app.current_database_role()` checks the PostgreSQL role setting against `session_user` membership; `SET ROLE` and `set_config('role',...)` cannot assume an ungranted worker role. Runtime pools also require each login to inherit exactly its configured runtime role. Forging agent, user, workspace, and run context under app or service therefore still returns false.

`ai.rollback_entity_version` remains executable only by the service role. PUBLIC, authentication, and readonly roles receive no helper execution; table privileges and RLS policies are unchanged. The [reviewed publication rules](../architecture/2026-09-23-postgres-novel-drafts-and-review.md) continue to govern ownership, tenant access, and publication.

Host readiness locates both helpers by catalog OID and checks their required execution grants. This detects a missing privilege migration without reading novel tables or the private migration journal, and adds no authentication-role privileges.

## Alternatives considered

**Skip helpers inside trigger bodies for other callers.** This requires replacing publication guards and duplicating the predicates' role checks. Granting execution of the existing boolean predicates preserves the reviewed trigger definitions.

## Consequences

The append-only migrations repair existing databases without rewriting applied checksums. Each caller can evaluate the required read-only predicates while publication, worker writes, and rollback authority remain controlled by their existing role checks and grants.

## Testing

Restricted PostgreSQL regressions exercise real app and worker character writes, require false with forged rollback or agent context, reject worker-role impersonation from app and service, and check the exact helper ACLs plus service-only rollback execution. App and service tests use separate restricted logins; the migrator is not a runtime-role member. Packaging regressions read both appended SQL files and checksums through the published migration directory.
