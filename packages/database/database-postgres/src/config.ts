import type { DatabaseConfig, DatabaseRuntimeRole } from './types.ts'

/** Defaults chosen for a small production web process. Tune through env vars. */
export const DEFAULT_DATABASE_POOL = {
  maxConnections: 10,
  idleTimeoutMs: 10_000,
  connectionTimeoutMs: 5_000,
  applicationName: 'dsh-database',
  runtimeRole: 'dsh_app_runtime' as const,
} as const

const databaseRuntimeRoles = new Set<DatabaseRuntimeRole>([
  'dsh_auth_runtime',
  'dsh_app_runtime',
  'dsh_worker_runtime',
  'dsh_service_runtime',
  'dsh_readonly',
])

/** Reject deployment and unknown roles before a runtime pool is constructed. */
export function assertDatabaseRuntimeRole(role: string): asserts role is DatabaseRuntimeRole {
  if (!databaseRuntimeRoles.has(role as DatabaseRuntimeRole)) {
    throw new DatabaseConfigurationError('DATABASE_RUNTIME_ROLE must select a supported dsh_* runtime role')
  }
}

/** Stable error raised when the database cannot be configured safely. */
export class DatabaseConfigurationError extends Error {
  readonly code = 'DATABASE_CONFIGURATION_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'DatabaseConfigurationError'
  }
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = environment[name]
  if (raw === undefined || raw.trim() === '') return fallback
  if (!/^\d+$/.test(raw)) {
    throw new DatabaseConfigurationError(`${name} must be a positive integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DatabaseConfigurationError(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Resolve a PostgreSQL configuration from explicit process environment values.
 *
 * @param environment - Environment-like values, injectable for tests.
 * @returns validated pool configuration.
 * @throws {@link DatabaseConfigurationError} when the URL or pool values are invalid.
 */
export function resolveDatabaseConfig(environment: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const rawUrl = environment.DATABASE_URL?.trim()
  if (!rawUrl) {
    throw new DatabaseConfigurationError('DATABASE_URL is required for PostgreSQL runtime startup')
  }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new DatabaseConfigurationError('DATABASE_URL must be a valid PostgreSQL connection URL')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new DatabaseConfigurationError('DATABASE_URL must use the postgres or postgresql scheme')
  }
  if (!url.hostname) {
    throw new DatabaseConfigurationError('DATABASE_URL must include a PostgreSQL host')
  }
  if (decodeURIComponent(url.username).toLowerCase() === 'postgres') {
    throw new DatabaseConfigurationError('DATABASE_URL must not connect as the PostgreSQL superuser postgres')
  }

  const configuredRole = environment.DATABASE_RUNTIME_ROLE?.trim() || DEFAULT_DATABASE_POOL.runtimeRole
  assertDatabaseRuntimeRole(configuredRole)

  const applicationName = environment.DATABASE_APPLICATION_NAME?.trim() || DEFAULT_DATABASE_POOL.applicationName
  return {
    url: rawUrl,
    maxConnections: positiveInteger(environment, 'DATABASE_POOL_MAX', DEFAULT_DATABASE_POOL.maxConnections),
    idleTimeoutMs: positiveInteger(environment, 'DATABASE_IDLE_TIMEOUT_MS', DEFAULT_DATABASE_POOL.idleTimeoutMs),
    connectionTimeoutMs: positiveInteger(
      environment,
      'DATABASE_CONNECTION_TIMEOUT_MS',
      DEFAULT_DATABASE_POOL.connectionTimeoutMs,
    ),
    applicationName,
    runtimeRole: configuredRole as DatabaseRuntimeRole,
  }
}

/** Resolve the deployment-only connection used to apply versioned migrations. */
export function resolveMigrationDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const rawUrl = environment.DATABASE_MIGRATION_URL?.trim()
  if (!rawUrl) {
    throw new DatabaseConfigurationError('DATABASE_MIGRATION_URL is required to apply PostgreSQL migrations')
  }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new DatabaseConfigurationError('DATABASE_MIGRATION_URL must be a valid PostgreSQL connection URL')
  }
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname) {
    throw new DatabaseConfigurationError('DATABASE_MIGRATION_URL must use PostgreSQL and include a host')
  }
  if (decodeURIComponent(url.username).toLowerCase() === 'postgres') {
    throw new DatabaseConfigurationError('DATABASE_MIGRATION_URL must not connect as the PostgreSQL superuser postgres')
  }
  return rawUrl
}
