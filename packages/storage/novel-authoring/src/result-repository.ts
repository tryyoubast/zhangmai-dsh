import { AsyncLocalStorage } from 'node:async_hooks'
import {
  and,
  eq,
  generationResults,
  drizzleFromPoolClient,
  requestContextSettings,
  withRequestContext,
  type DatabaseClient,
  type DshDatabase,
} from '@deepseek-ai/dsh-database-postgres'
import type { AuthPrincipal } from '@deepseek-ai/dsh-user-auth'
import type { DraftGenerationResult, GenerationResultLookup, GenerationResultRepository } from './generation.ts'

/** PostgreSQL result store with a cross-process advisory-lock boundary. */
export class PostgresGenerationResultRepository implements GenerationResultRepository {
  private readonly lockedDatabase = new AsyncLocalStorage<DshDatabase>()

  constructor(
    private readonly database: DatabaseClient<DshDatabase>,
    private readonly principal: AuthPrincipal,
  ) {}

  async findByIdempotencyKey(input: GenerationResultLookup): Promise<DraftGenerationResult | undefined> {
    this.assertScope(input.workspaceId, input.novelId)
    const lockedDatabase = this.lockedDatabase.getStore()
    if (lockedDatabase !== undefined) return this.findByDatabase(lockedDatabase, input)
    return withRequestContext(this.database, this.context(), async db => this.findByDatabase(db, input))
  }

  private async findByDatabase(db: DshDatabase, input: GenerationResultLookup): Promise<DraftGenerationResult | undefined> {
    const [row] = await db.select().from(generationResults).where(and(
      eq(generationResults.workspaceId, input.workspaceId),
      eq(generationResults.novelId, input.novelId),
      eq(generationResults.idempotencyKey, input.idempotencyKey),
    )).limit(1)
    if (row === undefined) return undefined
    return {
      generationRunId: row.generationRunId,
      workspaceId: row.workspaceId,
      novelId: row.novelId,
      idempotencyKey: row.idempotencyKey,
      selectedContext: row.selectedContext as unknown as DraftGenerationResult['selectedContext'],
      records: row.records as DraftGenerationResult['records'],
      proposals: row.proposals as DraftGenerationResult['proposals'],
    }
  }

  async save(result: DraftGenerationResult): Promise<void> {
    this.assertScope(result.workspaceId, result.novelId)
    const lockedDatabase = this.lockedDatabase.getStore()
    if (lockedDatabase !== undefined) return this.saveWithDatabase(lockedDatabase, result)
    await withRequestContext(this.database, this.context(), async db => this.saveWithDatabase(db, result))
  }

  private async saveWithDatabase(db: DshDatabase, result: DraftGenerationResult): Promise<void> {
    await db.insert(generationResults).values({
      workspaceId: result.workspaceId,
      novelId: result.novelId,
      generationRunId: result.generationRunId,
      idempotencyKey: result.idempotencyKey,
      selectedContext: result.selectedContext as unknown as readonly Record<string, unknown>[],
      records: result.records,
      proposals: result.proposals,
    })
  }

  async withIdempotencyLock<T>(input: GenerationResultLookup, callback: () => Promise<T>): Promise<T> {
    this.assertScope(input.workspaceId, input.novelId)
    const connect = this.database.pool.connect
    if (connect === undefined) return callback()
    const client = await connect()
    const key = `${input.workspaceId}:${input.novelId}:${input.idempotencyKey}`
    try {
      await client.query('BEGIN')
      for (const [name, value] of requestContextSettings(this.context())) {
        await client.query('SELECT set_config($1, $2, true)', [name, value])
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key])
      const lockedDatabase = drizzleFromPoolClient(client as Parameters<typeof drizzleFromPoolClient>[0])
      const result = await this.lockedDatabase.run(lockedDatabase, callback)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Releasing the client still closes the failed transaction when rollback fails.
      }
      throw error
    } finally {
      client.release()
    }
  }

  private assertScope(workspaceId: string, novelId: string): void {
    if (workspaceId !== this.principal.workspaceId || workspaceId.trim() === '' || novelId.trim() === '') {
      throw new Error('workspace context mismatch')
    }
    if (this.principal.actorType !== 'agent') throw new Error('generation result persistence requires an agent actor')
    if (this.principal.agentPrincipalId === undefined) throw new Error('agent result persistence requires an agent principal')
  }

  private context(): {
    userId: string
    workspaceId: string
    actorType: 'agent'
    agentPrincipalId: string
  } {
    if (this.principal.actorType !== 'agent' || this.principal.agentPrincipalId === undefined) {
      throw new Error('agent result persistence requires an agent principal')
    }
    return {
      userId: this.principal.userId,
      workspaceId: this.principal.workspaceId,
      actorType: 'agent',
      agentPrincipalId: this.principal.agentPrincipalId,
    }
  }
}
