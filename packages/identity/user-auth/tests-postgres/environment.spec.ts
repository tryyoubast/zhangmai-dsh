/** Reject unsafe test database targets before a driver can connect. */
import { describe, expect, it } from 'vitest'
import { postgresTestEnvironment } from './environment.ts'
import { provisionPostgresTestDatabase } from './provision.ts'

const valid = {
  DATABASE_TEST_URL: 'postgresql://auth_login:fixture-only@127.0.0.1:5432/auth_test',
  DATABASE_MIGRATION_URL: 'postgresql://migration_login:fixture-only@127.0.0.1:5432/auth_test',
}

describe('PostgreSQL regression environment', () => {
  it('requires both explicit credentials instead of falling back to DATABASE_URL', () => {
    expect(() => postgresTestEnvironment({ DATABASE_URL: valid.DATABASE_TEST_URL })).toThrow('DATABASE_TEST_URL is required')
    expect(() => postgresTestEnvironment({ DATABASE_TEST_URL: valid.DATABASE_TEST_URL })).toThrow('DATABASE_MIGRATION_URL is required')
  })

  it('accepts two logins targeting one test database and treats an omitted default port as 5432', () => {
    expect(postgresTestEnvironment(valid)).toEqual({ runtimeUrl: valid.DATABASE_TEST_URL, migrationUrl: valid.DATABASE_MIGRATION_URL })
    expect(() => postgresTestEnvironment({ ...valid, DATABASE_TEST_URL: valid.DATABASE_TEST_URL.replace(':5432', '') })).not.toThrow()
  })

  for (const key of ['DATABASE_TEST_URL', 'DATABASE_MIGRATION_URL'] as const) {
    for (const [caseName, url] of [
      ['malformed URL', 'not-a-url'], ['non PostgreSQL URL', 'https://auth_login@example.test/auth_test'],
      ['missing login', 'postgresql://127.0.0.1/auth_test'], ['non-test database', 'postgresql://login@127.0.0.1/production'],
      ['superuser login', 'postgresql://postgres@127.0.0.1/auth_test'],
      ['driver host override', `${valid[key]}?host=elsewhere`],
      ['driver port override', `${valid[key]}?port=5433`],
      ['driver login override', `${valid[key]}?user=postgres`],
      ['driver options override', `${valid[key]}?options=-c%20role=postgres`],
    ]) {
      it(`rejects ${caseName} in ${key} without echoing credentials`, () => {
        expect(() => postgresTestEnvironment({ ...valid, [key]: url })).toThrow()
        try {
          postgresTestEnvironment({ ...valid, [key]: url })
        } catch (error) {
          expect(String(error)).not.toContain('fixture-only')
        }
      })
    }
  }

  for (const target of ['postgresql://migration_login@different-host:5432/auth_test',
    'postgresql://migration_login@127.0.0.1:5433/auth_test', 'postgresql://migration_login@127.0.0.1:5432/another_test']) {
    it(`rejects a different migration target ${new URL(target).host}${new URL(target).pathname}`, () => {
      expect(() => postgresTestEnvironment({ ...valid, DATABASE_MIGRATION_URL: target })).toThrow('same host, port, and test database')
    })
  }

  it('rejects using one login for runtime and migration', () => {
    expect(() => postgresTestEnvironment({ ...valid, DATABASE_MIGRATION_URL: valid.DATABASE_TEST_URL })).toThrow('separate login roles')
  })

  it.each(['host=elsewhere', 'port=5433', 'user=postgres', 'options=-c%20role=postgres'])(
    'rejects bootstrap query override %s before opening a connection', async (query) => {
      await expect(provisionPostgresTestDatabase({
        ...valid,
        TEST_DATABASE_BOOTSTRAP_URL: `postgresql://postgres@127.0.0.1:5432/auth_test?${query}`,
      })).rejects.toThrow('must not contain query parameters')
    },
  )
})
