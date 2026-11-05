import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabase, type DatabaseClient, type DshDatabase } from '@deepseek-ai/dsh-database-postgres'
import type { AuthPrincipal } from '@deepseek-ai/dsh-user-auth'
import { PostgresGenerationResultRepository } from '../src/index.ts'

const principal: AuthPrincipal = {
  userId: 'user-1', sessionId: 'session-1', clientType: 'browser', workspaceId: 'workspace-1',
  roles: ['editor'], actorType: 'agent', agentPrincipalId: 'agent-1',
}

const databases: DatabaseClient<DshDatabase>[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.close()))
})

function lockedRepository() {
  const database = createDatabase({
    url: 'postgresql://worker:unused@127.0.0.1:5432/unused', maxConnections: 1,
    idleTimeoutMs: 1000, connectionTimeoutMs: 1000, applicationName: 'authoring-lock-test', runtimeRole: 'dsh_worker_runtime',
  })
  databases.push(database)
  const pool = database.pool
  const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [] }))
  const client = { query, release: vi.fn() }
  const connect = vi.spyOn(pool, 'connect').mockImplementation(function (this: typeof pool) {
    expect(this).toBe(pool)
    return Promise.resolve(client)
  })
  return { repository: new PostgresGenerationResultRepository(database, principal), connect, query, release: client.release }
}

describe('PostgresGenerationResultRepository durable lock', () => {
  const lookup = { workspaceId: 'workspace-1', novelId: 'novel-1', idempotencyKey: 'lock-key' }

  it('checks out an instance-backed pool connection and commits before release', async () => {
    const { repository, connect, query, release } = lockedRepository()
    const callback = vi.fn(async () => 'saved')
    await expect(repository.withIdempotencyLock(lookup, callback)).resolves.toBe('saved')
    expect(connect).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(query.mock.calls.map(call => call[0])).toEqual([
      'BEGIN', ...Array.from({ length: 4 }, () => 'SELECT set_config($1, $2, true)'),
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', 'COMMIT',
    ])
    expect(query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['workspace-1:novel-1:lock-key'])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rolls back rejected lock work and releases the connection', async () => {
    const { repository, connect, query, release } = lockedRepository()
    const failure = new Error('save failed')
    await expect(repository.withIdempotencyLock(lookup, async () => { throw failure })).rejects.toBe(failure)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(release).toHaveBeenCalledTimes(1)
  })
})
