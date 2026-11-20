import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDatabase, migrateDatabase } from '@deepseek-ai/dsh-database-postgres'
import type { AuthPrincipal } from '@deepseek-ai/dsh-user-auth'
import { NovelAuthoringService, NovelGenerationWorkflowService, type GenerationRunStatus } from '../src/index.ts'
import { postgresTestEnvironment } from '../../../identity/user-auth/tests-postgres/environment.ts'
import { TestPgClient } from '../../../identity/user-auth/tests-postgres/pg-client.ts'

const config = postgresTestEnvironment()
const control = new TestPgClient({ connectionString: config.migrationUrl })
const databases = Array.from({ length: 2 }, () => createDatabase({
  url: config.runtimeUrl, runtimeRole: 'dsh_worker_runtime', maxConnections: 1,
  idleTimeoutMs: 5_000, connectionTimeoutMs: 5_000, applicationName: `queued-claim-${randomUUID()}`,
}))

beforeAll(async () => {
  await migrateDatabase(config.migrationUrl)
  await control.connect()
  const login = await control.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = session_user')
  if (login.rows[0]?.rolsuper || login.rows[0]?.rolbypassrls) throw new Error('Test control requires a restricted migrator login')
  const memberships = await control.query(`SELECT rolname FROM pg_roles
    WHERE rolname <> session_user AND pg_has_role(session_user, oid, 'MEMBER')`)
  if (memberships.rows.length !== 1 || memberships.rows[0]?.rolname !== 'dsh_migrator') {
    throw new Error('Test control login must belong only to dsh_migrator')
  }
  await control.query('SET ROLE dsh_migrator')
  await control.query("SET statement_timeout = '15s'")
})

afterAll(async () => {
  await Promise.all([...databases.map(database => database.close()), control.end()])
})

async function seed(agentPrincipalId: 'user-request' | 'novel-worker', status: GenerationRunStatus = 'queued') {
  const userId = randomUUID()
  const sessionId = randomUUID()
  const workspaceId = randomUUID()
  const novelId = randomUUID()
  const generationRunId = randomUUID()
  await control.query(`INSERT INTO auth.users(id,email,email_normalized,password_hash,status,password_changed_at)
    VALUES ($1,$2,$2,'fixture','active',now())`, [userId, `${userId}@test.invalid`])
  await control.query(`INSERT INTO auth.sessions(id,user_id,token_hash,client_type,expires_at,last_seen_at)
    VALUES ($1,$2,$3,'official_client',now()+interval '1 day',now())`, [sessionId, userId, randomUUID()])
  await control.query("INSERT INTO app.workspaces(id,owner_user_id,name,status) VALUES ($1,$2,'Queue fixture','active')", [workspaceId, userId])
  await control.query("INSERT INTO app.workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'owner')", [workspaceId, userId])
  await control.query(`INSERT INTO novel.novels(id,workspace_id,title,status,created_by_user_id)
    VALUES ($1,$2,'Queue fixture','draft',$3)`, [novelId, workspaceId, userId])
  await control.query(`INSERT INTO ai.generation_runs(id,workspace_id,novel_id,initiated_by_user_id,agent_principal_id,
    model,prompt_version,source_session_id,status,idempotency_key,instruction,context_limit,completed_at)
    VALUES ($1,$2,$3,$4,$5,'fixture','v1',$6,$7,$8,'Saved instruction',0,
      CASE WHEN $7 IN ('completed','failed','cancelled') THEN now() ELSE NULL END)`,
  [generationRunId, workspaceId, novelId, userId, agentPrincipalId, sessionId, status, randomUUID()])
  const principal: AuthPrincipal = {
    userId, sessionId, workspaceId, actorType: 'agent', agentPrincipalId: 'novel-worker', clientType: 'browser', roles: ['owner'],
  }
  return {
    locator: { workspaceId, generationRunId }, novelId, principal,
    services: databases.map(database => new NovelAuthoringService(database, principal)),
  }
}

async function storedStatus(generationRunId: string) {
  const result = await control.query('SELECT status FROM ai.generation_runs WHERE id=$1', [generationRunId])
  return result.rows[0]?.status
}

describe('atomic queued generation claims under PostgreSQL RLS', () => {
  it.each(['user-request', 'novel-worker'] as const)('permits one concurrent delivery for a queued row owned by %s', async (agentPrincipalId) => {
    const fixture = await seed(agentPrincipalId)
    const results = await Promise.allSettled(fixture.services.map(service => service.getQueuedGenerationRequest(fixture.locator)))
    const failures = results.filter(result => result.status === 'rejected').map((result) => {
      const failure: unknown = result.reason
      return failure instanceof Error ? `${failure.message}\n${String(failure.cause)}` : String(failure)
    })
    expect(results.filter(result => result.status === 'fulfilled'), failures.join('\n')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    await expect(storedStatus(fixture.locator.generationRunId)).resolves.toBe('running')
  })

  it('executes generation, enrichment, and materialization once when same-agent deliveries overlap', async () => {
    const fixture = await seed('novel-worker')
    const generation = {
      generate: vi.fn(async () => ({
        ...fixture.locator, novelId: fixture.novelId, idempotencyKey: 'saved-key', selectedContext: [], records: [], proposals: [],
      })),
      findPersistedResult: vi.fn(async () => undefined),
    }
    const enrichment = { enrich: vi.fn(async () => ({ records: [], proposals: [] })) }
    const materialization = { materialize: vi.fn(async () => ({ records: [] })) }
    const claimsSettled = Promise.withResolvers<void>()
    let attempts = 0
    // Both claim attempts settle before either delivery reaches the provider, exposing duplicate successful claims deterministically.
    const workflows = fixture.services.map(service => new NovelGenerationWorkflowService({
      authoring: {
        createGenerationRun: vi.fn(async () => { throw new Error('queued execution must not recreate the run') }),
        getGenerationRunStatus: input => service.getGenerationRunStatus(input),
        updateGenerationRunStatus: input => service.updateGenerationRunStatus(input),
        getQueuedGenerationRequest: async (input) => {
          try { return await service.getQueuedGenerationRequest(input) } finally {
            attempts += 1
            if (attempts === 2) claimsSettled.resolve()
            await claimsSettled.promise
          }
        },
      },
      generation, enrichment, materialization,
    }))
    const results = await Promise.allSettled(workflows.map(workflow => workflow.executeQueued(fixture.locator)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(generation.generate).toHaveBeenCalledTimes(1)
    expect(enrichment.enrich).toHaveBeenCalledTimes(1)
    expect(materialization.materialize).toHaveBeenCalledTimes(1)
    await expect(storedStatus(fixture.locator.generationRunId)).resolves.toBe('completed')
  })

  it.each(['running', 'completed', 'failed', 'cancelled'] as const)('refuses to claim a %s run without changing its state', async (status) => {
    const fixture = await seed('novel-worker', status)
    const results = await Promise.allSettled(fixture.services.map(service => service.getQueuedGenerationRequest(fixture.locator)))
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    await expect(storedStatus(fixture.locator.generationRunId)).resolves.toBe(status)
  })

  it('rejects a different workspace and hides a run requested through another novel', async () => {
    const fixture = await seed('novel-worker')
    for (const service of fixture.services) {
      await expect(service.getQueuedGenerationRequest({ ...fixture.locator, workspaceId: randomUUID() })).rejects.toThrow('workspace context mismatch')
      await expect(service.getGenerationRun({ ...fixture.locator, novelId: randomUUID() })).resolves.toBeUndefined()
    }
    await expect(storedStatus(fixture.locator.generationRunId)).resolves.toBe('queued')
  })

  it('prevents another editor in the workspace from claiming a browser request initiated by its owner', async () => {
    const fixture = await seed('user-request')
    const userId = randomUUID()
    const sessionId = randomUUID()
    await control.query(`INSERT INTO auth.users(id,email,email_normalized,password_hash,status,password_changed_at)
      VALUES ($1,$2,$2,'fixture','active',now())`, [userId, `${userId}@test.invalid`])
    await control.query(`INSERT INTO auth.sessions(id,user_id,token_hash,client_type,expires_at,last_seen_at)
      VALUES ($1,$2,$3,'official_client',now()+interval '1 day',now())`, [sessionId, userId, randomUUID()])
    await control.query("INSERT INTO app.workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'editor')", [fixture.locator.workspaceId, userId])
    const services = databases.map(database => new NovelAuthoringService(database, { ...fixture.principal, userId, sessionId, roles: ['editor'] }))
    for (const service of services) {
      await expect(service.getQueuedGenerationRequest(fixture.locator)).rejects.toThrow('generation run was not found')
    }
    await expect(storedStatus(fixture.locator.generationRunId)).resolves.toBe('queued')
  })
})
