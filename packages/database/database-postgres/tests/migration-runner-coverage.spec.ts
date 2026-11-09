import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDatabase, drizzleFromPoolClient, migrateDatabase, resolveMigrationsDirectory } from '../src/database.ts'

interface Migration {
  sql: string[]
  folderMillis: number
  hash: string
}

const state = vi.hoisted(() => ({
  migrations: [] as Migration[],
  applied: [] as Array<{ hash: string; created_at: string }>,
  statements: [] as Array<{ sql: string; values: unknown }>,
  failures: new Map<string, unknown>(),
  bootstrap: true,
  connectError: undefined as unknown,
  release: vi.fn<(error?: Error) => void>(),
  end: vi.fn<() => Promise<void>>(),
}))

vi.mock('drizzle-orm/migrator', () => ({ readMigrationFiles: () => state.migrations }))
vi.mock('pg', () => ({
  Pool: class {
    async connect() {
      if (state.connectError !== undefined) throw state.connectError
      return {
        async query(sql: string, values?: unknown) {
          state.statements.push({ sql, values })
          if (state.failures.has(sql)) throw state.failures.get(sql)
          if (sql.includes('to_regclass')) return { rows: [{ journal_exists: state.bootstrap }] }
          if (sql.startsWith('SELECT hash, created_at')) return { rows: state.applied }
          return { rows: [] }
        },
        release: state.release,
      }
    }

    end = state.end
  },
}))

const deploymentUrl = 'postgresql://deploy@localhost/runner_test'
const journal = JSON.parse(readFileSync(resolve(import.meta.dirname, '../migrations/meta/_journal.json'), 'utf8')) as {
  entries: Array<{ when: number; tag: string }>
}
const baseline = journal.entries[0]
if (baseline === undefined) throw new Error('Released migration journal must have a baseline')
const lock = 'SELECT pg_advisory_lock(703143015642)'
const unlock = 'SELECT pg_advisory_unlock(703143015642)'
const migration = (folderMillis = baseline.when): Migration => ({
  folderMillis, hash: 'fixture-hash', sql: ['BEGIN;\nSELECT 1;', 'SELECT 2;\nCOMMIT;'],
})

beforeEach(() => {
  state.migrations = [migration()]
  state.applied = []
  state.statements = []
  state.failures.clear()
  state.bootstrap = true
  state.connectError = undefined
  state.release.mockReset()
  state.end.mockReset().mockResolvedValue(undefined)
})

afterEach(() => vi.unstubAllEnvs())

describe('deployment migration transaction ownership', () => {
  it('applies each missing migration and journal write before its commit, then releases lock and pool', async () => {
    state.migrations.push({ folderMillis: baseline.when + 1, hash: 'next-hash', sql: ['SELECT 3;'] })
    await migrateDatabase(deploymentUrl)
    expect(state.statements.map(entry => entry.sql)).toEqual([
      "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS journal_exists",
      lock, 'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC',
      'BEGIN', 'SELECT 1;\n', '\nSELECT 2;',
      'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', 'COMMIT',
      'BEGIN', 'SELECT 3;', 'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', 'COMMIT', unlock,
    ])
    expect(state.statements.filter(entry => entry.sql.startsWith('INSERT')).map(entry => entry.values)).toEqual([
      ['fixture-hash', baseline.when], ['next-hash', baseline.when + 1],
    ])
    expect(state.release).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(state.end).toHaveBeenCalledOnce()
  })

  it('uses the deployment-only environment URL when no explicit URL is supplied', async () => {
    vi.stubEnv('DATABASE_MIGRATION_URL', deploymentUrl)
    await migrateDatabase()
    expect(state.statements.map(entry => entry.sql)).toContain('COMMIT')
    expect(state.end).toHaveBeenCalledOnce()
  })

  it('skips already applied migrations with the same hashes without opening another transaction', async () => {
    state.applied = [{ hash: 'fixture-hash', created_at: String(baseline.when) }]
    await migrateDatabase(deploymentUrl)
    expect(state.statements.map(entry => entry.sql)).not.toContain('BEGIN')
    expect(state.statements.at(-1)?.sql).toBe(unlock)
    expect(state.release).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('accepts duplicate identical journal rows while rejecting conflicting rows', async () => {
    state.applied = [{ hash: 'fixture-hash', created_at: String(baseline.when) }, { hash: 'fixture-hash', created_at: String(baseline.when) }]
    await migrateDatabase(deploymentUrl)
    expect(state.statements.map(entry => entry.sql)).not.toContain('BEGIN')
    state.applied[1] = { hash: 'conflicting-hash', created_at: String(baseline.when) }
    await expect(migrateDatabase(deploymentUrl)).rejects.toThrow(`Conflicting PostgreSQL migration history at ${String(baseline.when)}`)
  })

  it.each([baseline.when, 123])('rejects a modified applied migration at timestamp %i', async (timestamp) => {
    state.migrations = [migration(timestamp)]
    state.applied = [{ hash: 'different-hash', created_at: String(timestamp) }]
    await expect(migrateDatabase(deploymentUrl)).rejects.toThrow(`migration ${timestamp === baseline.when ? baseline.tag : String(timestamp)} differs`)
    expect(state.statements.map(entry => entry.sql)).not.toContain('BEGIN')
    expect(state.statements.at(-1)?.sql).toBe(unlock)
    expect(state.release).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(state.end).toHaveBeenCalledOnce()
  })

  it('rejects a gap preceding the latest applied migration before changing the database', async () => {
    state.applied = [{ hash: 'later-hash', created_at: String(baseline.when + 1) }]
    await expect(migrateDatabase(deploymentUrl)).rejects.toThrow(`history is missing earlier migration ${baseline.tag}`)
    expect(state.statements.map(entry => entry.sql)).not.toContain('BEGIN')
    expect(state.statements.at(-1)?.sql).toBe(unlock)
  })

  it('fails missing ownership bootstrap without trying to unlock a lock it never acquired', async () => {
    state.bootstrap = false
    await expect(migrateDatabase(deploymentUrl)).rejects.toThrow('baseline 0001 and its DBA ownership bootstrap')
    expect(state.statements.map(entry => entry.sql)).not.toContain(lock)
    expect(state.statements.map(entry => entry.sql)).not.toContain(unlock)
    expect(state.release).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(state.end).toHaveBeenCalledOnce()
  })

  it('closes the pool when connection acquisition fails', async () => {
    const failure = new Error('connection unavailable')
    state.connectError = failure
    await expect(migrateDatabase(deploymentUrl)).rejects.toBe(failure)
    expect(state.release).not.toHaveBeenCalled()
    expect(state.end).toHaveBeenCalledOnce()
  })

  it('releases a connection if acquiring the deployment advisory lock fails', async () => {
    const failure = new Error('lock unavailable')
    state.failures.set(lock, failure)
    await expect(migrateDatabase(deploymentUrl)).rejects.toBe(failure)
    expect(state.statements.map(entry => entry.sql)).not.toContain(unlock)
    expect(state.release).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('rolls back failed migration SQL, preserves the original error, and leaves no journal write', async () => {
    const failure = new Error('DDL rejected')
    state.failures.set('SELECT 1;\n', failure)
    await expect(migrateDatabase(deploymentUrl)).rejects.toBe(failure)
    expect(state.statements.map(entry => entry.sql).slice(-2)).toEqual(['ROLLBACK', unlock])
    expect(state.statements.some(entry => entry.sql.startsWith('INSERT'))).toBe(false)
    expect(state.release).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(state.end).toHaveBeenCalledOnce()
  })

  it.each([new Error('rollback connection failed'), 'non-Error rollback failure'])(
    'preserves the SQL error when rollback also fails (%s)', async (rollbackFailure) => {
      const failure = new Error('SQL rejected')
      state.failures.set('SELECT 1;\n', failure)
      state.failures.set('ROLLBACK', rollbackFailure)
      await expect(migrateDatabase(deploymentUrl)).rejects.toBe(failure)
      expect(state.release).toHaveBeenCalledExactlyOnceWith(rollbackFailure instanceof Error ? rollbackFailure : undefined)
      expect(state.statements.map(entry => entry.sql)).toContain('ROLLBACK')
      expect(state.statements.map(entry => entry.sql).includes(unlock)).toBe(!(rollbackFailure instanceof Error))
      expect(state.end).toHaveBeenCalledOnce()
    },
  )

  it.each([new Error('unlock connection failed'), 'non-Error unlock failure'])(
    'releases the connection and closes its pool even if unlocking fails (%s)', async (failure) => {
      state.failures.set(unlock, failure)
      await expect(migrateDatabase(deploymentUrl)).rejects.toBe(failure)
      expect(state.release).toHaveBeenCalledExactlyOnceWith(failure instanceof Error ? failure : undefined)
      expect(state.end).toHaveBeenCalledOnce()
    },
  )

  it('rejects a broken packaged migration directory before opening a connection', () => {
    expect(() => resolveMigrationsDirectory(new URL('missing/index.js', import.meta.url).href)).toThrow('missing their Drizzle journal')
  })

  it('creates an environment-configured runtime pool lazily and closes it explicitly', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://runtime@localhost/runtime_test')
    const database = createDatabase()
    expect(state.statements).toHaveLength(0)
    expect(database.db).toBeDefined()
    await database.close()
    expect(state.end).toHaveBeenCalledOnce()
  })

  it('wraps an existing connection without creating or closing another pool', async () => {
    const { Client } = await vi.importActual<typeof import('pg')>('pg')
    const release = vi.fn<() => void>()
    const query = vi.fn<(statement: unknown, parameters: unknown[]) => Promise<{ rows: Array<{ probe: number }> }>>()
      .mockResolvedValue({ rows: [{ probe: 1 }] })
    const client = Object.assign(new Client(), { release, query })
    const database = drizzleFromPoolClient(client)
    expect((await database.execute(sql`SELECT ${1} AS probe`)).rows).toEqual([{ probe: 1 }])
    expect(query).toHaveBeenCalledOnce()
    const call = query.mock.calls[0]
    if (call === undefined) throw new Error('Expected query to use the supplied connection')
    expect(call[0]).toHaveProperty('text', 'SELECT $1 AS probe')
    expect(call[1]).toEqual([1])
    expect(release).not.toHaveBeenCalled()
    expect(state.end).not.toHaveBeenCalled()
  })
})
