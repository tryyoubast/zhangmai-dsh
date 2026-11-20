# Agent Note: First-login workspace authority

Status: implemented

English | [中文](2026-11-10-first-login-workspace-authority.zh.md)

## Problem

Workspace-scoped RLS requires a workspace before ordinary membership queries can establish one. Revoked rows are invisible through those queries, so treating an empty visible result as a new account can recreate access. An INSERT RETURNING workspace also requires SELECT visibility before its owner membership exists. Browser login can release a session cookie before configured workspace resolution succeeds.

## Decision

`app.current_user_workspace_memberships()` is a no-argument SECURITY DEFINER function owned by `dsh_migrator`, with a fixed search path and execution granted only to `dsh_app_runtime`. It reads the transaction-local user GUC and returns that user's membership history with workspace status, including revoked records. The app service distinguishes empty history from inaccessible history without accepting a lookup user argument in SQL.

`PostgresWorkspaceIdentity.onboard()` runs only after successful login. A user-scoped transaction advisory lock serializes the empty-history check and personal workspace creation. Ordinary `resolve()` only reads current membership roles; explicit inaccessible workspace hints return null. Session authentication stays with the authentication resolver. Workspace creation assigns a UUID and inserts the workspace without RETURNING, then inserts its owner membership in the same transaction.

Configured login identity resolution settles before either browser cookies or official-client credentials are returned. Resolver failure uses the controller's sanitized availability response. Unconfigured browser login retains its existing behavior.

An archived workspace does not invalidate a current owner or admin membership. Login and refresh can establish a session for that member, but only a restore action scoped to that workspace resolves the archived membership for authoring. The update still requires the existing administrator RLS policy and changes only an archived, undeleted row to active. Revoked memberships do not qualify.

## Alternatives considered

**Use the ordinary membership SELECT policy.** Workspace-scoped visibility cannot distinguish new accounts from users with only revoked memberships, so it cannot safely control onboarding.

**Create or restore a workspace during ordinary request resolution.** That gives reads a durable side effect and can turn revoked history into renewed access. Login owns the explicit onboarding operation.

**Relax workspace SELECT RLS for INSERT RETURNING.** Generated UUIDs allow the owner membership to establish visibility without broadening any policy.

## Consequences

The app role can discover only its current user's historical memberships. Each request reads roles from the database, while session validity remains a separate prerequisite. The restricted PostgreSQL regression proves concurrent onboarding creates one workspace, inaccessible history cannot recreate it, other users cannot select it, and workspace creation succeeds without relaxing RLS. Authentication regressions prove configured asynchronous resolver failure releases no credentials. Migration 0016 repairs only the approved claim policies; it does not validate worker session expiry or revocation.
