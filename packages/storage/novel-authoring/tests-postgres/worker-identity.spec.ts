import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  migrateDatabase, sql, withRequestContext, type RequestDatabaseContext,
} from '@deepseek-ai/dsh-database-postgres'
import * as authoring from '../src/index.ts'
import { novelPostgresFixture, readForgedRollbackContext } from './fixture.ts'

const { control, connectControl, migrationUrl, runtime } = novelPostgresFixture()
const database = runtime('dsh_worker_runtime', 'worker-identity')
const agentPrincipalId = 'novel-worker'

beforeAll(async () => {
  await migrateDatabase(migrationUrl)
  await connectControl()
})

afterAll(async () => { await Promise.all([database.close(), control.end()]) })

interface SeedOptions {
  readonly agent?: string
  readonly status?: authoring.GenerationRunStatus
  readonly userStatus?: string
  readonly verified?: boolean
  readonly userDeleted?: boolean
  readonly sessionExpired?: boolean
  readonly sessionRevoked?: boolean
  readonly sessionMismatch?: boolean
  readonly role?: string
  readonly memberRevoked?: boolean
  readonly workspaceStatus?: string
  readonly workspaceDeleted?: boolean
}

async function seed(options: SeedOptions = {}) {
  const userId = randomUUID()
  const sessionId = randomUUID()
  const workspaceId = randomUUID()
  const novelId = randomUUID()
  const generationRunId = randomUUID()
  await control.query(`INSERT INTO auth.users(id,email,email_normalized,password_hash,status,password_changed_at,email_verified_at,deleted_at)
    VALUES ($1,$2,$2,'fixture',$3,now(),CASE WHEN $4 THEN now() END,CASE WHEN $5 THEN now() END)`,
  [userId, `${userId}@test.invalid`, options.userStatus ?? 'active', options.verified ?? true, options.userDeleted ?? false])
  let sessionUserId = userId
  if (options.sessionMismatch) {
    sessionUserId = randomUUID()
    await control.query(`INSERT INTO auth.users(id,email,email_normalized,password_hash,status,password_changed_at,email_verified_at)
      VALUES ($1,$2,$2,'fixture','active',now(),now())`, [sessionUserId, `${sessionUserId}@test.invalid`])
  }
  await control.query(`INSERT INTO auth.sessions(id,user_id,token_hash,client_type,expires_at,last_seen_at,revoked_at)
    VALUES ($1,$2,$3,'web',now()+CASE WHEN $4 THEN interval '-1 day' ELSE interval '1 day' END,
      now(),CASE WHEN $5 THEN now() END)`,
  [sessionId, sessionUserId, randomUUID(), options.sessionExpired ?? false, options.sessionRevoked ?? false])
  await control.query(`INSERT INTO app.workspaces(id,owner_user_id,name,status,deleted_at)
    VALUES ($1,$2,'Worker identity fixture',$3,CASE WHEN $4 THEN now() END)`,
  [workspaceId, userId, options.workspaceStatus ?? 'active', options.workspaceDeleted ?? false])
  await control.query(`INSERT INTO app.workspace_members(workspace_id,user_id,role,revoked_at)
    VALUES ($1,$2,$3,CASE WHEN $4 THEN now() END)`, [workspaceId, userId, options.role ?? 'owner', options.memberRevoked ?? false])
  await control.query(`INSERT INTO novel.novels(id,workspace_id,title,status,created_by_user_id)
    VALUES ($1,$2,'Worker identity fixture','draft',$3)`, [novelId, workspaceId, userId])
  await control.query(`INSERT INTO ai.generation_runs(id,workspace_id,novel_id,initiated_by_user_id,agent_principal_id,
    model,prompt_version,source_session_id,status,idempotency_key,instruction,context_limit,completed_at)
    VALUES ($1,$2,$3,$4,$5,'fixture','v1',$6,$7,$8,'Saved instruction',0,
      CASE WHEN $7 IN ('completed','failed','cancelled') THEN now() END)`,
  [generationRunId, workspaceId, novelId, userId, options.agent ?? 'user-request', sessionId, options.status ?? 'queued', randomUUID()])
  return { locator: { workspaceId, generationRunId }, userId, sessionId, novelId }
}

function lookup(locator: { workspaceId: string; generationRunId: string }, context: Partial<RequestDatabaseContext> = {}) {
  return withRequestContext(database, {
    userId: '', workspaceId: locator.workspaceId, actorType: 'agent', agentPrincipalId, ...context,
  }, async db => (await db.execute(sql`SELECT * FROM ai.resolve_generation_run_worker_identity(
    ${locator.workspaceId}::uuid, ${locator.generationRunId}::uuid
  )`)).rows)
}

async function settle(locator: { workspaceId: string; generationRunId: string }) {
  return withRequestContext(database, {
    userId: '', workspaceId: locator.workspaceId, actorType: 'agent', agentPrincipalId,
  }, async db => (await db.execute<{ acknowledge: boolean }>(sql`
    SELECT ai.settle_generation_run_without_authority(${locator.workspaceId}::uuid, ${locator.generationRunId}::uuid) AS acknowledge
  `)).rows[0]?.acknowledge)
}

describe('persisted generation worker identity under restricted PostgreSQL roles', () => {
  it('exposes only the approved worker lookup with a fixed search path and migrator ownership', async () => {
    const result = await control.query(`SELECT owner.rolname AS owner, function.prosecdef, function.provolatile,
      function.proconfig, function.proargnames
      FROM pg_proc AS function JOIN pg_roles AS owner ON owner.oid = function.proowner
      WHERE function.oid = to_regprocedure('ai.resolve_generation_run_worker_identity(uuid,uuid)')`)
    expect(result.rows).toEqual([{
      owner: 'dsh_migrator', prosecdef: true, provolatile: 's',
      proconfig: ['search_path=pg_catalog, app, ai, auth'],
      proargnames: ['requested_workspace_id', 'requested_run_id', 'user_id', 'session_id', 'workspace_id', 'novel_id', 'member_role', 'run_status'],
    }])
    const grants = await control.query(`SELECT grantee.rolname, acl.privilege_type FROM pg_proc AS function
      CROSS JOIN LATERAL aclexplode(function.proacl) AS acl LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
      WHERE function.oid = 'ai.resolve_generation_run_worker_identity(uuid,uuid)'::regprocedure
      ORDER BY grantee.rolname`)
    expect(grants.rows).toEqual([
      { rolname: 'dsh_migrator', privilege_type: 'EXECUTE' },
      { rolname: 'dsh_worker_runtime', privilege_type: 'EXECUTE' },
    ])
    const roles = await control.query(`SELECT role, has_function_privilege(role,
      'ai.resolve_generation_run_worker_identity(uuid,uuid)', 'EXECUTE') AS allowed
      FROM unnest(ARRAY['dsh_app_runtime','dsh_auth_runtime','dsh_readonly','dsh_service_runtime']) AS role`)
    expect(roles.rows.every(row => row.allowed === false)).toBe(true)
  })

  it('keeps authentication tables unreadable to the worker login', async () => {
    const login = await withRequestContext(database, { userId: '', workspaceId: '', actorType: 'agent', agentPrincipalId }, async db =>
      (await db.execute(sql`SELECT current_user AS role, has_table_privilege(current_user, 'auth.users', 'SELECT') AS users,
        has_table_privilege(current_user, 'auth.sessions', 'SELECT') AS sessions`)).rows)
    expect(login).toEqual([{ role: 'dsh_worker_runtime', users: false, sessions: false }])
    await expect(database.db.execute(sql`SELECT id FROM auth.users LIMIT 1`)).rejects.toMatchObject({ cause: { code: '42501' } })
    await expect(database.db.execute(sql`SELECT id FROM auth.sessions LIMIT 1`)).rejects.toMatchObject({ cause: { code: '42501' } })
  })

  it.each(['owner', 'admin', 'editor'])('resolves a queued browser request with current %s authority and no supplied user identity', async (role) => {
    const fixture = await seed({ role })
    await expect(lookup(fixture.locator)).resolves.toEqual([{
      user_id: fixture.userId, session_id: fixture.sessionId, workspace_id: fixture.locator.workspaceId,
      novel_id: fixture.novelId, member_role: role, run_status: 'queued',
    }])
  })

  it.each(['queued', 'running', 'completed', 'failed', 'cancelled'] as const)('resolves an assigned worker run in %s state without changing it', async (status) => {
    const fixture = await seed({ agent: agentPrincipalId, status })
    const resolver = new authoring.PostgresGenerationWorkerIdentity(database, agentPrincipalId)
    await expect(resolver.resolve(fixture.locator)).resolves.toEqual({
      principal: {
        userId: fixture.userId, sessionId: fixture.sessionId, workspaceId: fixture.locator.workspaceId,
        actorType: 'agent', agentPrincipalId, clientType: 'official-client', roles: ['owner'],
      },
      novelId: fixture.novelId, status,
    })
    const stored = await control.query('SELECT status, agent_principal_id FROM ai.generation_runs WHERE id=$1', [fixture.locator.generationRunId])
    expect(stored.rows).toEqual([{ status, agent_principal_id: agentPrincipalId }])
  })

  it('returns null for unknown run and workspace locators', async () => {
    const resolver = new authoring.PostgresGenerationWorkerIdentity(database, agentPrincipalId)
    const fixture = await seed()
    await expect(resolver.resolve({ ...fixture.locator, generationRunId: randomUUID() })).resolves.toBeNull()
    await expect(resolver.resolve({ ...fixture.locator, workspaceId: randomUUID() })).resolves.toBeNull()
  })

  it.each([
    ['another assigned agent', { agent: 'other-worker' }],
    ['a running unassigned browser request', { status: 'running' }],
    ['an expired session', { sessionExpired: true }],
    ['a revoked session', { sessionRevoked: true }],
    ['a session belonging to another user', { sessionMismatch: true }],
    ['an inactive account', { userStatus: 'suspended' }],
    ['an unverified account', { verified: false }],
    ['a deleted account', { userDeleted: true }],
    ['a revoked membership', { memberRevoked: true }],
    ['a read-only membership', { role: 'member' }],
    ['an archived workspace', { workspaceStatus: 'archived' }],
    ['a deleted workspace', { workspaceDeleted: true }],
  ] satisfies ReadonlyArray<readonly [string, SeedOptions]>)('hides identity for %s', async (_name, options) => {
    const fixture = await seed(options)
    const resolver = new authoring.PostgresGenerationWorkerIdentity(database, agentPrincipalId)
    await expect(resolver.resolve(fixture.locator)).resolves.toBeNull()
  })

  it('requires matching workspace, an agent actor, and an agent principal even with a known locator', async () => {
    const fixture = await seed({ agent: agentPrincipalId })
    await expect(lookup(fixture.locator, { workspaceId: randomUUID() })).resolves.toEqual([])
    await expect(lookup(fixture.locator, { actorType: 'user' })).resolves.toEqual([])
    await expect(lookup(fixture.locator, { agentPrincipalId: '' })).resolves.toEqual([])
    await expect(lookup(fixture.locator, { agentPrincipalId: 'other-worker' })).resolves.toEqual([])
  })

  it('does not accept the migrator owner as a worker even with forged agent and workspace context', async () => {
    const fixture = await seed()
    await control.query('BEGIN')
    try {
      await control.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_type','agent',true),set_config('app.agent_principal_id',$2,true)",
        [fixture.locator.workspaceId, agentPrincipalId])
      const result = await control.query('SELECT * FROM ai.resolve_generation_run_worker_identity($1,$2)',
        [fixture.locator.workspaceId, fixture.locator.generationRunId])
      expect(result.rows).toEqual([])
    } finally { await control.query('ROLLBACK') }
  })

  it('rechecks revoked session authority on every resolution', async () => {
    const fixture = await seed()
    const resolver = new authoring.PostgresGenerationWorkerIdentity(database, agentPrincipalId)
    expect(await resolver.resolve(fixture.locator)).not.toBeNull()
    await control.query('UPDATE auth.sessions SET revoked_at=now() WHERE id=$1', [fixture.sessionId])
    await expect(resolver.resolve(fixture.locator)).resolves.toBeNull()
  })

  it.each(['queued', 'running'] as const)('settles a %s run after session revocation with one terminal audit', async (status) => {
    const fixture = await seed({ status, ...(status === 'running' ? { agent: agentPrincipalId } : {}) })
    const { locator, sessionId } = fixture
    await expect(settle(locator)).resolves.toBe(false)
    await control.query('UPDATE auth.sessions SET revoked_at=now() WHERE id=$1', [sessionId])
    await expect(settle(locator)).resolves.toBe(true)
    await expect(settle(locator)).resolves.toBe(true)
    expect((await control.query('SELECT status, error_code, completed_at IS NOT NULL AS completed FROM ai.generation_runs WHERE id=$1',
      [locator.generationRunId])).rows).toEqual([{ status: 'failed', error_code: 'GENERATION_AUTHORITY_UNAVAILABLE', completed: true }])
    expect((await control.query('SELECT actor_id FROM security.audit_events WHERE target_id=$1 AND metadata->>\'status\'=\'failed\'',
      [locator.generationRunId])).rows).toEqual([{ actor_id: agentPrincipalId }])
  })

  it('acknowledges unrelated and missing deliveries without changing their rows', async () => {
    const { locator } = await seed({ agent: 'other-worker', sessionRevoked: true })
    await expect(settle(locator)).resolves.toBe(true)
    await expect(settle({ ...locator, generationRunId: randomUUID() })).resolves.toBe(true)
    await expect(settle({ ...locator, workspaceId: randomUUID() })).resolves.toBe(true)
    expect((await control.query('SELECT status FROM ai.generation_runs WHERE id=$1', [locator.generationRunId])).rows).toEqual([{ status: 'queued' }])
  })

  it('allows only the worker runtime to invoke settlement', async () => {
    const { rows } = await control.query(`SELECT role, has_function_privilege(role,
      'ai.settle_generation_run_without_authority(uuid,uuid)', 'EXECUTE') AS allowed
      FROM unnest(ARRAY['dsh_app_runtime','dsh_auth_runtime','dsh_readonly','dsh_service_runtime','dsh_worker_runtime']) AS role`)
    expect(rows).toEqual([
      { role: 'dsh_app_runtime', allowed: false }, { role: 'dsh_auth_runtime', allowed: false },
      { role: 'dsh_readonly', allowed: false }, { role: 'dsh_service_runtime', allowed: false },
      { role: 'dsh_worker_runtime', allowed: true },
    ])
  })
})

describe('worker draft publication guards under restricted PostgreSQL roles', () => {
  it('persists an own-run character draft through the publication guard', async () => {
    const fixture = await seed({ agent: agentPrincipalId, status: 'running' })
    const identity = await new authoring.PostgresGenerationWorkerIdentity(database, agentPrincipalId).resolve(fixture.locator)
    if (identity === null) throw new Error('Seeded worker identity was not resolved')
    const service = new authoring.NovelAuthoringService(database, identity.principal)
    const id = await service.createCharacterDraft({
      ...fixture.locator, novelId: fixture.novelId, name: 'Guarded courier', idempotencyKey: randomUUID(),
    })
    const stored = await control.query('SELECT status, source_generation_run_id FROM novel.characters WHERE id=$1', [id])
    expect(stored.rows).toEqual([{ status: 'draft', source_generation_run_id: fixture.locator.generationRunId }])
  })

  it('keeps rollback inactive for a worker with forged user and rollback settings', async () => {
    const result = await readForgedRollbackContext(database)
    expect(result).toEqual([{ role: 'dsh_worker_runtime', active: false }])
  })

  it('keeps entity rollback execution exclusive to the service role', async () => {
    const result = await control.query(`SELECT role_name, has_function_privilege(role_name,
      'ai.rollback_entity_version(uuid,text,uuid,integer)', 'EXECUTE') AS allowed
      FROM unnest(ARRAY['dsh_app_runtime','dsh_worker_runtime','dsh_service_runtime']) AS roles(role_name)`)
    expect(result.rows).toEqual([
      { role_name: 'dsh_app_runtime', allowed: false },
      { role_name: 'dsh_worker_runtime', allowed: false },
      { role_name: 'dsh_service_runtime', allowed: true },
    ])
    const helper = await control.query(`SELECT prosecdef,
      EXISTS (SELECT 1 FROM aclexplode(proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute,
      has_function_privilege('dsh_auth_runtime', oid, 'EXECUTE') AS auth_execute,
      has_function_privilege('dsh_readonly', oid, 'EXECUTE') AS readonly_execute
      FROM pg_proc WHERE oid='novel.rollback_context_active()'::regprocedure`)
    expect(helper.rows).toEqual([{ prosecdef: false, public_execute: false, auth_execute: false, readonly_execute: false }])
  })
})
