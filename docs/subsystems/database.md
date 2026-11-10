# PostgreSQL application database

English | [中文](database.zh.md)

The application database stores authentication, workspaces, novels, fixed entity drafts, generation context, proposals, and audit events. The [PostgreSQL library](../../packages/database/database-postgres/README.md) owns connections, Drizzle declarations, and versioned SQL. Generic [KV storage](storage.md) owns separate harness/session persistence and cannot substitute for these application tables.

## Connections and ownership

`createDatabase()` returns a `DatabaseClient<DshDatabase>` with the typed Drizzle database, pool, and `close()`. The host shares that client with services and closes it after stopping in-flight work. Callers checking out raw connections through `pool.connect()` must release them in `finally`; a Drizzle wrapper does not transfer connection ownership.

`resolveDatabaseConfig()` validates the PostgreSQL URL, pool limits, timeouts, application name, and selected role before pool construction. Each newly established connection checks login privileges and memberships, assumes the selected role, and rejects superuser, BYPASSRLS, or unexpected inherited roles. Deployment variables and shutdown usage belong to the [library reference](../../packages/database/database-postgres/README.md#use-this-package).

## Trusted request transactions

`RequestDatabaseContext` carries server-resolved `userId`, `workspaceId`, `actorType`, and an optional agent principal. `withRequestContext()` starts a transaction, applies `app.user_id`, `app.workspace_id`, `app.actor_type`, and `app.agent_principal_id` through transaction-local `set_config`, and passes that transaction to its callback. Success commits the callback's work; failure rolls it back. The callback must use the supplied transaction rather than the outer database client.

Authentication and workspace authorization precede context construction. RLS and constraints enforce workspace and actor permissions inside the trusted service process. These SQL-writable identity settings do not authenticate stolen database credentials or prevent arbitrary SQL execution. Models receive neither database credentials nor executable SQL access.

## Roles and migrations

Runtime pools select one of `dsh_auth_runtime`, `dsh_app_runtime`, `dsh_worker_runtime`, `dsh_service_runtime`, or `dsh_readonly`, with a login inheriting only that selected role. Authentication stores use the authentication role; application, worker, publication-service, and read-only permissions remain separate. Workers create drafts in their bound workspace; reviewer-authorized publication and rollback use separate service operations.

An administrator applies baseline `0001` and its ownership bootstrap. Routine migrations use a separate login inheriting only `dsh_migrator` and `DATABASE_MIGRATION_URL`. The controlled runner serializes deployments with an advisory lock, checks journal hashes, and applies each pending entry and journal update in one transaction. After packaged migrations load successfully, connection and migration execution release the connection and close the pool on completion or failure. The [library reference](../../packages/database/database-postgres/README.md#understand-the-implementation) owns migration SQL and the deployment procedure.

AI creates characters, locations, and other records in fixed tables. Adding a stable entity type requires a reviewed migration; generation never creates tables or grants itself DDL permissions. [Authoring services](../../packages/storage/novel-authoring/README.md) own draft validation and generation orchestration, and [authentication services](../../packages/identity/user-auth/README.md) own login and registration.

## Source owners

| Responsibility | Owner |
|---|---|
| Pool, request transactions, migrations | [database.ts](../../packages/database/database-postgres/src/database.ts) |
| Environment and runtime role validation | [config.ts](../../packages/database/database-postgres/src/config.ts) |
| Client and trusted identity types | [types.ts](../../packages/database/database-postgres/src/types.ts) |
| Application tables and constraints | [schema.ts](../../packages/database/database-postgres/src/schema.ts) and [migrations](../../packages/database/database-postgres/migrations) |
