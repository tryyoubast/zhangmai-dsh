# Agent Note: Application data callbacks and validated input

Status: implemented

English | [中文](2026-11-04-application-data-lint-baseline.zh.md)

## Problem

Authentication route promises escaped their surrounding error handler, and a detached session-resolver method lost its receiver. Premature assertions also described untrusted JSON as validated values. The PostgreSQL driver's asynchronous connection hook had a synchronous dependency declaration despite the driver awaiting its result.

## Decision

Authentication dispatch awaits each route inside its existing error handler and invokes session methods on their owner. Decoded JWT objects and provider records stay unknown until validated. HTTP and materialization share the fixed draft-target predicate; malformed provider arrays fail without dropping elements. Durable-lock calls retain their repository receiver and failure cleanup; the PostgreSQL result store invokes connection acquisition on its owning pool.

The pool uses a private configuration type that describes its awaited connection hook. Failed initialization rejects checkout and closes the connection; role validation never runs as detached work. Drizzle array callbacks retain the existing table metadata. Migration SQL, role grants, token lifetimes, and refresh-token rotation remain separate responsibilities.

The [database and publication decision](../architecture/2026-09-23-postgres-novel-drafts-and-review.md), [idempotent writer decision](2026-10-29-atomic-ai-idempotent-draft-writes.md), and [documentation ownership decision](../process/2026-11-04-application-data-documentation-ownership.md) remain active; this correction does not supersede their mechanisms.

## Alternatives considered

**Suppress diagnostics or assert parsed data into domain types.** This hides invalid runtime input and callback obligations rather than establishing them.

**Discard the connection hook's promise.** This permits checkout before privilege validation finishes and separates initialization failures from acquisition.

**Apply repository-wide automatic fixes.** Callback timing, receiver binding, and database metadata require checks against their owners; the repair stays limited to the affected packages.

## Consequences

Focused regressions cover asynchronous HTTP failures, instance-backed callbacks, malformed JSON, fixed draft targets, and connection acquisition ordering. A normalized Drizzle metadata fixture checks mapping equivalence. Package tests, lint, TypeScript, and documentation checks verify the repair without changing production database objects or weakening validation rules.
