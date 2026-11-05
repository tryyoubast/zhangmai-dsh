import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createDatabase, sql } from '@deepseek-ai/dsh-database-postgres'
import { Pool, type PoolClient } from 'pg'
import { expect } from 'vitest'
import { hashToken, PostgresRefreshTokenStore, type RefreshTokenReplacement } from '../src/index.ts'

function testUrls(): { runtime: string; migration: string } {
  function required(name: 'DATABASE_TEST_URL' | 'DATABASE_TEST_MIGRATION_URL'): URL {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`${name} is required for PostgreSQL integration tests`)
    const url = new URL(value)
    if (!decodeURIComponent(url.pathname).toLowerCase().includes('test')) {
      throw new Error(`${name} database name must contain "test"`)
    }
    return url
  }
  const runtime = required('DATABASE_TEST_URL')
  const migration = required('DATABASE_TEST_MIGRATION_URL')
  if (runtime.hostname.toLowerCase() !== migration.hostname.toLowerCase()
    || (runtime.port || '5432') !== (migration.port || '5432')
    || decodeURIComponent(runtime.pathname) !== decodeURIComponent(migration.pathname)) {
    throw new Error('runtime and migration test URLs must target the same host, port, and database')
  }
  return { runtime: runtime.href, migration: migration.href }
}

function runtimeDatabase(url: string, applicationName: string) {
  return createDatabase({
    url, applicationName, runtimeRole: 'dsh_auth_runtime', maxConnections: 1,
    idleTimeoutMs: 60_000, connectionTimeoutMs: 5_000,
  })
}

interface TokenRow {
  id: string
  token_hash: string
  used_at: Date | null
  revoked_at: Date | null
  replaced_by: string | null
}

/** Per-test database resources; audit rows remain until the disposable database is removed. */
class Fixture {
  readonly suffix = randomUUID().replaceAll('-', '')
  readonly userId = randomUUID()
  readonly sessionId = randomUUID()
  readonly familyId = randomUUID()
  readonly now = new Date()
  readonly expiresAt = new Date(this.now.getTime() + 3_600_000)
  readonly firstDatabase
  readonly secondDatabase
  readonly first
  readonly second
  readonly pool: Pool
  migrator: PoolClient | undefined
  control: PoolClient | undefined
  firstPid = 0
  secondPid = 0
  controlPid = 0
  private readonly operations: Promise<unknown>[] = []
  private readonly triggers: Array<{ name: string; table: string }> = []

  constructor() {
    const urls = testUrls()
    this.firstDatabase = runtimeDatabase(urls.runtime, `refresh-first-${this.suffix}`)
    this.secondDatabase = runtimeDatabase(urls.runtime, `refresh-second-${this.suffix}`)
    this.first = new PostgresRefreshTokenStore(this.firstDatabase, () => this.now)
    this.second = new PostgresRefreshTokenStore(this.secondDatabase, () => this.now)
    this.pool = new Pool({
      connectionString: urls.migration, max: 2, connectionTimeoutMillis: 5_000,
      application_name: `refresh-fixture-${this.suffix}`, statement_timeout: 12_000,
    })
  }

  async setup(): Promise<void> {
    this.migrator = await this.pool.connect()
    await this.migrator.query('SET ROLE dsh_migrator')
    this.control = await this.pool.connect()
    await this.control.query('SET ROLE dsh_migrator')
    this.controlPid = (await this.control.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    for (const database of [this.firstDatabase, this.secondDatabase]) {
      // createDatabase rejects superuser, BYPASSRLS, and every membership except dsh_auth_runtime.
      await database.db.execute(sql`SET statement_timeout = '12s'`)
    }
    this.firstPid = (await this.firstDatabase.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid
    this.secondPid = (await this.secondDatabase.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid
    await this.migrator.query(
      `INSERT INTO auth.users
        (id, email, email_normalized, password_hash, status, email_verified_at, password_changed_at)
      VALUES ($1, $2, $2, 'test-password-hash', 'active', $3, $3)`,
      [this.userId, `refresh-${this.userId}@example.invalid`, this.now],
    )
    await this.migrator.query(
      `INSERT INTO auth.sessions (id, user_id, token_hash, client_type, expires_at, last_seen_at)
      VALUES ($1, $2, $3, 'official_client', $4, $5)`,
      [this.sessionId, this.userId, hashToken(randomUUID()), this.expiresAt, this.now],
    )
  }

  replacement(): RefreshTokenReplacement {
    return { id: randomUUID(), tokenHash: hashToken(randomUUID()), expiresAt: this.expiresAt }
  }

  async token(familyId = this.familyId) {
    const raw = randomUUID()
    const token = { ...this.replacement(), tokenHash: hashToken(raw), raw, familyId }
    await this.migrator!.query(
      `INSERT INTO auth.refresh_tokens (id, user_id, session_id, family_id, token_hash, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [token.id, this.userId, this.sessionId, familyId, token.tokenHash, this.expiresAt],
    )
    return token
  }

  track<T>(operation: Promise<T>): Promise<T> {
    this.operations.push(operation)
    // A gate observation can throw before the caller reaches its await; teardown still drains this operation.
    void operation.catch(() => undefined)
    return operation
  }

  private async triggerDdl(table: string, statement: string): Promise<void> {
    const deadline = Date.now() + 8_000
    while (true) {
      await this.migrator!.query('BEGIN')
      try {
        // A queued trigger DDL lock would block another fixture's competing request behind its gated transaction.
        await this.migrator!.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE NOWAIT`)
        await this.migrator!.query(statement)
        await this.migrator!.query('COMMIT')
        return
      } catch (error) {
        try {
          await this.migrator!.query('ROLLBACK')
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Fixture trigger DDL and rollback failed')
        }
        if ((error as { code?: string }).code !== '55P03' || Date.now() >= deadline) throw error
      }
      await delay(10)
    }
  }

  async gate(tokenId: string, transition: 'used' | 'revoked' = 'used'): Promise<() => Promise<void>> {
    const suffix = randomUUID().replaceAll('-', '')
    const name = `refresh_gate_${suffix}`
    const gate = {
      keys: [Number.parseInt(suffix.slice(0, 8), 16) | 0, Number.parseInt(suffix.slice(8, 16), 16) | 0] as [number, number],
      held: false,
    }
    await this.control!.query('SELECT pg_advisory_lock($1::int, $2::int)', gate.keys)
    gate.held = true
    this.triggers.push({ name, table: 'auth.refresh_tokens' })
    await this.migrator!.query(`CREATE FUNCTION auth.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${gate.keys[0]}, ${gate.keys[1]});
        RETURN NEW;
      END $$`)
    const column = transition === 'used' ? 'used_at' : 'revoked_at'
    await this.triggerDdl('auth.refresh_tokens', `CREATE TRIGGER ${name} BEFORE UPDATE ON auth.refresh_tokens
      FOR EACH ROW WHEN (OLD.id = '${tokenId}'::uuid AND OLD.${column} IS NULL AND NEW.${column} IS NOT NULL)
      EXECUTE FUNCTION auth.${name}()`)
    return async () => {
      if (!gate.held) return
      await this.control!.query('SELECT pg_advisory_unlock($1::int, $2::int)', gate.keys)
      gate.held = false
    }
  }

  async blocked(waiterPid: number, blockerPid: number): Promise<void> {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const result = await this.migrator!.query<{ blocked: boolean }>(
        'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked', [waiterPid, blockerPid],
      )
      if (result.rows[0]!.blocked) return
      // Polling cadence bounds observer traffic; only the blocker observation establishes readiness.
      await delay(10)
    }
    throw new Error(`backend ${waiterPid} was not observed blocked by backend ${blockerPid}`)
  }

  async tokens(familyId = this.familyId): Promise<TokenRow[]> {
    return (await this.migrator!.query<TokenRow>(
      `SELECT id, token_hash, used_at, revoked_at, replaced_by FROM auth.refresh_tokens
      WHERE family_id = $1 ORDER BY created_at, id`, [familyId],
    )).rows
  }

  async audit(tokenId: string, count = 1): Promise<void> {
    const result = await this.migrator!.query(
      `SELECT workspace_id, actor_type, actor_id, action, target_type, target_id, metadata, created_at
      FROM security.audit_events WHERE action = 'auth.refresh_token_reuse_detected' AND target_id = $1`,
      [this.familyId],
    )
    expect(result.rows).toHaveLength(count)
    if (count === 0) return
    expect(result.rows).toEqual([{
      workspace_id: null, actor_type: 'system', actor_id: 'auth.refresh_token_service',
      action: 'auth.refresh_token_reuse_detected', target_type: 'refresh_token_family',
      target_id: this.familyId, metadata: { userId: this.userId, sessionId: this.sessionId, tokenId },
      created_at: this.now,
    }])
  }

  async failAudit(): Promise<() => Promise<void>> {
    const name = `refresh_audit_failure_${this.suffix}`
    this.triggers.push({ name, table: 'security.audit_events' })
    await this.migrator!.query(`CREATE FUNCTION auth.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture audit insert failed'; END $$`)
    await this.triggerDdl('security.audit_events', `CREATE TRIGGER ${name} BEFORE INSERT ON security.audit_events
      FOR EACH ROW WHEN (NEW.target_id = '${this.familyId}') EXECUTE FUNCTION auth.${name}()`)
    return async () => { await this.triggerDdl('security.audit_events', `DROP TRIGGER IF EXISTS ${name} ON security.audit_events`) }
  }

  async cleanup(): Promise<unknown[]> {
    const errors: unknown[] = []
    const attempt = async (operation: () => Promise<unknown>) => {
      try { await operation() } catch (error) { errors.push(error) }
    }
    // Releasing the dedicated control connection also releases gates if explicit unlock fails.
    if (this.control) {
      await attempt(() => this.control!.query('SELECT pg_advisory_unlock_all()'))
      this.control.release(errors.length > 0)
      this.control = undefined
    }
    await Promise.allSettled(this.operations)
    if (this.migrator) {
      for (const { name, table } of this.triggers) {
        await attempt(() => this.triggerDdl(table, `DROP TRIGGER IF EXISTS ${name} ON ${table}`))
        await attempt(() => this.migrator!.query(`DROP FUNCTION IF EXISTS auth.${name}()`))
      }
      await attempt(() => this.migrator!.query('DELETE FROM auth.refresh_tokens WHERE user_id = $1', [this.userId]))
      await attempt(() => this.migrator!.query('DELETE FROM auth.sessions WHERE user_id = $1', [this.userId]))
      await attempt(() => this.migrator!.query('DELETE FROM auth.users WHERE id = $1', [this.userId]))
      this.migrator.release()
      this.migrator = undefined
    }
    const closed = await Promise.allSettled([this.firstDatabase.close(), this.secondDatabase.close(), this.pool.end()])
    for (const result of closed) if (result.status === 'rejected') errors.push(result.reason)
    return errors
  }
}

/** Acquire and dispose the complete fixture, preserving setup/test errors alongside cleanup errors.
 * @param body Assertions using the isolated fixture.
 * @returns Completion after operations, fixture records, triggers, and connections are disposed.
 */
export async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = new Fixture()
  const errors: unknown[] = []
  try {
    await fixture.setup()
    await body(fixture)
  } catch (error) {
    errors.push(error)
  }
  errors.push(...await fixture.cleanup())
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'PostgreSQL fixture failed and cleanup reported errors')
}
