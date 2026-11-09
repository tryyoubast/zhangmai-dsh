/** Real restricted runtime connections and migrator-owned deterministic concurrency barriers. */
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { createDatabase, migrateDatabase, type DatabaseClient, type DshDatabase } from '@deepseek-ai/dsh-database-postgres'
import { PostgresAuthStore, RefreshTokenService, hashToken } from '../src/index.ts'
import { postgresTestEnvironment } from './environment.ts'
import { TestPgClient } from './pg-client.ts'

export const testNow = new Date('2026-11-09T12:00:00Z')
export const testExpiry = new Date('2027-11-09T12:00:00Z')

/** Stored refresh metadata read independently of the auth store's return value. */
export interface StoredRefreshToken {
  readonly id: string
  readonly user_id: string
  readonly session_id: string
  readonly family_id: string
  readonly token_hash: string
  readonly used_at: Date | null
  readonly revoked_at: Date | null
  readonly replaced_by: string | null
}

/** An owned temporary database trigger and its control-session lock. */
export interface MutationBarrier {
  release(): Promise<void>
  dispose(): Promise<void>
}

/** Owned runtime sessions and a separately authenticated DDL/control session. */
export class PostgresAuthFixture {
  readonly control: TestPgClient
  readonly first: DatabaseClient<DshDatabase>
  readonly second: DatabaseClient<DshDatabase>
  readonly firstStore: PostgresAuthStore
  readonly secondStore: PostgresAuthStore
  readonly firstService: RefreshTokenService
  readonly secondService: RefreshTokenService
  readonly applicationNames = [randomUUID(), randomUUID()] as const

  constructor() {
    const config = postgresTestEnvironment()
    this.control = new TestPgClient({ connectionString: config.migrationUrl })
    const runtime = (applicationName: string) => createDatabase({
      url: config.runtimeUrl, runtimeRole: 'dsh_auth_runtime', maxConnections: 1,
      idleTimeoutMs: 10_000, connectionTimeoutMs: 5_000, applicationName,
    })
    this.first = runtime(this.applicationNames[0])
    this.second = runtime(this.applicationNames[1])
    this.firstStore = new PostgresAuthStore(this.first, () => testNow)
    this.secondStore = new PostgresAuthStore(this.second, () => testNow)
    this.firstService = new RefreshTokenService(this.firstStore, () => testNow)
    this.secondService = new RefreshTokenService(this.secondStore, () => testNow)
  }

  async open(): Promise<void> {
    await migrateDatabase(postgresTestEnvironment().migrationUrl)
    await this.control.connect()
    const role = await this.control.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = session_user')
    if (role.rows[0]?.rolsuper || role.rows[0]?.rolbypassrls) throw new Error('Test control must use a restricted migrator login')
    const memberships = await this.control.query(`SELECT rolname FROM pg_roles
      WHERE rolname <> session_user AND pg_has_role(session_user, oid, 'MEMBER')`)
    if (memberships.rows.length !== 1 || memberships.rows[0]?.rolname !== 'dsh_migrator') throw new Error('Test control login must belong only to dsh_migrator')
    await this.control.query('SET ROLE dsh_migrator')
    await this.control.query("SET statement_timeout = '15s'")
    for (const database of [this.first, this.second]) {
      await database.db.execute("SET statement_timeout = '15s'")
      // A host-level stronger default must not replace the store's explicitly chosen READ COMMITTED snapshots.
      await database.db.execute("SET default_transaction_isolation = 'repeatable read'")
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.first.close(), this.second.close(), this.control.end()])
  }

  async seed(): Promise<{ userId: string; sessionId: string }> {
    const userId = randomUUID()
    await this.control.query(`INSERT INTO auth.users(id,email,email_normalized,password_hash,status,password_changed_at)
      VALUES ($1,$2,$2,'original-password','active',$3)`, [userId, `${userId}@test.invalid`, testNow])
    const sessionId = await this.session(userId)
    return { userId, sessionId }
  }

  async session(userId: string): Promise<string> {
    const sessionId = randomUUID()
    await this.control.query(`INSERT INTO auth.sessions(id,user_id,token_hash,client_type,expires_at,last_seen_at)
      VALUES ($1,$2,$3,'official_client',$4,$5)`, [sessionId, userId, randomUUID(), testExpiry, testNow])
    return sessionId
  }

  async family(userId: string, sessionId: string) {
    return this.firstService.issue(userId, sessionId)
  }

  async tokens(familyId: string) {
    const result = await this.control.query<StoredRefreshToken>(`SELECT id,user_id,session_id,family_id,token_hash,used_at,revoked_at,replaced_by
      FROM auth.refresh_tokens WHERE family_id=$1 ORDER BY id`, [familyId])
    return result.rows
  }

  async audits(familyId: string) {
    const result = await this.control.query(`SELECT workspace_id,actor_type,actor_id,action,target_type,target_id,metadata
      FROM security.audit_events WHERE action='auth.refresh_token_reuse_detected' AND target_id=$1`, [familyId])
    return result.rows
  }

  async waitFor(label: string, predicate: () => Promise<boolean>): Promise<void> {
    const deadline = performance.now() + 10_000
    while (performance.now() < deadline) {
      if (await predicate()) return
      await setImmediate()
    }
    throw new Error(`Timed out waiting for PostgreSQL state: ${label}`)
  }

  async blocked(applicationName: string, advisoryOnly = false): Promise<boolean> {
    const result = await this.control.query(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity activity JOIN pg_locks lock ON lock.pid=activity.pid
      WHERE activity.application_name=$1 AND NOT lock.granted
      AND ($2::boolean = false OR lock.locktype='advisory')
    ) AS blocked`, [applicationName, advisoryOnly])
    return result.rows[0]?.blocked === true
  }

  /** Observe the exact family lock to distinguish family serialization from incidental row contention. */
  async waitingForFamily(applicationName: string, familyId: string): Promise<boolean> {
    const result = await this.control.query(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity activity JOIN pg_locks lock ON lock.pid=activity.pid
      CROSS JOIN LATERAL (SELECT hashtextextended('dsh:auth:refresh-family:' || $2::text, 0) AS key) family
      WHERE activity.application_name=$1 AND NOT lock.granted AND lock.locktype='advisory'
      AND lock.classid::bigint = ((family.key >> 32) & 4294967295)
      AND lock.objid::bigint = (family.key & 4294967295) AND lock.objsubid=1
    ) AS blocked`, [applicationName, familyId])
    return result.rows[0]?.blocked === true
  }

  /** Pause only this test's row mutation after production transaction locks have been acquired. */
  async barrier(table: 'auth.refresh_tokens' | 'auth.users', id: string, operation: 'UPDATE' | 'INSERT' = 'UPDATE'): Promise<MutationBarrier> {
    const name = `test_barrier_${randomUUID().replaceAll('-', '')}`
    const key = BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 14)}`).toString()
    await this.control.query('SELECT pg_advisory_lock($1::bigint)', [key])
    try {
      await this.control.query(`CREATE FUNCTION auth.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.id = '${id}'::uuid THEN
          IF current_setting('transaction_isolation') <> 'read committed' THEN
            RAISE EXCEPTION 'refresh operation must explicitly use READ COMMITTED';
          END IF;
          PERFORM pg_advisory_xact_lock(${key}::bigint);
        END IF;
        RETURN NEW; END $$`)
      await this.control.query(`CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION auth.${name}()`)
    } catch (error) {
      await this.control.query('SELECT pg_advisory_unlock($1::bigint)', [key])
      await this.control.query(`DROP FUNCTION IF EXISTS auth.${name}()`)
      throw error
    }
    return {
      release: async () => { await this.control.query('SELECT pg_advisory_unlock($1::bigint)', [key]) },
      dispose: async () => {
        await this.control.query('SELECT pg_advisory_unlock($1::bigint)', [key])
        await this.control.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`)
        await this.control.query(`DROP FUNCTION IF EXISTS auth.${name}()`)
      },
    }
  }

  async rejectAudit(familyId: string): Promise<() => Promise<void>> {
    const name = `test_audit_failure_${randomUUID().replaceAll('-', '')}`
    await this.control.query(`CREATE FUNCTION security.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.target_id = '${familyId}' THEN RAISE EXCEPTION 'injected audit insert failure'; END IF;
      RETURN NEW; END $$`)
    try {
      await this.control.query(`CREATE TRIGGER ${name} BEFORE INSERT ON security.audit_events FOR EACH ROW EXECUTE FUNCTION security.${name}()`)
    } catch (error) {
      await this.control.query(`DROP FUNCTION security.${name}()`)
      throw error
    }
    return async () => {
      await this.control.query(`DROP TRIGGER ${name} ON security.audit_events`)
      await this.control.query(`DROP FUNCTION security.${name}()`)
    }
  }
}

export { hashToken }
