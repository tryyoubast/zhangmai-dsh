import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DATABASE_POOL,
  DatabaseConfigurationError,
  resolveMigrationDatabaseUrl,
  resolveDatabaseConfig,
} from '../src/config.ts'

describe('resolveDatabaseConfig', () => {
  it('fails loudly when DATABASE_URL is missing', () => {
    expect(() => resolveDatabaseConfig({})).toThrowError(DatabaseConfigurationError)
    expect(() => resolveDatabaseConfig({})).toThrow(/DATABASE_URL is required/)
  })

  it('does not expose a database password in configuration errors', () => {
    expect(() => resolveDatabaseConfig({ DATABASE_URL: 'postgresql://app:secret-value@' })).toThrow()
    try {
      resolveDatabaseConfig({ DATABASE_URL: 'postgresql://app:secret-value@' })
    } catch (error) {
      expect(String(error)).not.toContain('secret-value')
    }
  })

  it('uses production-safe pool defaults and explicit overrides', () => {
    expect(resolveDatabaseConfig({ DATABASE_URL: 'postgresql://localhost/dsh' })).toMatchObject({
      ...DEFAULT_DATABASE_POOL,
      url: 'postgresql://localhost/dsh',
    })
    expect(resolveDatabaseConfig({
      DATABASE_URL: 'postgresql://localhost/dsh',
      DATABASE_POOL_MAX: '12',
      DATABASE_IDLE_TIMEOUT_MS: '4500',
      DATABASE_CONNECTION_TIMEOUT_MS: '1800',
      DATABASE_APPLICATION_NAME: 'dsh-test',
      DATABASE_RUNTIME_ROLE: 'dsh_worker_runtime',
    })).toEqual({
      url: 'postgresql://localhost/dsh',
      maxConnections: 12,
      idleTimeoutMs: 4500,
      connectionTimeoutMs: 1800,
      applicationName: 'dsh-test',
      runtimeRole: 'dsh_worker_runtime',
    })
  })

  it('rejects postgres and migration roles for runtime pools', () => {
    expect(() => resolveDatabaseConfig({ DATABASE_URL: 'postgresql://postgres@localhost/dsh' }))
      .toThrow(/must not connect as the PostgreSQL superuser/)
    expect(() => resolveDatabaseConfig({
      DATABASE_URL: 'postgresql://dsh-deploy@localhost/dsh',
      DATABASE_RUNTIME_ROLE: 'dsh_migrator',
    })).toThrow(/supported dsh_\* runtime role/)
  })

  it('requires a separate non-superuser connection for deployment migrations', () => {
    expect(() => resolveMigrationDatabaseUrl({})).toThrow(/DATABASE_MIGRATION_URL is required/)
    expect(resolveMigrationDatabaseUrl({
      DATABASE_MIGRATION_URL: 'postgresql://dsh_deploy@localhost/dsh',
    })).toBe('postgresql://dsh_deploy@localhost/dsh')
    expect(() => resolveMigrationDatabaseUrl({
      DATABASE_MIGRATION_URL: 'postgresql://postgres@localhost/dsh',
    })).toThrow(/must not connect as the PostgreSQL superuser/)
    expect(() => resolveMigrationDatabaseUrl({
      DATABASE_MIGRATION_URL: 'postgresql://dsh_deploy@localhost/dsh',
    })).not.toThrow(/dsh_deploy/)
  })
})
