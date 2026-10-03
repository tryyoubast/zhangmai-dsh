# @deepseek-ai/dsh-api-novel-authoring-http

English | [中文](README.zh.md)

Framework-neutral HTTP adapter for the multi-user novel authoring services. The host resolves the authenticated `AuthPrincipal` and injects the database-backed domain services; this package never trusts a client-supplied user ID, role, or workspace membership.

The adapter exposes workspace and novel creation, workspace member invitation/listing/role changes/revocation, ownership transfer, archive/restore actions, generation-run creation, worker-only draft generation and proposal materialization, review/publication, rollback, and persisted-context reads. It returns business statuses suitable for a non-technical Web UI and leaves cookie/JWT parsing to the authentication boundary. Workspace member and lifecycle operations are delegated to the authenticated domain service; client-supplied workspace IDs are checked against the resolved principal. Browser principals can enqueue runs and review proposals, but the worker-only generation and proposal routes are not exposed to them.

## Known Limitations and Deferred Work

- This package is an HTTP adapter, not a server or Web UI. The host must provide routing, authentication/session resolution, email/Redis controls, and a browser-facing presentation layer. The optional generation route requires the injected `NovelGenerationWorkflowService` and its provider/storage adapters.
