/** Recover persisted generation authority through the worker-only PostgreSQL identity lookup. */
import {
  sql, withRequestContext, type DatabaseClient, type DshDatabase,
} from '@deepseek-ai/dsh-database-postgres'
import type { AuthPrincipal, WorkspaceRole } from '@deepseek-ai/dsh-user-auth'
import type { GenerationRunStatus } from './index.ts'

interface WorkerIdentityRow extends Record<string, unknown> {
  readonly user_id: string
  readonly session_id: string
  readonly workspace_id: string
  readonly novel_id: string
  readonly member_role: WorkspaceRole
  readonly run_status: GenerationRunStatus
}

/** Current persisted authority and run state, without queued instruction text or authentication credentials. */
export interface GenerationWorkerIdentity {
  readonly principal: AuthPrincipal
  readonly novelId: string
  readonly status: GenerationRunStatus
}

/**
 * Resolve persisted run/session authority using a pool connected exclusively as dsh_worker_runtime.
 * The host supplies its configured agent principal; queue messages supply only workspace and run UUIDs.
 */
export class PostgresGenerationWorkerIdentity {
  constructor(
    private readonly database: DatabaseClient<DshDatabase>,
    private readonly agentPrincipalId: string,
  ) {}

  /**
   * Read current authority without claiming the run or caching its user, session, membership, or state.
   * The returned principal's official-client type identifies worker execution, not the originating session transport.
   * @param locator - Workspace and generation run UUIDs parsed at the host's queue-message boundary.
   * @returns Database-backed identity and state, or null for missing or inaccessible authority; database failures reject.
   */
  async resolve(locator: {
    readonly workspaceId: string
    readonly generationRunId: string
  }): Promise<GenerationWorkerIdentity | null> {
    return withRequestContext(this.database, {
      userId: '', workspaceId: locator.workspaceId, actorType: 'agent', agentPrincipalId: this.agentPrincipalId,
    }, async (database) => {
      const result = await database.execute<WorkerIdentityRow>(sql`SELECT * FROM ai.resolve_generation_run_worker_identity(
        ${locator.workspaceId}::uuid, ${locator.generationRunId}::uuid
      )`)
      const row = result.rows[0]
      if (row === undefined) return null
      return {
        principal: {
          userId: row.user_id, sessionId: row.session_id, workspaceId: row.workspace_id, roles: [row.member_role],
          actorType: 'agent', agentPrincipalId: this.agentPrincipalId, clientType: 'official-client',
        },
        novelId: row.novel_id, status: row.run_status,
      }
    })
  }
}
