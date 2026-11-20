import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrateDatabase, sql, withRequestContext } from '@deepseek-ai/dsh-database-postgres'
import { NovelAuthoringService, PostgresWorkspaceIdentity, WorkspaceAuthoringService } from '../src/index.ts'
import { postgresTestEnvironment } from '../../../identity/user-auth/tests-postgres/environment.ts'
import { novelPostgresFixture, readForgedRollbackContext } from './fixture.ts'

const { control, connectControl, migrationUrl, runtime } = novelPostgresFixture()
const databases = Array.from({ length: 2 }, () => runtime('dsh_app_runtime', 'workspace-identity'))
const identities = databases.map(database => new PostgresWorkspaceIdentity(database))
const identity = identities[0]!
const database = databases[0]!
const serviceConfig = postgresTestEnvironment({ ...process.env, DATABASE_TEST_URL: process.env.DATABASE_SERVICE_TEST_URL })
const serviceDatabase = runtime('dsh_service_runtime', 'service-guard', serviceConfig.runtimeUrl)

beforeAll(async () => {
  await migrateDatabase(migrationUrl)
  await connectControl()
})

afterAll(async () => {
  await Promise.all([...databases.map(item => item.close()), serviceDatabase.close(), control.end()])
})

async function user() {
  const userId = randomUUID()
  await control.query(`INSERT INTO auth.users(id,email,email_normalized,password_hash,status,password_changed_at,email_verified_at)
    VALUES ($1,$2,$2,'fixture','active',now(),now())`, [userId, `${userId}@test.invalid`])
  return userId
}

async function workspace(userId: string, status = 'active', revoked = false) {
  const workspaceId = randomUUID()
  await control.query("INSERT INTO app.workspaces(id,owner_user_id,name,status) VALUES ($1,$2,'Fixture workspace',$3)", [workspaceId, userId, status])
  await control.query(`INSERT INTO app.workspace_members(workspace_id,user_id,role,revoked_at)
    VALUES ($1,$2,'owner',CASE WHEN $3 THEN now() ELSE NULL END)`, [workspaceId, userId, revoked])
  return workspaceId
}

async function counts(userId: string) {
  const result = await control.query(`SELECT
    (SELECT count(*)::int FROM app.workspaces WHERE owner_user_id=$1) AS workspaces,
    (SELECT count(*)::int FROM app.workspace_members WHERE user_id=$1) AS memberships`, [userId])
  return result.rows[0]
}

describe('workspace identity using restricted PostgreSQL roles', () => {
  it('creates a workspace and owner membership before requiring SELECT visibility', async () => {
    const userId = await user()
    const workspaceId = await workspace(userId)
    const service = new WorkspaceAuthoringService(database, {
      userId, workspaceId, sessionId: randomUUID(), clientType: 'browser', actorType: 'user', roles: ['owner'],
    })
    const created = await service.createWorkspace({ name: 'Second workspace' })
    await expect(identity.resolve(userId, created)).resolves.toEqual({ userId, workspaceId: created, roles: ['owner'] })
  })

  it('restricts the no-parameter history function to the app role and fixed definer settings', async () => {
    const result = await control.query(`SELECT p.pronargs, p.prosecdef, p.proconfig, owner.rolname,
      has_function_privilege('dsh_app_runtime',p.oid,'EXECUTE') AS app_execute,
      has_function_privilege('dsh_auth_runtime',p.oid,'EXECUTE') AS auth_execute,
      has_function_privilege('dsh_worker_runtime',p.oid,'EXECUTE') AS worker_execute,
      has_function_privilege('dsh_service_runtime',p.oid,'EXECUTE') AS service_execute,
      has_function_privilege('dsh_readonly',p.oid,'EXECUTE') AS readonly_execute,
      EXISTS (SELECT 1 FROM aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner
      WHERE p.oid='app.current_user_workspace_memberships()'::regprocedure`)
    expect(result.rows).toEqual([{
      pronargs: 0, prosecdef: true, proconfig: ['search_path=pg_catalog, app'], rolname: 'dsh_migrator',
      app_execute: true, auth_execute: false, worker_execute: false, service_execute: false,
      readonly_execute: false, public_execute: false,
    }])
  })

  it('returns no history without an authenticated user GUC or with an agent actor', async () => {
    const userId = await user()
    await workspace(userId)
    for (const configuredUser of ['', 'invalid']) {
      const result = await withRequestContext(database, { userId: configuredUser, workspaceId: '', actorType: 'user' }, async db =>
        db.execute(sql`SELECT * FROM app.current_user_workspace_memberships()`))
      expect(result.rows).toEqual([])
    }
    const result = await withRequestContext(database, { userId, workspaceId: '', actorType: 'agent' }, async db =>
      db.execute(sql`SELECT * FROM app.current_user_workspace_memberships()`))
    expect(result.rows).toEqual([])
    await expect(withRequestContext(database, { userId, workspaceId: '', actorType: 'user' }, async db =>
      db.execute(sql`SELECT * FROM app.current_user_workspace_memberships(${userId}::uuid)`))).rejects.toThrow()
  })

  it('never creates data for ordinary requests, including an unknown user', async () => {
    const userId = await user()
    await expect(identity.resolve(userId)).resolves.toBeNull()
    await expect(identity.resolve(randomUUID())).resolves.toBeNull()
    await expect(counts(userId)).resolves.toEqual({ workspaces: 0, memberships: 0 })
  })

  it('serializes concurrent first logins into exactly one personal workspace', async () => {
    const userId = await user()
    const results = await Promise.all(identities.map(item => item.onboard(userId)))
    expect(results[0]?.workspaceId).toMatch(/^[\da-f-]{36}$/u)
    expect(results[0]).toEqual({ userId, workspaceId: results[0]?.workspaceId, roles: ['owner'] })
    expect(results[1]).toEqual(results[0])
    await expect(identity.onboard(userId)).resolves.toEqual(results[0])
    await expect(counts(userId)).resolves.toEqual({ workspaces: 1, memberships: 1 })
  })

  it.each([
    { status: 'active', revoked: true }, { status: 'archived', revoked: true }, { status: 'deleted', revoked: false },
  ])('does not recreate or restore inaccessible membership history: $status revoked=$revoked', async ({ status, revoked }) => {
    const userId = await user()
    const workspaceId = await workspace(userId, status, revoked)
    await expect(identity.onboard(userId)).resolves.toBeNull()
    await expect(identity.resolve(userId, workspaceId)).resolves.toBeNull()
    await expect(counts(userId)).resolves.toEqual({ workspaces: 1, memberships: 1 })
    const stored = await control.query('SELECT status FROM app.workspaces WHERE id=$1', [workspaceId])
    expect(stored.rows[0]?.status).toBe(status)
    const history = await withRequestContext(database, { userId, workspaceId: '', actorType: 'user' }, async db =>
      db.execute(sql`SELECT * FROM app.current_user_workspace_memberships()`))
    expect(history.rows).toHaveLength(1)
    expect(history.rows[0]?.workspace_status).toBe(status)
    expect(history.rows[0]?.revoked_at === null).toBe(!revoked)
  })

  it('restores an archived workspace only with an existing administrator membership and explicit request', async () => {
    const owner = await user()
    const editor = await user()
    const workspaceId = await workspace(owner, 'archived')
    await control.query("INSERT INTO app.workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'editor')", [workspaceId, editor])
    const expected = { userId: owner, workspaceId, roles: ['owner'] }
    await expect(identity.onboard(owner)).resolves.toEqual(expected)
    await expect(identity.resolveForCredentials(owner, workspaceId)).resolves.toEqual(expected)
    await expect(identity.resolve(owner, workspaceId)).resolves.toBeNull()
    await expect(identity.resolveForRestore(editor, workspaceId)).resolves.toBeNull()
    const authority = await identity.resolveForRestore(owner, workspaceId)
    if (authority === null) throw new Error('Archived workspace administrator could not resolve')
    await new WorkspaceAuthoringService(database, {
      ...authority, sessionId: randomUUID(), clientType: 'browser', actorType: 'user',
    }).restoreWorkspace(workspaceId)
    await expect(identity.resolve(owner, workspaceId)).resolves.toEqual(expected)
    await expect(counts(owner)).resolves.toEqual({ workspaces: 1, memberships: 1 })
  })

  it('honors only visible active hints, reads changed roles, and denies cross-user workspace selection', async () => {
    const owner = await user()
    const editor = await user()
    const outsider = await user()
    const workspaceId = await workspace(owner)
    await control.query("INSERT INTO app.workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'editor')", [workspaceId, editor])
    await expect(identity.resolve(editor, workspaceId)).resolves.toEqual({ userId: editor, workspaceId, roles: ['editor'] })
    await control.query("UPDATE app.workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [workspaceId, editor])
    await expect(identity.resolve(editor, workspaceId.toUpperCase())).resolves.toEqual({ userId: editor, workspaceId, roles: ['member'] })
    for (const hint of [randomUUID(), 'invalid', '']) await expect(identity.resolve(editor, hint)).resolves.toBeNull()
    await expect(identity.resolve(outsider, workspaceId)).resolves.toBeNull()
    await control.query('UPDATE app.workspace_members SET revoked_at=now() WHERE workspace_id=$1 AND user_id=$2', [workspaceId, editor])
    await expect(identity.resolve(editor)).resolves.toBeNull()
    await expect(identity.onboard(editor)).resolves.toBeNull()
    await expect(counts(editor)).resolves.toEqual({ workspaces: 0, memberships: 1 })
    const mismatched = await withRequestContext(database, { userId: outsider, workspaceId, actorType: 'user' }, async db =>
      db.execute(sql`SELECT * FROM app.current_user_workspace_memberships()`))
    expect(mismatched.rows).toEqual([])
  })
})

describe('app draft publication guards under restricted PostgreSQL roles', () => {
  it('persists an editor character draft through the publication guard', async () => {
    const userId = await user()
    const workspaceId = await workspace(userId)
    const novelId = randomUUID()
    await control.query(`INSERT INTO novel.novels(id,workspace_id,title,status,created_by_user_id)
      VALUES ($1,$2,'App draft fixture','draft',$3)`, [novelId, workspaceId, userId])
    const result = await withRequestContext(database, { userId, workspaceId, actorType: 'user' }, async db =>
      db.execute(sql`INSERT INTO novel.characters(workspace_id,novel_id,name,status,created_by_user_id)
        VALUES (${workspaceId}::uuid,${novelId}::uuid,'Editor courier','draft',${userId}::uuid)
        RETURNING status`))
    expect(result.rows).toEqual([{ status: 'draft' }])
  })

  it('keeps rollback inactive for an app user with forged rollback settings', async () => {
    const result = await readForgedRollbackContext(database)
    expect(result).toEqual([{ role: 'dsh_app_runtime', active: false }])
  })
})

describe('human generation retries after persisted worker assignment', () => {
  it.each(['running', 'completed', 'failed'] as const)('returns the same run ID in state %s without changing its assigned worker', async (status) => {
    const userId = await user()
    const workspaceId = await workspace(userId)
    const novelId = randomUUID()
    const sessionId = randomUUID()
    await control.query(`INSERT INTO auth.sessions(id,user_id,token_hash,client_type,expires_at,last_seen_at)
      VALUES ($1,$2,$3,'web',now()+interval '1 day',now())`, [sessionId, userId, randomUUID()])
    await control.query(`INSERT INTO novel.novels(id,workspace_id,title,status,created_by_user_id)
      VALUES ($1,$2,'Retry fixture','draft',$3)`, [novelId, workspaceId, userId])
    const service = new NovelAuthoringService(database, {
      userId, workspaceId, sessionId, clientType: 'browser', actorType: 'user', roles: ['owner'],
    })
    const input = {
      workspaceId, novelId, model: 'fixture', promptVersion: 'v1', sourceSessionId: sessionId,
      instruction: 'Saved instruction', contextLimit: 0, idempotencyKey: randomUUID(),
    }
    const runId = await service.createGenerationRun(input)
    await expect(service.createGenerationRun(input)).resolves.toBe(runId)
    await control.query(`UPDATE ai.generation_runs SET agent_principal_id='novel-worker',status=$2,
      completed_at=CASE WHEN $2 IN ('completed','failed') THEN now() ELSE NULL END WHERE id=$1`, [runId, status])
    await expect(service.createGenerationRun(input)).resolves.toBe(runId)
    await expect(service.createGenerationRun({ ...input, instruction: 'Changed instruction' })).rejects.toThrow('instruction mismatch')
    await expect(service.createGenerationRun({ ...input, sourceSessionId: randomUUID() })).rejects.toThrow('sourceSessionId mismatch')
    const persisted = await control.query(`SELECT id,status,agent_principal_id,instruction,
      (SELECT count(*)::int FROM ai.generation_runs WHERE workspace_id=$2 AND idempotency_key=$3) AS matching_runs
      FROM ai.generation_runs WHERE id=$1`, [runId, workspaceId, input.idempotencyKey])
    expect(persisted.rows).toEqual([{
      id: runId, status, agent_principal_id: 'novel-worker', instruction: input.instruction, matching_runs: 1,
    }])
  })
})

describe('shared agent predicate under restricted PostgreSQL roles', () => {
  const callers = [
    { role: 'dsh_app_runtime', database },
    { role: 'dsh_service_runtime', database: serviceDatabase },
  ]

  it('limits helper execution to app, worker, and service without exposing authentication tables', async () => {
    const result = await control.query(`SELECT p.prosecdef, p.proconfig, owner.rolname AS owner,
      has_function_privilege('dsh_app_runtime',p.oid,'EXECUTE') AS app_execute,
      has_function_privilege('dsh_worker_runtime',p.oid,'EXECUTE') AS worker_execute,
      has_function_privilege('dsh_service_runtime',p.oid,'EXECUTE') AS service_execute,
      has_function_privilege('dsh_auth_runtime',p.oid,'EXECUTE') AS auth_execute,
      has_function_privilege('dsh_readonly',p.oid,'EXECUTE') AS readonly_execute,
      EXISTS (SELECT 1 FROM aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner
      WHERE p.oid='app.agent_run_allowed(uuid,uuid,uuid)'::regprocedure`)
    expect(result.rows).toEqual([{
      prosecdef: true, proconfig: ['search_path=pg_catalog, app, ai'], owner: 'dsh_migrator',
      app_execute: true, worker_execute: true, service_execute: true,
      auth_execute: false, readonly_execute: false, public_execute: false,
    }])
    for (const caller of callers) {
      const access = await caller.database.db.execute(sql`SELECT
        has_table_privilege(current_user,'auth.users','SELECT') AS users,
        has_table_privilege(current_user,'auth.sessions','SELECT') AS sessions`)
      expect(access.rows).toEqual([{ users: false, sessions: false }])
    }
  })

  it.each(callers)('returns false for $role with otherwise valid forged agent context', async (caller) => {
    const userId = await user()
    const workspaceId = await workspace(userId)
    const novelId = randomUUID()
    const sessionId = randomUUID()
    const runId = randomUUID()
    const agent = 'novel-worker'
    await control.query(`INSERT INTO auth.sessions(id,user_id,token_hash,client_type,expires_at,last_seen_at)
      VALUES ($1,$2,$3,'web',now()+interval '1 day',now())`, [sessionId, userId, randomUUID()])
    await control.query(`INSERT INTO novel.novels(id,workspace_id,title,status,created_by_user_id)
      VALUES ($1,$2,'Predicate fixture','draft',$3)`, [novelId, workspaceId, userId])
    await control.query(`INSERT INTO ai.generation_runs(id,workspace_id,novel_id,initiated_by_user_id,agent_principal_id,
      model,prompt_version,source_session_id,status,idempotency_key,instruction,context_limit)
      VALUES ($1,$2,$3,$4,$5,'fixture','v1',$6,'running',$7,'Saved instruction',0)`,
    [runId, workspaceId, novelId, userId, agent, sessionId, randomUUID()])
    const result = await withRequestContext(caller.database, { userId, workspaceId, actorType: 'agent', agentPrincipalId: agent }, async db =>
      db.execute(sql`SELECT current_user AS role, app.current_database_role() AS database_role,
        app.agent_run_allowed(${workspaceId}::uuid,${novelId}::uuid,${runId}::uuid) AS allowed`))
    expect(result.rows).toEqual([{ role: caller.role, database_role: caller.role, allowed: false }])
  })

  it.each(callers)('cannot forge worker role through SET ROLE or set_config as $role', async (caller) => {
    await expect(withRequestContext(caller.database, { userId: '', workspaceId: '', actorType: 'agent' }, async db =>
      db.execute(sql`SET LOCAL ROLE dsh_worker_runtime`))).rejects.toMatchObject({ cause: { code: '42501' } })
    await expect(withRequestContext(caller.database, { userId: '', workspaceId: '', actorType: 'agent' }, async db =>
      db.execute(sql`SELECT set_config('role','dsh_worker_runtime',true)`))).rejects.toMatchObject({ cause: { code: '42501' } })
  })
})
