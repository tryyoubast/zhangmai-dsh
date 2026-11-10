import { describe, expect, it } from 'vitest'
import { DatabaseConfigurationError, resolveDatabaseConfig, resolveMigrationDatabaseUrl } from '../src/config.ts'

describe('PostgreSQL configuration rejection', () => {
  it.each(['-1', '1.5', 'abc', '0', '9007199254740992'])(
    'rejects invalid or unsafe connection limits %s without silently coercing them', (value) => {
      expect(() => resolveDatabaseConfig({ DATABASE_URL: 'postgresql://app@localhost/test', DATABASE_POOL_MAX: value }))
        .toThrow('DATABASE_POOL_MAX must be a positive integer')
    },
  )

  it('treats an empty pool override as absent', () => {
    expect(resolveDatabaseConfig({ DATABASE_URL: 'postgresql://app@localhost/test', DATABASE_POOL_MAX: '  ' }).maxConnections).toBe(10)
  })

  it.each(['https://example.com/test', 'postgres:///test'])(
    'rejects runtime connection URLs without the required scheme or host (%s)', (url) => {
      expect(() => resolveDatabaseConfig({ DATABASE_URL: url })).toThrow(DatabaseConfigurationError)
    },
  )

  it.each(['not a url', 'https://example.com/test', 'postgres:///test'])(
    'rejects invalid deployment URLs (%s)', (url) => {
      expect(() => resolveMigrationDatabaseUrl({ DATABASE_MIGRATION_URL: url })).toThrow(DatabaseConfigurationError)
    },
  )
})
