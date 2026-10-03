import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { sql } from 'drizzle-orm'
import { Pool, type PoolClient } from 'pg'
import { assertDatabaseRuntimeRole, resolveDatabaseConfig, resolveMigrationDatabaseUrl } from './config.ts'
import * as schema from './schema.ts'
import type { DatabaseClient, DatabaseConfig, RequestDatabaseContext } from './types.ts'

/** The typed Drizzle database for the application schemas. */
export type DshDatabase = NodePgDatabase<typeof schema>

/** Create a Drizzle database bound to one checked-out PostgreSQL connection. */
export function drizzleFromPoolClient(client: PoolClient): DshDatabase {
  return drizzle(client, { schema })
}

/** Convert trusted request identity into transaction-local PostgreSQL GUC values. */
export function requestContextSettings(context: RequestDatabaseContext): readonly [string, string][] {
  return [
    ['app.user_id', context.userId],
    ['app.workspace_id', context.workspaceId],
    ['app.actor_type', context.actorType],
    ['app.agent_principal_id', context.agentPrincipalId ?? ''],
  ]
}

/** Execute a callback with RLS identity settings scoped to one database transaction. */
export async function withRequestContext<T>(
  database: DatabaseClient<DshDatabase>,
  context: RequestDatabaseContext,
  callback: (database: DshDatabase) => Promise<T>,
): Promise<T> {
  return database.db.transaction(async (transaction) => {
    for (const [name, value] of requestContextSettings(context)) {
      await transaction.execute(sql`SELECT set_config(${name}, ${value}, true)`)
    }
    return callback(transaction as unknown as DshDatabase)
  })
}

function createRolePool(url: string, role: string, config?: DatabaseConfig): Pool {
  return new Pool({
    connectionString: url,
    ...(config && {
      max: config.maxConnections,
      idleTimeoutMillis: config.idleTimeoutMs,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      application_name: config.applicationName,
    }),
    onConnect: async (client) => {
      const result = await client.query<{
        rolsuper: boolean
        rolbypassrls: boolean
        role_name: string
        is_member: boolean
      }>(
        `SELECT login.rolsuper, login.rolbypassrls, roles.role_name,
          pg_has_role(session_user, roles.role_name, 'MEMBER') AS is_member
        FROM pg_catalog.pg_roles AS login
        CROSS JOIN unnest(ARRAY[
          'dsh_migrator', 'dsh_auth_runtime', 'dsh_app_runtime', 'dsh_worker_runtime',
          'dsh_service_runtime', 'dsh_readonly'
        ]) AS roles(role_name)
        WHERE login.rolname = session_user`,
      )
      const login = result.rows[0]
      if (!login || login.rolsuper || login.rolbypassrls) {
        throw new Error('PostgreSQL connections cannot use superuser or BYPASSRLS login roles')
      }
      const grantedRoles = result.rows.filter(row => row.is_member).map(row => row.role_name)
      const inheritedRoles = await client.query<{ role_name: string }>(
        `SELECT inherited.rolname AS role_name
        FROM pg_catalog.pg_roles AS inherited
        WHERE inherited.rolname <> session_user
          AND pg_has_role(session_user, inherited.oid, 'MEMBER')`,
      )
      assertRuntimeRoleMembership(
        grantedRoles,
        inheritedRoles.rows.map(row => row.role_name),
        role,
      )
      await client.query(`SET ROLE "${role}"`)
      const activeRole = await client.query<{ current_user: string }>('SELECT current_user')
      if (activeRole.rows[0]?.current_user !== role) {
        throw new Error(`PostgreSQL connection could not assume the required ${role} role`)
      }
    },
  })
}

/** Require a runtime login to inherit exactly its configured dsh_* role. */
export function assertRuntimeRoleMembership(
  grantedRuntimeRoles: string[],
  inheritedRoles: string[],
  selectedRole: string,
): void {
  if (grantedRuntimeRoles.length !== 1 || grantedRuntimeRoles[0] !== selectedRole) {
    throw new Error('PostgreSQL login must belong only to its selected dsh_* role')
  }
  if (inheritedRoles.length !== 1 || inheritedRoles[0] !== selectedRole) {
    throw new Error('PostgreSQL login cannot inherit roles outside its selected dsh_* role')
  }
}

/** Keep released transaction wrappers from escaping the runner's per-migration transaction. */
export function migrationStatements(source: string): string[] {
  const normalized = source
    .replace(/^\s*BEGIN\s*;\s*/i, '')
    .replace(/\s*COMMIT\s*;\s*$/i, '')
  return normalized.split('--> statement-breakpoint').filter(statement => statement.trim() !== '')
}

/** Resolve the packaged migration directory from either source or bundled entry points. */
export function resolveMigrationsDirectory(entryPointUrl = import.meta.url): string {
  const directory = resolve(dirname(fileURLToPath(entryPointUrl)), '../migrations')
  if (!existsSync(resolve(directory, 'meta/_journal.json'))) {
    throw new Error('Packaged PostgreSQL migrations are missing their Drizzle journal')
  }
  return directory
}

/** Apply the packaged SQL migration journal using the deployment-only role. */
export async function migrateDatabase(databaseUrl = resolveMigrationDatabaseUrl()): Promise<void> {
  const pool = createRolePool(databaseUrl, 'dsh_migrator')
  const migrationsDirectory = resolveMigrationsDirectory()
  const journal = JSON.parse(readFileSync(resolve(migrationsDirectory, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ when: number; tag: string }>
  }
  const migrationTags = new Map(journal.entries.map(entry => [entry.when, entry.tag]))
  const migrationName = (timestamp: number): string => migrationTags.get(timestamp) ?? String(timestamp)
  const migrations = readMigrationFiles({ migrationsFolder: migrationsDirectory })
  try {
    const client = await pool.connect()
    let advisoryLockAcquired = false
    let releaseWithError: Error | undefined
    try {
      const bootstrap = await client.query<{ journal_exists: boolean }>(
        "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS journal_exists",
      )
      if (!bootstrap.rows[0]?.journal_exists) {
        throw new Error('PostgreSQL baseline 0001 and its DBA ownership bootstrap must run before migrateDatabase()')
      }
      await client.query('SELECT pg_advisory_lock(703143015642)')
      advisoryLockAcquired = true
      const applied = await client.query<{ hash: string; created_at: string }>(
        'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC',
      )
      const appliedByTimestamp = new Map<number, string>()
      for (const migration of applied.rows) {
        const timestamp = Number(migration.created_at)
        const existingHash = appliedByTimestamp.get(timestamp)
        if (existingHash !== undefined && existingHash !== migration.hash) {
          throw new Error(`Conflicting PostgreSQL migration history at ${String(timestamp)}`)
        }
        appliedByTimestamp.set(timestamp, migration.hash)
      }
      let latestMigration = applied.rows.length > 0
        ? Number(applied.rows.at(-1)?.created_at)
        : Number.NEGATIVE_INFINITY

      for (const migration of migrations) {
        const appliedHash = appliedByTimestamp.get(migration.folderMillis)
        if (appliedHash !== undefined) {
          if (appliedHash !== migration.hash) {
            throw new Error(`PostgreSQL migration ${migrationName(migration.folderMillis)} differs from the applied migration history`)
          }
          continue
        }
        if (latestMigration > migration.folderMillis) {
          throw new Error(`PostgreSQL migration history is missing earlier migration ${migrationName(migration.folderMillis)}`)
        }
        await client.query('BEGIN')
        try {
          for (const statement of migrationStatements(migration.sql.join('\n--> statement-breakpoint\n'))) {
            await client.query(statement)
          }
          await client.query(
            'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
            [migration.hash, migration.folderMillis],
          )
          await client.query('COMMIT')
          latestMigration = migration.folderMillis
          appliedByTimestamp.set(migration.folderMillis, migration.hash)
        } catch (error) {
          try {
            await client.query('ROLLBACK')
          } catch (rollbackError) {
            if (rollbackError instanceof Error) releaseWithError = rollbackError
          }
          throw error
        }
      }
    } finally {
      try {
        if (advisoryLockAcquired && releaseWithError === undefined) {
          await client.query('SELECT pg_advisory_unlock(703143015642)')
        }
      } catch (error) {
        if (error instanceof Error) releaseWithError = error
        throw error
      } finally {
        client.release(releaseWithError)
      }
    }
  } finally {
    await pool.end()
  }
}

/** Create a Drizzle database and an owned PostgreSQL connection pool. */
export function createDatabase(config: DatabaseConfig = resolveDatabaseConfig()): DatabaseClient<DshDatabase> {
  assertDatabaseRuntimeRole(config.runtimeRole)
  const pool = createRolePool(config.url, config.runtimeRole, config)
  const db = drizzle(pool, { schema })
  return {
    db,
    pool,
    close: () => pool.end(),
  }
}
