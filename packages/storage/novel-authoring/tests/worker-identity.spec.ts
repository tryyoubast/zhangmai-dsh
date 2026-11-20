import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import type { DatabaseClient, DshDatabase } from '@deepseek-ai/dsh-database-postgres'
import * as authoring from '../src/index.ts'
import { serviceDatabase } from './coverage-fixture.ts'

const { PgDialect } = createRequire(new URL('../../../database/database-postgres/package.json', import.meta.url))('drizzle-orm/pg-core') as {
  PgDialect: new () => { sqlToQuery(query: unknown): { sql: string; params: unknown[] } }
}

const locator = { workspaceId: 'workspace', generationRunId: 'run' }
const row = {
  user_id: 'persisted-user', session_id: 'persisted-session', workspace_id: 'workspace', novel_id: 'persisted-novel',
  member_role: 'editor', run_status: 'queued',
}

describe('PostgreSQL generation worker identity', () => {
  it('restores a persisted principal using only the trusted worker agent and queue locator', async () => {
    expect(authoring).toHaveProperty('PostgresGenerationWorkerIdentity')
    const fixture = serviceDatabase()
    fixture.executionReplies.set(5, [row])
    const resolver = new authoring.PostgresGenerationWorkerIdentity(fixture.database, 'novel-worker')
    await expect(resolver.resolve(locator)).resolves.toEqual({
      principal: {
        userId: 'persisted-user', sessionId: 'persisted-session', workspaceId: 'workspace',
        roles: ['editor'], actorType: 'agent', agentPrincipalId: 'novel-worker', clientType: 'official-client',
      },
      novelId: 'persisted-novel', status: 'queued',
    })
    const dialect = new PgDialect()
    const queries = fixture.executes.map(query => dialect.sqlToQuery(query))
    expect(queries.map(query => query.params)).toEqual([
      ['app.user_id', ''], ['app.workspace_id', 'workspace'], ['app.actor_type', 'agent'],
      ['app.agent_principal_id', 'novel-worker'], ['workspace', 'run'],
    ])
    expect(queries[4]?.sql).toContain('ai.resolve_generation_run_worker_identity')
    expect(fixture.writes).toHaveLength(0)
    expect(fixture.transactions).toBe(1)
  })

  it('returns null when the database does not establish current authority', async () => {
    const fixture = serviceDatabase()
    const resolver = new authoring.PostgresGenerationWorkerIdentity(fixture.database, 'novel-worker')
    await expect(resolver.resolve(locator)).resolves.toBeNull()
  })

  it('reads current database authority again instead of caching a queue identity', async () => {
    const fixture = serviceDatabase()
    fixture.executionReplies.set(5, [row])
    const resolver = new authoring.PostgresGenerationWorkerIdentity(fixture.database, 'novel-worker')
    expect(await resolver.resolve(locator)).not.toBeNull()
    await expect(resolver.resolve(locator)).resolves.toBeNull()
    expect(fixture.transactions).toBe(2)
  })

  it('rejects database failures instead of supplying a queue-derived fallback identity', async () => {
    const fixture = serviceDatabase()
    const failure = new Error('worker lookup unavailable')
    const database: DatabaseClient<DshDatabase> = fixture.database
    vi.spyOn(database.db, 'transaction').mockRejectedValueOnce(failure)
    const resolver = new authoring.PostgresGenerationWorkerIdentity(database, 'novel-worker')
    await expect(resolver.resolve(locator)).rejects.toBe(failure)
  })
})
