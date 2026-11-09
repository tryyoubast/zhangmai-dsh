/** Explicit credentials for the disposable PostgreSQL regression database; never loads .env. */
export interface PostgresTestEnvironment {
  readonly runtimeUrl: string
  readonly migrationUrl: string
}

function connectionUrl(environment: NodeJS.ProcessEnv, name: string): URL {
  const raw = environment[name]?.trim()
  if (!raw) throw new Error(`${name} is required for PostgreSQL regression tests`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL`)
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username) {
    throw new Error(`${name} must be a PostgreSQL URL with a host and login`)
  }
  if (url.search || url.hash) throw new Error(`${name} must not contain query parameters or a fragment`)
  if (!decodeURIComponent(url.pathname.slice(1)).toLowerCase().includes('test')) {
    throw new Error(`${name} database name must include test`)
  }
  if (decodeURIComponent(url.username).toLowerCase() === 'postgres') {
    throw new Error(`${name} must use a non-superuser login`)
  }
  return url
}

/**
 * Validate both credentials before opening any database connection.
 * @param environment - Explicit environment values, with no file fallback.
 * @returns Runtime and migration URLs targeting the same test database.
 */
export function postgresTestEnvironment(environment: NodeJS.ProcessEnv = process.env): PostgresTestEnvironment {
  const runtime = connectionUrl(environment, 'DATABASE_TEST_URL')
  const migration = connectionUrl(environment, 'DATABASE_MIGRATION_URL')
  if (runtime.hostname !== migration.hostname
    || (runtime.port || '5432') !== (migration.port || '5432')
    || decodeURIComponent(runtime.pathname) !== decodeURIComponent(migration.pathname)) {
    throw new Error('DATABASE_TEST_URL and DATABASE_MIGRATION_URL must target the same host, port, and test database')
  }
  if (runtime.username === migration.username) throw new Error('Runtime and migration tests require separate login roles')
  return { runtimeUrl: runtime.href, migrationUrl: migration.href }
}
