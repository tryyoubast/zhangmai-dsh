/** DBA bootstrap for an empty disposable test database; all subsequent migration SQL uses dsh_migrator. */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { migrateDatabase } from '@deepseek-ai/dsh-database-postgres'
import { postgresTestEnvironment } from './environment.ts'
import { TestPgClient } from './pg-client.ts'

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Apply only the released baseline and ownership bootstrap with the disposable DBA credential.
 * @param environment - Explicit test URLs and TEST_DATABASE_BOOTSTRAP_URL for the same empty database.
 */
export async function provisionPostgresTestDatabase(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = postgresTestEnvironment(environment)
  if (!environment.TEST_DATABASE_BOOTSTRAP_URL) throw new Error('TEST_DATABASE_BOOTSTRAP_URL is required to provision an empty test database')
  let bootstrap: URL
  try {
    bootstrap = new URL(environment.TEST_DATABASE_BOOTSTRAP_URL)
  } catch {
    throw new Error('TEST_DATABASE_BOOTSTRAP_URL must be a PostgreSQL URL')
  }
  if (!['postgres:', 'postgresql:'].includes(bootstrap.protocol) || !bootstrap.username) {
    throw new Error('TEST_DATABASE_BOOTSTRAP_URL must be a PostgreSQL URL with a login')
  }
  if (bootstrap.search || bootstrap.hash) throw new Error('TEST_DATABASE_BOOTSTRAP_URL must not contain query parameters or a fragment')
  const runtime = new URL(config.runtimeUrl)
  const migration = new URL(config.migrationUrl)
  if (bootstrap.hostname !== runtime.hostname || (bootstrap.port || '5432') !== (runtime.port || '5432')
    || decodeURIComponent(bootstrap.pathname) !== decodeURIComponent(runtime.pathname)) {
    throw new Error('Bootstrap URL must target the same disposable test database')
  }
  const client = new TestPgClient({ connectionString: bootstrap.href })
  try {
    await client.connect()
    const bootstrapRole = await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = session_user')
    if (bootstrapRole.rows[0]?.rolsuper !== true) throw new Error('Test baseline bootstrap requires a PostgreSQL superuser login')
    const existing = await client.query("SELECT to_regclass('auth.users') AS relation")
    if (existing.rows[0]?.relation !== null) throw new Error('Test bootstrap requires an empty database')
    await client.query(await readFile(new URL('../../../database/database-postgres/migrations/0001_auth_workspace_novel_ai.sql', import.meta.url), 'utf8'))
    await client.query(await readFile(new URL('../../../database/database-postgres/scripts/bootstrap-migrator-ownership.sql', import.meta.url), 'utf8'))
    for (const [url, role] of [[runtime, 'dsh_auth_runtime'], [migration, 'dsh_migrator']] as const) {
      await client.query(`CREATE ROLE ${identifier(decodeURIComponent(url.username))} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(decodeURIComponent(url.password))}`)
      await client.query(`GRANT ${identifier(role)} TO ${identifier(decodeURIComponent(url.username))}`)
    }
  } finally {
    await client.end()
  }
  await migrateDatabase(config.migrationUrl)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await provisionPostgresTestDatabase()
}
