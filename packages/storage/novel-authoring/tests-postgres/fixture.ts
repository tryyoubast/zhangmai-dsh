import { randomUUID } from 'node:crypto'
import { createDatabase, sql, withRequestContext, type DatabaseClient, type DatabaseRuntimeRole, type DshDatabase } from '@deepseek-ai/dsh-database-postgres'
import { postgresTestEnvironment } from '../../../identity/user-auth/tests-postgres/environment.ts'
import { TestPgClient } from '../../../identity/user-auth/tests-postgres/pg-client.ts'

export function novelPostgresFixture() {
  const { runtimeUrl, migrationUrl } = postgresTestEnvironment()
  const control = new TestPgClient({ connectionString: migrationUrl })

  return {
    control,
    migrationUrl,
    runtime(role: DatabaseRuntimeRole, name: string, url = runtimeUrl) {
      return createDatabase({
        url, runtimeRole: role, maxConnections: 1,
        idleTimeoutMs: 5_000, connectionTimeoutMs: 5_000, applicationName: `${name}-${randomUUID()}`,
      })
    },
    async connectControl() {
      await control.connect()
      const login = await control.query(`SELECT rolsuper, rolbypassrls,
        ARRAY(SELECT rolname::text FROM pg_roles
          WHERE rolname <> session_user AND pg_has_role(session_user, oid, 'MEMBER')) AS memberships
        FROM pg_roles WHERE rolname = session_user`)
      const role = login.rows[0]
      if (role?.rolsuper !== false || role.rolbypassrls !== false
        || !Array.isArray(role.memberships) || role.memberships.length !== 1 || role.memberships[0] !== 'dsh_migrator') {
        throw new Error('Test control requires a restricted login that belongs only to dsh_migrator')
      }
      await control.query('SET ROLE dsh_migrator')
      await control.query("SET statement_timeout = '15s'")
    },
  }
}

export function readForgedRollbackContext(database: DatabaseClient<DshDatabase>) {
  const workspaceId = randomUUID()
  return withRequestContext(database, { userId: randomUUID(), workspaceId, actorType: 'user' }, async (db) => {
    await db.execute(sql`SELECT set_config('app.rollback_context', '1', true),
      set_config('app.rollback_workspace_id', ${workspaceId}, true),
      set_config('app.rollback_target_id', ${randomUUID()}, true),
      set_config('app.rollback_target_type', 'characters', true)`)
    return (await db.execute(sql`SELECT current_user AS role, novel.rollback_context_active() AS active`)).rows
  })
}
